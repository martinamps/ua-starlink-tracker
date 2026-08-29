#!/usr/bin/env bun
/**
 * Dev entrypoint: compiled Tailwind + hot-reloading server.
 *
 * Utilities are compiled ahead of time now (see src/styles/tailwind.css), so a
 * class typed into a component is invisible until the CSS is rebuilt. That is
 * the one ergonomic cost of dropping the browser JIT, and this script pays it:
 * every change under src/ or to index.html triggers a rebuild before the
 * reloaded server serves the new markup.
 *
 * The rebuild is a one-shot CLI run rather than `tailwindcss --watch` on
 * purpose — watch mode needs @parcel/watcher's build-from-source postinstall,
 * which is not worth adding to a dependency chain that also installs in Docker.
 * A full compile is ~50ms.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dir, "..");
const TAILWIND_BIN = path.join(ROOT, "node_modules", ".bin", "tailwindcss");
const WATCH_TARGETS = [path.join(ROOT, "src"), path.join(ROOT, "index.html")];

function buildCss(): void {
  const started = performance.now();
  const result = spawnSync(
    TAILWIND_BIN,
    ["-i", "src/styles/tailwind.css", "-o", "static/tailwind.css", "--minify"],
    { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] }
  );
  if (result.status !== 0) {
    console.error("[dev] tailwind build failed — pages will render unstyled");
    return;
  }
  console.log(`[dev] css rebuilt in ${Math.round(performance.now() - started)}ms`);
}

buildCss();

// Coalesce the burst of events a single editor save produces into one compile.
let pending: ReturnType<typeof setTimeout> | null = null;
function scheduleBuild(filename: string | null): void {
  if (filename && !/\.(tsx?|html|css)$/.test(filename)) return;
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    buildCss();
  }, 120);
}

for (const target of WATCH_TARGETS) {
  if (!fs.existsSync(target)) continue;
  fs.watch(target, { recursive: fs.statSync(target).isDirectory() }, (_event, filename) =>
    scheduleBuild(filename)
  );
}

const server = spawn("bun", ["--watch", "server.ts"], { cwd: ROOT, stdio: "inherit" });
server.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.kill(signal));
}
