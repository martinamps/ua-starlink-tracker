/**
 * IndexNow: tells Bing-family engines which pages changed when a tail joins
 * (or leaves) the Starlink list, so they recrawl before the sitemap cycle.
 *
 * Only pages whose answer changed are submitted, never the sitemap and never
 * on a timer: the protocol asks for exactly that, and a host that pings
 * unchanged pages is treated as noise. Every submission is a background side
 * channel: it has a deadline, and a failure is logged and counted, never
 * thrown into the job that noticed the change.
 *
 * Off unless NODE_ENV=production with jobs enabled; INDEXNOW_DISABLED=1 turns
 * it off there too, key file included.
 */

import type { Database } from "bun:sqlite";
import { normalizeAircraftType } from "../airlines/aircraft-families";
import { aircraftPageForFamily } from "../airlines/aircraft-pages";
import {
  AIRLINES,
  type AirlineCode,
  type SiteConfig,
  airlineSlug,
  enabledAirlines,
  isHubContent,
  siteForAirline,
} from "../airlines/registry";
import { getEquippedTails, getMeta, getRecentInstalls, setMeta } from "../database/database";
import { COUNTERS, metrics, normalizeAirlineTag } from "../observability/metrics";
import { info, error as logError } from "../utils/logger";

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

/** The protocol's key alphabet and length. */
const KEY_SHAPE = /^[A-Za-z0-9-]{8,128}$/;

// Meta rows live under the hub scope: one key and one ledger per site, none
// of them an airline's.
const META_SCOPE = "ALL";
const KEY_META = "indexnowKey";
const sentMeta = (site: SiteConfig) => `indexnowSent:${site.key}`;
const ANNOUNCED_META = "indexnowAnnounced";

type Env = Record<string, string | undefined>;

function switchedOff(env: Env): boolean {
  return env.INDEXNOW_DISABLED === "1";
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
  /** Unix seconds until which the engine asked us to stay quiet. */
  pausedUntil?: number;
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
}

export interface IndexNow {
  /** Submit `paths` of the airline's own live site. Never rejects. */
  submit(airline: AirlineCode, paths: string[]): Promise<SubmitStatus>;
  /** Submit the changed pages for every tail that joined a list since the
   * last call. Never rejects. */
  announceNewTails(): Promise<void>;
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

  async function submitToSite(
    site: SiteConfig,
    airline: AirlineCode,
    paths: string[]
  ): Promise<SubmitStatus> {
    const tags = { vendor: "indexnow", type: "ping", airline: normalizeAirlineTag(airline) };
    const count = (status: Exclude<SubmitStatus, "noop">) =>
      metrics.increment(COUNTERS.VENDOR_REQUEST, { ...tags, status });
    try {
      if (!site.live) return "noop";
      const wanted = [...new Set(paths.flatMap((p) => addressOf(site, p) ?? []))];
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
      const room = DAILY_URL_CAP - ledger.sent.length;
      if (ledger.pausedUntil || room <= 0) {
        count("shed");
        return "shed";
      }
      const urlList = due.slice(0, room);
      // Counted before the answer: a submission that fails still spent an
      // attempt, and nothing here retries.
      ledger.sent.push(...urlList.map((a): [string, number] => [a, now]));
      writeLedger(site, ledger);

      let res: Response;
      try {
        res = await doFetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({ host: site.canonicalHost, key, urlList }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const timedOut =
          err instanceof Error && /timeout|abort/i.test(`${err.name} ${err.message}`);
        count(timedOut ? "timeout" : "error");
        logError(`IndexNow: no answer for ${site.canonicalHost}`, err);
        return timedOut ? "timeout" : "error";
      }
      // 200 = accepted; 202 = accepted, key check pending.
      if (res.status === 200 || res.status === 202) {
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
      logError(`IndexNow: ${res.status} for ${site.canonicalHost}`);
      return "error";
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

  /** Tails that joined `code`'s list since the last look. The first look only
   * records the list: what was already there is the sitemap's to tell. */
  function newTails(code: AirlineCode): Array<{ tail: string; aircraft: string | null }> {
    const cfg = AIRLINES[code];
    const equipped = getEquippedTails(db, code);
    const stored = getMeta(db, ANNOUNCED_META, code);
    let seen: Set<string> | null = null;
    try {
      const parsed = stored ? (JSON.parse(stored) as unknown) : null;
      if (Array.isArray(parsed)) seen = new Set(parsed.filter((t) => typeof t === "string"));
    } catch {
      seen = null;
    }
    const fresh = seen ? equipped.filter((t) => !seen.has(t.tail)) : [];
    if (!seen || fresh.length > 0) {
      // A tail is announced once: one that leaves the list and returns is not
      // news again.
      const all = new Set([...(seen ?? []), ...equipped.map((t) => t.tail)]);
      setMeta(db, ANNOUNCED_META, JSON.stringify([...all]), code);
    }
    return fresh.filter((t) => cfg.tailPattern.test(t.tail));
  }

  async function announceNewTails(): Promise<void> {
    for (const cfg of enabledAirlines()) {
      try {
        const fresh = newTails(cfg.code);
        if (fresh.length === 0) continue;
        info(
          `IndexNow: ${fresh.length} new ${cfg.code} tail(s): ${fresh.map((t) => t.tail).join(", ")}`
        );
        const logged = new Set(
          getRecentInstalls(db, cfg.code, INSTALL_LOG_DEPTH).map((r) => r.TailNumber)
        );
        const inLog = fresh.some((t) => logged.has(t.tail));
        const logPages = inLog ? ["/newly-equipped", "/feed.xml"] : [];

        const own = siteForAirline(cfg.code, true);
        if (own) {
          const shown = fresh.slice(0, TAIL_PAGES_PER_EVENT);
          const typePages = shown.flatMap((t) => {
            const def = t.aircraft
              ? aircraftPageForFamily(cfg.code, normalizeAircraftType(t.aircraft))
              : null;
            return def ? [`/fleet/${def.slug}`] : [];
          });
          await submitToSite(own, cfg.code, [
            "/",
            "/fleet",
            ...logPages,
            ...typePages,
            ...shown.map((t) => `/fleet/${t.tail}`),
          ]);
        }
        const hub = siteForAirline("ALL", true);
        if (hub && isHubContent(cfg)) {
          await submitToSite(hub, cfg.code, [
            ...(cfg.publicInHub ? ["/", "/fleet", ...logPages] : []),
            `/airlines/${airlineSlug(cfg)}`,
          ]);
        }
      } catch (err) {
        logError(`IndexNow: new-tail check failed for ${cfg.code}`, err);
      }
    }
  }

  return { submit, announceNewTails };
}

let active: IndexNow | null = null;

/** Wire the process's one submitter (server.ts, production with jobs on).
 * Until then every pingIndexNow is a no-op, which is what keeps tests, dev
 * and DISABLE_JOBS=1 silent. */
export function activateIndexNow(deps: IndexNowDeps): IndexNow {
  active = createIndexNow(deps);
  return active;
}

/** Fire-and-forget submission of an airline site's changed pages. */
export function pingIndexNow(airline: AirlineCode, paths: string[]): void {
  void active?.submit(airline, paths);
}
