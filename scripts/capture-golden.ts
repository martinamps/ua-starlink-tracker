#!/usr/bin/env bun
/**
 * Regenerate both contract goldens after an INTENTIONAL contract change
 * (clients cache schemas at connect time — review the diff before
 * committing): the MCP tools/list fixture here, then api-contracts.json by
 * running its test with UPDATE_GOLDEN=1. Both run against empty in-memory
 * DBs, so this works on a fresh clone with no snapshot. `bun run
 * capture-golden` formats tests/golden afterwards to biome's JSON style.
 *
 * History note: the fixture reflects the 2026-05-09 anyOf removal from tool
 * input schemas (commit aaa83b1) — a real schema change, not just prose.
 */

import { Database } from "bun:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { setupTables } from "../src/database/database";
import { createApp } from "../src/server/app";
import { mcpReq } from "../tests/helpers";

const OUT = "tests/golden";

const db = new Database(":memory:");
setupTables(db);
const app = createApp(db);
const r = await app.dispatch(mcpReq("unitedstarlinktracker.com", "tools/list", {}));
if (r.status !== 200) throw new Error(`mcp tools/list → ${r.status}`);

await mkdir(OUT, { recursive: true });
await writeFile(`${OUT}/mcp-tools-list.json`, `${JSON.stringify(await r.json(), null, 2)}\n`);
console.log(`wrote ${OUT}/mcp-tools-list.json`);

const contracts = Bun.spawnSync(["bun", "test", "tests/api-contract-golden.test.ts"], {
  env: { ...process.env, UPDATE_GOLDEN: "1" },
  stdout: "inherit",
  stderr: "inherit",
});
if (contracts.exitCode !== 0) throw new Error("api-contract-golden failed while regenerating");
console.log(`wrote ${OUT}/api-contracts.json`);
