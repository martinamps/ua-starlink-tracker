/**
 * Distribution surfaces: the newly-equipped Atom feed and page. Shape
 * assertions only — entry counts and dates ride the live snapshot and must
 * survive data drift.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AIRLINES, SITES, type SiteConfig } from "../src/airlines/registry";
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

/** The airline a site is bound to; null on the hub (which has no single one). */
const airlineOf = (site: SiteConfig) => (site.scope === "ALL" ? null : AIRLINES[site.scope]);

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

  test("entries date the find, not the install", async () => {
    // DateFound is when this tracker saw the tail. The page carries that caveat
    // in its footer; a syndicated entry reaches press without the footer, so
    // the wording has to travel with it.
    const { text } = await bodyOf(app, "/feed.xml", UA);
    expect(text).toContain("was first observed with Starlink on");
    expect(text).toContain("not necessarily the install date");
    expect(text).not.toContain("joined the Starlink-equipped fleet on");
    // …and the feed-level description says the same thing.
    expect(text).toMatch(/<subtitle>[^<]*not when the antenna went on/);
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
  test("every site with the feature on serves a cacheable SVG with its own live stat", async () => {
    for (const site of Object.values(SITES)) {
      const res = await app.dispatch(req("/badge.svg", site.canonicalHost));
      if (!site.features.embedPage) {
        // The badge rides the /embed flag — it was the one new surface a
        // tenant had no way to turn off.
        expect(res.status, site.key).toBe(404);
        continue;
      }
      expect(res.status, site.key).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("image/svg+xml");
      expect(res.headers.get("Cache-Control")).toContain("public");
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      const svg = await res.text();
      expect(svg).toContain("<svg");
      expect(svg).toContain(site.brand.accentColor);
      // Shape, not values: a denominator only where the tracked roster IS the
      // programme's own scope.
      const cfg = airlineOf(site);
      if (!cfg || cfg.rollout.rosterIsProgramScope) {
        expect(svg, site.key).toMatch(/\d+ of \d+ aircraft/);
      } else {
        expect(svg, site.key).toMatch(/\d+ aircraft equipped/);
      }
    }
  });

  test("a roster wider than the programme never publishes a ratio", async () => {
    // HA's 61 tails include 717s that will never be equipped and QR's 277
    // include narrowbodies and freighters the programme excludes — so "42 of
    // 61" would advertise a finished rollout as two-thirds done, cross-origin,
    // with none of the status chip context that qualifies it on-site.
    const outOfScope = Object.values(SITES).filter(
      (s) => s.features.embedPage && airlineOf(s)?.rollout.rosterIsProgramScope === false
    );
    expect(outOfScope.length, "no out-of-scope tenant to cover").toBeGreaterThan(0);
    for (const site of outOfScope) {
      const { text } = await bodyOf(app, "/badge.svg", site.canonicalHost);
      expect(text, site.key).not.toMatch(/\d+ of \d+/);
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

  test("only points at /api/fleet-summary where the tenant is in it", async () => {
    // The endpoint serves publicAirlines(); QR is publicInHub false, so a
    // Qatar visitor following that link would get three other carriers and
    // none of the airline they came for.
    const payload = await bodyOf(app, "/api/fleet-summary", HUB);
    const codes: string[] = JSON.parse(payload.text).airlines.map((a: { code: string }) => a.code);
    for (const site of Object.values(SITES)) {
      if (!site.features.embedPage) continue;
      const cfg = airlineOf(site);
      const { text } = await bodyOf(app, "/embed", site.canonicalHost);
      const present = !cfg || codes.includes(cfg.code);
      expect(text.includes("/api/fleet-summary"), `${site.key} fleet-summary link`).toBe(present);
    }
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

describe("secondary pages are reachable, not just sitemapped", () => {
  // Shipped as orphans: sitemapped and indexable with zero inbound href from
  // any component, so no PageRank path in and no way for a visitor to find
  // them. The footer nav is built from the same sitePages() filter, so a link
  // can never outlive the page it points at.
  const SECONDARY = ["/newly-equipped", "/install-rate", "/embed"];

  test("every advertised secondary page is linked from the pages a visitor lands on", async () => {
    const sitemap = await bodyOf(app, "/sitemap.xml", UA);
    const advertised = SECONDARY.filter((p) => sitemap.text.includes(`https://${UA}${p}<`));
    expect(advertised.length, "no secondary page advertised to cover").toBeGreaterThan(0);
    for (const entry of ["/", "/fleet"]) {
      const { text } = await bodyOf(app, entry, UA);
      for (const p of advertised) {
        expect(text, `${entry} has no link to ${p}`).toContain(`href="${p}"`);
      }
    }
  });

  test("a secondary page cross-links its siblings but never itself", async () => {
    for (const page of SECONDARY) {
      const { status, text } = await bodyOf(app, page, UA);
      expect(status, page).toBe(200);
      for (const other of SECONDARY.filter((p) => p !== page)) {
        expect(text, `${page} misses sibling ${other}`).toContain(`href="${other}"`);
      }
      // Self-links in a nav are noise; the header already links home.
      expect(text.split(`href="${page}"`).length - 1, `${page} self-links`).toBe(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bounded URL families: a tenant with no organic install history publishes
// neither the log, the feed, nor the index — and never advertises them.
//
// Synthetic DB rather than the snapshot: on production every AS row is a
// `*_seed` / `flyertalk_*` / `type_deterministic` write and every HA row is
// `ha_seed`, so INSTALL_FILTER leaves them nothing — but the snapshot happens
// to carry a `discovery` canary row for each, so only a constructed roster
// reproduces the shape deterministically.
// ─────────────────────────────────────────────────────────────────────────────

describe("empty-install tenants publish nothing", () => {
  const AS = SITES.alaska.canonicalHost;
  let bulkApp: ReturnType<typeof createApp>;

  beforeAll(() => {
    const db = makeSyntheticDb();
    // Bulk-only roster: the writers INSTALL_FILTER excludes by name.
    for (const [tail, gid] of [
      ["N100AS", "as_seed"],
      ["N101AS", "flyertalk_as"],
      ["N102AS", "type_deterministic"],
    ] as const) {
      db.query(
        `INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber, OperatedBy, fleet, verified_wifi, airline)
         VALUES ('Embraer ERJ-175LR','Starlink',?,'AS-horizon','2026-04-21',?,'Horizon Air','horizon','Starlink','AS')`
      ).run(gid, tail);
    }
    bulkApp = createApp(db);
  });

  test("the log and its feed 404 instead of serving an empty page", async () => {
    for (const path of ["/newly-equipped", "/feed.xml", "/install-rate"]) {
      const res = await bulkApp.dispatch(req(path, AS));
      expect(res.status, `${path} served with no data behind it`).toBe(404);
    }
  });

  test("nothing advertises a URL that 404s", async () => {
    const sitemap = await bodyOf(bulkApp, "/sitemap.xml", AS);
    const llms = await bodyOf(bulkApp, "/llms.txt", AS);
    for (const path of ["/newly-equipped", "/install-rate"]) {
      expect(sitemap.text, `sitemap advertises ${path}`).not.toContain(`${AS}${path}<`);
      expect(llms.text, `llms.txt advertises ${path}`).not.toContain(`${AS}${path})`);
    }
    // …and the autodiscovery <link> goes with them, so no reader subscribes to
    // a feed that isn't there.
    const home = await bodyOf(bulkApp, "/", AS);
    expect(home.text).not.toContain('type="application/atom+xml"');
  });

  test("the same tenant with one organic install turns them back on", async () => {
    const db = makeSyntheticDb();
    db.query(
      `INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber, OperatedBy, fleet, verified_wifi, airline)
       VALUES ('Embraer ERJ-175LR','Starlink','discovery','AS-horizon','2026-04-21','N103AS','Horizon Air','horizon','Starlink','AS')`
    ).run();
    const live = createApp(db);
    expect((await live.dispatch(req("/newly-equipped", AS))).status).toBe(200);
    expect((await live.dispatch(req("/feed.xml", AS))).status).toBe(200);
    const sitemap = await bodyOf(live, "/sitemap.xml", AS);
    expect(sitemap.text).toContain(`${AS}/newly-equipped<`);
    db.close();
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

  // The bug this veto exists for: upcoming_flights is a forward-only ~47h cache
  // that updateFlights DELETEs per tail, so its earliest surviving row is the
  // earliest still cached — not the tail's first. Replayed against the
  // production snapshot without the veto, 14 of 14 recorded "first flights"
  // skipped between 3 and 41 real departures already sitting in departure_log.
  describe("departure_log veto", () => {
    const logDeparture = (
      db: ReturnType<typeof makeSyntheticDb>,
      tail: string,
      at: number,
      airline = "UA"
    ) =>
      db
        .query(
          "INSERT INTO departure_log (tail_number, airport, departed_at, airline) VALUES (?,?,?,?)"
        )
        .run(tail, "EWR", at, airline);

    test("an earlier logged departure kills the candidate outright", () => {
      const db = makeSyntheticDb();
      seedTail(db, "N04TST", recentDay, "discovery", [
        ["UA100", "EWR", "SFO", recentInstall + 40000],
      ]);
      logDeparture(db, "N04TST", recentInstall + 10000);

      expect(recordFirstFlights(db, NOW)).toEqual([]);
      db.close();
    });

    test("the candidate's own archived row is not its own veto", () => {
      // archive_departures and first_flight_watch share a cadence, so the
      // departure being recorded is usually already in departure_log at the
      // same timestamp. A `<=` veto would abstain on every real first flight.
      const db = makeSyntheticDb();
      const departedAt = recentInstall + 10000;
      seedTail(db, "N05TST", recentDay, "discovery", [["UA100", "EWR", "SFO", departedAt]]);
      logDeparture(db, "N05TST", departedAt);

      expect(recordFirstFlights(db, NOW)).toHaveLength(1);
      db.close();
    });

    test("a departure logged before the install date is not evidence", () => {
      // Pre-install flying says nothing about the Starlink era; only departures
      // at or after DateFound can refute a post-install first.
      const db = makeSyntheticDb();
      seedTail(db, "N06TST", recentDay, "discovery", [
        ["UA100", "EWR", "SFO", recentInstall + 10000],
      ]);
      logDeparture(db, "N06TST", recentInstall - 200000);

      expect(recordFirstFlights(db, NOW)).toHaveLength(1);
      db.close();
    });

    test("another airline's log entry never vetoes this tenant's candidate", () => {
      const db = makeSyntheticDb();
      seedTail(db, "N07TST", recentDay, "discovery", [
        ["UA100", "EWR", "SFO", recentInstall + 40000],
      ]);
      logDeparture(db, "N07TST", recentInstall + 10000, "HA");

      expect(recordFirstFlights(db, NOW)).toHaveLength(1);
      db.close();
    });

    test("every recorded row is the earliest departure the log knows of", () => {
      // The invariant the table has to hold forever: it is kept permanently, so
      // a wrong claim never self-corrects.
      const db = makeSyntheticDb();
      seedTail(db, "N08TST", recentDay, "discovery", [
        ["UA100", "EWR", "SFO", recentInstall + 10000],
        ["UA200", "ORD", "DEN", recentInstall + 40000],
      ]);
      seedTail(db, "N09TST", recentDay, "discovery", [
        ["UA300", "IAH", "LAX", recentInstall + 40000],
      ]);
      logDeparture(db, "N09TST", recentInstall + 5000);

      for (const r of recordFirstFlights(db, NOW)) {
        const earlier = db
          .query(
            `SELECT COUNT(*) AS n FROM departure_log
             WHERE tail_number = ? AND airline = ?
               AND departed_at >= ? AND departed_at < ?`
          )
          .get(r.tail_number, r.airline, recentInstall, r.departed_at) as { n: number };
        expect(earlier.n, `${r.tail_number} recorded past an earlier logged departure`).toBe(0);
      }
      db.close();
    });
  });

  test("a re-registered tail can hold one record per airline", () => {
    // first_flights was keyed on tail_number alone: a registration moving
    // between carriers (AS↔HA is doing exactly this) could never get its
    // second record, and the airline-blind NOT EXISTS hid it as "already done".
    const db = makeSyntheticDb();
    seedTail(db, "N10TST", recentDay, "discovery", [
      ["UA100", "EWR", "SFO", recentInstall + 10000],
    ]);
    expect(recordFirstFlights(db, NOW)).toHaveLength(1);

    db.query(
      `INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber, OperatedBy, fleet, verified_wifi, airline)
       VALUES ('A330','Starlink','discovery','HA-mainline',?,?,'Hawaiian','mainline','Starlink','HA')`
    ).run(recentDay, "N10TST");
    db.query(
      `INSERT INTO upcoming_flights (tail_number, flight_number, departure_airport, arrival_airport, departure_time, arrival_time, last_updated, airline)
       VALUES (?,?,?,?,?,?,?, 'HA')`
    ).run("N10TST", "HA50", "HNL", "LAX", recentInstall + 20000, recentInstall + 40000, NOW);

    const second = recordFirstFlights(db, NOW);
    expect(second).toHaveLength(1);
    expect(second[0].airline).toBe("HA");
    expect(getFirstFlights(db, ["N10TST"], "UA")).toHaveLength(1);
    expect(getFirstFlights(db, ["N10TST"], "HA")).toHaveLength(1);
    db.close();
  });
});
