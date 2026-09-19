/**
 * Shared FlyerTalk-tail applier. Both ingest paths (direct script and
 * residential-sync) write through here so every confirm batch ends with
 * refreshFleetMeta — public totals move the same day, not at the next daily
 * fleet sync. (lastUpdated ownership still holds: refreshFleetMeta stamps via
 * stampLastUpdated, which no-ops for non-fleet-meta owners like QR.)
 */

import type { Database } from "bun:sqlite";
import {
  addDiscoveredStarlinkPlane,
  refreshFleetMeta,
  upsertFleetAircraft,
} from "../database/database";
import type { FleetSource } from "../types";
import { info, warn } from "../utils/logger";

export function applyFlyertalkTails(
  db: Database,
  tails: string[],
  opts: {
    airline: "AS" | "QR";
    gid: Extract<FleetSource, "flyertalk_as" | "flyertalk_qr">;
    operator: string;
    /** Aircraft type to write when the tail qualifies; null skips the tail. */
    gate: (tail: string) => { aircraftType: string | null } | null;
    gateLabel: string;
  }
): number {
  if (tails.length === 0) return 0;

  let written = 0;
  const tx = db.transaction((rows: string[]) => {
    for (const tail of rows) {
      const hit = opts.gate(tail);
      if (!hit) continue;
      // FlyerTalk tails are individually spotted/flown (community observation,
      // not a type rule) — observation semantics: verified stamps + parking.
      upsertFleetAircraft(
        db,
        tail,
        hit.aircraftType,
        opts.gid,
        "mainline",
        opts.operator,
        opts.airline,
        { starlinkStatus: "confirmed", verifiedWifi: "Starlink", evidence: "observed" }
      );
      addDiscoveredStarlinkPlane(
        db,
        tail,
        hit.aircraftType,
        "Starlink",
        opts.operator,
        "mainline",
        {
          sheetGid: opts.gid,
          airline: opts.airline,
          evidence: "observed",
        }
      );
      written++;
    }
  });
  tx(tails);

  if (written > 0) refreshFleetMeta(db, opts.airline);

  info(
    `FlyerTalk ${opts.airline} sync: ${written}/${tails.length} tails written (${opts.gateLabel})`
  );
  return written;
}

export class FlyertalkRedirectRejected extends Error {
  override name = "FlyertalkRedirectRejected";
}

export type FlyertalkFetcher = (url: string, init: RequestInit) => Promise<Response>;

const FLYERTALK_HOST = "www.flyertalk.com";
const MAX_REDIRECT_HOPS = 2;

// FlyerTalk renames thread slugs when an editor retitles the thread (AS 2201647
// did in May and the oracle died silently on redirect:"error"). Follow only a
// rename of the same thread on the same host; anything else could point the
// tail regex at an attacker-controlled or unrelated page.
function acceptRedirect(next: URL, threadId: number): boolean {
  return (
    next.protocol === "https:" &&
    next.hostname === FLYERTALK_HOST &&
    new RegExp(`^/forum/[^/]+/${threadId}-[^/]*\\.html$`).test(next.pathname)
  );
}

export async function fetchFlyertalk(
  url: string,
  threadId: number,
  headers: Record<string, string>,
  fetcher: FlyertalkFetcher = fetch
): Promise<{ html: string; finalUrl: string }> {
  let cur = url;
  for (let hop = 0; ; hop++) {
    const res = await fetcher(cur, { headers, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`HTTP ${res.status} without Location for ${cur}`);
      if (hop >= MAX_REDIRECT_HOPS)
        throw new FlyertalkRedirectRejected(
          `too many redirects (> ${MAX_REDIRECT_HOPS}) from ${url}`
        );
      let next: URL;
      try {
        next = new URL(loc, cur);
      } catch {
        throw new FlyertalkRedirectRejected(`unparseable Location ${loc} from ${cur}`);
      }
      if (!acceptRedirect(next, threadId))
        throw new FlyertalkRedirectRejected(`refusing redirect ${cur} → ${next.href}`);
      warn(`FlyerTalk ${threadId} moved: ${next.href} — refresh THREAD_URL`);
      cur = next.href;
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${cur}`);
    // FlyerTalk serves windows-1252; treat as bytes and only keep ASCII matches.
    const html = new TextDecoder("latin1").decode(new Uint8Array(await res.arrayBuffer()));
    return { html, finalUrl: cur };
  }
}
