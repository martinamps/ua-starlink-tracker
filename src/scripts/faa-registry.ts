/**
 * Daily FAA Releasable Aircraft Registry sync: canonical existence/deregistration
 * status and Mode-S hex for every tracked tail. The three files are streamed out
 * of the bulk zip with `unzip -p`, so the ~480 MB extract never lands in memory —
 * only rows for tails we track are kept.
 */

import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { replaceFaaRegistry } from "../database/database";
import { COUNTERS, GAUGES, metrics, normalizeAirlineTag, withSpan } from "../observability";
import type { FaaRegistryRow } from "../types";
import { BROWSER_USER_AGENT } from "../utils/constants";
import { type JobHandle, startJob } from "../utils/job-runner";
import { info, error as logError, warn } from "../utils/logger";

const REGISTRY_ZIP_URL = "https://registry.faa.gov/database/ReleasableAircraft.zip";

export type RegistryFile = "MASTER.txt" | "ACFTREF.txt" | "DEREG.txt";
export type LineSource = (file: RegistryFile) => AsyncIterable<string> | Iterable<string>;

export interface FaaSyncDeps {
  loadLines?: LineSource;
}

export interface FaaSyncResult {
  outcome: "success" | "error";
  tracked: number;
  resolved: number;
  flagged: number;
}

// FAA N-NUMBER columns carry no leading N.
const stripN = (tail: string) => tail.trim().toUpperCase().replace(/^N/, "");

interface MasterRow {
  serial: string;
  mfrMdlCode: string;
  yearMfr: string;
  registrant: string;
  statusCode: string;
  modeSHex: string;
  expirationDate: string;
}

function headerIndex(headerLine: string): Record<string, number> {
  const idx: Record<string, number> = {};
  headerLine
    .replace(/^﻿/, "")
    .split(",")
    .forEach((name, i) => {
      idx[name.trim()] = i;
    });
  return idx;
}

export async function collectMasterRows(
  lines: AsyncIterable<string> | Iterable<string>,
  wanted: ReadonlySet<string>
): Promise<Map<string, MasterRow>> {
  const out = new Map<string, MasterRow>();
  let idx: Record<string, number> | null = null;
  for await (const line of lines) {
    if (!idx) {
      idx = headerIndex(line);
      continue;
    }
    const cols = line.split(",");
    const n = (cols[idx["N-NUMBER"]] ?? "").trim();
    if (!wanted.has(n)) continue;
    out.set(n, {
      serial: (cols[idx["SERIAL NUMBER"]] ?? "").trim(),
      mfrMdlCode: (cols[idx["MFR MDL CODE"]] ?? "").trim(),
      yearMfr: (cols[idx["YEAR MFR"]] ?? "").trim(),
      registrant: (cols[idx.NAME] ?? "").trim(),
      statusCode: (cols[idx["STATUS CODE"]] ?? "").trim(),
      modeSHex: (cols[idx["MODE S CODE HEX"]] ?? "").trim(),
      expirationDate: (cols[idx["EXPIRATION DATE"]] ?? "").trim(),
    });
  }
  return out;
}

export async function collectAcftref(
  lines: AsyncIterable<string> | Iterable<string>,
  wantedCodes: ReadonlySet<string>
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let idx: Record<string, number> | null = null;
  for await (const line of lines) {
    if (!idx) {
      idx = headerIndex(line);
      continue;
    }
    const cols = line.split(",");
    const code = (cols[idx.CODE] ?? "").trim();
    if (!wantedCodes.has(code)) continue;
    const mfr = (cols[idx.MFR] ?? "").trim();
    const model = (cols[idx.MODEL] ?? "").trim();
    out.set(code, `${mfr} ${model}`.trim());
  }
  return out;
}

export async function collectDereg(
  lines: AsyncIterable<string> | Iterable<string>,
  wanted: ReadonlySet<string>
): Promise<Map<string, Array<{ serial: string; cancelDate: string }>>> {
  const out = new Map<string, Array<{ serial: string; cancelDate: string }>>();
  let idx: Record<string, number> | null = null;
  for await (const line of lines) {
    if (!idx) {
      idx = headerIndex(line);
      continue;
    }
    const cols = line.split(",");
    const n = (cols[idx["N-NUMBER"]] ?? "").trim();
    if (!wanted.has(n)) continue;
    const records = out.get(n) ?? [];
    records.push({
      serial: (cols[idx["SERIAL-NUMBER"]] ?? "").trim(),
      cancelDate: (cols[idx["CANCEL-DATE"]] ?? "").trim(),
    });
    out.set(n, records);
  }
  return out;
}

export interface FaaFlags {
  missingFromMaster: string[];
  /** Tails we mark as Starlink-equipped that the FAA says don't validly exist.
   * Deliberately a log+gauge tripwire (expected ~0), not a mismatch-list entry. */
  wrongYes: Array<{ tail: string; reason: string }>;
}

export function buildFaaRecords(opts: {
  tails: readonly string[];
  starlinkTails: ReadonlySet<string>;
  master: ReadonlyMap<string, MasterRow>;
  acftref: ReadonlyMap<string, string>;
  dereg: ReadonlyMap<string, Array<{ serial: string; cancelDate: string }>>;
}): { rows: Array<Omit<FaaRegistryRow, "last_refreshed">>; flags: FaaFlags } {
  const rows: Array<Omit<FaaRegistryRow, "last_refreshed">> = [];
  const flags: FaaFlags = { missingFromMaster: [], wrongYes: [] };

  for (const tail of [...opts.tails].sort()) {
    const n = stripN(tail);
    const m = opts.master.get(n);
    // Raw N-number dereg matches are dominated by historical N-number reuse —
    // a record only counts when the tail is gone from MASTER or the serial matches.
    const relevantDereg = (opts.dereg.get(n) ?? []).filter((d) => !m || d.serial === m.serial);
    const deregDate =
      relevantDereg
        .map((d) => d.cancelDate)
        .sort()
        .at(-1) ?? null;

    if (!m) flags.missingFromMaster.push(tail);
    if (opts.starlinkTails.has(tail) && (!m || m.statusCode !== "V")) {
      flags.wrongYes.push({
        tail,
        reason: m ? `FAA status ${m.statusCode}` : "not in FAA registry",
      });
    }

    rows.push({
      tail_number: tail,
      mode_s_hex: m?.modeSHex || null,
      serial: m?.serial || null,
      year_mfr: m?.yearMfr || null,
      faa_status: m ? m.statusCode || "?" : "NOT_IN_MASTER",
      registrant: m?.registrant || null,
      faa_model: (m && opts.acftref.get(m.mfrMdlCode)) || null,
      expiration_date: m?.expirationDate || null,
      dereg_date: deregDate,
    });
  }
  return { rows, flags };
}

async function* spawnLines(cmd: string[]): AsyncGenerator<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  try {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of proc.stdout) {
      buf += decoder.decode(chunk, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        yield buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
    }
    if (buf.trim() !== "") yield buf;
    const code = await proc.exited;
    if (code !== 0) throw new Error(`${cmd.join(" ")} exited with ${code}`);
  } finally {
    // Covers consumers that stop iterating early — never leave unzip blocked
    // on an undrained pipe.
    proc.kill();
    await proc.exited;
  }
}

async function downloadRegistryZip(): Promise<{ dir: string; zipPath: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), "faa-registry-"));
  const zipPath = path.join(dir, "ReleasableAircraft.zip");
  // curl, not fetch: the FAA host needs a browser User-Agent (503s otherwise)
  // and Bun's fetch stalls indefinitely streaming this particular 73 MB body.
  const proc = Bun.spawn(
    [
      "curl",
      "-sSL",
      "--fail",
      "--max-time",
      "600",
      "-A",
      BROWSER_USER_AGENT,
      "-o",
      zipPath,
      REGISTRY_ZIP_URL,
    ],
    { stdout: "ignore", stderr: "pipe" }
  );
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`registry download failed (curl exit ${code}): ${stderr.slice(0, 200)}`);
  }
  return { dir, zipPath };
}

function trackedTails(db: Database): { tails: string[]; starlinkTails: Set<string> } {
  const fleet = db.query("SELECT tail_number, starlink_status FROM united_fleet").all() as Array<{
    tail_number: string;
    starlink_status: string | null;
  }>;
  const sheet = db.query("SELECT TailNumber, wifi FROM starlink_planes").all() as Array<{
    TailNumber: string;
    wifi: string | null;
  }>;

  const isUsReg = (t: string) => /^N/i.test(t);
  const tails = new Set<string>();
  const starlinkTails = new Set<string>();
  for (const r of fleet) {
    if (!isUsReg(r.tail_number)) continue;
    tails.add(r.tail_number);
    if (r.starlink_status === "confirmed") starlinkTails.add(r.tail_number);
  }
  for (const r of sheet) {
    if (!isUsReg(r.TailNumber)) continue;
    tails.add(r.TailNumber);
    if (r.wifi === "Starlink" || r.wifi === "StrLnk") starlinkTails.add(r.TailNumber);
  }
  return { tails: [...tails], starlinkTails };
}

export async function runFaaRegistrySync(
  db: Database,
  deps: FaaSyncDeps = {}
): Promise<FaaSyncResult> {
  return withSpan(
    "scraper.faa_registry",
    async (span): Promise<FaaSyncResult> => {
      span.setTag("job.type", "background");
      let cleanup = () => {};
      try {
        let loadLines = deps.loadLines;
        if (!loadLines) {
          const { dir, zipPath } = await downloadRegistryZip();
          cleanup = () => rmSync(dir, { recursive: true, force: true });
          loadLines = (file) => spawnLines(["unzip", "-p", zipPath, file]);
        }

        const { tails, starlinkTails } = trackedTails(db);
        const wanted = new Set(tails.map(stripN));
        // ACFTREF needs MASTER's model codes; DEREG doesn't, so scan it concurrently.
        const [master, dereg] = await Promise.all([
          collectMasterRows(loadLines("MASTER.txt"), wanted),
          collectDereg(loadLines("DEREG.txt"), wanted),
        ]);
        const acftref = await collectAcftref(
          loadLines("ACFTREF.txt"),
          new Set([...master.values()].map((m) => m.mfrMdlCode))
        );

        const { rows, flags } = buildFaaRecords({ tails, starlinkTails, master, acftref, dereg });
        replaceFaaRegistry(db, rows);

        const resolved = rows.filter((r) => r.faa_status !== "NOT_IN_MASTER").length;
        metrics.gauge(GAUGES.FAA_REGISTRY_TAILS, resolved, {
          state: "resolved",
          airline: normalizeAirlineTag("UA"),
        });
        metrics.gauge(GAUGES.FAA_REGISTRY_TAILS, flags.missingFromMaster.length, {
          state: "not_in_master",
          airline: normalizeAirlineTag("UA"),
        });
        metrics.gauge(GAUGES.FAA_REGISTRY_TAILS, flags.wrongYes.length, {
          state: "starlink_flagged",
          airline: normalizeAirlineTag("UA"),
        });
        metrics.increment(COUNTERS.SCRAPER_SYNC, {
          source: "faa_registry",
          airline: normalizeAirlineTag("UA"),
          status: "success",
        });

        for (const f of flags.wrongYes) {
          warn(`faa-registry: ${f.tail} is marked Starlink but ${f.reason}`);
        }
        span.setTag("resolved", resolved);
        span.setTag("flagged", flags.wrongYes.length);
        info(
          `faa-registry sync: ${resolved}/${rows.length} tails resolved, ` +
            `${flags.missingFromMaster.length} not in registry, ${flags.wrongYes.length} starlink-flagged`
        );
        return {
          outcome: "success",
          tracked: rows.length,
          resolved,
          flagged: flags.wrongYes.length,
        };
      } catch (err) {
        logError("faa-registry sync failed", err);
        metrics.increment(COUNTERS.SCRAPER_SYNC, {
          source: "faa_registry",
          airline: normalizeAirlineTag("UA"),
          status: "error",
        });
        span.setTag("error", true);
        return { outcome: "error", tracked: 0, resolved: 0, flagged: 0 };
      } finally {
        cleanup();
      }
    },
    { "job.type": "background" }
  );
}

export function startFaaRegistryJob(db: Database): JobHandle {
  return startJob({
    name: "faa_registry",
    intervalMs: 24 * 3600 * 1000,
    initialDelayMs: 20 * 60 * 1000,
    run: async () => {
      await runFaaRegistrySync(db);
    },
  });
}
