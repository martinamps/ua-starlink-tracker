#!/usr/bin/env bun
/**
 * Capture golden HTTP fixtures from the current server before refactoring.
 * Run after `bun run test:setup`. Spawns server.ts on PORT 3999 with jobs
 * disabled and DB pointed at the test snapshot, fetches a fixed set of
 * endpoints, writes pretty-printed JSON to tests/golden/.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "bun";

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = "tests/golden";
const TEST_DB = "/tmp/ua-test.sqlite";

async function waitForReady(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/data`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
    } catch {}
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`server did not become ready on :${PORT} within ${timeoutMs}ms`);
}

async function getJSON(path: string) {
  const r = await fetch(`${BASE}${path}`, {
    headers: { Host: "unitedstarlinktracker.com" },
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

async function postMcp(method: string, params: unknown) {
  const r = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "unitedstarlinktracker.com" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!r.ok) throw new Error(`mcp ${method} → ${r.status}`);
  return r.json();
}

async function main() {
  await mkdir(OUT, { recursive: true });

  const proc = spawn({
    cmd: ["bun", "run", "server.ts"],
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: TEST_DB,
      DISABLE_JOBS: "1",
      NODE_ENV: "test",
      DD_TRACE_ENABLED: "false",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    await waitForReady();

    const fixtures: Record<string, unknown> = {
      "api-data.json": await getJSON("/api/data"),
      "api-check-flight-UA123.json": await getJSON(
        "/api/check-flight?flight_number=UA123&date=2026-03-20"
      ),
      "api-check-flight-UA4421.json": await getJSON(
        "/api/check-flight?flight_number=UA4421&date=2026-03-22"
      ),
      "mcp-initialize.json": await postMcp("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "golden", version: "1" },
      }),
      "mcp-tools-list.json": await postMcp("tools/list", {}),
    };

    for (const [name, body] of Object.entries(fixtures)) {
      await writeFile(`${OUT}/${name}`, `${JSON.stringify(body, null, 2)}\n`);
      console.log(`wrote ${OUT}/${name}`);
    }
  } finally {
    proc.kill();
    await proc.exited;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
