/**
 * Golden snapshots — the multi-airline refactor must produce byte-identical
 * UA-host responses to what server.ts produced before any of it shipped.
 * Fixtures captured by `bun scripts/capture-golden.ts` against the test
 * snapshot BEFORE canary seeding.
 */

import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createApp } from "../src/server/app";

const G = "tests/golden";
const TEST_DB = "/tmp/ua-test.sqlite";
const UA = "unitedstarlinktracker.com";
const load = (name: string) => JSON.parse(readFileSync(`${G}/${name}`, "utf8"));

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  const db = new Database(TEST_DB, { readonly: true });
  app = createApp(db);
});

function req(path: string, init: RequestInit = {}) {
  return new Request(`http://x${path}`, {
    ...init,
    headers: { Host: UA, ...(init.headers as Record<string, string>) },
  });
}

async function getJSON(path: string) {
  const r = await app.dispatch(req(path));
  expect(r.status).toBe(200);
  return r.json();
}

async function postMcp(method: string, params: unknown) {
  const r = await app.dispatch(
    req("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    })
  );
  expect(r.status).toBe(200);
  return r.json();
}

describe("golden snapshots (refactor must be byte-identical)", () => {
  test("/api/data", async () => {
    const live = await getJSON("/api/data");
    expect(live).toEqual(load("api-data.json"));
  });

  test("/api/check-flight UA123 (false)", async () => {
    const live = await getJSON("/api/check-flight?flight_number=UA123&date=2026-03-20");
    expect(live).toEqual(load("api-check-flight-UA123.json"));
  });

  test("/api/check-flight UA4421 (true, verified)", async () => {
    const live = await getJSON("/api/check-flight?flight_number=UA4421&date=2026-03-22");
    expect(live).toEqual(load("api-check-flight-UA4421.json"));
  });

  test("MCP initialize", async () => {
    const live = await postMcp("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "golden", version: "1" },
    });
    expect(live).toEqual(load("mcp-initialize.json"));
  });

  test("MCP tools/list", async () => {
    const live = await postMcp("tools/list", {});
    expect(live).toEqual(load("mcp-tools-list.json"));
  });
});
