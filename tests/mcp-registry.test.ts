/**
 * MCP distribution metadata: registry server.json files stay in step with
 * what the server actually announces, and the misrouted-client alias
 * redirects into the real endpoint.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SITES } from "../src/airlines/registry";
import { MCP_SERVER_VERSION } from "../src/api/mcp-server";
import { setupTables } from "../src/database/database";
import { createApp } from "../src/server/app";
import { postMcp, req } from "./helpers";

const REGISTRY: Array<[string, string]> = [
  ["server.ua.json", SITES.united.canonicalHost],
  ["server.hub.json", SITES.airline.canonicalHost],
];

const readServerJson = (file: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, "..", "registry", file), "utf8"));

function emptyApp() {
  const db = new Database(":memory:");
  setupTables(db);
  return createApp(db);
}

describe("registry server.json", () => {
  test.each(REGISTRY)("%s matches serverInfo and its host", async (file, host) => {
    const s = readServerJson(file);
    expect(s.version).toBe(MCP_SERVER_VERSION);
    const domain = host.replace(/\.com$/, "");
    expect(s.name).toBe(`com.${domain}/starlink-tracker`);
    expect(s.remotes).toEqual([{ type: "streamable-http", url: `https://${host}/mcp` }]);
    expect(s.description.length).toBeLessThanOrEqual(100);

    const init = await postMcp(emptyApp(), host, "initialize", { protocolVersion: "2025-06-18" });
    expect(init.result.serverInfo.version).toBe(s.version);
    expect(init.result.serverInfo.websiteUrl).toBe(`https://${host}`);
    expect(typeof init.result.serverInfo.title).toBe("string");
  });
});

describe("/mcp.com/mcp alias", () => {
  const host = SITES.united.canonicalHost;

  test("POST 308s to /mcp, keeping the query string", async () => {
    const r = await emptyApp().dispatch(
      req("/mcp.com/mcp?scope=ALL", host, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      })
    );
    expect(r.status).toBe(308);
    expect(r.headers.get("location")).toBe("/mcp?scope=ALL");
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("OPTIONS answers the preflight instead of redirecting", async () => {
    const r = await emptyApp().dispatch(req("/mcp.com/mcp", host, { method: "OPTIONS" }));
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-methods")).toContain("POST");
  });
});
