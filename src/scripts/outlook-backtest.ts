#!/usr/bin/env bun
/**
 * Backtest of the rollout outlook (src/outlook/). Replays past days: project
 * each type's installs from what was dated then, compare with what followed.
 *
 *   bun run outlook-backtest                         # default DB (DB_PATH)
 *   bun run outlook-backtest -- --db=.test-snapshot.sqlite
 *   bun run outlook-backtest -- --csv=tails.csv --summary=fleet-summary.json
 *       # the public /data/starlink-tails.csv and /api/fleet-summary, for a
 *       # replay without database access (type figures only; no routes)
 *   --now=YYYY-MM-DD  --from=YYYY-MM-DD  --routes=SFO-SIN,ORD-LAX
 *
 * Prints markdown. reports/rollout-outlook.md is this output, read.
 */

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { normalizeAircraftType } from "../airlines/aircraft-families";
import { airlineOutlook, listingTimes, routeOutlookFor } from "../database/outlook";
import { programmeRoster } from "../database/roster";
import { DAY_SEC, unixNow } from "../database/sql/windows";
import {
  type BacktestSummary,
  type DatedInstall,
  backtestCases,
  backtestMixShare,
  backtestRouteMonths,
  cutoffs,
  summarize,
} from "../outlook/backtest";
import {
  FLEET,
  OUTLOOK_BACKTEST,
  PACE_WINDOWS_DAYS,
  PROJECTION_WINDOW_DAYS,
  type PaceWindowDays,
  type TypeOutlook,
  typeOutlook,
} from "../outlook/pace";
import { publishedTargets } from "../outlook/published";
import { isStarlinkDeparture, monthKeys } from "../outlook/route";
import { DB_PATH } from "../utils/constants";

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"] as const;
  })
);

const dayToUnix = (d: string) => Date.parse(`${d}T00:00:00Z`) / 1000;
const now = args.has("now") ? dayToUnix(args.get("now")!) : unixNow();
const from = dayToUnix(args.get("from") ?? "2026-03-01");
const HORIZONS = [30, 60, 90];

interface Inputs {
  installs: DatedInstall[];
  totals: Map<string, number>;
  /** Equipped today per family, as the source counts it. */
  equipped: Map<string, number>;
  db: Database | null;
}

function fromCsv(csvPath: string, summaryPath: string): Inputs {
  const lines = readFileSync(csvPath, "utf8").trim().split(/\r?\n/);
  const head = lines[0].split(",");
  const col = (name: string) => head.indexOf(name);
  const installs: DatedInstall[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",").map((c) => c.trim());
    const at = Date.parse(`${cells[col("DateFound")]}T00:00:00Z`) / 1000;
    if (!Number.isFinite(at)) continue;
    installs.push({ family: normalizeAircraftType(cells[col("Aircraft")]), installedAt: at });
  }
  const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as {
    airlines: Array<{
      code: string;
      installed: number;
      total: number;
      families: Array<{ family: string; installed: number; total: number }>;
    }>;
  };
  const ua = summary.airlines.find((a) => a.code === "UA")!;
  const totals = new Map<string, number>([[FLEET, ua.total]]);
  const equipped = new Map<string, number>([[FLEET, ua.installed]]);
  for (const f of ua.families) {
    totals.set(f.family, f.total);
    equipped.set(f.family, f.installed);
  }
  return { installs, totals, equipped, db: null };
}

function fromDb(path: string | undefined): Inputs {
  const db = new Database(path ?? DB_PATH, { readonly: true });
  const roster = programmeRoster(db, "UA");
  const listed = listingTimes(db, "UA");
  const installs: DatedInstall[] = [];
  const totals = new Map<string, number>([[FLEET, roster.length]]);
  const equipped = new Map<string, number>();
  for (const t of roster) {
    totals.set(t.family, (totals.get(t.family) ?? 0) + 1);
    if (t.equipped) {
      equipped.set(t.family, (equipped.get(t.family) ?? 0) + 1);
      equipped.set(FLEET, (equipped.get(FLEET) ?? 0) + 1);
    }
    const at = t.equipped ? listed.get(t.tail_number) : null;
    if (at != null) installs.push({ family: t.family, installedAt: at });
  }
  return { installs, totals, equipped, db };
}

const inputs = args.has("csv")
  ? fromCsv(args.get("csv")!, args.get("summary")!)
  : fromDb(args.get("db"));
const visible = inputs.installs.filter((i) => i.installedAt <= now);
// A type with no dated install has nothing to replay: it is "no pace" at every cutoff.
const replayed = new Set([FLEET, ...visible.map((i) => i.family)]);
const replayTotals = new Map([...inputs.totals].filter(([f]) => replayed.has(f)));

const pct = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)}%`);
const num = (x: number | null, d = 1) => (x === null ? "–" : x.toFixed(d));
const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

console.log(`# Outlook backtest, as of ${day(now)}\n`);
console.log(`Installs dated: ${visible.length}. Cutoffs every 15 days from ${day(from)}.\n`);

// 1. Which window projects best, fleet-wide and pooled over types.
const all: BacktestSummary[] = [];
for (const h of HORIZONS) {
  for (const w of PACE_WINDOWS_DAYS) {
    const cases = backtestCases({
      installs: visible,
      totals: replayTotals,
      cutoffs: cutoffs(from, now, h),
      horizonDays: h,
      windowDays: w,
    });
    all.push(...summarize(cases, OUTLOOK_BACKTEST.relativeError));
  }
}

console.log("## Which window\n");
console.log(
  "| horizon | window | fleet median error | fleet error per install | types pooled: error per install | types' cases without a rate |"
);
console.log("|---|---|---|---|---|---|");
for (const h of HORIZONS) {
  for (const w of PACE_WINDOWS_DAYS) {
    const rows = all.filter((s) => s.horizonDays === h && s.windowDays === w);
    const fleet = rows.find((s) => s.family === FLEET);
    const types = rows.filter((s) => s.family !== FLEET && s.medianRelError !== null);
    const cases = backtestCases({
      installs: visible,
      totals: new Map([...replayTotals].filter(([f]) => f !== FLEET)),
      cutoffs: cutoffs(from, now, h),
      horizonDays: h,
      windowDays: w,
    });
    const rated = cases.filter((c) => c.projected !== null);
    const pooled =
      rated.reduce((a, c) => a + Math.abs(c.projected! - c.actual), 0) /
      Math.max(
        1,
        rated.reduce((a, c) => a + c.actual, 0)
      );
    console.log(
      `| ${h} d | ${w} d | ${num(fleet?.medianAbsError ?? null)} tails | ${pct(fleet?.wape ?? null)} | ${pct(rated.length ? pooled : null)} | ${cases.length - rated.length} of ${cases.length} (types: ${types.length}) |`
    );
  }
}

const chosen = Number(args.get("window") ?? PROJECTION_WINDOW_DAYS) as PaceWindowDays;
for (const h of HORIZONS) {
  console.log(`\n## Per type, ${h}-day horizon, ${chosen}-day window\n`);
  console.log(
    "| type | cases | no pace | median error (tails) | error per install | bias (tails) | inside ±band |"
  );
  console.log("|---|---|---|---|---|---|---|");
  for (const s of all
    .filter((x) => x.horizonDays === h && x.windowDays === chosen)
    .sort((a, b) => (inputs.totals.get(b.family) ?? 0) - (inputs.totals.get(a.family) ?? 0))) {
    console.log(
      `| ${s.family} | ${s.cases} | ${s.noPace} | ${num(s.medianAbsError)} | ${pct(s.wape)} | ${num(s.bias)} | ${pct(s.bandHits)} |`
    );
  }
}

// 2. Routes as their type mix: single-type routes feel the type's error.
const MIXES: Record<string, Array<{ family: string; weight: number }>> = {
  "all 787": [{ family: "B787", weight: 1 }],
  "all 737 MAX 9": [{ family: "B737-MAX9", weight: 1 }],
  "all 737 MAX 8": [{ family: "B737-MAX8", weight: 1 }],
  "all 737-800": [{ family: "B737-800", weight: 1 }],
  "half MAX 9, half 757": [
    { family: "B737-MAX9", weight: 1 },
    { family: "B757", weight: 1 },
  ],
  "half A321, half 737-900": [
    { family: "A321", weight: 1 },
    { family: "B737-900", weight: 1 },
  ],
};
for (const h of [30, 60]) {
  console.log(`\n## Routes as a fixed type mix, ${h}-day horizon\n`);
  console.log("| mix | cases | median error (points) | worst (points) |");
  console.log("|---|---|---|---|");
  for (const [label, mix] of Object.entries(MIXES)) {
    const errs = cutoffs(from, now, h).map((c) => {
      const r = backtestMixShare({
        mix,
        installs: visible,
        totals: inputs.totals,
        cutoff: c,
        horizonDays: h,
        windowDays: chosen,
      });
      return Math.abs(r.projected - r.actual) * 100;
    });
    const s = [...errs].sort((a, b) => a - b);
    console.log(
      `| ${label} | ${s.length} | ${num(s[Math.floor(s.length / 2)] ?? null)} | ${num(s.at(-1) ?? null)} |`
    );
  }
}

// 3. Today's outlook, and real routes where the database has their departures.
const line = (t: TypeOutlook) =>
  `| ${t.family} | ${t.equipped} of ${t.total} | ${t.pace.map((p) => p.installs).join(" / ")} | ${t.trend} | ${t.status} | ${t.projection ? `${t.projection.earliest} to ${t.projection.latest ?? "open"} (likely ${t.projection.likely})` : "–"} | ${t.next60Days ? `${t.next60Days.low}–${t.next60Days.high} (likely ${t.next60Days.likely})` : "–"} | ${t.published.map((p) => `${p.label} (${p.deadline}): needs ${num(p.requiredPerMonth)}/month${p.onPace === null ? "" : p.onPace ? ", on pace" : ", behind"}`).join("; ") || "–"} |`;
const todayOutlook = (() => {
  if (inputs.db) return airlineOutlook(inputs.db, "UA", now);
  const build = (family: string) =>
    typeOutlook({
      family,
      equipped: inputs.equipped.get(family) ?? 0,
      total: inputs.totals.get(family) ?? 0,
      installedAt: visible
        .filter((i) => family === FLEET || i.family === family)
        .map((i) => i.installedAt),
      now,
      published: publishedTargets("UA", family),
      relativeError: family === FLEET ? OUTLOOK_BACKTEST.fleetRelativeError : undefined,
    });
  return {
    fleet: build(FLEET),
    families: [...inputs.totals.keys()].filter((f) => f !== FLEET).map(build),
  };
})();
console.log("\n## Today's outlook\n");
console.log(
  "| type | equipped | installs 30/60/90 d | trend | status | completion at pace (not stated) | next 60 days | published |"
);
console.log("|---|---|---|---|---|---|---|---|");
console.log(line(todayOutlook.fleet));
for (const t of todayOutlook.families) console.log(line(t));

if (inputs.db) {
  const db = inputs.db;
  const out = airlineOutlook(db, "UA", now);

  const routes = (args.get("routes") ?? "SFO-SIN,EWR-SFO,SFO-EWR,GUM-NRT,ORD-LAX,DEN-ORD").split(
    ","
  );
  console.log("\n## Routes from flight draws\n");
  for (const r of routes) {
    const [o, d] = r.split("-");
    const ro = routeOutlookFor(db, "UA", o, d, now, out);
    if (!ro) continue;
    console.log(
      `### ${o}-${d}: ${ro.direction}${ro.changePoints === null ? "" : ` (${num(ro.changePoints)} points)`}\n`
    );
    console.log(
      `Numbers: ${ro.flightNumbers.join(", ") || "none"}; left out as multi-pair: ${ro.excludedFlightNumbers.join(", ") || "none"}\n`
    );
    for (const m of ro.months)
      console.log(
        `- ${m.month}: ${m.starlink} of ${m.departures} (${pct(m.share)})${m.complete ? "" : ", month still filling"}`
      );
    for (const t of ro.types)
      console.log(
        `- ${t.family}: ${pct(t.share)} of departures; type ${t.outlook ? `${t.outlook.equipped} of ${t.outlook.total}` : "not in roster"}`
      );
    const departures = routeDepartures(db, ro.flightNumbers);
    const bt = backtestRouteMonths({
      departures,
      installs: visible,
      totals: inputs.totals,
      months: monthKeys(now, 4),
      windowDays: chosen,
      minDepartures: 20,
    });
    for (const b of bt)
      console.log(
        `- backtest ${b.month}: projected ${pct(b.projected)}, actual ${pct(b.actual)} (${b.departures} departures)`
      );
    console.log("");
  }
}

function routeDepartures(db: Database, flightNumbers: string[]) {
  if (flightNumbers.length === 0) return [];
  const roster = new Map(programmeRoster(db, "UA").map((t) => [t.tail_number, t]));
  const listed = listingTimes(db, "UA");
  const rows = db
    .query(
      `SELECT tail_number, first_seen FROM adsb_flight_draws
       WHERE first_seen >= ? AND flight_number IN (${flightNumbers.map(() => "?").join(",")})`
    )
    .all(now - 130 * DAY_SEC, ...flightNumbers) as Array<{
    tail_number: string;
    first_seen: number;
  }>;
  return rows.map((r) => {
    const t = roster.get(r.tail_number);
    return {
      departedAt: r.first_seen,
      family: t?.family ?? "unknown",
      starlink: isStarlinkDeparture({
        departedAt: r.first_seen,
        tail: r.tail_number,
        family: t?.family ?? "unknown",
        equippedSince: t?.equipped ? (listed.get(r.tail_number) ?? 0) : null,
      }),
    };
  });
}
