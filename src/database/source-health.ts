/**
 * Per-source health: when each outside source we read on a schedule last
 * succeeded and last failed, kept in `meta` so a restart doesn't reset the
 * clock, plus one Slack notice when a source goes quiet and one when it
 * returns.
 *
 * data.freshness_seconds (data-freshness.ts) already ages when a pipeline
 * stops writing, but it is a gauge with no memory of why and nothing that
 * speaks up: the sheet scrape refused every hourly run from 27 Oct to
 * 17 Nov 2026 and nobody was told.
 *
 * "Success" means the source gave us usable data, not that the request
 * returned. A blocked or empty page that parses to nothing is a failure of
 * kind "empty" or "refused"; each job reports through the outcome it already
 * computes, so this module never fetches anything itself.
 */

import type { Database } from "bun:sqlite";
import { AIRLINES, enabledAirlines } from "../airlines/registry";
import { COUNTERS, GAUGES, metrics, normalizeScopeTag } from "../observability/metrics";
import { type JobHandle, startJob } from "../utils/job-runner";
import { info, error as logError, warn } from "../utils/logger";
import { SLACK_MENTION, notifySlack } from "../utils/notify";

export type SourceId =
  | "sheet_scrape"
  | "united_site"
  | "flight_schedule"
  | "fleet_roster"
  | "alaska_site"
  | "alaska_tracker"
  | "qatar_schedule"
  | "fleet_progress"
  | "fleet_progress_tails"
  | "ship_numbers"
  | "faa_registry"
  | "sec_filings"
  | "bts"
  | "starlink_geofeed"
  | "adsb";

/** Closed set: it is a metric tag. */
export type SourceFailureKind =
  | "error" // the request or its parse threw
  | "timeout"
  | "blocked" // the vendor refused us (403, captcha, rate limit)
  | "empty" // answered, with nothing usable in it
  | "refused" // answered, but our own sanity floor rejected the result
  | "partial"; // some of the source's parts failed

interface SourceDef {
  label: string;
  /** What "normal" looks like, for the notice. */
  cadence: string;
  /** Quiet for longer than this and the alarm goes out. */
  quietAfterHours: number;
  /** Scopes ("UA", "ALL", …) this source is watched under. */
  scopes: () => string[];
  /** Decides what a page says about a plane or a flight, so a page's "last
   * updated" may not read fresher than this source's last good read. */
  feedsPages?: boolean;
  /** Runs only under a flag or key: watched once it has reported at all, so
   * a deployment that never enabled it never alarms. */
  optional?: boolean;
}

const HOURLY_QUIET_HOURS = 6;
const DAILY_QUIET_HOURS = 72;

const only = (code: string) => () => (AIRLINES[code]?.enabled ? [code] : []);

/** Thresholds follow each job's schedule: six missed runs for an hourly job,
 * three for a daily one, and a few hours for the loops that tick every
 * minute or so (their own breakers already pause 30 minutes at a time). */
export const SOURCES: Record<SourceId, SourceDef> = {
  sheet_scrape: {
    label: "Community sheet scrape",
    cadence: "hourly",
    quietAfterHours: HOURLY_QUIET_HOURS,
    feedsPages: true,
    scopes: only("UA"),
  },
  united_site: {
    label: "united.com Wi-Fi check",
    cadence: "a check every few minutes",
    quietAfterHours: 6,
    feedsPages: true,
    scopes: only("UA"),
  },
  flight_schedule: {
    label: "Flight schedule lookups",
    cadence: "a tail every 22 seconds",
    quietAfterHours: 3,
    feedsPages: true,
    scopes: () => ["ALL"],
  },
  fleet_roster: {
    label: "Fleet roster sync",
    cadence: "daily",
    quietAfterHours: DAILY_QUIET_HOURS,
    feedsPages: true,
    scopes: () =>
      enabledAirlines()
        .filter((a) => a.fr24Slug)
        .map((a) => a.code),
  },
  alaska_site: {
    label: "alaskaair.com flight status check",
    // Each tail comes due about weekly, so good reads arrive in bursts: the
    // longest ordinary gap in production is ~53 h (AS) and ~49 h (HA).
    cadence: "bursts through the week, gaps up to two days",
    quietAfterHours: 72,
    feedsPages: true,
    scopes: () =>
      enabledAirlines()
        .filter((a) => a.verifierBackend === "alaska-json")
        .map((a) => a.code),
  },
  alaska_tracker: {
    label: "Alaska install tracker",
    cadence: "daily",
    quietAfterHours: DAILY_QUIET_HOURS,
    feedsPages: true,
    scopes: () => (AIRLINES.AS?.enabled && AIRLINES.AS.officialTracker?.url ? ["AS"] : []),
  },
  qatar_schedule: {
    label: "Qatar equipment schedule",
    cadence: "hourly",
    quietAfterHours: HOURLY_QUIET_HOURS,
    feedsPages: true,
    scopes: only("QR"),
  },
  fleet_progress: {
    label: "Install progress sheets",
    cadence: "daily",
    quietAfterHours: DAILY_QUIET_HOURS,
    scopes: only("UA"),
  },
  fleet_progress_tails: {
    label: "Install progress sheets, per tail",
    cadence: "daily",
    quietAfterHours: DAILY_QUIET_HOURS,
    scopes: only("UA"),
    optional: true,
  },
  ship_numbers: {
    label: "Ship number sheet",
    cadence: "daily",
    quietAfterHours: DAILY_QUIET_HOURS,
    scopes: only("UA"),
  },
  faa_registry: {
    label: "FAA registry",
    cadence: "daily",
    quietAfterHours: DAILY_QUIET_HOURS,
    scopes: only("UA"),
  },
  sec_filings: {
    label: "SEC filings",
    cadence: "daily",
    quietAfterHours: DAILY_QUIET_HOURS,
    scopes: only("UA"),
  },
  // BTS posts one file a month; a run that finds no new month reports
  // nothing, so the clock is the last month ingested. Two publication cycles.
  bts: {
    label: "BTS monthly traffic file",
    cadence: "monthly",
    quietAfterHours: 62 * 24,
    scopes: only("UA"),
  },
  starlink_geofeed: {
    label: "Starlink geofeed",
    cadence: "daily",
    quietAfterHours: DAILY_QUIET_HOURS,
    scopes: () => ["ALL"],
    optional: true,
  },
  adsb: {
    label: "ADS-B sweep",
    cadence: "every 5 minutes",
    quietAfterHours: 3,
    scopes: only("UA"),
  },
};

export interface SourceState {
  /** Where the quiet clock starts for a source that has never succeeded. */
  firstSeenAt: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastFailureKind: SourceFailureKind | null;
  failuresSinceSuccess: number;
  /** Set while a quiet episode is open. */
  quietSince: number | null;
  /** The notice for this episode reached Slack, so an all-clear is owed. */
  alarmSent: boolean;
}

const metaKey = (id: SourceId, scope: string) => `${scope}:source_health.${id}`;

export function readSourceState(db: Database, id: SourceId, scope: string): SourceState | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(metaKey(id, scope)) as {
    value: string;
  } | null;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<SourceState>;
    if (typeof parsed.firstSeenAt !== "number") return null;
    return {
      firstSeenAt: parsed.firstSeenAt,
      lastSuccessAt: parsed.lastSuccessAt ?? null,
      lastFailureAt: parsed.lastFailureAt ?? null,
      lastFailureKind: parsed.lastFailureKind ?? null,
      failuresSinceSuccess: parsed.failuresSinceSuccess ?? 0,
      quietSince: parsed.quietSince ?? null,
      alarmSent: parsed.alarmSent ?? false,
    };
  } catch {
    return null;
  }
}

/** Synchronous read-modify-write, so a job's report landing while a notice is
 * in flight is never overwritten by the checker's older copy. */
function updateSourceState(
  db: Database,
  id: SourceId,
  scope: string,
  now: number,
  change: (state: SourceState) => void
): SourceState {
  const state = readSourceState(db, id, scope) ?? {
    firstSeenAt: now,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureKind: null,
    failuresSinceSuccess: 0,
    quietSince: null,
    alarmSent: false,
  };
  change(state);
  db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
    metaKey(id, scope),
    JSON.stringify(state)
  );
  return state;
}

// A job's own work must never fail because its health report did.
function guarded(what: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    logError(`source-health: ${what} failed`, err);
  }
}

export function recordSourceSuccess(
  db: Database,
  id: SourceId,
  scope: string,
  now = Date.now()
): void {
  guarded(`success report for ${id}`, () => {
    updateSourceState(db, id, scope, now, (s) => {
      s.lastSuccessAt = now;
      s.failuresSinceSuccess = 0;
    });
  });
}

export function recordSourceFailure(
  db: Database,
  id: SourceId,
  scope: string,
  kind: SourceFailureKind,
  now = Date.now()
): void {
  guarded(`failure report for ${id}`, () => {
    updateSourceState(db, id, scope, now, (s) => {
      s.lastFailureAt = now;
      s.lastFailureKind = kind;
      s.failuresSinceSuccess++;
    });
    metrics.increment(COUNTERS.SOURCE_FAILURE, {
      source: id,
      kind,
      airline: normalizeScopeTag(scope),
    });
  });
}

/** For jobs that already sum a run up as success / partial / error. Any other
 * outcome (noop, skipped, abandoned) says nothing about the source. */
export function recordSyncOutcome(
  db: Database,
  id: SourceId,
  scope: string,
  outcome: string,
  now = Date.now()
): void {
  if (outcome === "success") recordSourceSuccess(db, id, scope, now);
  else if (outcome === "partial" || outcome === "error" || outcome === "empty") {
    recordSourceFailure(db, id, scope, outcome, now);
  }
}

/** Buckets a thrown vendor error for the failure-kind tag. */
export function failureKindOf(err: unknown): SourceFailureKind {
  const msg = (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).toLowerCase();
  if (/cloudflare|403|blocked|captcha|rate.?limit|429/.test(msg)) return "blocked";
  if (/timeout|timed.?out|aborted|econnreset|etimedout|socket/.test(msg)) return "timeout";
  return "error";
}

const HOUR_MS = 3600 * 1000;

function utcStamp(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function hoursLabel(ms: number): string {
  const hours = ms / HOUR_MS;
  return hours >= 48 ? `${(hours / 24).toFixed(1)} days` : `${hours.toFixed(1)} hours`;
}

function sourceName(id: SourceId, scope: string): string {
  const airline = AIRLINES[scope]?.name;
  return airline ? `${SOURCES[id].label} (${airline})` : SOURCES[id].label;
}

export function formatQuietNotice(
  id: SourceId,
  scope: string,
  state: SourceState,
  now: number,
  mention = SLACK_MENTION
): string {
  const def = SOURCES[id];
  const since = state.lastSuccessAt ?? state.firstSeenAt;
  const lastGood =
    state.lastSuccessAt !== null
      ? `Last good read ${utcStamp(state.lastSuccessAt)}`
      : `No good read since watching began ${utcStamp(state.firstSeenAt)}`;
  const lastBad =
    state.lastFailureAt !== null
      ? `${state.failuresSinceSuccess} failed since, the latest \`${state.lastFailureKind}\` at ${utcStamp(state.lastFailureAt)}`
      : "no run has reported since";
  return [
    `🔇 *Data source quiet:* ${sourceName(id, scope)} · no good read for ${hoursLabel(now - since)}`,
    `(normally ${def.cadence}; alarm after ${hoursLabel(def.quietAfterHours * HOUR_MS)}).`,
    `${lastGood}; ${lastBad}.`,
    `\`${id}\``,
    mention,
  ]
    .filter(Boolean)
    .join(" ");
}

export function formatRecoveredNotice(
  id: SourceId,
  scope: string,
  state: SourceState,
  quietFrom: number
): string {
  const backAt = state.lastSuccessAt ?? quietFrom;
  return [
    `✅ *Data source back:* ${sourceName(id, scope)} · good read at ${utcStamp(backAt)}`,
    `after ${hoursLabel(backAt - quietFrom)} quiet.`,
    `\`${id}\``,
  ].join(" ");
}

export interface SourceHealthDeps {
  now?: number;
  notify?: (text: string) => Promise<boolean>;
}

export interface SourceHealthRow {
  id: SourceId;
  scope: string;
  hoursSinceSuccess: number;
  quiet: boolean;
}

/** Every watched (source, scope) pair, in a stable order. */
export function watchedSources(db: Database): Array<{ id: SourceId; scope: string }> {
  const out: Array<{ id: SourceId; scope: string }> = [];
  for (const id of Object.keys(SOURCES) as SourceId[]) {
    for (const scope of SOURCES[id].scopes()) {
      if (SOURCES[id].optional && !readSourceState(db, id, scope)) continue;
      out.push({ id, scope });
    }
  }
  return out;
}

/**
 * One pass over every watched source: emit its gauges, open a quiet episode
 * when it passes its threshold, close it when a success lands. One notice per
 * episode each way. Without SLACK_WEBHOOK_URL nothing is sent; the episode is
 * still tracked and logged once, and a notice goes out if the webhook is set
 * while the source is still quiet.
 */
export async function checkSourceHealth(
  db: Database,
  deps: SourceHealthDeps = {}
): Promise<SourceHealthRow[]> {
  const now = deps.now ?? Date.now();
  const notify = deps.notify ?? notifySlack;
  const webhookSet = Boolean(process.env.SLACK_WEBHOOK_URL);
  const rows: SourceHealthRow[] = [];

  for (const { id, scope } of watchedSources(db)) {
    try {
      const def = SOURCES[id];
      // Persists firstSeenAt on first sight, so the clock survives a restart
      // even for a source that has never reported.
      let state = updateSourceState(db, id, scope, now, () => {});
      const since = state.lastSuccessAt ?? state.firstSeenAt;
      const quietMs = Math.max(0, now - since);
      const quiet = quietMs > def.quietAfterHours * HOUR_MS;
      const tags = { source: id, airline: normalizeScopeTag(scope) };
      metrics.gauge(GAUGES.SOURCE_HOURS_SINCE_SUCCESS, quietMs / HOUR_MS, tags);
      metrics.gauge(GAUGES.SOURCE_QUIET, quiet ? 1 : 0, tags);
      rows.push({ id, scope, hoursSinceSuccess: quietMs / HOUR_MS, quiet });

      if (quiet) {
        if (state.quietSince === null) {
          state = updateSourceState(db, id, scope, now, (s) => {
            s.quietSince = since;
            s.alarmSent = false;
          });
          logError(`source-health: ${formatQuietNotice(id, scope, state, now, "")}`);
        }
        if (
          !state.alarmSent &&
          webhookSet &&
          (await notify(formatQuietNotice(id, scope, state, now)))
        ) {
          updateSourceState(db, id, scope, now, (s) => {
            s.alarmSent = true;
          });
        }
      } else if (state.quietSince !== null) {
        const text = formatRecoveredNotice(id, scope, state, state.quietSince);
        // An all-clear is owed only for an alarm that went out. If it can't
        // be delivered, keep the episode open and try again next pass.
        if (state.alarmSent && webhookSet && !(await notify(text))) {
          warn(`source-health: all-clear for ${id} not delivered; will retry`);
          continue;
        }
        updateSourceState(db, id, scope, now, (s) => {
          s.quietSince = null;
          s.alarmSent = false;
        });
        info(`source-health: ${text}`);
      }
    } catch (err) {
      logError(`source-health: check failed for ${id}/${scope}`, err);
    }
  }
  return rows;
}

const PAGE_SOURCES = (Object.keys(SOURCES) as SourceId[]).filter((id) => SOURCES[id].feedsPages);

/**
 * A page's "last updated" stamp, held back to the last good read of any
 * source behind that airline's pages that is quiet right now. The stamp
 * itself follows one owning pipeline per airline (stampLastUpdated), so
 * without this a dead united.com check sat behind a date that still moved
 * with every sheet scrape. Untouched while nothing is quiet.
 */
export function capToQuietSources(
  db: Database,
  airline: string,
  stampIso: string | null
): string | null {
  const stampMs = stampIso ? Date.parse(stampIso) : Number.NaN;
  if (!stampIso || !Number.isFinite(stampMs)) return stampIso;
  let cap = stampMs;
  try {
    for (const id of PAGE_SOURCES) {
      for (const scope of SOURCES[id].scopes()) {
        if (scope !== airline && scope !== "ALL") continue;
        const quietSince = readSourceState(db, id, scope)?.quietSince;
        if (quietSince != null && quietSince < cap) cap = quietSince;
      }
    }
  } catch (err) {
    logError("source-health: last-updated cap failed", err);
    return stampIso;
  }
  return cap < stampMs ? new Date(cap).toISOString() : stampIso;
}

export function startSourceHealthJob(db: Database): JobHandle {
  return startJob({
    name: "source_health",
    intervalMs: 5 * 60 * 1000,
    // After the boot-time runs have reported, so a restart doesn't sample
    // every clock at its oldest.
    initialDelayMs: 2 * 60 * 1000,
    run: async () => {
      await checkSourceHealth(db);
    },
  });
}
