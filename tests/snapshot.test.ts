/**
 * The shared snapshot stays in rollback-journal mode. Under WAL a readonly
 * handle still opens -wal and -shm read-write and shares state through them;
 * CI's random "disk I/O error" on snapshot reads came from there. test:setup
 * puts the file back to DELETE after the migration switches it to WAL.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { TEST_DB, openSnapshot } from "./helpers";

describe("test snapshot", () => {
  test("is in rollback-journal mode, so readers touch one file only", () => {
    const db = openSnapshot();
    const { journal_mode } = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    db.query("SELECT count(*) FROM meta").get();
    const sideFiles = ["-wal", "-shm"].filter((s) => existsSync(TEST_DB + s));
    db.close();
    expect({ journal_mode, sideFiles }).toEqual({ journal_mode: "delete", sideFiles: [] });
  });
});
