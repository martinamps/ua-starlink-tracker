/**
 * Distribution surfaces: the newly-equipped Atom feed and page. Shape
 * assertions only — entry counts and dates ride the live snapshot and must
 * survive data drift.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SITES } from "../src/airlines/registry";
import { getFirstFlights, recordFirstFlights } from "../src/database/database";
import { createApp } from "../src/server/app";
import { bodyOf, makeSyntheticDb, openSnapshot, req } from "./helpers";

// (SITES is iterated for the badge sweep; tenant pages are covered by the
// tenant-matrix ROUTES table.)

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  app = createApp(openSnapshot());
});

const UA = SITES.united.canonicalHost;
const HUB = SITES.airline.canonicalHost;
const QR = SITES.qatar.canonicalHost;

// ─────────────────────────────────────────────────────────────────────────────
// /feed.xml — newly-equipped Atom feed
// ─────────────────────────────────────────────────────────────────────────────

describe("newly-equipped Atom feed", () => {
  test("UA host serves valid Atom shape with entries", async () => {
    const res = await app.dispatch(req("/feed.xml", UA));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/atom+xml");
    expect(res.headers.get("Cache-Control")).toContain("public");
    const xml = await res.text();
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(xml).toContain(`<link href="https://${UA}/feed.xml" rel="self"/>`);
    // Snapshot always carries organic UA installs (sheet-scraped rows).
    expect(xml).toContain("<entry>");
    // Required Atom elements per entry.
    expect(xml).toMatch(/<entry>[\s\S]*?<title>[\s\S]*?<id>[\s\S]*?<updated>/);
  });

  test("entry ids and links stay on the serving host", async () => {
    for (const host of [UA, HUB]) {
      const { status, text } = await bodyOf(app, "/feed.xml", host);
      expect(status).toBe(200);
      const ids = [...text.matchAll(/<id>([^<]+)<\/id>/g)].map((m) => m[1]);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        expect(new URL(id).host, `${host} feed id ${id}`).toBe(host);
      }
    }
  });

  test("feed <updated> derives from data, not the request clock", async () => {
    const first = await (await app.dispatch(req("/feed.xml", UA))).text();
    await new Promise((r) => setTimeout(r, 5));
    const second = await (await app.dispatch(req("/feed.xml", UA))).text();
    expect(second).toBe(first);
    const stamps = [...first.matchAll(/<updated>([^<]+)<\/updated>/g)].map((m) => m[1]);
    const now = Date.now();
    for (const s of stamps) {
      const t = Date.parse(s);
      expect(Number.isNaN(t), `unparseable <updated> ${s}`).toBe(false);
      expect(t).toBeLessThanOrEqual(now);
    }
  });

  test("404 where the feature is off (qatar)", async () => {
    const res = await app.dispatch(req("/feed.xml", QR));
    expect(res.status).toBe(404);
  });

  test("POST is not a feed method", async () => {
    const res = await app.dispatch(req("/feed.xml", UA, { method: "POST" }));
    expect(res.status).toBe(405);
  });
});

describe("feed autodiscovery link", () => {
  test("advertised in <head> only where the feed serves", async () => {
    const ua = await bodyOf(app, "/", UA);
    expect(ua.text).toContain('type="application/atom+xml"');
    expect(ua.text).toContain(`https://${UA}/feed.xml`);
    const qr = await bodyOf(app, "/", QR);
    expect(qr.text).not.toContain('type="application/atom+xml"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /badge.svg + /embed
// ─────────────────────────────────────────────────────────────────────────────

describe("/badge.svg", () => {
  test("every site serves a cacheable SVG with its own live stat", async () => {
    for (const site of Object.values(SITES)) {
      const res = await app.dispatch(req("/badge.svg", site.canonicalHost));
      expect(res.status, site.key).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("image/svg+xml");
      expect(res.headers.get("Cache-Control")).toContain("public");
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      const svg = await res.text();
      expect(svg).toContain("<svg");
      // "N of M aircraft" with real numbers — shape, not values.
      expect(svg).toMatch(/\d+ of \d+ aircraft/);
      expect(svg).toContain(site.brand.accentColor);
    }
  });

  test("tenant badge names its airline; hub badge stays generic", async () => {
    const ua = await bodyOf(app, "/badge.svg", UA);
    expect(ua.text).toContain("United Starlink");
    const hub = await bodyOf(app, "/badge.svg", HUB);
    expect(hub.text).toContain("Airline Starlink");
    expect(hub.text).not.toContain("United Starlink");
  });

  test("POST → 405", async () => {
    const res = await app.dispatch(req("/badge.svg", UA, { method: "POST" }));
    expect(res.status).toBe(405);
  });
});

describe("/embed page", () => {
  test("documents the badge with host-correct snippets", async () => {
    const { status, text } = await bodyOf(app, "/embed", UA);
    expect(status).toBe(200);
    expect(text).toContain(`https://${UA}/badge.svg`);
    expect(text).toContain('src="/badge.svg"'); // live preview
  });

  test("hub /embed uses the hub host in snippets", async () => {
    const { status, text } = await bodyOf(app, "/embed", HUB);
    expect(status).toBe(200);
    expect(text).toContain(`https://${HUB}/badge.svg`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Share-card download link (pre-rendered by the nightly og batch)
// ─────────────────────────────────────────────────────────────────────────────

describe("share-card link", () => {
  const uaCard = join(import.meta.dir, "..", "static", "share-card-ua.png");

  test("absent until the batch has rendered the card", async () => {
    if (existsSync(uaCard)) return; // a locally generated card makes this moot
    const { text } = await bodyOf(app, "/", UA);
    expect(text).not.toContain("share-card-ua.png");
  });

  test("offered once the card exists, tenant-scoped path", async () => {
    const had = existsSync(uaCard);
    if (!had) writeFileSync(uaCard, "png");
    try {
      for (const path of ["/", "/fleet"]) {
        const { text } = await bodyOf(app, path, UA);
        expect(text, `${path} misses share link`).toContain("/static/share-card-ua.png");
        expect(text).toContain("download");
      }
      // The hub never offers a tenant's card (its own would be share-card-hub).
      const hub = await bodyOf(app, "/", HUB);
      expect(hub.text).not.toContain("share-card-ua.png");
    } finally {
      if (!had) unlinkSync(uaCard);
    }
  });
});

describe("/newly-equipped page", () => {
  test("UA host renders install rows linking the feed", async () => {
    const { status, text } = await bodyOf(app, "/newly-equipped", UA);
    expect(status).toBe(200);
    expect(text).toContain("Newly Equipped Aircraft");
    expect(text).toContain('href="/feed.xml"');
  });

  test("hub renders (aggregate across airlines)", async () => {
    const { status } = await bodyOf(app, "/newly-equipped", HUB);
    expect(status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// recordFirstFlights — the detection job behind the feed's "first flight" line.
// Synthetic DB (write path): the snapshot is readonly and carries no installs
// inside the 14-day window, so these are constructed rather than drifted-upon.
// ─────────────────────────────────────────────────────────────────────────────

describe("recordFirstFlights", () => {
  const NOW = Math.floor(Date.now() / 1000);
  const dayOf = (epoch: number) => new Date(epoch * 1000).toISOString().slice(0, 10);
  const midnight = (day: string) => Math.floor(new Date(`${day}T00:00:00Z`).getTime() / 1000);

  function seedTail(
    db: ReturnType<typeof makeSyntheticDb>,
    tail: string,
    day: string,
    gid: string,
    departures: [flight: string, origin: string, destination: string, at: number][]
  ) {
    db.query(
      `INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber, OperatedBy, fleet, verified_wifi, airline)
       VALUES ('B737','Starlink',?,'UA-mainline',?,?,'United','mainline','Starlink','UA')`
    ).run(gid, day, tail);
    for (const [flight, origin, destination, at] of departures) {
      db.query(
        `INSERT INTO upcoming_flights (tail_number, flight_number, departure_airport, arrival_airport, departure_time, arrival_time, last_updated, airline)
         VALUES (?,?,?,?,?,?,?, 'UA')`
      ).run(tail, flight, origin, destination, at, at + 9000, NOW);
    }
  }

  const recentDay = dayOf(NOW - 3 * 86400);
  const recentInstall = midnight(recentDay);

  test("records the earliest departed flight, not an arbitrary row", () => {
    const db = makeSyntheticDb();
    // Earliest is inserted second — a bare-column MIN that ignored rowid order
    // would hand back UA200 and quietly fabricate the scoop.
    seedTail(db, "N00TST", recentDay, "discovery", [
      ["UA200", "ORD", "DEN", recentInstall + 40000],
      ["UA100", "EWR", "SFO", recentInstall + 10000],
      ["UA300", "IAH", "LAX", recentInstall + 90000],
    ]);

    const recorded = recordFirstFlights(db, NOW);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      tail_number: "N00TST",
      airline: "UA",
      flight_number: "UA100",
      origin: "EWR",
      destination: "SFO",
    });
    expect(typeof recorded[0].departed_at).toBe("number");
    expect(typeof recorded[0].recorded_at).toBe("number");
    db.close();
  });

  test("returns only this call's inserts, so a tail notifies once", () => {
    const db = makeSyntheticDb();
    seedTail(db, "N00TST", recentDay, "discovery", [
      ["UA100", "EWR", "SFO", recentInstall + 10000],
    ]);

    expect(recordFirstFlights(db, NOW)).toHaveLength(1);
    expect(recordFirstFlights(db, NOW)).toHaveLength(0);
    expect(getFirstFlights(db, ["N00TST"], "UA")).toHaveLength(1);
    db.close();
  });

  test("reads back tenant-scoped", () => {
    const db = makeSyntheticDb();
    seedTail(db, "N00TST", recentDay, "discovery", [
      ["UA100", "EWR", "SFO", recentInstall + 10000],
    ]);
    recordFirstFlights(db, NOW);

    expect(getFirstFlights(db, ["N00TST"], "UA")).toHaveLength(1);
    expect(getFirstFlights(db, ["N00TST"], "HA")).toHaveLength(0);
    db.close();
  });

  test("abstains where the record would be a guess", () => {
    const db = makeSyntheticDb();
    // Not yet departed — nothing to report.
    seedTail(db, "N01TST", recentDay, "discovery", [["UA900", "SFO", "JFK", NOW + 50000]]);
    // Bulk seed import: DateFound is the import date, not an install date.
    seedTail(db, "N02TST", recentDay, "ua_seed", [["UA901", "SFO", "JFK", recentInstall + 5000]]);
    // Older than the 14-day window: upcoming_flights only looks ~2 days ahead,
    // so its "earliest" row is today's flight, not the true first.
    const oldDay = dayOf(NOW - 40 * 86400);
    seedTail(db, "N03TST", oldDay, "discovery", [["UA902", "SFO", "JFK", midnight(oldDay) + 5000]]);

    expect(recordFirstFlights(db, NOW)).toEqual([]);
    db.close();
  });
});
