#!/usr/bin/env bun
/**
 * Fetch sources that block the prod ASN (OVH) from a residential IP, then ship
 * the result to prod for ingest. One file, two modes:
 *
 *   bun run src/scripts/residential-sync.ts            # laptop: fetch → ssh → ingest
 *   bun run src/scripts/residential-sync.ts --dry-run  # laptop: fetch + print, no ship
 *   ... --ingest                                       # prod: stdin JSON → DB (invoked over ssh)
 *
 * Exit codes: 0 ok · 1 fetch failed · 2 validation refused · 3 ingest failed
 */

import { hostname } from "node:os";
import { initializeDatabase, refreshFleetMeta, setMeta } from "../database/database";
import { info, error as logError } from "../utils/logger";
import { applyQatarFlyertalkTails, fetchQatarFlyertalkTails } from "./flyertalk-qatar";

const PROD_SSH = process.env.RESIDENTIAL_SYNC_HOST ?? "llc";
const PROD_CMD =
  "sudo docker exec -i $(sudo docker ps -q --filter name=c4wg48 | head -1) bun run /app/src/scripts/residential-sync.ts --ingest";

const QR_TAIL_RE = /^A7-[A-Z]{3}$/;
const QR_FLOOR = 30;
const FETCH_ATTEMPTS = 3;

type Payload = {
  v: 1;
  sources: { flyertalk_qr: { tails: string[] } };
  fetchedAt: string;
  fetchedFrom: string;
};

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

function validateQr(tails: string[]): void {
  const bad = tails.filter((t) => !QR_TAIL_RE.test(t));
  if (bad.length)
    throw Object.assign(new Error(`malformed QR tails: ${bad.join(",")}`), { code: 2 });
  if (tails.length < QR_FLOOR)
    throw Object.assign(
      new Error(
        `only ${tails.length} QR tails (< floor ${QR_FLOOR}); refusing to ship a partial scrape`
      ),
      { code: 2 }
    );
}

async function buildPayload(): Promise<Payload> {
  const tails = await withRetry(fetchQatarFlyertalkTails, "flyertalk_qr");
  validateQr(tails);
  return {
    v: 1,
    sources: { flyertalk_qr: { tails } },
    fetchedAt: new Date().toISOString(),
    fetchedFrom: hostname(),
  };
}

async function ship(payload: Payload): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["ssh", PROD_SSH, PROD_CMD], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out + (err ? `\n[stderr] ${err}` : "") };
}

async function ingest(): Promise<void> {
  const raw = await new Response(Bun.stdin.stream()).text();
  let payload: Payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    throw Object.assign(new Error(`invalid JSON on stdin: ${e}`), { code: 2 });
  }
  if (payload.v !== 1)
    throw Object.assign(new Error(`unsupported payload v=${payload.v}`), { code: 2 });

  const qr = payload.sources.flyertalk_qr;
  validateQr(qr.tails);

  const db = initializeDatabase();
  try {
    const before = new Set(
      (
        db
          .query(
            "SELECT tail_number FROM united_fleet WHERE airline='QR' AND starlink_status='confirmed'"
          )
          .all() as { tail_number: string }[]
      ).map((r) => r.tail_number)
    );
    const written = applyQatarFlyertalkTails(db, qr.tails);
    const newTails = qr.tails.filter((t) => !before.has(t));
    setMeta(db, "residentialSyncAt", payload.fetchedAt, "QR");
    setMeta(db, "residentialSyncFrom", payload.fetchedFrom, "QR");
    refreshFleetMeta(db, "QR");

    console.log(
      JSON.stringify({
        ok: true,
        source: "flyertalk_qr",
        scraped: qr.tails.length,
        written,
        new: newTails,
        fetchedAt: payload.fetchedAt,
      })
    );
  } finally {
    db.close();
  }
}

function fail(e: unknown): never {
  const code = (e as { code?: number })?.code ?? 1;
  logError("residential-sync", e);
  console.error(String(e));
  process.exit(code);
}

if (import.meta.main) {
  const argv = new Set(process.argv.slice(2));

  if (argv.has("--ingest")) {
    ingest().catch((e) => fail(Object.assign(e, { code: (e as { code?: number }).code ?? 3 })));
  } else {
    buildPayload()
      .then(async (payload) => {
        const n = payload.sources.flyertalk_qr.tails.length;
        if (argv.has("--dry-run")) {
          console.log(JSON.stringify(payload, null, 2));
          info(`dry-run: ${n} QR tails fetched, not shipped`);
          return;
        }
        info(`fetched ${n} QR tails from ${payload.fetchedFrom}; shipping to ${PROD_SSH}`);
        const { code, out } = await ship(payload);
        console.log(out.trim());
        if (code !== 0) throw Object.assign(new Error(`prod ingest exited ${code}`), { code: 3 });
        info("residential-sync complete");
      })
      .catch(fail);
  }
}
