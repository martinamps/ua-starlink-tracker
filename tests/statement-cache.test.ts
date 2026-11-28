/**
 * bun:sqlite keeps only the first MAX_QUERY_CACHE_SIZE (default 20) distinct
 * SQL strings prepared; every later string is prepared again on each query().
 * openDatabase raises that bound so the server's few hundred strings stay
 * prepared. These tests pin the raise and the behaviour it relies on.
 */

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QUERY_CACHE_SIZE, openDatabase } from "../src/database/database";

const dir = mkdtempSync(join(tmpdir(), "stmt-cache-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("prepared statement cache", () => {
  const db = openDatabase(join(dir, "cache.sqlite"));
  db.exec("CREATE TABLE t (x INTEGER)");
  db.exec("INSERT INTO t VALUES (1), (2), (3)");

  test("openDatabase raises the bound and never lowers it", () => {
    expect(Database.MAX_QUERY_CACHE_SIZE).toBeGreaterThanOrEqual(QUERY_CACHE_SIZE);
    expect(QUERY_CACHE_SIZE).toBeGreaterThan(20);
  });

  test("a string past the default 20 comes back as the same prepared statement", () => {
    const sqls = Array.from({ length: 60 }, (_, i) => `SELECT x, ${i} AS k FROM t WHERE x <= ?`);
    const first = sqls.map((s) => db.query(s));
    const again = sqls.map((s) => db.query(s));
    for (let i = 0; i < sqls.length; i++) expect(again[i]).toBe(first[i]);
  });

  test("one cached string reused inside a loop over its own rows reads all of them", () => {
    const sql = "SELECT x FROM t WHERE x <= ? ORDER BY x";
    const outer = db.query(sql).all(3) as { x: number }[];
    const seen: number[] = [];
    for (const row of outer) {
      expect((db.query(sql).all(row.x) as unknown[]).length).toBe(row.x);
      seen.push(row.x);
    }
    expect(seen).toEqual([1, 2, 3]);
  });

  test("a half-read cached statement holds no snapshot: a checkpoint can truncate the WAL", () => {
    db.query("SELECT x FROM t ORDER BY x").get();
    const other = new Database(join(dir, "cache.sqlite"));
    other.exec("INSERT INTO t VALUES (4)");
    const cp = other.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
    other.close();
    expect(cp.busy).toBe(0);
  });
});
