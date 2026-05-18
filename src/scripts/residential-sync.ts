#!/usr/bin/env bun
/**
 * Fetch sources that block the prod ASN (OVH) from a residential IP, then ship
 * the result to prod for ingest. One file, two modes:
 *
 *   bun run residential-sync             # preflight → fetch → ship → ingest → verify
 *   bun run residential-sync --dry-run   # preflight → fetch → print payload, no write
 *   ... --ingest                         # prod-side: stdin JSON → DB (invoked over ssh)
 *   ... --preflight                      # prod-side: print {confirmed,total} for QR
 *
 * Exit codes: 0 ok · 1 fetch failed · 2 validation refused · 3 ship/ingest failed · 4 post-verify failed
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { initializeDatabase, refreshFleetMeta, setMeta } from "../database/database";
import { info, error as logError, warn } from "../utils/logger";
import { applyQatarFlyertalkTails, fetchQatarFlyertalkTails } from "./flyertalk-qatar";

const PROD_SSH = process.env.RESIDENTIAL_SYNC_HOST ?? "llc";
const CONTAINER = "$(sudo docker ps -q --filter name=c4wg48 | head -1)";
const REMOTE = (flag: string) =>
  `sudo docker exec -i ${CONTAINER} bun run /app/src/scripts/residential-sync.ts ${flag}`;

const QR_TAIL_RE = /^A7-[A-Z]{3}$/;
const QR_FLOOR = 30;
const QR_CEILING_MULT = 2;
const FETCH_ATTEMPTS = 3;
const SNAPSHOT_DIR = "/srv/ua-starlink-tracker/backup/qr-snapshots";

type ProdState = { confirmed: number; total: number; tails: string[] };
type Payload = {
  v: 1;
  sources: { flyertalk_qr: { tails: string[] } };
  fetchedAt: string;
  fetchedFrom: string;
};
type IngestResult = {
  ok: true;
  source: "flyertalk_qr";
  scraped: number;
  before: number;
  after: number;
  written: number;
  new: string[];
  snapshot: string;
  fetchedAt: string;
};

function refused(msg: string): never {
  throw Object.assign(new Error(msg), { code: 2 });
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= FETCH_ATTEMPTS; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < FETCH_ATTEMPTS) {
        const wait = 2000 * 2 ** (i - 1);
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

function validateQr(tails: string[], prodConfirmed?: number): void {
  const bad = tails.filter((t) => !QR_TAIL_RE.test(t));
  if (bad.length)
    refused(`malformed QR tails: ${bad.slice(0, 5).join(",")}${bad.length > 5 ? "…" : ""}`);
  if (tails.length < QR_FLOOR)
    refused(`only ${tails.length} QR tails (< floor ${QR_FLOOR}); refusing partial scrape`);
  if (prodConfirmed && tails.length > prodConfirmed * QR_CEILING_MULT)
    refused(
      `scraped ${tails.length} > ${QR_CEILING_MULT}× prod confirmed ${prodConfirmed}; ` +
        "page layout likely changed and the regex is over-matching"
    );
}

// ---- prod-side handlers ----

function readQrState(db: ReturnType<typeof initializeDatabase>): ProdState {
  const rows = db
    .query(
      "SELECT tail_number, starlink_status FROM united_fleet WHERE airline='QR' ORDER BY tail_number"
    )
    .all() as { tail_number: string; starlink_status: string }[];
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
    console.log(JSON.stringify(readQrState(db)));
  } finally {
    db.close();
  }
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

  const qr = payload.sources.flyertalk_qr;
  const db = initializeDatabase();
  try {
    const before = readQrState(db);
    validateQr(qr.tails, before.confirmed || undefined);

    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const snapshot = `${SNAPSHOT_DIR}/${payload.fetchedAt.replace(/[:.]/g, "-")}.json`;
    writeFileSync(snapshot, JSON.stringify({ before, payload }, null, 2));

    const written = applyQatarFlyertalkTails(db, qr.tails);
    const after = readQrState(db);

    if (after.confirmed < before.confirmed)
      throw Object.assign(
        new Error(`integrity: confirmed dropped ${before.confirmed}→${after.confirmed}`),
        { code: 4 }
      );

    setMeta(db, "residentialSyncAt", payload.fetchedAt, "QR");
    setMeta(db, "residentialSyncFrom", payload.fetchedFrom, "QR");
    refreshFleetMeta(db, "QR");

    const newTails = after.tails.filter((t) => !before.tails.includes(t));
    const result: IngestResult = {
      ok: true,
      source: "flyertalk_qr",
      scraped: qr.tails.length,
      before: before.confirmed,
      after: after.confirmed,
      written,
      new: newTails,
      snapshot,
      fetchedAt: payload.fetchedAt,
    };
    console.log(JSON.stringify(result));
  } finally {
    db.close();
  }
}

// ---- laptop-side driver ----

async function run(dryRun: boolean): Promise<void> {
  info(`preflight: checking ${PROD_SSH} reachability + QR state`);
  const prod = await sshJson<ProdState>(REMOTE("--preflight"));
  info(`preflight ok: prod has ${prod.confirmed}/${prod.total} QR confirmed`);

  const tails = await withRetry(fetchQatarFlyertalkTails, "flyertalk_qr");
  validateQr(tails, prod.confirmed || undefined);
  const payload: Payload = {
    v: 1,
    sources: { flyertalk_qr: { tails } },
    fetchedAt: new Date().toISOString(),
    fetchedFrom: hostname(),
  };

  const localNew = tails.filter((t) => !prod.tails.includes(t));
  info(
    `scraped ${tails.length} QR tails (${localNew.length} not yet confirmed on prod` +
      (localNew.length
        ? `: ${localNew.slice(0, 8).join(" ")}${localNew.length > 8 ? " …" : ""}`
        : "") +
      ")"
  );

  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    info("dry-run: not shipped");
    return;
  }

  info(`shipping to ${PROD_SSH}`);
  const result = await sshJson<IngestResult>(REMOTE("--ingest"), JSON.stringify(payload));

  if (result.after !== prod.confirmed + result.new.length) {
    warn(
      `post-verify: after=${result.after} != preflight ${prod.confirmed} + new ${result.new.length} ` +
        "(another writer may have raced; not fatal)"
    );
  }

  console.log(JSON.stringify(result, null, 2));
  info(
    `done: ${result.before}→${result.after} confirmed (+${result.new.length}), snapshot ${result.snapshot}`
  );
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
