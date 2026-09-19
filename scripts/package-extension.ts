#!/usr/bin/env bun
/**
 * Builds the Chrome Web Store / Edge Add-ons upload: dist/ext-<version>.zip.
 *
 * The file list is read from manifest.json rather than globbed, so docs
 * (README, QA-CHECKLIST) and stray editor files never ship, and a file the
 * manifest references but the folder lacks fails here instead of in review.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const EXT_DIR = join(ROOT, "chrome-extension");
const DIST_DIR = join(ROOT, "dist");

type Manifest = {
  version: string;
  background?: { service_worker?: string };
  content_scripts?: Array<{ js?: string[]; css?: string[] }>;
  icons?: Record<string, string>;
};

export function runtimeFiles(manifest: Manifest): string[] {
  const files = new Set<string>(["manifest.json"]);
  if (manifest.background?.service_worker) files.add(manifest.background.service_worker);
  for (const cs of manifest.content_scripts ?? []) {
    for (const f of [...(cs.js ?? []), ...(cs.css ?? [])]) files.add(f);
  }
  for (const f of Object.values(manifest.icons ?? {})) files.add(f);
  // background.js pulls lib.js in with importScripts, which the manifest cannot see.
  files.add("lib.js");
  return [...files].filter((f) => !f.endsWith(".md")).sort();
}

async function main() {
  const manifest = (await Bun.file(join(EXT_DIR, "manifest.json")).json()) as Manifest;
  const files = runtimeFiles(manifest);
  const missing = files.filter((f) => !existsSync(join(EXT_DIR, f)));
  if (missing.length > 0) {
    console.error(`manifest references missing files: ${missing.join(", ")}`);
    process.exit(1);
  }

  mkdirSync(DIST_DIR, { recursive: true });
  const out = join(DIST_DIR, `ext-${manifest.version}.zip`);
  rmSync(out, { force: true });
  const proc = Bun.spawnSync(["zip", "-X", "-q", out, ...files], { cwd: EXT_DIR });
  if (proc.exitCode !== 0) {
    console.error(proc.stderr.toString() || "zip failed");
    process.exit(1);
  }
  console.log(`${out}\n  ${files.join("\n  ")}`);
}

if (import.meta.main) await main();
