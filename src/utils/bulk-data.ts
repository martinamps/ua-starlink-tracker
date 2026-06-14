/**
 * Helpers for bulk public data files (FAA registry, BTS on-time): download a
 * zip to a temp dir with curl, stream a member's lines without holding the
 * extract in memory, and split CSV lines. curl rather than fetch — the FAA
 * host 503s default user agents and Bun's fetch stalls on its large bodies.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BROWSER_USER_AGENT } from "./constants";

export async function downloadZipToTemp(
  url: string,
  opts: { prefix: string; maxTimeSec?: number; notFoundOk?: boolean }
): Promise<{ dir: string; zipPath: string } | null> {
  const dir = mkdtempSync(path.join(tmpdir(), opts.prefix));
  const zipPath = path.join(dir, "download.zip");
  const proc = Bun.spawn(
    [
      "curl",
      "-sSL",
      "--fail",
      "--max-time",
      String(opts.maxTimeSec ?? 600),
      "-A",
      BROWSER_USER_AGENT,
      "-w",
      "%{http_code}",
      "-o",
      zipPath,
      url,
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  const code = await proc.exited;
  if (code !== 0) {
    rmSync(dir, { recursive: true, force: true });
    const httpCode = (await new Response(proc.stdout).text()).trim();
    // notFoundOk only swallows a true 404 (file not published yet); 403/429/5xx
    // must surface so an outage doesn't masquerade as "nothing new".
    if (opts.notFoundOk && code === 22 && httpCode === "404") return null;
    const stderr = await new Response(proc.stderr).text();
    throw new Error(
      `download failed (curl exit ${code}, http ${httpCode || "?"}): ${stderr.slice(0, 200)}`
    );
  }
  return { dir, zipPath };
}

export async function* spawnLines(cmd: string[]): AsyncGenerator<string> {
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
    // Covers consumers that stop iterating early — never leave the child
    // blocked on an undrained pipe.
    proc.kill();
    await proc.exited;
  }
}

/** Split one CSV line, honoring double quotes (BTS city names contain commas). */
export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      cells.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  cells.push(field);
  return cells;
}
