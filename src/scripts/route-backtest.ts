/**
 * Daily replay of the rollout outlook's route months against the routes' own
 * departures (src/database/outlook.ts routeBacktests), logged and gauged so
 * the error a route page would carry can be read from production without
 * database access. Nothing here reaches a page.
 *
 * One log line per route and draw source, e.g.
 *   route-backtest UA SFO-SIN source=placed months=2026-09:0/41(0%)* … types=B787:100%
 *     checks=2026-10:proj 1% act 2% n=58 mae=1.0pt
 * (* = month not complete: still filling, or older than the draws we keep).
 */

import type { Database } from "bun:sqlite";
import {
  ROUTE_BACKTEST_SAMPLE,
  type RouteBacktest,
  type RouteDrawSource,
  routeBacktests,
} from "../database/outlook";
import { unixNow } from "../database/sql/windows";
import { GAUGES, metrics, normalizeAirlineTag } from "../observability/metrics";
import { type JobHandle, type JobStampStore, startJob } from "../utils/job-runner";
import { info } from "../utils/logger";

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function formatRouteBacktest(airline: string, b: RouteBacktest): string {
  const months = b.months
    .map((m) => `${m.month}:${m.starlink}/${m.departures}(${pct(m.share)})${m.complete ? "" : "*"}`)
    .join(" ");
  const types = b.types.map((t) => `${t.family}:${pct(t.share)}`).join(",") || "none";
  const checks =
    b.checks
      .map((c) => `${c.month}:proj ${pct(c.projected)} act ${pct(c.actual)} n=${c.departures}`)
      .join("; ") || "none";
  const mae = b.meanAbsErrorPoints === null ? "–" : `${b.meanAbsErrorPoints.toFixed(1)}pt`;
  return `route-backtest ${airline} ${b.origin}-${b.destination} source=${b.source} months=${months} types=${types} checks=${checks} mae=${mae}`;
}

export interface RouteBacktestRun {
  results: RouteBacktest[];
  /** Per draw source, over every check of every sampled route. */
  pooled: Record<RouteDrawSource, { checks: number; meanAbsErrorPoints: number | null }>;
}

export function runRouteBacktest(
  db: Database,
  airline = "UA",
  now = unixNow(),
  routes = ROUTE_BACKTEST_SAMPLE
): RouteBacktestRun {
  const results = routes.flatMap(([o, d]) => routeBacktests(db, airline, o, d, now));
  const pool = (source: RouteDrawSource) => {
    const checks = results.filter((r) => r.source === source).flatMap((r) => r.checks);
    return {
      checks: checks.length,
      meanAbsErrorPoints: checks.length
        ? (checks.reduce((s, c) => s + Math.abs(c.projected - c.actual), 0) / checks.length) * 100
        : null,
    };
  };
  const pooled = { numbers: pool("numbers"), placed: pool("placed") };

  for (const r of results) info(formatRouteBacktest(airline, r));
  const tag = normalizeAirlineTag(airline);
  for (const source of ["numbers", "placed"] as const) {
    const p = pooled[source];
    metrics.gauge(GAUGES.OUTLOOK_ROUTE_BACKTEST_CHECKS, p.checks, { airline: tag, source });
    if (p.meanAbsErrorPoints !== null)
      metrics.gauge(GAUGES.OUTLOOK_ROUTE_BACKTEST_ERROR_POINTS, p.meanAbsErrorPoints, {
        airline: tag,
        source,
      });
  }
  return { results, pooled };
}

export function startRouteBacktestJob(db: Database, stamps: JobStampStore): JobHandle {
  return startJob({
    name: "route_outlook_backtest",
    stamps,
    intervalMs: 24 * 3600 * 1000,
    initialDelayMs: 20 * 60 * 1000,
    run: () => {
      runRouteBacktest(db);
    },
  });
}
