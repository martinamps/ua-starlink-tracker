/**
 * A page rendered by one build asks for that build's fingerprinted scripts
 * later: the route planner fetches the airport picker only when a box is first
 * touched. After a deploy that changed the picker, its old name has to keep
 * answering, or the open page finds no airports until it is reloaded.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { openAssetArchive } from "../src/server/asset-archive";
import { bodyOf, openSnapshot, req } from "./helpers";

const HOST = "unitedstarlinktracker.com";
const DAY = 24 * 3600 * 1000;
const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "asset-archive-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("previous builds' assets after a deploy", () => {
  const db = openSnapshot();

  test("an open route planner's picker still loads once the next build serves", async () => {
    const dir = tempDir();
    const before = createApp(db, { assetArchive: null });
    const { text: page } = await bodyOf(before, "/route-planner", HOST);
    const pickerSrc = page.match(/data-picker-src="([^"]+)"/)?.[1];
    expect(pickerSrc).toMatch(/^\/static\/airport-picker\.[0-9a-z]+\.js$/);

    // Build one stored its picker; build two's picker is different code, so
    // build one's name is no longer one this process holds.
    const previous = (pickerSrc as string).replace(/\.[0-9a-z]+\.js$/, ".0prevbuild1.js");
    const previousCode = "window.attachAirportBox=function(){};";
    openAssetArchive(dir).keep(previous, previousCode);

    const after = createApp(db, { assetArchive: openAssetArchive(dir) });
    const res = await after.dispatch(req(previous, HOST));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/javascript");
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    expect(await res.text()).toBe(previousCode);

    // A name no build ever had is still a miss nobody stores.
    const never = await after.dispatch(req("/static/airport-picker.1xdu1m88z8ihp.js", HOST));
    expect(never.status).toBe(404);
    expect(never.headers.get("Cache-Control")).toBe("no-store");
  });

  test("a previous build's stylesheet answers too", async () => {
    const dir = tempDir();
    openAssetArchive(dir).keep("/static/tailwind.0prevbuild2.css", "@layer base{}");
    const app = createApp(db, { assetArchive: openAssetArchive(dir) });
    const res = await app.dispatch(req("/static/tailwind.0prevbuild2.css", HOST));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/css");
  });

  test("only fingerprinted names are looked up, and never outside the folder", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "secret.txt"), "no");
    writeFileSync(join(dir, "notes.js"), "no");
    const archive = openAssetArchive(dir);
    const app = createApp(db, { assetArchive: archive });
    for (const path of [
      "/static/secret.txt",
      "/static/notes.js",
      "/static/../secret.txt",
      "/static/%2e%2e%2fsecret.txt",
      "/static/a/b.0prevbuild3.js",
      "/static/Home.0prevbuild3.js",
    ]) {
      expect({ path, found: archive.find(path) }).toEqual({ path, found: null });
      const res = await app.dispatch(req(path, HOST));
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }
    archive.keep("/static/../escape.0prevbuild4.js", "no");
    archive.keep("/static/notes.js", "no");
    expect(existsSync(join(dir, "..", "escape.0prevbuild4.js"))).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(["notes.js", "secret.txt"]);
  });
});

describe("how long the archive keeps a build", () => {
  const href = "/static/route-planner.0prevbuild5.js";

  test("a week after a build last served a file, the next boot drops it", () => {
    const dir = tempDir();
    const t0 = Date.UTC(2026, 10, 20);
    openAssetArchive(dir, { now: () => t0 }).keep(href, "x");

    expect(openAssetArchive(dir, { now: () => t0 + 6 * DAY }).find(href)).not.toBeNull();

    openAssetArchive(dir, { now: () => t0 + 8 * DAY });
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a file the new build also serves is stamped fresh, however old", () => {
    const dir = tempDir();
    const t0 = Date.UTC(2026, 10, 1);
    openAssetArchive(dir, { now: () => t0 }).keep(href, "x");
    const later = t0 + 30 * DAY;
    const archive = openAssetArchive(dir, { now: () => later });
    archive.keep(href, "x");
    expect(archive.find(href)).not.toBeNull();
    expect(openAssetArchive(dir, { now: () => later + 6 * DAY }).find(href)).not.toBeNull();
  });

  test("a stored file is never rewritten: the name is its content", async () => {
    const dir = tempDir();
    const archive = openAssetArchive(dir);
    archive.keep(href, "first");
    archive.keep(href, "second");
    expect(await Bun.file(join(dir, "route-planner.0prevbuild5.js")).text()).toBe("first");
  });

  test("a folder it cannot write leaves the server serving", () => {
    const dir = tempDir();
    const blocked = join(dir, "file-not-folder");
    writeFileSync(blocked, "");
    const archive = openAssetArchive(blocked);
    expect(() => archive.keep(href, "x")).not.toThrow();
    expect(archive.find(href)).toBeNull();
  });
});
