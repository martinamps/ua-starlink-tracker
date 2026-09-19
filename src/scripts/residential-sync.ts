#!/usr/bin/env bun
/**
 * Fetch sources that block the prod ASN (OVH) from a residential IP, then ship
 * the result to prod for ingest. One file, two modes:
 *
 *   bun run residential-sync             # preflight → fetch → ship → ingest → verify
 *   bun run residential-sync --dry-run   # preflight → fetch → print payload, no write
 *   ... --ingest                         # prod-side: stdin JSON → DB (invoked over ssh)
 *   ... --preflight                      # prod-side: print {qr,as} confirmed/total state
 *
 * Exit codes: 0 ok · 1 fetch failed · 2 validation refused · 3 ship/ingest failed · 4 post-verify failed
 *             5 partial: one source skipped, the other shipped
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { AIRLINES } from "../airlines/registry";
import { initializeDatabase, setMeta } from "../database/database";
import { info, error as logError, warn } from "../utils/logger";
import { applyAlaskaFlyertalkTails, fetchAlaskaFlyertalkTails } from "./flyertalk-alaska";
import { FlyertalkRedirectRejected } from "./flyertalk-common";
import { applyQatarFlyertalkTails, fetchQatarFlyertalkTails } from "./flyertalk-qatar";

const PROD_SSH = process.env.RESIDENTIAL_SYNC_HOST ?? "llc";
const CONTAINER = "$(sudo docker ps -q --filter name=c4wg48 | head -1)";
const REMOTE = (flag: string) =>
  `sudo docker exec -i ${CONTAINER} bun run /app/src/scripts/residential-sync.ts ${flag}`;

const QR_FLOOR = 30;
const AS_FLOOR = 1;
const CEILING_MULT = 2;
const FETCH_ATTEMPTS = 3;
const PARTIAL_EXIT_CODE = 5;
const SNAPSHOT_DIR = "/srv/ua-starlink-tracker/backup/residential-snapshots";

type ProdState = { confirmed: number; total: number; tails: string[] };
type Preflight = { qr: ProdState; as: ProdState };
type Payload = {
  v: 1;
  sources: { flyertalk_qr?: { tails: string[] }; flyertalk_as?: { tails: string[] } };
  fetchedAt: string;
  fetchedFrom: string;
};
type SourceResult = {
  source: "flyertalk_qr" | "flyertalk_as";
  scraped: number;
  before: number;
  after: number;
  written: number;
  new: string[];
};
type IngestResult = {
  ok: true;
  results: SourceResult[];
  snapshot: string;
  fetchedAt: string;
};

function refused(msg: string): never {
  throw Object.assign(new Error(msg), { code: 2 });
}

// A rejected redirect or a changed page layout fails identically on every
// attempt; retrying only delays the error by 6s.
export function isDeterministicFetchError(e: unknown): boolean {
  if (e instanceof FlyertalkRedirectRejected) return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /wikipost block not found|section bounds not found/.test(msg);
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  baseDelayMs = 2000
): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= FETCH_ATTEMPTS; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (isDeterministicFetchError(e)) throw e;
      if (i < FETCH_ATTEMPTS) {
        const wait = baseDelayMs * 2 ** (i - 1);
        info(`${label}: attempt ${i}/${FETCH_ATTEMPTS} failed (${e}), retrying in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw last;
}

async function sshJson<T>(cmd: string, stdin?: string): Promise<T> {
  const proc = Bun.spawn(["ssh", "-o", "ConnectTimeout=10", PROD_SSH, cmd], {
    stdin: stdin ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin) {
    proc.stdin.write(stdin);
    proc.stdin.end();
  }
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0)
    throw Object.assign(new Error(`ssh '${cmd.slice(0, 40)}…' exited ${code}: ${err || out}`), {
      code: 3,
    });
  // Remote stdout interleaves logger JSON with the result JSON; pick the last
  // line that parses and isn't a log record.
  for (const l of out.split("\n").reverse()) {
    if (!l.startsWith("{")) continue;
    try {
      const o = JSON.parse(l);
      if (!("level" in o && "timestamp" in o)) return o as T;
    } catch {}
  }
  throw Object.assign(new Error(`no result JSON in remote output: ${out}`), { code: 3 });
}

function validateTails(
  label: string,
  tails: string[],
  re: RegExp,
  floor: number,
  prodConfirmed?: number
): void {
  const bad = tails.filter((t) => !re.test(t));
  if (bad.length)
    refused(`malformed ${label} tails: ${bad.slice(0, 5).join(",")}${bad.length > 5 ? "…" : ""}`);
  if (tails.length < floor)
    refused(`only ${tails.length} ${label} tails (< floor ${floor}); refusing partial scrape`);
  if (prodConfirmed && tails.length > prodConfirmed * CEILING_MULT)
    refused(
      `scraped ${tails.length} ${label} > ${CEILING_MULT}× prod confirmed ${prodConfirmed}; ` +
        "page layout likely changed and the regex is over-matching"
    );
}

const validateQr = (t: string[], c?: number) =>
  validateTails("QR", t, AIRLINES.QR.tailPattern, QR_FLOOR, c);
const validateAs = (t: string[], c?: number) =>
  validateTails("AS", t, AIRLINES.AS.tailPattern, AS_FLOOR, c);

// ---- prod-side handlers ----

function readState(
  db: ReturnType<typeof initializeDatabase>,
  airline: string,
  fleet?: string
): ProdState {
  const where = fleet ? "airline=? AND fleet=?" : "airline=?";
  const params = fleet ? [airline, fleet] : [airline];
  const rows = db
    .query(
      `SELECT tail_number, starlink_status FROM united_fleet WHERE ${where} ORDER BY tail_number`
    )
    .all(...params) as { tail_number: string; starlink_status: string }[];
  const confirmed = rows.filter((r) => r.starlink_status === "confirmed");
  return {
    confirmed: confirmed.length,
    total: rows.length,
    tails: confirmed.map((r) => r.tail_number),
  };
}

function preflight(): void {
  const db = initializeDatabase();
  try {
    const out: Preflight = { qr: readState(db, "QR"), as: readState(db, "AS", "mainline") };
    console.log(JSON.stringify(out));
  } finally {
    db.close();
  }
}

function ingestSource(
  db: ReturnType<typeof initializeDatabase>,
  source: SourceResult["source"],
  airline: string,
  tails: string[],
  validate: (t: string[], c?: number) => void,
  apply: (db: ReturnType<typeof initializeDatabase>, t: string[]) => number,
  fleet?: string
): SourceResult {
  const before = readState(db, airline, fleet);
  validate(tails, before.confirmed || undefined);
  const written = apply(db, tails);
  const after = readState(db, airline, fleet);
  if (after.confirmed < before.confirmed)
    throw Object.assign(
      new Error(`integrity: ${airline} confirmed dropped ${before.confirmed}→${after.confirmed}`),
      { code: 4 }
    );
  // No refreshFleetMeta here — applyFlyertalkTails owns it (runs it whenever
  // it writes), so the meta refresh can't be double-stamped or forgotten.
  return {
    source,
    scraped: tails.length,
    before: before.confirmed,
    after: after.confirmed,
    written,
    new: after.tails.filter((t) => !before.tails.includes(t)),
  };
}

async function ingest(): Promise<void> {
  const raw = await new Response(Bun.stdin.stream()).text();
  let payload: Payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    refused(`invalid JSON on stdin: ${e}`);
  }
  if (payload.v !== 1) refused(`unsupported payload v=${payload.v}`);

  const db = initializeDatabase();
  try {
    const before: Preflight = { qr: readState(db, "QR"), as: readState(db, "AS", "mainline") };
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const snapshot = `${SNAPSHOT_DIR}/${payload.fetchedAt.replace(/[:.]/g, "-")}.json`;
    writeFileSync(snapshot, JSON.stringify({ before, payload }, null, 2));

    if (!payload.sources.flyertalk_qr && !payload.sources.flyertalk_as)
      refused("payload carries no sources");

    const results: SourceResult[] = [];
    if (payload.sources.flyertalk_qr) {
      results.push(
        ingestSource(
          db,
          "flyertalk_qr",
          "QR",
          payload.sources.flyertalk_qr.tails,
          validateQr,
          applyQatarFlyertalkTails
        )
      );
      setMeta(db, "residentialSyncAt", payload.fetchedAt, "QR");
      setMeta(db, "residentialSyncFrom", payload.fetchedFrom, "QR");
    }
    if (payload.sources.flyertalk_as) {
      results.push(
        ingestSource(
          db,
          "flyertalk_as",
          "AS",
          payload.sources.flyertalk_as.tails,
          validateAs,
          applyAlaskaFlyertalkTails,
          "mainline"
        )
      );
      setMeta(db, "residentialSyncAt", payload.fetchedAt, "AS");
      setMeta(db, "residentialSyncFrom", payload.fetchedFrom, "AS");
    }

    const result: IngestResult = { ok: true, results, snapshot, fetchedAt: payload.fetchedAt };
    console.log(JSON.stringify(result));
  } finally {
    db.close();
  }
}

// ---- laptop-side driver ----

function reportNew(label: string, scraped: string[], prod: ProdState): void {
  const localNew = scraped.filter((t) => !prod.tails.includes(t));
  info(
    `scraped ${scraped.length} ${label} tails (${localNew.length} not yet confirmed on prod` +
      (localNew.length
        ? `: ${localNew.slice(0, 8).join(" ")}${localNew.length > 8 ? " …" : ""}`
        : "") +
      ")"
  );
}

async function run(dryRun: boolean): Promise<void> {
  info(`preflight: checking ${PROD_SSH} reachability + QR/AS state`);
  const prod = await sshJson<Preflight>(REMOTE("--preflight"));
  info(
    `preflight ok: prod has QR ${prod.qr.confirmed}/${prod.qr.total}, ` +
      `AS mainline ${prod.as.confirmed}/${prod.as.total} confirmed`
  );

  // Each source is fetched independently so one dead oracle can't block the
  // other; a skip logs an error and exits PARTIAL_EXIT_CODE so the run reads
  // as unhealthy instead of silently shipping half (AS was dead May→Sept).
  const skipped: string[] = [];
  let firstFailure: unknown;
  const fetchSource = async (
    source: SourceResult["source"],
    label: string,
    fetchTails: () => Promise<string[]>,
    validate: (t: string[], c?: number) => void,
    state: ProdState
  ): Promise<string[] | undefined> => {
    try {
      const tails = await withRetry(fetchTails, source);
      validate(tails, state.confirmed || undefined);
      reportNew(label, tails, state);
      return tails;
    } catch (e) {
      logError(`${source} skipped: ${(e as Error).message}`, e);
      skipped.push(source);
      firstFailure ??= e;
      return undefined;
    }
  };

  const qrTails = await fetchSource(
    "flyertalk_qr",
    "QR",
    () => fetchQatarFlyertalkTails(),
    validateQr,
    prod.qr
  );
  const asTails = await fetchSource(
    "flyertalk_as",
    "AS",
    () => fetchAlaskaFlyertalkTails(),
    validateAs,
    prod.as
  );
  if (!qrTails && !asTails) throw firstFailure;

  const payload: Payload = {
    v: 1,
    sources: {
      ...(qrTails ? { flyertalk_qr: { tails: qrTails } } : {}),
      ...(asTails ? { flyertalk_as: { tails: asTails } } : {}),
    },
    fetchedAt: new Date().toISOString(),
    fetchedFrom: hostname(),
  };

  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    info("dry-run: not shipped");
    markPartial(skipped);
    return;
  }

  info(`shipping to ${PROD_SSH}`);
  const result = await sshJson<IngestResult>(REMOTE("--ingest"), JSON.stringify(payload));

  for (const r of result.results) {
    const pre = r.source === "flyertalk_qr" ? prod.qr : prod.as;
    if (r.after !== pre.confirmed + r.new.length) {
      warn(
        `post-verify ${r.source}: after=${r.after} != preflight ${pre.confirmed} + new ${r.new.length} ` +
          "(another writer may have raced; not fatal)"
      );
    }
  }

  console.log(JSON.stringify(result, null, 2));
  const summary = result.results
    .map((r) => `${r.source} ${r.before}→${r.after} (+${r.new.length})`)
    .join(", ");
  info(`done: ${summary}, snapshot ${result.snapshot}`);
  markPartial(skipped);
}

function markPartial(skipped: string[]): void {
  if (!skipped.length) return;
  logError(`partial sync: skipped ${skipped.join(", ")} — exit ${PARTIAL_EXIT_CODE}`);
  process.exitCode = PARTIAL_EXIT_CODE;
}

function fail(e: unknown): never {
  const code = (e as { code?: number })?.code ?? 1;
  logError("residential-sync", e);
  console.error(String((e as Error)?.message ?? e));
  process.exit(code);
}

if (import.meta.main) {
  const argv = new Set(process.argv.slice(2));
  if (argv.has("--preflight")) {
    try {
      preflight();
    } catch (e) {
      fail(e);
    }
  } else if (argv.has("--ingest")) {
    ingest().catch((e) => fail(Object.assign(e, { code: (e as { code?: number }).code ?? 3 })));
  } else {
    run(argv.has("--dry-run")).catch(fail);
  }
}
