/**
 * Google Sheets CSV-export retry policy. The hourly scrape aborts the whole
 * roster replace when any tab fails, so a transient 429/5xx near the end of
 * the 23-tab burst must retry before it can cost an hour of freshness — while
 * a permanent status (tab renamed/deleted) must fail fast and say so.
 */

import { describe, expect, test } from "bun:test";
import { SheetFetchError, fetchCsvWithRetry } from "../src/utils/utils";

function fakeFetch(responses: Array<number | Error>, calls: number[] = []) {
  let i = 0;
  const fetchFn = (async () => {
    calls.push(i);
    const next = responses[Math.min(i++, responses.length - 1)];
    if (next instanceof Error) throw next;
    return new Response(next === 200 ? "a,b\n1,2" : "nope", { status: next });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const noSleep = { sleep: async (_ms: number) => {} };

describe("fetchCsvWithRetry", () => {
  test("429 then 200 → retries and returns the CSV", async () => {
    const { fetchFn, calls } = fakeFetch([429, 200]);
    const csv = await fetchCsvWithRetry("https://x/export", { fetchFn, ...noSleep });
    expect(csv).toBe("a,b\n1,2");
    expect(calls.length).toBe(2);
  });

  test("network error then 200 → retries", async () => {
    const { fetchFn, calls } = fakeFetch([new Error("socket reset"), 200]);
    const csv = await fetchCsvWithRetry("https://x/export", { fetchFn, ...noSleep });
    expect(csv).toBe("a,b\n1,2");
    expect(calls.length).toBe(2);
  });

  test("persistent 5xx → exhausts retries, throws a retryable SheetFetchError", async () => {
    const { fetchFn, calls } = fakeFetch([503, 503, 503, 503]);
    const err = await fetchCsvWithRetry("https://x/export", { fetchFn, ...noSleep }).catch(
      (e) => e
    );
    expect(err).toBeInstanceOf(SheetFetchError);
    expect((err as SheetFetchError).retryable).toBe(true);
    expect((err as SheetFetchError).status).toBe(503);
    // 1 initial + one per configured backoff step — bounded, never unbounded.
    expect(calls.length).toBe(3);
  });

  test("4xx → fails immediately, marked permanent, message says the tab is gone", async () => {
    const { fetchFn, calls } = fakeFetch([400]);
    const err = await fetchCsvWithRetry("https://x/export", { fetchFn, ...noSleep }).catch(
      (e) => e
    );
    expect(err).toBeInstanceOf(SheetFetchError);
    expect((err as SheetFetchError).retryable).toBe(false);
    expect((err as SheetFetchError).status).toBe(400);
    expect((err as SheetFetchError).message).toContain("renamed or removed");
    expect(calls.length).toBe(1);
  });

  test("backoff waits between attempts, none before the first", async () => {
    const waits: number[] = [];
    const { fetchFn } = fakeFetch([429, 429, 200]);
    await fetchCsvWithRetry("https://x/export", {
      fetchFn,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(waits.length).toBe(2);
    for (const w of waits) expect(w).toBeGreaterThan(0);
    // Backs off harder on the second retry — one burst-wide blip should clear.
    expect(waits[1]).toBeGreaterThan(waits[0]);
  });
});
