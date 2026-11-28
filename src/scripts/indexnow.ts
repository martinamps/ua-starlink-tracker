/**
 * IndexNow: tells Bing-family engines which pages changed when a tail joins
 * the Starlink list, so they recrawl before the sitemap cycle.
 *
 * Only pages whose answer changed are submitted, never the sitemap and never
 * on a timer: the protocol asks for exactly that, and a host that pings
 * unchanged pages is treated as noise. Every submission is a background side
 * channel: it has a deadline, and a failure is logged and counted, never
 * thrown into the job that noticed the change.
 *
 * A new tail counts as announced for a site only once the engine accepted the
 * send. Until then it waits in the database (so a restart keeps it) and goes
 * out, whole and once, at the first later pass the site has room for.
 *
 * A rollout fact (src/airlines/rollout-facts.ts) that was added, edited or
 * replaced is news too, for the hub's /timeline and the pages that show it.
 * Facts live in code, so they change at a deploy: each pass compares them
 * with what was last recorded and queues the pages of what differs. The
 * first pass only records, so a deploy of this feature announces nothing.
 *
 * A flight page whose next plane on the same leg flipped between Starlink
 * and not (starlinkFlip in check-flight/answer-key.ts) is news for that page
 * alone. The hourly answer watcher hands those over; a first sighting, a new
 * plane with the same answer, a leg rotation, a lead that appears or goes,
 * verified ↔ likely, the usual band and the quiet note never reach here
 * (the last three still move the sitemap date). They go out in one small batch per pass, under a daily cap of
 * their own, at most once a day per page, so tails and facts keep all of
 * theirs.
 *
 * Off unless NODE_ENV=production with jobs enabled; INDEXNOW_DISABLED=1 (or
 * "true") turns it off there too, key file included.
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { normalizeAircraftType } from "../airlines/aircraft-families";
import { aircraftPageForFamily, aircraftPagesFor } from "../airlines/aircraft-pages";
import {
  AIRLINES,
  type AirlineCode,
  type AirlineConfig,
  type SiteConfig,
  airlineSlug,
  enabledAirlines,
  isHubContent,
  siteForAirline,
} from "../airlines/registry";
import {
  AIRLINE_FACTS,
  type AirlineFactsEntry,
  ROLLOUT_TIMELINES,
  type RolloutTimeline,
} from "../airlines/rollout-facts";
import { getEquippedTails, getMeta, getRecentInstalls, setMeta } from "../database/database";
import {
  COUNTERS,
  metrics,
  normalizeAirlineTag,
  normalizeScopeTag,
} from "../observability/metrics";
import { info, error as logError, warn } from "../utils/logger";

export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
/** Addresses one site may submit in any 24 hours. A day with several new
 * tails needs about a dozen; past this something is looping. */
export const DAILY_URL_CAP = 40;
/** The protocol's FAQ asks for at least ten minutes before the same address
 * is sent again. */
const RESUBMIT_GAP_SEC = 10 * 60;
const DAY_SEC = 24 * 3600;
/** Tail pages per site per event: a bulk import lists dozens at once, and the
 * summary pages already carry that news. */
const TAIL_PAGES_PER_EVENT = 5;
/** A tail this high in its airline's install log is on /newly-equipped and in
 * the feed on its own site and on the hub (whose per-airline share is larger). */
const INSTALL_LOG_DEPTH = 10;
const REQUEST_TIMEOUT_MS = 10_000;
const SELF_CHECK_TIMEOUT_MS = 10_000;
const DEFAULT_PAUSE_SEC = 3600;
/** A send that failed for any reason but a 429 quiets its site for the
 * resubmit gap, doubling with each failure in a row up to this. An outage
 * then costs a handful of tries a day instead of one every pass. */
const MAX_FAILURE_PAUSE_SEC = 6 * 3600;
/** A new tail waits this long at most for an accepted send. Past it the
 * sitemap and the engine's own crawl of the home page have told the news. */
export const WAITING_MAX_AGE_SEC = 7 * DAY_SEC;
/** Tails one airline may have waiting. One accepted send clears them all, so
 * only an outage during a bulk import gets near it; past it the newest are
 * not queued (the summary pages the others send carry them too). */
export const WAITING_MAX_TAILS = 50;

/** Fact pages one site sends in one pass. A deploy that touches many
 * airlines' facts goes out over a few passes instead of one burst. */
export const FACT_PAGES_PER_PASS = 10;
/** Room under the daily cap a fact send leaves for new tails: they are the
 * news only this job carries, while a fact page also reaches the sitemap's
 * lastmod. */
export const FACT_TAIL_RESERVE = 20;
/** Fact pages one site may have waiting; past it the rest are left to the
 * sitemap. */
export const FACT_WAITING_MAX_PAGES = 60;

/** Flight pages one site may submit in any 24 hours, on a ledger of their
 * own. Engines take one or two URLs of a submission and leave the rest: of
 * the flight pages sent on fleet-discovery flips since 30 Oct, Bing fetched 1
 * in 16 within the hour, while it fetched the home page after most sends.
 * Each address sent counts against the engine's crawl of the site, so only
 * Starlink flips are sent, and few. Raise it only once a week of sends shows
 * Bing fetching more than 1 in 5 sent flight pages within the hour. Past it
 * the rest are left to the sitemap's lastmod, and a loop in the watcher costs
 * no more. */
export const FLIGHT_DAILY_CAP = 25;
/** Flight pages one site sends in one pass (the watcher runs hourly): the
 * day's cap goes out through the day, each pass's most telling turns first,
 * instead of in one burst at the first pass after the window rolls. */
export const FLIGHT_PAGES_PER_PASS = 5;
/** Flight pages self-checked per pass at most: each is a page render, and
 * one that no longer serves or indexes frees its place for the next. */
const FLIGHT_CHECKS_PER_PASS = 4 * FLIGHT_PAGES_PER_PASS;

/** The protocol's key alphabet and length. */
const KEY_SHAPE = /^[A-Za-z0-9-]{8,128}$/;

// Meta rows live under the hub scope: one key and one ledger per site, none
// of them an airline's.
const META_SCOPE = "ALL";
const KEY_META = "indexnowKey";
const sentMeta = (site: SiteConfig) => `indexnowSent:${site.key}`;
/** Per site: flight pages sent in the last 24 hours. Apart from sentMeta so
 * flight sends never spend the room kept for tails and facts. */
const flightSentMeta = (site: SiteConfig) => `indexnowFlightSent:${site.key}`;
/** Every tail the job has ever noticed on an airline's list: what "new" is
 * measured against. Not the same as announced: see WAITING_META. */
const ANNOUNCED_META = "indexnowAnnounced";
/** Per airline: noticed tails whose send a site has not accepted yet. */
const WAITING_META = "indexnowWaiting";
/** The rollout facts as last recorded (FactPrints). */
const FACTS_META = "indexnowFacts";
/** Per site scope: fact pages whose send has not been accepted yet. */
const FACTS_WAITING_META = "indexnowFactsWaiting";

type Env = Record<string, string | undefined>;

// An off switch that stays on for "true" fails in the direction nobody
// wants, so both spellings turn it off.
function switchedOff(env: Env): boolean {
  const value = env.INDEXNOW_DISABLED?.trim().toLowerCase();
  return value === "1" || value === "true";
}

/** Why an INDEXNOW_KEY is not a key, in words that never repeat it. */
function keyFault(value: string): string {
  if (/\s/.test(value)) return "it contains whitespace";
  if (value.length < 8) return "it is shorter than 8 characters";
  if (value.length > 128) return "it is longer than 128 characters";
  return "it has a character other than letters, digits and hyphens";
}

/** Submissions run only on the live server's own jobs. */
export function indexNowOn(env: Env = process.env): boolean {
  return env.NODE_ENV === "production" && env.DISABLE_JOBS !== "1" && !switchedOff(env);
}

/**
 * The key this server proves its hosts with, or null when there is none (or
 * the switch is off). INDEXNOW_KEY wins when set: engines have already
 * verified a deployment's existing key, and replacing it buys nothing.
 * Otherwise the key is the one this server made for itself (ensureIndexNowKey).
 * Read-only, so it is safe on a readonly handle.
 */
export function readIndexNowKey(db: Database, env: Env = process.env): string | null {
  if (switchedOff(env)) return null;
  const fromEnv = env.INDEXNOW_KEY;
  if (fromEnv && KEY_SHAPE.test(fromEnv)) return fromEnv;
  const stored = getMeta(db, KEY_META, META_SCOPE);
  return stored && KEY_SHAPE.test(stored) ? stored : null;
}

/** readIndexNowKey, making and storing a random key the first time. The key
 * never leaves the database and the key file: with it anyone could submit in
 * our hosts' name. */
export function ensureIndexNowKey(db: Database, env: Env = process.env): string | null {
  if (switchedOff(env)) return null;
  const fromEnv = env.INDEXNOW_KEY;
  if (fromEnv && !KEY_SHAPE.test(fromEnv)) {
    // Engines verified the deployment's key, not ours: say so once at boot
    // rather than let a typo quietly swap keys.
    warn(
      `IndexNow: INDEXNOW_KEY is set but is not a usable key (${keyFault(fromEnv)}); falling back to this server's own key, which the engines have not verified for these hosts`
    );
  }
  const existing = readIndexNowKey(db, env);
  if (existing) return existing;
  const key = crypto.randomUUID().replace(/-/g, "");
  setMeta(db, KEY_META, key, META_SCOPE);
  info("IndexNow: generated this server's key");
  return key;
}

/** The key file's body when `pathname` is its address, else null. */
export function indexNowKeyFile(key: string | null, pathname: string): string | null {
  return key && pathname === `/${key}.txt` ? key : null;
}

export type SubmitStatus = "success" | "rate_limited" | "timeout" | "error" | "shed" | "noop";

interface Ledger {
  /** [address, unix seconds] of every address sent in the last 24 hours. */
  sent: Array<[string, number]>;
  /** Unix seconds until which the site stays quiet: what the engine asked
   * after a 429, or our own back-off after a failed send. */
  pausedUntil?: number;
  /** Failed sends in a row (429s aside) since the last accepted one. */
  failures?: number;
}

interface SendOptions {
  /** All of what is due or none of it: an announcement that only half fits
   * under the cap waits for room instead of being sent in pieces. */
  whole?: boolean;
  /** Room under the daily cap this send must leave untouched. */
  reserve?: number;
  /** The metric's `type` tag: "ping" for tails and callers, "fact" for a
   * rollout fact that was added or replaced. */
  kind?: "ping" | "fact";
}

type SendKind = "ping" | "fact" | "flight";

interface WaitingTail {
  tail: string;
  /** Unix seconds when the job first noticed it. */
  at: number;
  /** Keys of the sites that have not accepted its send yet. */
  sites: string[];
}

/** What one fact (or timeline line) tells about the pages it shows on. */
interface FactMark {
  /** It carries asOf, so the hub's /timeline lists it. */
  dated: boolean;
  /** The airline's type pages it shows on (aircraftPages; "*" = all). Empty
   * once superseded: type pages drop a replaced fact. */
  types: string[];
}

/** Group → fact hash → mark. A group is `facts:<trackedCode>:<slug>` for an
 * AIRLINE_FACTS entry (code empty when untracked) or `timeline:<code>` for an
 * airline's own /timeline. */
export type FactPrints = Record<string, Record<string, FactMark>>;

const hashOf = (value: unknown) =>
  createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 16);

/** The facts as they stand, one hash per fact. `accessed` is left out: a
 * re-read of an undated page changes nothing a reader sees. */
export function factPrints(
  entries: readonly AirlineFactsEntry[],
  timelines: Partial<Record<string, RolloutTimeline>>
): FactPrints {
  const prints: FactPrints = {};
  for (const entry of entries) {
    const group: Record<string, FactMark> = {};
    for (const fact of entry.facts) {
      const { accessed: _accessed, ...shown } = fact;
      group[hashOf(shown)] = {
        dated: Boolean(fact.asOf),
        types: fact.superseded ? [] : [...(fact.aircraftPages ?? [])],
      };
    }
    prints[`facts:${entry.trackedCode ?? ""}:${entry.slug}`] = group;
  }
  for (const [code, timeline] of Object.entries(timelines)) {
    if (!timeline) continue;
    const group: Record<string, FactMark> = {};
    for (const line of [...timeline.milestones, ...timeline.targets]) {
      group[hashOf(line)] = { dated: true, types: [] };
    }
    prints[`timeline:${code}`] = group;
  }
  return prints;
}

/** The pages that changed between two sets of prints, by site scope ("ALL"
 * for the hub, else the airline's code), most read first. */
export function factChangePages(before: FactPrints, after: FactPrints): Map<string, string[]> {
  const pages = new Map<string, Set<string>>();
  const add = (scope: string, path: string) => {
    if (!pages.has(scope)) pages.set(scope, new Set());
    pages.get(scope)?.add(path);
  };
  for (const group of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const was = before[group] ?? {};
    const is = after[group] ?? {};
    const changed = [
      ...Object.entries(was).filter(([h]) => !(h in is)),
      ...Object.entries(is).filter(([h]) => !(h in was)),
    ].map(([, mark]) => mark);
    if (changed.length === 0) continue;
    const [kind, code, slug] = group.split(":");
    if (kind === "timeline" && code) {
      add(code, "/timeline");
      continue;
    }
    if (kind !== "facts" || !slug) continue;
    const cfg = code ? AIRLINES[code] : undefined;
    if (code && !cfg) continue;
    // The hub lists an untracked airline always, a tracked one only when it
    // is hub content.
    if (!cfg || isHubContent(cfg)) {
      if (changed.some((m) => m.dated)) add(META_SCOPE, "/timeline");
      add(META_SCOPE, `/airlines/${slug}`);
    }
    if (cfg) {
      for (const type of new Set(changed.flatMap((m) => m.types))) {
        const slugs = type === "*" ? aircraftPagesFor(cfg.code).map((d) => d.slug) : [type];
        for (const s of slugs) add(cfg.code, `/fleet/${s}`);
      }
    }
  }
  // /timeline first on the hub: it is the one page every dated change touches.
  return new Map(
    [...pages].map(([scope, set]) => [
      scope,
      [...set].sort((a, b) => Number(b === "/timeline") - Number(a === "/timeline")),
    ])
  );
}

interface FactWaiting {
  /** Unix seconds when the oldest of these pages first waited. */
  at: number;
  paths: string[];
}

export interface IndexNowDeps {
  db: Database;
  key: string;
  /** The app's own dispatch: a page is submitted only if we serve it, 200 and
   * indexable, at that moment. */
  dispatch: (req: Request) => Promise<Response>;
  endpoint?: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  /** The rollout facts and timelines, as deployed. Tests pass their own. */
  facts?: () => readonly AirlineFactsEntry[];
  timelines?: () => Partial<Record<string, RolloutTimeline>>;
}

export interface IndexNow {
  /** Submit `paths` of the airline's own live site. Never rejects. */
  submit(airline: AirlineCode, paths: string[]): Promise<SubmitStatus>;
  /** Submit the changed pages for every tail that joined a list since the
   * last call, and for every earlier one a site has not accepted yet. Never
   * rejects. */
  announceNewTails(): Promise<void>;
  /** Submit the pages of every rollout fact added, edited or replaced since
   * the last call, and of earlier ones not accepted yet. The first call only
   * records the facts. Never rejects. */
  announceFactChanges(): Promise<void>;
  /** Submit the pages of `flightNumbers` on the airline's own site: flights
   * whose answer turned this pass, most telling first. At most
   * FLIGHT_PAGES_PER_PASS go, each page at most once a day, under
   * FLIGHT_DAILY_CAP; what does not fit is left to the sitemap, never
   * queued. Never rejects. */
  announceFlightChanges(airline: AirlineCode, flightNumbers: string[]): Promise<SubmitStatus>;
}

export function createIndexNow(deps: IndexNowDeps): IndexNow {
  const { db, key, dispatch } = deps;
  const endpoint = deps.endpoint ?? INDEXNOW_ENDPOINT;
  const doFetch = deps.fetch ?? fetch;
  const nowSec = () => Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;

  function readLedger(site: SiteConfig, now: number): Ledger {
    try {
      const raw = JSON.parse(getMeta(db, sentMeta(site), META_SCOPE) ?? "{}") as Partial<Ledger>;
      const sent = Array.isArray(raw.sent)
        ? raw.sent.filter(
            (e): e is [string, number] =>
              Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "number"
          )
        : [];
      return {
        sent: sent.filter(([, at]) => now - at < DAY_SEC),
        ...(typeof raw.pausedUntil === "number" && raw.pausedUntil > now
          ? { pausedUntil: raw.pausedUntil }
          : {}),
        ...(typeof raw.failures === "number" && raw.failures > 0
          ? { failures: Math.floor(raw.failures) }
          : {}),
      };
    } catch {
      return { sent: [] };
    }
  }

  const writeLedger = (site: SiteConfig, ledger: Ledger) =>
    setMeta(db, sentMeta(site), JSON.stringify(ledger), META_SCOPE);

  /** The site's own absolute address for `path`, or null when the path would
   * leave the site (a tail or slug is other people's text). */
  function addressOf(site: SiteConfig, path: string): string | null {
    if (!path.startsWith("/") || path.startsWith("//") || /[\s\\]/.test(path)) return null;
    const origin = `https://${site.canonicalHost}`;
    if (!URL.canParse(path, origin)) return null;
    const url = new URL(path, origin);
    return url.origin === origin && !url.search && !url.hash ? url.href : null;
  }

  async function serves(site: SiteConfig, address: string): Promise<boolean> {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const res = await Promise.race([
        dispatch(
          new Request(address, {
            headers: {
              host: site.canonicalHost,
              accept: "text/html,application/xhtml+xml,application/xml",
              "user-agent": "ua-starlink-tracker-indexnow-selfcheck (bot)",
            },
          })
        ),
        new Promise<null>((resolve) => {
          deadline = setTimeout(() => resolve(null), SELF_CHECK_TIMEOUT_MS);
        }),
      ]);
      if (!res || res.status !== 200) return false;
      if (/noindex/i.test(res.headers.get("x-robots-tag") ?? "")) return false;
      if (!(res.headers.get("content-type") ?? "").includes("html")) return true;
      return !/<meta name="robots" content="[^"]*noindex/i.test(await res.text());
    } catch {
      return false;
    } finally {
      clearTimeout(deadline);
    }
  }

  /** The vendor request counter for one kind of send. */
  function counter(airline: AirlineCode, kind: SendKind) {
    const tags = {
      vendor: "indexnow",
      type: kind,
      airline: airline === META_SCOPE ? normalizeScopeTag(airline) : normalizeAirlineTag(airline),
    };
    return (status: Exclude<SubmitStatus, "noop">) =>
      metrics.increment(COUNTERS.VENDOR_REQUEST, { ...tags, status });
  }

  /** Record a failed send and quiet the site; returns the pause in seconds. */
  function backOff(site: SiteConfig): number {
    const at = nowSec();
    const ledger = readLedger(site, at);
    const failures = (ledger.failures ?? 0) + 1;
    const pause = Math.min(
      RESUBMIT_GAP_SEC * 2 ** Math.min(failures - 1, 10),
      MAX_FAILURE_PAUSE_SEC
    );
    writeLedger(site, {
      ...ledger,
      failures,
      pausedUntil: Math.max(ledger.pausedUntil ?? 0, at + pause),
    });
    return pause;
  }

  /** POST `urlList` for `site` and settle the ledger by the answer: a 429
   * pauses the site for what the engine asked, any other failure backs off. */
  async function post(
    site: SiteConfig,
    urlList: string[],
    count: (status: Exclude<SubmitStatus, "noop" | "shed">) => void
  ): Promise<SubmitStatus> {
    let res: Response;
    try {
      res = await doFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ host: site.canonicalHost, key, urlList }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && /timeout|abort/i.test(`${err.name} ${err.message}`);
      count(timedOut ? "timeout" : "error");
      logError(`IndexNow: no answer for ${site.canonicalHost}, quiet for ${backOff(site)}s`, err);
      return timedOut ? "timeout" : "error";
    }
    // 200 = accepted; 202 = accepted, key check pending.
    if (res.status === 200 || res.status === 202) {
      const { failures, ...settled } = readLedger(site, nowSec());
      if (failures) writeLedger(site, settled);
      count("success");
      info(`IndexNow: ${urlList.length} page(s) submitted for ${site.canonicalHost}`);
      return "success";
    }
    if (res.status === 429) {
      const asked = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
      const pause = Number.isFinite(asked)
        ? Math.min(Math.max(asked, RESUBMIT_GAP_SEC), DAY_SEC)
        : DEFAULT_PAUSE_SEC;
      const at = nowSec();
      writeLedger(site, { ...readLedger(site, at), pausedUntil: at + pause });
      count("rate_limited");
      logError(`IndexNow: 429 for ${site.canonicalHost}, quiet for ${pause}s`);
      return "rate_limited";
    }
    // 400 bad request, 403 key not found or not matching, 422 an address
    // that is not the host's.
    count("error");
    logError(`IndexNow: ${res.status} for ${site.canonicalHost}, quiet for ${backOff(site)}s`);
    return "error";
  }

  async function submitToSite(
    site: SiteConfig,
    airline: AirlineCode,
    paths: string[],
    opts: SendOptions = {}
  ): Promise<SubmitStatus> {
    const { whole = false, reserve = 0, kind = "ping" } = opts;
    const count = counter(airline, kind);
    try {
      if (!site.live) return "noop";
      const wanted = [...new Set(paths.flatMap((p) => addressOf(site, p) ?? []))];
      if (wanted.length === 0) return "noop";
      // Before the gap check below: addresses of a send that just failed are
      // inside the resubmit gap, and "nothing due" must not pass for "told".
      if (readLedger(site, nowSec()).pausedUntil) {
        count("shed");
        return "shed";
      }
      const served: string[] = [];
      for (const address of wanted) {
        if (await serves(site, address)) served.push(address);
      }

      // No await between reading the ledger and writing it back, so two
      // submissions for one site can never both spend the same room.
      const now = nowSec();
      const ledger = readLedger(site, now);
      const lastSent = new Map(ledger.sent);
      const due = served.filter((a) => now - (lastSent.get(a) ?? 0) >= RESUBMIT_GAP_SEC);
      if (due.length === 0) return "noop";
      const room = DAILY_URL_CAP - reserve - ledger.sent.length;
      if (ledger.pausedUntil || room <= 0 || (whole && due.length > room)) {
        count("shed");
        return "shed";
      }
      const urlList = due.slice(0, room);
      // Counted before the answer: a submission that fails still spent an
      // attempt, so a retry stays inside the same daily cap.
      ledger.sent.push(...urlList.map((a): [string, number] => [a, now]));
      writeLedger(site, ledger);

      return await post(site, urlList, count);
    } catch (err) {
      count("error");
      logError(`IndexNow: submission failed for ${site.canonicalHost}`, err);
      return "error";
    }
  }

  async function submit(airline: AirlineCode, paths: string[]): Promise<SubmitStatus> {
    const site = siteForAirline(airline, true);
    return site ? submitToSite(site, airline, paths) : "noop";
  }

  /** The live sites a new tail of `cfg` is announced on: its own, and the hub
   * when the hub shows the airline. */
  function announceTargets(cfg: AirlineConfig): Array<{ site: SiteConfig; hub: boolean }> {
    const own = siteForAirline(cfg.code, true);
    const hub = isHubContent(cfg) ? siteForAirline("ALL", true) : null;
    return [
      ...(own ? [{ site: own, hub: false }] : []),
      ...(hub ? [{ site: hub, hub: true }] : []),
    ];
  }

  function readWaiting(code: AirlineCode, siteKeys: string[]): WaitingTail[] {
    try {
      const raw = JSON.parse(getMeta(db, WAITING_META, code) ?? "[]") as unknown;
      if (!Array.isArray(raw)) return [];
      const seen = new Set<string>();
      return raw.flatMap((e: Partial<WaitingTail> | null): WaitingTail[] => {
        if (!e || typeof e.tail !== "string" || typeof e.at !== "number") return [];
        if (!Array.isArray(e.sites) || seen.has(e.tail)) return [];
        const sites = siteKeys.filter((k) => (e.sites as unknown[]).includes(k));
        if (sites.length === 0) return [];
        seen.add(e.tail);
        return [{ tail: e.tail, at: e.at, sites }];
      });
    } catch {
      return [];
    }
  }

  const writeWaiting = (code: AirlineCode, waiting: WaitingTail[]) =>
    setMeta(db, WAITING_META, JSON.stringify(waiting), code);

  /**
   * Notice the tails that joined `cfg`'s list since the last look and queue
   * them; returns everything still waiting, oldest first. The first look only
   * records the list: what was already there is the sitemap's to tell. One
   * transaction, so a tail is never recorded as noticed without being queued.
   */
  function noteNewTails(
    cfg: AirlineConfig,
    siteKeys: string[],
    now: number
  ): { waiting: WaitingTail[]; aircraftOf: Map<string, string | null> } {
    const code = cfg.code;
    const equipped = getEquippedTails(db, code);
    const aircraftOf = new Map(equipped.map((t) => [t.tail, t.aircraft]));
    const stored = getMeta(db, ANNOUNCED_META, code);
    let seen: Set<string> | null = null;
    try {
      const parsed = stored ? (JSON.parse(stored) as unknown) : null;
      if (Array.isArray(parsed)) seen = new Set(parsed.filter((t) => typeof t === "string"));
    } catch {
      seen = null;
    }
    const noticed = seen ? equipped.filter((t) => !seen.has(t.tail)) : [];
    const fresh = noticed.filter((t) => cfg.tailPattern.test(t.tail));
    if (fresh.length > 0) {
      info(`IndexNow: ${fresh.length} new ${code} tail(s): ${fresh.map((t) => t.tail).join(", ")}`);
    }

    const before = readWaiting(code, siteKeys);
    const queued = new Set(before.map((w) => w.tail));
    const all =
      siteKeys.length > 0
        ? [
            ...before,
            ...fresh
              .filter((t) => !queued.has(t.tail))
              .map((t): WaitingTail => ({ tail: t.tail, at: now, sites: [...siteKeys] })),
          ]
        : [];
    const young = all.filter((w) => now - w.at < WAITING_MAX_AGE_SEC);
    const waiting = young.slice(0, WAITING_MAX_TAILS);
    const kept = new Set(waiting.map((w) => w.tail));
    const dropped = all.filter((w) => !kept.has(w.tail)).map((w) => w.tail);
    if (dropped.length > 0) {
      info(
        `IndexNow: ${dropped.length} ${code} tail(s) no longer wait to be announced (older than ${WAITING_MAX_AGE_SEC / DAY_SEC} days, or past ${WAITING_MAX_TAILS} waiting): ${dropped.join(", ")}`
      );
    }

    db.transaction(() => {
      if (!seen || noticed.length > 0) {
        // Noticed once: a tail that leaves the list and returns is not news
        // again.
        const everSeen = new Set([...(seen ?? []), ...equipped.map((t) => t.tail)]);
        setMeta(db, ANNOUNCED_META, JSON.stringify([...everSeen]), code);
      }
      if (JSON.stringify(waiting) !== JSON.stringify(before) || dropped.length > 0) {
        writeWaiting(code, waiting);
      }
    })();
    return { waiting, aircraftOf };
  }

  /** `tails` were accepted for `siteKey`: they stop waiting on it. */
  function settle(code: AirlineCode, siteKeys: string[], siteKey: string, tails: Set<string>) {
    const waiting = readWaiting(code, siteKeys).flatMap((w): WaitingTail[] => {
      if (!tails.has(w.tail)) return [w];
      const sites = w.sites.filter((k) => k !== siteKey);
      return sites.length > 0 ? [{ ...w, sites }] : [];
    });
    writeWaiting(code, waiting);
  }

  async function announceNewTails(): Promise<void> {
    for (const cfg of enabledAirlines()) {
      try {
        const targets = announceTargets(cfg);
        const siteKeys = targets.map((t) => t.site.key);
        const started = nowSec();
        const { waiting, aircraftOf } = noteNewTails(cfg, siteKeys, started);
        if (waiting.length === 0) continue;
        const logged = new Set(
          getRecentInstalls(db, cfg.code, INSTALL_LOG_DEPTH).map((r) => r.TailNumber)
        );

        for (const { site, hub } of targets) {
          // A tail that is off the list this pass keeps waiting: its pages
          // would not serve, and it may be back at the next one.
          const batch = waiting.filter((w) => w.sites.includes(site.key) && aircraftOf.has(w.tail));
          if (batch.length === 0) continue;
          const inLog = batch.some((w) => logged.has(w.tail));
          const logPages = inLog ? ["/newly-equipped", "/feed.xml"] : [];
          let paths: string[];
          if (hub) {
            paths = [
              ...(cfg.publicInHub ? ["/", "/fleet", ...logPages] : []),
              `/airlines/${airlineSlug(cfg)}`,
            ];
          } else {
            const shown = batch.slice(0, TAIL_PAGES_PER_EVENT);
            const typePages = shown.flatMap((w) => {
              const aircraft = aircraftOf.get(w.tail);
              const def = aircraft
                ? aircraftPageForFamily(cfg.code, normalizeAircraftType(aircraft))
                : null;
              return def ? [`/fleet/${def.slug}`] : [];
            });
            paths = [
              "/",
              "/fleet",
              ...logPages,
              ...typePages,
              ...shown.map((w) => `/fleet/${w.tail}`),
            ];
          }
          const status = await submitToSite(site, cfg.code, paths, { whole: true });
          // "noop" is nothing left to tell: every page was accepted inside the
          // last ten minutes, or none of them is served and indexable.
          if (status !== "success" && status !== "noop") continue;
          settle(cfg.code, siteKeys, site.key, new Set(batch.map((w) => w.tail)));
          const late = batch.filter((w) => w.at < started).length;
          if (late > 0 && status === "success") {
            info(
              `IndexNow: ${late} ${cfg.code} tail(s) that had waited went out for ${site.canonicalHost}`
            );
          }
        }
      } catch (err) {
        logError(`IndexNow: new-tail check failed for ${cfg.code}`, err);
      }
    }
  }

  function readFactPrints(): FactPrints | null {
    try {
      const raw = JSON.parse(getMeta(db, FACTS_META, META_SCOPE) ?? "null") as unknown;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const prints: FactPrints = {};
      for (const [group, marks] of Object.entries(raw as Record<string, unknown>)) {
        if (!marks || typeof marks !== "object" || Array.isArray(marks)) return null;
        prints[group] = {};
        for (const [hash, mark] of Object.entries(marks as Record<string, Partial<FactMark>>)) {
          prints[group][hash] = {
            dated: mark?.dated === true,
            types: Array.isArray(mark?.types)
              ? mark.types.filter((t): t is string => typeof t === "string")
              : [],
          };
        }
      }
      return prints;
    } catch {
      return null;
    }
  }

  function readFactWaiting(): Record<string, FactWaiting> {
    try {
      const raw = JSON.parse(getMeta(db, FACTS_WAITING_META, META_SCOPE) ?? "{}") as unknown;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
      const waiting: Record<string, FactWaiting> = {};
      for (const [scope, w] of Object.entries(raw as Record<string, Partial<FactWaiting>>)) {
        if (typeof w?.at !== "number" || !Array.isArray(w.paths)) continue;
        const paths = w.paths.filter((p): p is string => typeof p === "string");
        if (paths.length > 0) waiting[scope] = { at: w.at, paths };
      }
      return waiting;
    } catch {
      return {};
    }
  }

  const writeFactWaiting = (waiting: Record<string, FactWaiting>) =>
    setMeta(db, FACTS_WAITING_META, JSON.stringify(waiting), META_SCOPE);

  async function announceFactChanges(): Promise<void> {
    try {
      const now = nowSec();
      const after = factPrints(
        deps.facts?.() ?? AIRLINE_FACTS,
        deps.timelines?.() ?? ROLLOUT_TIMELINES
      );
      const before = readFactPrints();
      const stored = readFactWaiting();
      const waiting: Record<string, FactWaiting> = {};
      for (const [scope, w] of Object.entries(stored)) {
        if (now - w.at < WAITING_MAX_AGE_SEC) waiting[scope] = w;
        else info(`IndexNow: ${w.paths.length} fact page(s) for ${scope} no longer wait`);
      }
      // No record yet (this feature's first deploy, or a broken row): record
      // and send nothing, since what was already there is the sitemap's.
      const changes = before ? factChangePages(before, after) : new Map<string, string[]>();
      for (const [scope, paths] of changes) {
        info(`IndexNow: rollout facts changed, ${scope} page(s): ${paths.join(", ")}`);
        const merged = [...new Set([...(waiting[scope]?.paths ?? []), ...paths])];
        const kept = merged.slice(0, FACT_WAITING_MAX_PAGES);
        if (kept.length < merged.length) {
          info(
            `IndexNow: ${merged.length - kept.length} ${scope} fact page(s) not queued (past ${FACT_WAITING_MAX_PAGES} waiting)`
          );
        }
        waiting[scope] = { at: waiting[scope]?.at ?? now, paths: kept };
      }
      db.transaction(() => {
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          setMeta(db, FACTS_META, JSON.stringify(after), META_SCOPE);
        }
        if (JSON.stringify(waiting) !== JSON.stringify(stored)) writeFactWaiting(waiting);
      })();

      for (const [scope, w] of Object.entries(waiting)) {
        const site = siteForAirline(scope, true);
        const batch = w.paths.slice(0, FACT_PAGES_PER_PASS);
        const status = site
          ? await submitToSite(site, scope, batch, {
              whole: true,
              reserve: FACT_TAIL_RESERVE,
              kind: "fact",
            })
          : "noop";
        // "noop": no live site, nothing it serves, or all sent in the last ten
        // minutes. Each way there is nothing left to tell.
        if (status !== "success" && status !== "noop") continue;
        const sent = new Set(batch);
        const current = readFactWaiting();
        const left = (current[scope]?.paths ?? []).filter((p) => !sent.has(p));
        if (left.length > 0) current[scope] = { at: current[scope]?.at ?? now, paths: left };
        else delete current[scope];
        writeFactWaiting(current);
      }
    } catch (err) {
      logError("IndexNow: rollout fact check failed", err);
    }
  }

  function readFlightSent(site: SiteConfig, now: number): Array<[string, number]> {
    try {
      const raw = JSON.parse(getMeta(db, flightSentMeta(site), META_SCOPE) ?? "[]") as unknown;
      if (!Array.isArray(raw)) return [];
      return raw.filter(
        (e): e is [string, number] =>
          Array.isArray(e) &&
          typeof e[0] === "string" &&
          typeof e[1] === "number" &&
          now - e[1] < DAY_SEC
      );
    } catch {
      return [];
    }
  }

  async function announceFlightChanges(
    airline: AirlineCode,
    flightNumbers: string[]
  ): Promise<SubmitStatus> {
    const count = counter(airline, "flight");
    try {
      const site = siteForAirline(airline, true);
      if (!site?.live) return "noop";
      const wanted = [
        ...new Set(
          flightNumbers.flatMap(
            (fn) => addressOf(site, `/check-flight/${encodeURIComponent(fn)}`) ?? []
          )
        ),
      ];
      if (wanted.length === 0) return "noop";
      const sentBefore = new Set(readFlightSent(site, nowSec()).map(([a]) => a));
      // Once a day per page: an answer that flips back and forth hourly is
      // one recrawl's worth of news, not many.
      const fresh = wanted.filter((a) => !sentBefore.has(a));
      if (fresh.length === 0) return "noop";
      if (readLedger(site, nowSec()).pausedUntil) {
        count("shed");
        return "shed";
      }
      const room = Math.min(FLIGHT_PAGES_PER_PASS, FLIGHT_DAILY_CAP - sentBefore.size);
      if (room <= 0) {
        count("shed");
        info(
          `IndexNow: ${fresh.length} ${airline} flight page(s) past the ${FLIGHT_DAILY_CAP}-a-day cap, left to the sitemap`
        );
        return "shed";
      }
      const served: string[] = [];
      for (const address of fresh.slice(0, FLIGHT_CHECKS_PER_PASS)) {
        if (served.length >= room) break;
        if (await serves(site, address)) served.push(address);
      }
      if (served.length === 0) return "noop";

      // No await between reading the ledger and writing it back.
      const now = nowSec();
      const ledger = readFlightSent(site, now);
      const already = new Set(ledger.map(([a]) => a));
      const urlList = served
        .filter((a) => !already.has(a))
        .slice(0, Math.max(0, Math.min(room, FLIGHT_DAILY_CAP - ledger.length)));
      if (urlList.length === 0) return "noop";
      const left = fresh.length - urlList.length;
      if (left > 0) {
        info(
          `IndexNow: ${left} ${airline} flight page(s) not sent this pass (cap, or not served), left to the sitemap`
        );
      }
      // Counted before the answer, as on the main ledger: a failed send still
      // spent its place, and is not retried.
      setMeta(
        db,
        flightSentMeta(site),
        JSON.stringify([...ledger, ...urlList.map((a): [string, number] => [a, now])]),
        META_SCOPE
      );
      return await post(site, urlList, count);
    } catch (err) {
      count("error");
      logError(`IndexNow: flight page submission failed for ${airline}`, err);
      return "error";
    }
  }

  return { submit, announceNewTails, announceFactChanges, announceFlightChanges };
}

let active: IndexNow | null = null;

/** Wire the process's one submitter (server.ts, production with jobs on).
 * Until then every pingIndexNow is a no-op, which is what keeps tests, dev
 * and DISABLE_JOBS=1 silent. */
export function activateIndexNow(deps: IndexNowDeps): IndexNow {
  active = createIndexNow(deps);
  return active;
}

/** The flight pages whose answer turned, to the process's submitter; a
 * no-op until one is activated. Never rejects. */
export async function announceFlightPages(
  airline: AirlineCode,
  flightNumbers: string[]
): Promise<SubmitStatus> {
  return active ? active.announceFlightChanges(airline, flightNumbers) : "noop";
}

/** Fire-and-forget submission of an airline site's changed pages. */
export function pingIndexNow(airline: AirlineCode, paths: string[]): void {
  void active?.submit(airline, paths);
}
