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
import { chromium } from "playwright";
import { AIRLINES, HUB_HOSTS } from "../src/airlines/registry";

const args = process.argv.slice(2);
const dbPath = args.find((a) => a.startsWith("--db="))?.slice(5) ?? "/tmp/ua-test.sqlite";
const urlPath = args.find((a) => a.startsWith("--path="))?.slice(7) ?? "/";
const port = 39920;

const hosts = [
  ...Object.values(AIRLINES)
    .filter((a) => a.enabled)
    .map((a) => ({ host: a.canonicalHost, name: a.code.toLowerCase() })),
  { host: HUB_HOSTS[0], name: "hub" },
];

const resolverRule = "MAP * 127.0.0.1";

console.log(`\n=== preview-hosts · db=${dbPath} path=${urlPath} ===`);

const server = spawn("bun", ["server.ts"], {
  env: { ...process.env, DISABLE_JOBS: "1", DB_PATH: dbPath, PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});
await new Promise((r) => setTimeout(r, 2000));

const browser = await chromium.launch({ args: [`--host-resolver-rules=${resolverRule}`] });

for (const { host, name } of hosts) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  try {
    await page.goto(`http://${host}:${port}${urlPath}`, {
      waitUntil: "domcontentloaded",
      timeout: 10000,
    });
    await page.waitForTimeout(400);
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
  }
  await page.close();
}

await browser.close();
server.kill();
console.log();
