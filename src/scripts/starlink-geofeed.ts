/**
 * Daily fetch of Starlink's RFC 8805 geofeed (~4k prefixes). Gives us
 * `isStarlinkIp(clientIp)` for the passenger-verify dark-launch probe.
 * The geofeed locates by PoP, not aircraft, so it answers "on Starlink?"
 * only — never which flight.
 */

import type { Database } from "bun:sqlite";
import { replaceStarlinkPrefixes } from "../database/database";
import { COUNTERS, GAUGES, metrics, withSpan } from "../observability";
import { type ParsedPrefix, parseCidr } from "../utils/ip-prefix";
import { type JobHandle, startJob } from "../utils/job-runner";
import { info, error as logError } from "../utils/logger";

const GEOFEED_URL = "https://geoip.starlinkisp.net/feed.csv";

export interface GeofeedSyncResult {
  outcome: "success" | "error";
  prefixes: number;
}

export function parseGeofeed(body: string): ParsedPrefix[] {
  const out = new Map<string, ParsedPrefix>();
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const cidr = line.split(",")[0]?.trim();
    if (!cidr) continue;
    const parsed = parseCidr(cidr);
    if (parsed) out.set(parsed.cidr, parsed);
  }
  return [...out.values()];
}

export async function runGeofeedSync(
  db: Database,
  fetchBody: () => Promise<string> = () => fetch(GEOFEED_URL).then((r) => r.text())
): Promise<GeofeedSyncResult> {
  return withSpan("scraper.starlink_geofeed", async (span) => {
    span.setTag("job.type", "background");
    try {
      const body = await fetchBody();
      const prefixes = parseGeofeed(body);
      // A short or empty body is a fetch failure (CDN error page), not a real
      // empty feed — keep yesterday's table rather than blanking the matcher.
      if (prefixes.length < 100) throw new Error(`geofeed parsed to ${prefixes.length} prefixes`);
      replaceStarlinkPrefixes(db, prefixes);
      metrics.gauge(GAUGES.GEOFEED_PREFIXES, prefixes.length, { airline: "all" });
      metrics.increment(COUNTERS.SCRAPER_SYNC, {
        source: "starlink_geofeed",
        airline: "all",
        status: "success",
      });
      info(`starlink-geofeed sync: ${prefixes.length} prefixes`);
      return { outcome: "success", prefixes: prefixes.length };
    } catch (err) {
      logError("starlink-geofeed sync failed", err);
      metrics.increment(COUNTERS.SCRAPER_SYNC, {
        source: "starlink_geofeed",
        airline: "all",
        status: "error",
      });
      span.setTag("error", true);
      return { outcome: "error", prefixes: 0 };
    }
  });
}

export function startGeofeedJob(db: Database): JobHandle {
  return startJob({
    name: "starlink_geofeed",
    intervalMs: 24 * 3600 * 1000,
    initialDelayMs: 30 * 1000,
    run: async () => {
      await runGeofeedSync(db);
    },
  });
}
