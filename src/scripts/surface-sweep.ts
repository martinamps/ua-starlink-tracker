#!/usr/bin/env bun
/**
 * Surface-contradiction sweep.
 *
 * Four code paths answer "does tail X have Starlink?" from different storage:
 *   A  starlink_planes.verified_wifi   → /api/data, /api/check-flight primary, MCP, homepage
 *   B  united_fleet.verified_wifi      → /fleet page
 *   C  united_fleet.starlink_status    → /api/check-flight FR24-fallback (tail ∉ starlink_planes)
 *   D  computeWifiConsensus(log)       → /api/check-flight FR24-fallback (tail ∈ starlink_planes)
 *
 * Any two non-unknown verdicts that disagree = a user-visible contradiction
 * across surfaces. This sweep finds them; reconcileConsensus is what heals them.
 *
 *   bun run surface-sweep                  # list offenders + counts
 *   bun run surface-sweep -- --emit        # also emit gauges
 */

import { Database } from "bun:sqlite";
import { computeWifiConsensus } from "../database/database";
import { metrics } from "../observability/metrics";
import { info } from "../utils/logger";

type Verdict = "starlink" | "not-starlink" | "unknown";

const VECTORS = ["A_B", "A_C", "A_D", "B_C", "B_D", "C_D"] as const;
type Vector = (typeof VECTORS)[number];

export interface TailContradiction {
  tail: string;
  A: Verdict;
  B: Verdict;
  C: Verdict;
  D: Verdict;
  vectors: Vector[];
}

export interface SweepResult {
  scanned: number;
  contradictions: TailContradiction[];
  byVector: Record<Vector, number>;
}

function fromWifi(v: string | null | undefined): Verdict {
  if (v == null || v === "") return "unknown";
  return /starlink/i.test(v) ? "starlink" : "not-starlink";
}

function fromStatus(v: string | null | undefined): Verdict {
  if (v === "confirmed") return "starlink";
  if (v === "negative") return "not-starlink";
  return "unknown";
}

function diff(a: Verdict, b: Verdict): boolean {
  return a !== "unknown" && b !== "unknown" && a !== b;
}

export function computeSurfaceContradictions(db: Database): SweepResult {
  const rows = db
    .query(`
      SELECT
        uf.tail_number AS tail,
        sp.verified_wifi AS sp_wifi,
        uf.verified_wifi AS uf_wifi,
        uf.starlink_status AS uf_status
      FROM united_fleet uf
      LEFT JOIN starlink_planes sp ON sp.TailNumber = uf.tail_number
    `)
    .all() as {
    tail: string;
    sp_wifi: string | null;
    uf_wifi: string | null;
    uf_status: string | null;
  }[];

  const byVector = Object.fromEntries(VECTORS.map((v) => [v, 0])) as Record<Vector, number>;
  const contradictions: TailContradiction[] = [];

  for (const r of rows) {
    const A = fromWifi(r.sp_wifi);
    const B = fromWifi(r.uf_wifi);
    const C = fromStatus(r.uf_status);
    const D = fromWifi(computeWifiConsensus(db, r.tail).verdict);

    const vectors: Vector[] = [];
    if (diff(A, B)) vectors.push("A_B");
    if (diff(A, C)) vectors.push("A_C");
    if (diff(A, D)) vectors.push("A_D");
    if (diff(B, C)) vectors.push("B_C");
    if (diff(B, D)) vectors.push("B_D");
    if (diff(C, D)) vectors.push("C_D");

    if (vectors.length > 0) {
      contradictions.push({ tail: r.tail, A, B, C, D, vectors });
      for (const v of vectors) byVector[v]++;
    }
  }

  return { scanned: rows.length, contradictions, byVector };
}

export function emitSweepGauges(r: SweepResult) {
  const base = { airline: "united" };
  metrics.gauge("surface_contradiction.total", r.contradictions.length, base);
  for (const v of VECTORS) {
    metrics.gauge("surface_contradiction.count", r.byVector[v], { ...base, vector: v });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dbPath =
    args.find((a) => a.startsWith("--db="))?.slice(5) ?? process.env.DB_PATH ?? "plane-data.sqlite";
  const emit = args.includes("--emit");

  const db = new Database(dbPath, { readonly: true });
  const r = computeSurfaceContradictions(db);
  db.close();

  console.log(`\n=== Surface-contradiction sweep · ${r.scanned} tails ===`);
  console.log(
    "  A=starlink_planes.verified_wifi  B=united_fleet.verified_wifi  C=united_fleet.starlink_status  D=consensus(log)"
  );
  console.log(`\n  by vector: ${VECTORS.map((v) => `${v}=${r.byVector[v]}`).join("  ")}`);
  console.log(`  total tails with ≥1 contradiction: ${r.contradictions.length}\n`);

  for (const c of r.contradictions.slice(0, 30)) {
    console.log(
      `  ${c.tail.padEnd(8)} A=${c.A.padEnd(12)} B=${c.B.padEnd(12)} C=${c.C.padEnd(12)} D=${c.D.padEnd(12)} [${c.vectors.join(",")}]`
    );
  }
  if (r.contradictions.length > 30) console.log(`  ... and ${r.contradictions.length - 30} more`);

  if (emit) {
    emitSweepGauges(r);
    info(`surface_contradiction gauges emitted: total=${r.contradictions.length}`);
  }
}
