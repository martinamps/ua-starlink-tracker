// Pins the SEC submissions parsing, the seed/record idempotency, and that the
// watcher only surfaces filings it hasn't seen before.

import { describe, expect, test } from "bun:test";
import { getFleetAnchors, recordSecFilings } from "../src/database/database";
import { SEED_ANCHORS, extractRecentFilings, runSecAnchorsSync } from "../src/scripts/sec-anchors";
import { makeSyntheticDb } from "./helpers";

const NOW = Date.parse("2026-06-14");

const SUBMISSIONS_FIXTURE = {
  filings: {
    recent: {
      accessionNumber: [
        "0000100517-26-000089",
        "0000100517-26-000050",
        "0000100517-26-000023",
        "0000100517-20-000001",
      ],
      form: ["8-K", "8-K", "10-K", "10-K"],
      filingDate: ["2026-04-21", "2026-03-10", "2026-02-26", "2020-02-26"],
      primaryDocument: [
        "ual_erx03312026xex991.htm",
        "financing.htm",
        "ual-20251231.htm",
        "old.htm",
      ],
      // Earnings 8-K (Item 2.02) vs a financing 8-K that must be ignored.
      items: ["2.02,9.01", "8.01,9.01", "", ""],
    },
  },
};

describe("extractRecentFilings", () => {
  test("keeps watched forms inside the window and builds archive URLs", () => {
    const filings = extractRecentFilings(
      "0000100517",
      "United Airlines Holdings",
      SUBMISSIONS_FIXTURE,
      NOW
    );
    expect(filings.map((f) => f.accession)).toEqual([
      "0000100517-26-000089",
      "0000100517-26-000023",
    ]);
    expect(filings[0].primary_doc_url).toBe(
      "https://www.sec.gov/Archives/edgar/data/100517/000010051726000089/ual_erx03312026xex991.htm"
    );
  });

  test("returns nothing for malformed submissions documents", () => {
    expect(extractRecentFilings("0000100517", "UAL", {}, NOW)).toEqual([]);
  });
});

describe("sec anchors storage and sync", () => {
  test("recordSecFilings returns only filings not seen before", () => {
    const db = makeSyntheticDb();
    const filings = extractRecentFilings("0000100517", "UAL", SUBMISSIONS_FIXTURE, NOW);
    expect(recordSecFilings(db, filings).length).toBe(2);
    expect(recordSecFilings(db, filings).length).toBe(0);
  });

  test("runSecAnchorsSync seeds anchors, records filings, and is idempotent", async () => {
    const db = makeSyntheticDb();
    const fetcher = (async () =>
      new Response(JSON.stringify(SUBMISSIONS_FIXTURE), { status: 200 })) as typeof fetch;

    const first = await runSecAnchorsSync(db, fetcher);
    expect(first.outcome).toBe("success");
    expect(first.newFilings).toBeGreaterThan(0);
    expect(first.anchors).toBe(SEED_ANCHORS.length);
    expect(getFleetAnchors(db, "UA").some((a) => a.metric === "mainline_fleet_total")).toBe(true);
    expect(getFleetAnchors(db, "HA")).toEqual([]);

    const second = await runSecAnchorsSync(db, fetcher);
    expect(second.newFilings).toBe(0);
    expect(second.anchors).toBe(SEED_ANCHORS.length);
  });

  test("reports error when every submissions fetch fails", async () => {
    const db = makeSyntheticDb();
    const fetcher = (async () => new Response("denied", { status: 403 })) as typeof fetch;
    const result = await runSecAnchorsSync(db, fetcher);
    expect(result.outcome).toBe("error");
    // Anchors are still seeded — they don't depend on the network.
    expect(result.anchors).toBe(SEED_ANCHORS.length);
  });
});
