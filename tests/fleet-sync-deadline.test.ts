/**
 * syncFullFleet's per-airline deadline: a hung FR24 page (page.evaluate has no
 * timeout) must not hold the Chromium browser for good. No network: a fake
 * browser and a fake per-airline sync stand in for Playwright and FR24.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { Browser } from "playwright";
import { AIRLINES, type AirlineConfig } from "../src/airlines/registry";
import {
  type FR24SyncResult,
  FR24_DEADLINE_ERROR,
  type FullFleetDeps,
  syncFleetFromFR24,
  syncFullFleet,
} from "../src/scripts/fleet-sync";

const airline = (code: string): AirlineConfig => ({
  ...AIRLINES.UA,
  code,
  fr24Slug: code.toLowerCase(),
});
const AIRLINES_3 = [airline("A1"), airline("A2"), airline("A3")];

const ok = (cfg: AirlineConfig): FR24SyncResult => ({
  airline: cfg.code,
  success: true,
  total: 1,
  new: 0,
  updated: 1,
  rejected: 0,
});

interface FakeBrowser {
  id: number;
  closes: number;
  onClose: Array<() => void>;
}

function harness(
  syncOne: (cfg: AirlineConfig, b: FakeBrowser, signal: AbortSignal) => Promise<FR24SyncResult>
) {
  const browsers: FakeBrowser[] = [];
  const attempts: string[] = [];
  const signals = new Map<string, AbortSignal>();
  const deps: FullFleetDeps = {
    airlines: AIRLINES_3,
    deadlineMs: 50,
    gapMs: 0,
    spreadsheet: async () => ({ success: true, synced: 0 }),
    launch: async () => {
      const b: FakeBrowser = { id: browsers.length, closes: 0, onClose: [] };
      browsers.push(b);
      const fake = {
        close: async () => {
          b.closes++;
          for (const fn of b.onClose) fn();
        },
      };
      (fake as unknown as { __fake: FakeBrowser }).__fake = b;
      return fake as unknown as Browser;
    },
    syncOne: (_db, cfg, browser, signal) => {
      attempts.push(cfg.code);
      signals.set(cfg.code, signal);
      return syncOne(cfg, (browser as unknown as { __fake: FakeBrowser }).__fake, signal);
    },
  };
  return { deps, browsers, attempts, signals };
}

const db = new Database(":memory:");

describe("syncFullFleet deadline", () => {
  test("a hung airline trips the deadline, its browser closes, the next airline gets a fresh one", async () => {
    // Like Playwright: closing the browser rejects the call that hung in it.
    const h = harness((cfg, b) =>
      cfg.code === "A2"
        ? new Promise((_, reject) => b.onClose.push(() => reject(new Error("Target closed"))))
        : Promise.resolve(ok(cfg))
    );
    const started = Date.now();
    const result = await syncFullFleet(db, h.deps);
    expect(Date.now() - started).toBeLessThan(1000);

    expect(h.attempts).toEqual(["A1", "A2", "A3"]);
    expect(result.fr24.map((r) => [r.airline, r.success, r.error ?? null])).toEqual([
      ["A1", true, null],
      ["A2", false, FR24_DEADLINE_ERROR],
      ["A3", true, null],
    ]);
    expect(h.signals.get("A2")?.aborted).toBe(true);
    expect(h.signals.get("A1")?.aborted).toBe(false);
    expect(h.browsers.map((b) => b.closes)).toEqual([1, 1]);
    expect(result.spreadsheet.success).toBe(true);
  });

  test("a call that never settles, even after close, still frees the loop", async () => {
    const h = harness((cfg) =>
      cfg.code === "A1" ? new Promise(() => {}) : Promise.resolve(ok(cfg))
    );
    const result = await syncFullFleet(db, h.deps);
    expect(result.fr24.map((r) => r.error ?? null)).toEqual([FR24_DEADLINE_ERROR, null, null]);
    expect(h.browsers.map((b) => b.closes)).toEqual([1, 1]);
  });

  test("every airline in time: one browser, closed once, all results back", async () => {
    const h = harness(async (cfg) => ok(cfg));
    const result = await syncFullFleet(db, h.deps);
    expect(result.fr24.map((r) => r.success)).toEqual([true, true, true]);
    expect(h.browsers.map((b) => b.closes)).toEqual([1]);
  });

  test("a throwing airline is recorded and the loop goes on", async () => {
    const h = harness(async (cfg) => {
      if (cfg.code === "A1") throw new Error("boom");
      return ok(cfg);
    });
    const result = await syncFullFleet(db, h.deps);
    expect(result.fr24.map((r) => r.error ?? null)).toEqual(["boom", null, null]);
    expect(h.browsers.map((b) => b.closes)).toEqual([1]);
  });

  test("a failed relaunch fails that airline only", async () => {
    const h = harness((cfg) =>
      cfg.code === "A1" ? new Promise(() => {}) : Promise.resolve(ok(cfg))
    );
    const launch = h.deps.launch as NonNullable<FullFleetDeps["launch"]>;
    let launches = 0;
    h.deps.launch = async () => {
      launches++;
      if (launches === 2) throw new Error("launch failed");
      return launch();
    };
    const result = await syncFullFleet(db, h.deps);
    expect(result.fr24.map((r) => r.error ?? null)).toEqual([
      FR24_DEADLINE_ERROR,
      "launch failed",
      null,
    ]);
    expect(h.attempts).toEqual(["A1", "A3"]);
    expect(h.browsers.map((b) => b.closes)).toEqual([1, 1]);
  });

  test("a sync whose deadline already passed scrapes and writes nothing", async () => {
    const abort = new AbortController();
    abort.abort();
    const browser = {
      newContext: () => {
        throw new Error("should not scrape");
      },
    } as unknown as Browser;
    const result = await syncFleetFromFR24(db, airline("A1"), browser, abort.signal);
    expect(result).toMatchObject({ success: false, error: FR24_DEADLINE_ERROR, total: 0 });
  });
});
