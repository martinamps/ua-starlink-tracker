/**
 * Build a SQL patch for planes with verified_wifi IS NULL, using CONSENSUS
 * from the verification log instead of live scraping.
 *
 * Retrofits are common on mainline 737s (Viasat → Starlink mid-cycle), so we
 * use a RECENT window (last 14 days) with ≥2 observations and ≥70% agreement.
 * Planes without enough recent data stay NULL (will be picked up by the
 * background verifier eventually).
 *
 * Usage:
 *   bun run src/scripts/verified-wifi-patch.ts                  # preview
 *   bun run src/scripts/verified-wifi-patch.ts --apply-local    # apply to local test DB
 *   # then manually: sqlite3 prod.sqlite < patches/verified-wifi-YYYY-MM-DD.sql
 */

import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";

const TEST_DB = "/tmp/ua-test.sqlite";
const RECENT_DAYS = 30;
const MIN_OBS = 2;
const CONSENSUS_THRESHOLD = 0.7;

const db = new Database(TEST_DB, { readonly: true });
const now = Math.floor(Date.now() / 1000);
const cutoff = now - RECENT_DAYS * 86400;

// Planes needing a decision
const nullPlanes = db
  .query("SELECT TailNumber, Aircraft, fleet FROM starlink_planes WHERE verified_wifi IS NULL")
  .all() as Array<{ TailNumber: string; Aircraft: string; fleet: string }>;

type Decision = {
  tail: string;
  aircraft: string;
  fleet: string;
  recent_obs: number;
  starlink_obs: number;
  consensus_pct: number;
  most_common_provider: string | null;
  verdict: "Starlink" | string | null;
  reason: string;
};

const decisions: Decision[] = [];

for (const p of nullPlanes) {
  // Recent observations excluding errors (mismatches, timeouts)
  const obs = db
    .query(
      `SELECT has_starlink, wifi_provider, date(checked_at, 'unixepoch') as checked
       FROM starlink_verification_log
       WHERE tail_number = ? AND source = 'united'
         AND checked_at >= ?
         AND error IS NULL
         AND has_starlink IS NOT NULL
       ORDER BY checked_at DESC`
    )
    .all(p.TailNumber, cutoff) as Array<{
    has_starlink: number;
    wifi_provider: string | null;
    checked: string;
  }>;

  const n = obs.length;
  const starlinkObs = obs.filter((o) => o.has_starlink === 1).length;
  const consensusPct = n > 0 ? starlinkObs / n : 0;

  // Most common non-null provider (for negative consensus)
  const providers = obs.map((o) => o.wifi_provider).filter((p): p is string => p !== null);
  const providerCounts = new Map<string, number>();
  for (const pr of providers) providerCounts.set(pr, (providerCounts.get(pr) ?? 0) + 1);
  const mostCommon = [...providerCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  let verdict: string | null = null;
  let reason: string;

  if (n < MIN_OBS) {
    reason = `insufficient recent obs (${n} in last ${RECENT_DAYS}d, need ${MIN_OBS})`;
  } else if (consensusPct >= CONSENSUS_THRESHOLD) {
    verdict = "Starlink";
    reason = `${starlinkObs}/${n} recent obs Starlink (${(consensusPct * 100).toFixed(0)}%)`;
  } else if (1 - consensusPct >= CONSENSUS_THRESHOLD) {
    // Strong negative consensus. Use most-common provider if known, else 'None'.
    verdict = mostCommon ?? "None";
    reason = `${n - starlinkObs}/${n} recent obs NOT Starlink (${((1 - consensusPct) * 100).toFixed(0)}%)${mostCommon ? `, provider: ${mostCommon}` : ""}`;
  } else {
    reason = `ambiguous: ${starlinkObs}/${n} Starlink recently — likely mid-retrofit or data noise`;
  }

  decisions.push({
    tail: p.TailNumber,
    aircraft: p.Aircraft,
    fleet: p.fleet,
    recent_obs: n,
    starlink_obs: starlinkObs,
    consensus_pct: consensusPct,
    most_common_provider: mostCommon,
    verdict,
    reason,
  });
}

// Report
console.log(
  `\n=== Consensus-based verified_wifi patch (${RECENT_DAYS}-day window, ≥${MIN_OBS} obs, ≥${CONSENSUS_THRESHOLD * 100}% agreement) ===\n`
);
console.log("Tail        | Fleet    | Recent | Starlink | Verdict     | Reason");
console.log(
  "------------|----------|--------|----------|-------------|------------------------------"
);
for (const d of decisions) {
  const verdict = d.verdict ?? "—";
  console.log(
    `${d.tail.padEnd(11)} | ${d.fleet.padEnd(8)} | ${String(d.recent_obs).padStart(6)} | ${String(d.starlink_obs).padStart(8)} | ${verdict.padEnd(11)} | ${d.reason}`
  );
}

// Generate SQL patch
const updates = decisions.filter((d) => d.verdict !== null);
const dateStr = new Date().toISOString().slice(0, 10);
const sqlLines = [
  `-- verified_wifi consensus patch generated ${new Date().toISOString()}`,
  `-- ${RECENT_DAYS}-day window, ≥${MIN_OBS} obs, ≥${CONSENSUS_THRESHOLD * 100}% agreement`,
  `-- ${updates.length} planes updated, ${decisions.length - updates.length} left NULL (insufficient/ambiguous)`,
  "",
  "BEGIN TRANSACTION;",
  "",
  ...updates.map(
    (d) =>
      `UPDATE starlink_planes SET verified_wifi = '${d.verdict}', verified_at = ${now} WHERE TailNumber = '${d.tail}' AND verified_wifi IS NULL; -- ${d.reason}`
  ),
  "",
  "COMMIT;",
];

const patchPath = `patches/verified-wifi-${dateStr}.sql`;
mkdirSync("patches", { recursive: true });
writeFileSync(patchPath, `${sqlLines.join("\n")}\n`);

console.log(`\n=== SQL patch written to: ${patchPath} ===`);
console.log(`${updates.length} UPDATE statements\n`);

// Apply locally if requested
if (process.argv.includes("--apply-local")) {
  console.log(`Applying to ${TEST_DB}...`);
  const writeDb = new Database(TEST_DB);
  writeDb.exec(sqlLines.join("\n"));
  writeDb.close();

  // Verify
  const after = new Database(TEST_DB, { readonly: true });
  const remaining = after
    .query("SELECT COUNT(*) as n FROM starlink_planes WHERE verified_wifi IS NULL")
    .get() as { n: number };
  console.log(`Remaining NULL planes after patch: ${remaining.n}`);
  after.close();
} else {
  console.log("(preview only — run with --apply-local to apply to test DB)");
}
