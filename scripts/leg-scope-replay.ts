#!/usr/bin/env bun
/**
 * Leg-scope replay (dev-only). Replays check-flight against a COPY of a
 * production snapshot, with the clock frozen at the snapshot's last write and
 * FR24 stubbed, to measure what origin/destination scoping changes.
 *
 *   --mode noparam    raw no-param bodies for every fn-day on every surface,
 *                     one TSV line each, to diff across commits (--out file)
 *   --mode diff       compare two noparam dumps (--a, --b); with --base-tz
 *                     (an older airport-tz.ts) checks every differing fn-day
 *                     departs an airport that file left unmapped
 *   --mode scoped     every row-backed leg of a multi-leg fn-day, unscoped vs
 *                     scoped: fixes, regressions, leakage of other legs' tails
 *   --mode fr24count  legs in the snapshot's -24h..+3d window: FR24 fetches
 *                     per fn-day card, unscoped vs scoped
 *   --mode adsb       supporting only: scoped vs unscoped firm answers scored
 *                     against ADS-B-observed recent legs (--truth legs.json)
 *
 * Refuses a DB inside a checkout: a production snapshot in the repo root
 * silently switches the test suite onto production data.
 */

import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { AIRLINES } from "../src/airlines/registry";
import { setAssignmentFetcher } from "../src/api/flight-verdict";
import { createApp } from "../src/server/app";
import { AIRPORT_TZ, airportLocalDate } from "../src/utils/airport-tz";

const { values: args } = parseArgs({
  options: {
    db: { type: "string" },
    mode: { type: "string" },
    out: { type: "string" },
    a: { type: "string" },
    b: { type: "string" },
    "base-tz": { type: "string" },
    truth: { type: "string" },
  },
});

const HOST: Record<string, string> = {
  UA: "unitedstarlinktracker.com",
  AS: "alaskastarlinktracker.com",
  HA: "hawaiianstarlinktracker.com",
  QR: "qatarstarlinktracker.com",
};
const HUB = "airlinestarlinktracker.com";

function refuseCheckoutPath(path: string): string {
  const abs = resolve(path);
  const checkout = resolve(import.meta.dir, "..");
  const mainRepo = checkout.split("/.claude/worktrees/")[0];
  for (const root of [checkout, mainRepo]) {
    if (abs.startsWith(`${root}/`)) {
      throw new Error(`refusing ${abs}: inside checkout ${root} — copy it to a scratch dir`);
    }
  }
  return abs;
}

type Row = {
  airline: string;
  fn: string;
  dep: string | null;
  arr: string | null;
  t: number;
  tail: string;
  equipped: number;
  lu: number;
};

function marketingNumber(airline: string, raw: string): string | null {
  const cfg = AIRLINES[airline];
  if (!cfg) return null;
  for (const prefix of [cfg.iata, ...cfg.carrierPrefixes]) {
    const m = raw.match(new RegExp(`^${prefix}0*(\\d{1,4})$`));
    if (m) return `${cfg.iata}${m[1]}`;
  }
  return null;
}

const utcDate = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);
const localDate = (airport: string | null, sec: number) =>
  airportLocalDate(airport ?? "", sec) ?? utcDate(sec);

function loadRows(db: Database, joinStarlink: boolean): Row[] {
  // Same classification the engine applies (settled negative, then a non-
  // Starlink verified_wifi) — only used for counts and the fixture of legs.
  const sql = joinStarlink
    ? `SELECT uf.airline, uf.flight_number AS fn, uf.departure_airport AS dep, uf.arrival_airport AS arr,
              uf.departure_time AS t, uf.tail_number AS tail, uf.last_updated AS lu,
              CASE WHEN neg.tail_number IS NOT NULL THEN 0
                   WHEN sp.verified_wifi IS NOT NULL AND sp.verified_wifi != 'Starlink' THEN 0
                   ELSE 1 END AS equipped
         FROM upcoming_flights uf
         JOIN starlink_planes sp ON sp.TailNumber = uf.tail_number
         LEFT JOIN united_fleet neg ON neg.tail_number = uf.tail_number AND neg.starlink_status = 'negative'
        ORDER BY uf.last_updated DESC`
    : `SELECT airline, flight_number AS fn, departure_airport AS dep, arrival_airport AS arr,
              departure_time AS t, tail_number AS tail, last_updated AS lu, 0 AS equipped
         FROM upcoming_flights ORDER BY last_updated DESC`;
  return db.query(sql).all() as Row[];
}

/** fn-day → deduped rows, keyed like the engine (marketing number, local date). */
function groupFnDays(rows: Row[]): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  const seen = new Map<string, Set<number>>();
  for (const r of rows) {
    if (r.airline === "QR") continue;
    const fn = marketingNumber(r.airline, r.fn);
    if (!fn) continue;
    const key = `${r.airline}|${fn}|${localDate(r.dep, r.t)}`;
    const times = seen.get(key) ?? seen.set(key, new Set()).get(key)!;
    if (times.has(r.t)) continue;
    times.add(r.t);
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }
  return groups;
}

function multiLegStats(groups: Map<string, Row[]>) {
  const out: Record<string, { fnDays: number; legs: number }> = {};
  for (const [key, rs] of groups) {
    const origins = new Set(rs.map((r) => r.dep));
    if (origins.size < 2) continue;
    const airline = key.split("|")[0];
    out[airline] ??= { fnDays: 0, legs: 0 };
    out[airline].fnDays++;
    out[airline].legs += origins.size;
  }
  return out;
}

const dbPath = args.mode === "diff" && !args.db ? null : refuseCheckoutPath(args.db ?? "");
const db = dbPath ? new Database(dbPath, { readonly: true }) : null;
const snapshotNow = db
  ? (db.query("SELECT MAX(last_updated) AS t FROM upcoming_flights").get() as { t: number }).t
  : 0;
if (db) {
  const frozen = snapshotNow * 1000;
  Date.now = () => frozen;
}

let fetches = 0;
const emptyFetcher = () => {
  fetches++;
  return Promise.resolve([]);
};

// A fresh client IP per request: the per-IP API limiter never refills under a
// frozen clock.
let requestSeq = 0;
async function body(app: ReturnType<typeof createApp>, host: string, path: string) {
  const n = requestSeq++;
  const ip = `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
  const r = await app.dispatch(
    new Request(`http://x${path}`, { headers: { Host: host, "cf-connecting-ip": ip } })
  );
  return { status: r.status, text: await r.text() };
}

async function noparam(): Promise<void> {
  const app = createApp(db!);
  const keys = new Set<string>();
  for (const r of loadRows(db!, false)) {
    // HA rows carry AS numbers since the merger; ask the carrier that owns the number.
    const owner = [r.airline, ...Object.keys(HOST)].find((a) => marketingNumber(a, r.fn));
    if (!owner) continue;
    const fn = marketingNumber(owner, r.fn);
    // Map-independent date set, so dumps from commits with different tz maps
    // enumerate the same requests.
    for (const d of [utcDate(r.t - 12 * 3600), utcDate(r.t), utcDate(r.t + 14 * 3600)]) {
      keys.add(`${owner}|${fn}|${d}`);
    }
  }
  for (const q of db!
    .query("SELECT DISTINCT flight_number AS fn, departure_time AS t FROM qatar_schedule")
    .all() as { fn: string; t: number | null }[]) {
    if (q.t) keys.add(`QR|${q.fn}|${utcDate(q.t)}`);
  }
  const lines: string[] = [];
  for (const key of [...keys].sort()) {
    const [airline, fn, date] = key.split("|");
    const qs = `flight_number=${fn}&date=${date}`;
    const surfaces: [string, string, string][] = [[airline, HOST[airline], "/api/check-flight"]];
    if (AIRLINES[airline].publicInHub) {
      surfaces.push(["hub", HUB, "/api/check-flight"], ["hub-any", HUB, "/api/check-any-flight"]);
    }
    for (const [name, host, path] of surfaces) {
      // Fresh FR24 cache + guards per request: every body is independent of
      // request order, so two dumps diff only where the code differs.
      setAssignmentFetcher(emptyFetcher);
      const r = await body(app, host, `${path}?${qs}`);
      lines.push(`${name}\t${fn}\t${date}\t${r.status}\t${r.text}`);
    }
  }
  writeFileSync(args.out ?? "/dev/stdout", `${lines.join("\n")}\n`);
  console.error(`noparam: ${keys.size} fn-days, ${lines.length} bodies`);
}

async function diff(): Promise<void> {
  const read = async (p: string) => {
    const m = new Map<string, string>();
    for (const line of (await Bun.file(p).text()).split("\n")) {
      if (!line) continue;
      const [s, fn, date, ...rest] = line.split("\t");
      m.set(`${s}\t${fn}\t${date}`, rest.join("\t"));
    }
    return m;
  };
  const a = await read(args.a!);
  const b = await read(args.b!);
  const differing = [...a.keys()].filter((k) => a.get(k) !== b.get(k));
  const onlyOne = [...b.keys()].filter((k) => !a.has(k)).length;
  console.log(
    `bodies: ${a.size} vs ${b.size}; differing: ${differing.length}; unmatched keys: ${onlyOne}`
  );
  if (!args["base-tz"] || differing.length === 0) return;
  const base = (await import(resolve(args["base-tz"]))).AIRPORT_TZ as Record<string, string>;
  const newlyMapped = new Set(Object.keys(AIRPORT_TZ).filter((k) => !base[k]));
  const byFn = new Map<string, Row[]>();
  for (const r of loadRows(db!, false)) {
    const fn = marketingNumber(r.airline, r.fn);
    if (fn) (byFn.get(fn) ?? byFn.set(fn, []).get(fn)!).push(r);
  }
  const qrDeps = new Map<string, string[]>();
  for (const q of db!
    .query("SELECT flight_number AS fn, departure_airport AS dep FROM qatar_schedule")
    .all() as { fn: string; dep: string | null }[]) {
    (qrDeps.get(q.fn) ?? qrDeps.set(q.fn, []).get(q.fn)!).push(q.dep ?? "");
  }
  const unexplained: string[] = [];
  const fnDays = new Set<string>();
  for (const k of differing) {
    const [, fn, date] = k.split("\t");
    fnDays.add(`${fn} ${date}`);
    const deps = [
      ...(byFn.get(fn) ?? [])
        .filter((r) => Math.abs(r.t - Date.parse(`${date}T12:00:00Z`) / 1000) < 2 * 86400)
        .map((r) => r.dep ?? ""),
      ...(qrDeps.get(fn) ?? []),
    ];
    if (!deps.some((d) => newlyMapped.has(d.toUpperCase()))) unexplained.push(k);
  }
  console.log(
    `differing fn-days: ${fnDays.size}; not explained by a newly mapped airport: ${unexplained.length}`
  );
  for (const k of unexplained.slice(0, 20)) console.log(`  ${k}`);
  for (const f of [...fnDays].sort().slice(0, 40)) console.log(`  ${f}`);
}

type Tri = boolean | null;

async function scoped(): Promise<void> {
  const app = createApp(db!);
  const joined = groupFnDays(loadRows(db!, true));
  console.log("multi-origin fn-days (starlink_planes JOIN):", multiLegStats(joined));
  console.log(
    "multi-origin fn-days (all rows, no JOIN):",
    multiLegStats(groupFnDays(loadRows(db!, false)))
  );

  const tally: Record<string, number> = {};
  const bump = (k: string) => {
    tally[k] = (tally[k] ?? 0) + 1;
  };
  const fixes: string[] = [];
  const regressions: string[] = [];
  let scopedAnswersWithLegs = 0;
  let scopedAnswersOnOrigin = 0;
  let unscopedYes = 0;
  let unscopedYesLeaky = 0;
  for (const [key, rows] of joined) {
    const origins = [...new Set(rows.map((r) => r.dep))];
    if (origins.length < 2) continue;
    const [airline, fn, date] = key.split("|");
    const host = HOST[airline];
    const qs = `flight_number=${fn}&date=${date}`;
    setAssignmentFetcher(emptyFetcher);
    const un = JSON.parse((await body(app, host, `/api/check-flight?${qs}`)).text);
    for (const origin of origins) {
      const own = rows.filter((r) => r.dep === origin);
      const destination = own[0].arr;
      setAssignmentFetcher(emptyFetcher);
      const sc = JSON.parse(
        (
          await body(
            app,
            host,
            `/api/check-flight?${qs}&origin=${origin}&destination=${destination ?? ""}`
          )
        ).text
      );
      const ownFirm: Tri = own.some((r) => r.equipped === 1);
      const from = un.hasStarlink as Tri;
      const to = sc.hasStarlink as Tri;
      bump(`${airline} match:${sc.leg?.match}${sc.leg?.reason ? `/${sc.leg.reason}` : ""}`);
      bump(`${airline} ${String(from)}->${String(to)}`);
      if (from === true && to === false) {
        fixes.push(`${fn} ${date} ${origin}-${destination} on ${own.map((r) => r.tail).join("/")}`);
      }
      if ((from === false && to === true) || to !== ownFirm) {
        regressions.push(
          `${fn} ${date} ${origin}-${destination} un=${from} sc=${to} own=${ownFirm}`
        );
      }
      const departures = [
        ...(sc.flights ?? []).map((f: { departure_airport: string }) => f.departure_airport),
        ...(sc.fallback?.segments ?? []).map((s: { origin: string }) => s.origin),
      ];
      if (departures.length > 0) {
        scopedAnswersWithLegs++;
        if (departures.every((d: string) => d === origin)) scopedAnswersOnOrigin++;
      }
      if (airline === "UA" && from === true) {
        unscopedYes++;
        const unDeps = (un.flights ?? []).map(
          (f: { departure_airport: string }) => f.departure_airport
        );
        if (unDeps.some((d: string) => d !== origin)) unscopedYesLeaky++;
      }
    }
  }
  console.log("tally:", tally);
  console.log(`yes→firm-no fixes: ${fixes.length}`);
  for (const f of fixes) console.log(`  ${f}`);
  console.log(`regressions (no→yes, or scoped ≠ the leg's own firm row): ${regressions.length}`);
  for (const r of regressions.slice(0, 20)) console.log(`  ${r}`);
  console.log(
    `scoped answers whose flights/segments all depart the requested origin: ${scopedAnswersOnOrigin}/${scopedAnswersWithLegs}`
  );
  console.log(
    `UA unscoped yes answers that include another leg's tail: ${unscopedYesLeaky}/${unscopedYes}`
  );
}

async function fr24count(): Promise<void> {
  const app = createApp(db!);
  const groups = groupFnDays(loadRows(db!, true));
  const lo = snapshotNow - 86400;
  const hi = snapshotNow + 3 * 86400;
  // Legs we hold no row for still get asked about by a TIM card: take the
  // number's recently flown routes as the card's other legs.
  const routeOrigins = new Map<string, Set<string>>();
  for (const r of db!
    .query(
      "SELECT flight_number AS fn, origin FROM flight_routes WHERE last_seen_at >= ? AND seen_count >= 10"
    )
    .all(snapshotNow - 3 * 86400) as { fn: string; origin: string }[]) {
    (routeOrigins.get(r.fn) ?? routeOrigins.set(r.fn, new Set()).get(r.fn)!).add(r.origin);
  }
  const t = {
    cards: 0,
    rowLegs: 0,
    routeOnlyLegs: 0,
    legsNowReachingFr24: 0,
    fr24FetchesUnscoped: 0,
    fr24FetchesScoped: 0,
    legsServedFromSharedCache: 0,
  };
  for (const [key, rows] of groups) {
    const [airline, fn, date] = key.split("|");
    if (airline !== "UA" || !rows.some((r) => r.t >= lo && r.t <= hi)) continue;
    const rowOrigins = new Set(rows.map((r) => r.dep ?? ""));
    const origins = new Set([...rowOrigins, ...(routeOrigins.get(fn) ?? [])]);
    if (origins.size < 2) continue;
    t.cards++;
    const qs = `flight_number=${fn}&date=${date}`;
    // One card = one session: before scoping, the extension asked once per number.
    setAssignmentFetcher(emptyFetcher);
    fetches = 0;
    await body(app, HOST.UA, `/api/check-flight?${qs}`);
    t.fr24FetchesUnscoped += fetches;
    setAssignmentFetcher(emptyFetcher);
    fetches = 0;
    const anyEquipped = rows.some((r) => r.equipped);
    for (const origin of origins) {
      if (rowOrigins.has(origin)) t.rowLegs++;
      else t.routeOnlyLegs++;
      const ownEquipped = rows.some((r) => r.dep === origin && r.equipped);
      if (anyEquipped && !ownEquipped) t.legsNowReachingFr24++;
      const f0 = fetches;
      await body(app, HOST.UA, `/api/check-flight?${qs}&origin=${origin}`);
      if (!ownEquipped && fetches === f0) t.legsServedFromSharedCache++;
    }
    t.fr24FetchesScoped += fetches;
  }
  const extra = t.fr24FetchesScoped - t.fr24FetchesUnscoped;
  const capacity = 15 * 60 * 24;
  console.log({
    window: [new Date(lo * 1000).toISOString(), new Date(hi * 1000).toISOString()],
    ...t,
    extraFetchesPerCardSweep: extra,
    extraPerSnapshotDay: +(extra / 4).toFixed(1),
    bucketDailyCapacity: capacity,
    extraShareOfCapacity: `${((extra / 4 / capacity) * 100).toFixed(3)}%`,
    note: "each multi-leg card looked up once, legs sequentially; FR24 stubbed empty, so legs within 6h of departure re-poll (worst case)",
  });
}

async function adsb(): Promise<void> {
  // Supporting evidence only: these are DEPARTED legs (ADS-B truth), not the
  // future Google Flights population the scoping serves.
  const truth = (await Bun.file(args.truth!).json()) as {
    fn: string;
    date: string;
    origin: string;
    tail: string;
    starlink: 0 | 1;
    dep: number;
    airline: string;
  }[];
  const app = createApp(db!);
  const recent = truth.filter(
    (l) => l.airline === "UA" && l.dep >= snapshotNow - 6 * 3600 && l.dep <= snapshotNow - 600
  );
  const score = { legs: 0, unWrong: 0, scWrong: 0, unFirm: 0, scFirm: 0 };
  const wrong: string[] = [];
  for (const l of recent) {
    const qs = `flight_number=${l.fn}&date=${l.date}`;
    setAssignmentFetcher(emptyFetcher);
    const un = JSON.parse((await body(app, HOST.UA, `/api/check-flight?${qs}`)).text);
    setAssignmentFetcher(emptyFetcher);
    const sc = JSON.parse(
      (await body(app, HOST.UA, `/api/check-flight?${qs}&origin=${l.origin}`)).text
    );
    score.legs++;
    const yes = l.starlink === 1;
    if (typeof un.hasStarlink === "boolean") {
      score.unFirm++;
      if (un.hasStarlink !== yes) score.unWrong++;
    }
    if (typeof sc.hasStarlink === "boolean") {
      score.scFirm++;
      if (sc.hasStarlink !== yes) {
        score.scWrong++;
        wrong.push(
          `${l.fn} ${l.origin} observed ${l.tail} (${l.starlink}) answered ${sc.hasStarlink}`
        );
      }
    }
  }
  console.log(score);
  for (const w of wrong) console.log(`  ${w}`);
}

const MODES: Record<string, () => Promise<void>> = { noparam, diff, scoped, fr24count, adsb };
const run = MODES[args.mode ?? ""];
if (!run) {
  console.error(`--mode must be one of ${Object.keys(MODES).join("|")}`);
  process.exit(2);
}
if (!db && args.mode !== "diff") {
  console.error("--db <snapshot copy> is required");
  process.exit(2);
}
await run();
setAssignmentFetcher(null);
