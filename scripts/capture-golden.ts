#!/usr/bin/env bun
/**
 * Regenerate the MCP tools/list golden after an INTENTIONAL contract change
 * (clients cache schemas at connect time — review the diff before
 * committing). Runs against an empty in-memory DB — tools/list is static
 * prose + schemas, so this works on a fresh clone with no snapshot. Run
 * `bun run format` after so the fixture matches biome's JSON style.
 *
 * History note: the fixture reflects the 2026-05-09 anyOf removal from tool
 * input schemas (commit aaa83b1) — a real schema change, not just prose.
 */

import { Database } from "bun:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { createApp } from "../src/server/app";
import { mcpReq } from "../tests/helpers";

const OUT = "tests/golden";

const app = createApp(new Database(":memory:"));
const r = await app.dispatch(mcpReq("unitedstarlinktracker.com", "tools/list", {}));
if (r.status !== 200) throw new Error(`mcp tools/list → ${r.status}`);

await mkdir(OUT, { recursive: true });
await writeFile(`${OUT}/mcp-tools-list.json`, `${JSON.stringify(await r.json(), null, 2)}\n`);
console.log(`wrote ${OUT}/mcp-tools-list.json`);
