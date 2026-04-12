#!/usr/bin/env bun
/**
 * Multi-host visual preview harness.
 * Starts the server against a DB, screenshots each tenant host via Chrome
 * host-resolver-rules (so the real Host header reaches dispatch), and reports
 * tail counts per host so you can see UA/HA/hub isolation at a glance.
 *
 *   bun scripts/preview-hosts.ts                       # /tmp/ua-test.sqlite
 *   bun scripts/preview-hosts.ts --db=./plane-data.sqlite --path=/fleet
 */

import { spawn } from "node:child_process";
import { type Browser, chromium } from "playwright";
import { HUB_HOSTS, enabledAirlines } from "../src/airlines/registry";

const args = process.argv.slice(2);
const dbPath = args.find((a) => a.startsWith("--db="))?.slice(5) ?? "/tmp/ua-test.sqlite";
const urlPath = args.find((a) => a.startsWith("--path="))?.slice(7) ?? "/";
const port = 39920;

const hosts = [
  ...enabledAirlines().map((a) => ({ host: a.canonicalHost, name: a.code.toLowerCase() })),
  { host: HUB_HOSTS[0], name: "hub" },
];

console.log(`\n=== preview-hosts · db=${dbPath} path=${urlPath} ===`);

const server = spawn("bun", ["server.ts"], {
  env: { ...process.env, DISABLE_JOBS: "1", DB_PATH: dbPath, PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});

const resolverRules = hosts.map((h) => `MAP ${h.host} 127.0.0.1`).join(",");

let browser: Browser | undefined;
try {
  await new Promise((r) => setTimeout(r, 2000));
  browser = await chromium.launch({ args: [`--host-resolver-rules=${resolverRules}`] });

  for (const { host, name } of hosts) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    try {
      await page.goto(`http://${host}:${port}${urlPath}`, {
        waitUntil: "networkidle",
        timeout: 15000,
      });
      await page.waitForTimeout(500);
      const out = `do_not_commit/preview-${name}${urlPath.replace(/\//g, "_")}.png`;
      await page.screenshot({ path: out });
      const tails = await page.evaluate(
        () => document.body.innerText.match(/N\d{3,5}[A-Z]{1,2}|A7-[A-Z]{3}/g)?.length || 0
      );
      console.log(
        `  ${name.padEnd(4)} ${host.padEnd(32)} tails=${String(tails).padStart(4)}  → ${out}`
      );
    } catch (e) {
      console.log(`  ${name.padEnd(4)} ${host.padEnd(32)} ERROR: ${(e as Error).message}`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser?.close();
  server.kill();
}
console.log();
