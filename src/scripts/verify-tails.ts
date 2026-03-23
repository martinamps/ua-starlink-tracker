#!/usr/bin/env bun
/**
 * Deterministic per-tail verification against United.com.
 *
 * Usage:
 *   bun run verify-tails N550GJ N549GJ N516GJ
 *   bun run verify-tails --file=tails.txt
 *   bun run verify-tails --delay=2000  (ms between checks, default 2000)
 *
 * For each tail:
 *   1. Finds next upcoming flight from the local DB
 *   2. Scrapes United.com flight-status for that flight
 *   3. Logs EVERYTHING: URL scraped, tail United shows, aircraft type,
 *      raw WiFi text, parsed provider, our DB's current state
 *   4. Writes results to tmp/verify-tails-YYYY-MM-DD.json
 *
 * Designed to be the ground-truth oracle when a user spot-checks tails
 * against United.com directly and finds discrepancies with our site.
 */

import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { FlightRadar24API } from "../api/flightradar24-api";
import { getShipToTailMap } from "../database/database";
import { DB_PATH, normalizeFlightNumber } from "../utils/constants";
import { checkStarlinkStatusSubprocess } from "./united-starlink-checker-subprocess";

// The subprocess mutex's .finally() chain can leak an unhandled rejection when
// the child exits non-zero. Swallow it so one failed scrape doesn't kill the
// whole batch — our per-tail try/catch already records the error.
process.on("unhandledRejection", () => {});

type VerifyResult = {
  tail: string;
  // DB state before check
  db: {
    status: string | null;
    verified_wifi: string | null;
    last_obs: string | null;
    last_obs_date: string | null;
  };
  // Flight we picked to verify
  flight: {
    number: string;
    date: string;
    origin: string;
    dest: string;
  } | null;
  // What United.com showed
  scrape:
    | {
        url: string;
        tail_shown: string | null;
        aircraft_shown: string | null;
        has_starlink: boolean;
        provider: string | null;
        tail_match: boolean;
      }
    | { error: string };
  // Our verdict vs user's claim
  verdict: "STARLINK" | "NOT_STARLINK" | "MISMATCH" | "ERROR" | "NO_FLIGHT";
};

const log = (msg: string) => {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
};

async function verifyTail(
  db: Database,
  tail: string,
  maxAttempts = 1,
  retryDelayMs = 2000
): Promise<VerifyResult> {
  log(`━━━ ${tail} ━━━`);

  // 1. DB state
  const dbRow = db
    .query("SELECT starlink_status, verified_wifi FROM united_fleet WHERE tail_number = ?")
    .get(tail) as { starlink_status: string; verified_wifi: string | null } | null;

  const lastObs = db
    .query(
      `SELECT wifi_provider, datetime(checked_at,'unixepoch') as dt
       FROM starlink_verification_log
       WHERE tail_number = ? AND error IS NULL
       ORDER BY checked_at DESC LIMIT 1`
    )
    .get(tail) as { wifi_provider: string; dt: string } | null;

  const dbState = {
    status: dbRow?.starlink_status ?? null,
    verified_wifi: dbRow?.verified_wifi ?? null,
    last_obs: lastObs?.wifi_provider ?? null,
    last_obs_date: lastObs?.dt ?? null,
  };
  log(
    `  DB: status=${dbState.status} wifi=${dbState.verified_wifi} ` +
      `last_obs=${dbState.last_obs}@${dbState.last_obs_date}`
  );

  // 2. Gather upcoming flights — DB first, then FR24 for freshness/fallback
  type FlightCand = {
    flight_number: string;
    departure_airport: string;
    arrival_airport: string;
    fdate: string;
  };
  const dbFlights = db
    .query(
      `SELECT flight_number, departure_airport, arrival_airport,
              date(departure_time,'unixepoch') as fdate
       FROM upcoming_flights
       WHERE tail_number = ? AND departure_time >= strftime('%s','now')
       ORDER BY departure_time LIMIT ?`
    )
    .all(tail, maxAttempts) as FlightCand[];

  const candidates = dbFlights;
  if (candidates.length < maxAttempts) {
    log(`  ${candidates.length} DB flights, fetching FR24 for more...`);
    const fr24 = new FlightRadar24API();
    const upcoming = await fr24.getUpcomingFlights(tail);
    const seen = new Set(candidates.map((c) => c.flight_number + c.fdate));
    for (const u of upcoming) {
      const fdate = new Date(u.departure_time * 1000).toISOString().slice(0, 10);
      const key = u.flight_number + fdate;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        flight_number: u.flight_number,
        departure_airport: u.departure_airport,
        arrival_airport: u.arrival_airport,
        fdate,
      });
      if (candidates.length >= maxAttempts) break;
    }
  }

  if (candidates.length === 0) {
    log("  ✗ no upcoming flight (DB + FR24) — cannot verify");
    return {
      tail,
      db: dbState,
      flight: null,
      scrape: { error: "no upcoming flight" },
      verdict: "NO_FLIGHT",
    };
  }

  // 3. Try each candidate until tail matches (express swaps ~60% of the time)
  let lastMismatch: VerifyResult | null = null;
  for (let i = 0; i < candidates.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, retryDelayMs));
    const flight = candidates[i];
    const uaNum = normalizeFlightNumber(flight.flight_number).replace(/^UA/, "");
    const f = {
      number: uaNum,
      date: flight.fdate,
      origin: flight.departure_airport,
      dest: flight.arrival_airport,
    };
    log(
      `  [${i + 1}/${candidates.length}] ${flight.flight_number} (UA${uaNum}) ${f.origin}→${f.dest} ${f.date}`
    );

    const url = `https://www.united.com/en/us/flightstatus/details/${uaNum}/${f.date}/${f.origin}/${f.dest}`;

    let result: Awaited<ReturnType<typeof checkStarlinkStatusSubprocess>>;
    try {
      result = await checkStarlinkStatusSubprocess(f.number, f.date, f.origin, f.dest);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`    ✗ scrape failed: ${msg}`);
      continue;
    }

    // Mainline pages show ship numbers. Resolve via lookup.
    let resolvedTail = result.tailNumber;
    if (!resolvedTail && result.shipNumber) {
      const shipMap = getShipToTailMap(db);
      resolvedTail = shipMap.get(result.shipNumber) ?? null;
      if (resolvedTail) {
        log(`    resolved ship #${result.shipNumber} → ${resolvedTail}`);
      }
    }

    const tailMatch = resolvedTail?.toUpperCase() === tail.toUpperCase();
    log(
      `    tail=${resolvedTail ?? "?"} ${tailMatch ? "✓" : "✗"} · ` +
        `wifi=${result.wifiProvider ?? "?"} · starlink=${result.hasStarlink ? "YES" : "no"}`
    );

    const verdict = !tailMatch ? "MISMATCH" : result.hasStarlink ? "STARLINK" : "NOT_STARLINK";
    const res: VerifyResult = {
      tail,
      db: dbState,
      flight: f,
      scrape: {
        url,
        tail_shown: resolvedTail,
        aircraft_shown: result.aircraftType,
        has_starlink: result.hasStarlink,
        provider: result.wifiProvider ?? null,
        tail_match: tailMatch,
      },
      verdict,
    };

    if (tailMatch) return res;
    lastMismatch = res;
  }

  log(`  ✗ all ${candidates.length} attempts swapped/failed`);
  return (
    lastMismatch ?? {
      tail,
      db: dbState,
      flight: null,
      scrape: { error: "all attempts failed" },
      verdict: "ERROR",
    }
  );
}

async function main() {
  const args = process.argv.slice(2);
  const delayMs = Number(args.find((a) => a.startsWith("--delay="))?.split("=")[1] ?? 2000);
  const maxAttempts = Number(
    args.find((a) => a.startsWith("--retry-on-swap="))?.split("=")[1] ?? 1
  );
  const fileArg = args.find((a) => a.startsWith("--file="))?.split("=")[1];

  let tails: string[];
  if (fileArg) {
    tails = (await Bun.file(fileArg).text())
      .split(/\s+/)
      .filter((t) => /^N[0-9A-Z]{2,5}$/i.test(t));
  } else {
    tails = args.filter((a) => /^N[0-9A-Z]{2,5}$/i.test(a));
  }

  if (tails.length === 0) {
    console.error(
      "Usage: bun run verify-tails N550GJ N549GJ ... [--delay=2000] [--retry-on-swap=5]"
    );
    process.exit(1);
  }

  log(
    `Verifying ${tails.length} tails · ${delayMs}ms between tails · up to ${maxAttempts} flights/tail`
  );
  const db = new Database(DB_PATH, { readonly: true });
  const results: VerifyResult[] = [];

  for (let i = 0; i < tails.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, delayMs));
    results.push(await verifyTail(db, tails[i].toUpperCase(), maxAttempts, delayMs));
  }

  // Summary table
  console.log("\n━━━ SUMMARY ━━━");
  console.log("Tail      DB status  DB last_obs   Scrape     Verdict");
  console.log("────────  ─────────  ────────────  ─────────  ─────────");
  for (const r of results) {
    const scrape =
      "error" in r.scrape
        ? "ERROR"
        : r.scrape.has_starlink
          ? "Starlink"
          : r.scrape.provider || "None";
    console.log(
      `${r.tail.padEnd(8)}  ${(r.db.status || "-").padEnd(9)}  ` +
        `${(r.db.last_obs || "-").padEnd(12)}  ${scrape.padEnd(9)}  ${r.verdict}`
    );
  }

  // Write JSON
  const date = new Date().toISOString().slice(0, 10);
  const outPath = `tmp/verify-tails-${date}.json`;
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nFull results → ${outPath}`);

  db.close();
}

main();
