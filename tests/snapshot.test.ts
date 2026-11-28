/**
 * The shared snapshot stays in rollback-journal mode. Under WAL a readonly
 * handle still opens -wal and -shm read-write and shares state through them;
 * CI's random "disk I/O error" on snapshot reads came from there. test:setup
 * puts the file back to DELETE after the migration switches it to WAL.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_DB, openSnapshot, snapshotInMemory } from "./helpers";

describe("test snapshot", () => {
  test("is in rollback-journal mode, so readers touch one file only", () => {
    const db = openSnapshot();
    const { journal_mode } = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    db.query("SELECT count(*) FROM meta").get();
    const sideFiles = ["-wal", "-shm"].filter((s) => existsSync(TEST_DB + s));
    db.close();
    expect({ journal_mode, sideFiles }).toEqual({ journal_mode: "delete", sideFiles: [] });
  });

  test("an in-memory copy works even from a file left in WAL", () => {
    const dir = mkdtempSync(join(tmpdir(), "snapshot-wal-"));
    try {
      const file = join(dir, "wal.sqlite");
      copyFileSync(TEST_DB, file);
      const wal = new Database(file);
      wal.exec("PRAGMA journal_mode = WAL");
      wal.close();
      const db = snapshotInMemory(file);
      db.run("CREATE TABLE copy_is_writable (x)");
      expect(db.query("SELECT count(*) AS n FROM meta").get()).toEqual({ n: expect.any(Number) });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
