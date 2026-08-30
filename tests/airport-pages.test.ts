/**
 * /airport/{IATA} — per-airport departure pages.
 *
 * Same two invariants as the route permalinks: the URL space is bounded by
 * real data, and the sitemap advertises exactly what resolves. The extra gate
 * here is the name table — a page titled by a bare IATA code is worse than no
 * page, so an airport the reference table doesn't know 404s even when the
 * route data backs it.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { AIRLINES, SITES } from "../src/airlines/registry";
import { getSitemapAirports } from "../src/database/database";
import { createApp } from "../src/server/app";
import { AIRPORT_NAMES } from "../src/utils/airport-names";
import { addFlight, addPlane, makeSyntheticDb, openSnapshot, req } from "./helpers";

let app: ReturnType<typeof createApp>;
let db: ReturnType<typeof openSnapshot>;

beforeAll(() => {
  db = openSnapshot();
  app = createApp(db);
});

const UA = SITES.united.canonicalHost;
const HUB = SITES.airline.canonicalHost;
const get = (path: string, host = UA) =>
  app.dispatch(req(path, host, { headers: { Accept: "text/html" } }));

/** The airports that should have a page: route data AND a reference name. */
function namedAirports() {
  const named = getSitemapAirports(db, "UA").filter((a) => AIRPORT_NAMES[a.airport]);
  if (named.length === 0) throw new Error("snapshot has no UA airports — run bun run test:setup");
  return named;
}

describe("/airport/{IATA}", () => {
  test("a data-backed airport renders, titled by its city not its code", async () => {
    const { airport } = namedAirports()[0];
    const res = await get(`/airport/${airport}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`<link rel="canonical" href="https://${UA}/airport/${airport}"`);
    // The name table is the whole reason this URL family exists — a page that
    // renders without the city has silently lost its gate.
    expect(body).toContain(AIRPORT_NAMES[airport].city);
    expect(body).toContain(AIRPORT_NAMES[airport].name);
  });

  test("routes on the page are real permalinks, never self-pairs", async () => {
    const { airport } = namedAirports()[0];
    const body = await (await get(`/airport/${airport}`)).text();
    const pairs = [...body.matchAll(/href="\/route-planner\/([A-Z]{3})\/([A-Z]{3})"/g)];
    for (const [, origin, destination] of pairs) {
      expect(origin).toBe(airport);
      expect(destination).not.toBe(airport);
    }
  });

  test("unknown and malformed codes 404 — bounded URL space", async () => {
    for (const path of [
      "/airport/ZZZ",
      "/airport/QQ",
      "/airport/QQQQ",
      "/airport/123",
      "/airport/EWR/extra",
      // Undecodable escape: the handler must 404, not throw a 500.
      "/airport/%zz",
    ]) {
      expect((await get(path)).status, path).toBe(404);
    }
  });

  test("one indexable URL per airport: case variants and the bare prefix redirect", async () => {
    const { airport } = namedAirports()[0];
    const lower = await get(`/airport/${airport.toLowerCase()}`);
    expect(lower.status).toBe(301);
    expect(lower.headers.get("location")).toBe(`https://${UA}/airport/${airport}`);

    const bare = await get("/airport/");
    expect(bare.status).toBe(301);
    expect(bare.headers.get("location")).toBe(`https://${UA}/airports`);
  });

  test("sitemap advertises exactly the airport pages that resolve", async () => {
    const body = await (await app.dispatch(req("/sitemap.xml", UA))).text();
    const advertised = [...body.matchAll(/<loc>[^<]*\/airport\/([A-Z]{3})<\/loc>/g)].map(
      (m) => m[1]
    );
    expect(advertised.slice().sort()).toEqual(
      namedAirports()
        .map((a) => a.airport)
        .sort()
    );
    for (const iata of advertised) {
      expect((await get(`/airport/${iata}`)).status, iata).toBe(200);
    }
  });

  test("a roster-scoped tenant never publishes an equipped share", async () => {
    // upcoming_flights is written per-tail off the Starlink roster, so a
    // COUNT over it is not United's schedule and "37 of 37" would be a
    // fabricated denominator. UA must publish a count and say what it counts.
    expect(AIRLINES.UA.scheduleCoverage).toBe("starlink-roster");
    const { airport } = namedAirports()[0];
    const body = await (await get(`/airport/${airport}`)).text();
    expect(body).toContain("not a share of every");
    expect(body).not.toContain("Starlink / departures");
    // The old note blamed the gap on unpublished assignments, which is the
    // opposite of the truth — upcoming_flights.tail_number is always set.
    expect(body).not.toContain("Departures without a published assignment");
  });

  test("the page dates the live window it renders", async () => {
    const { airport } = namedAirports()[0];
    const body = await (await get(`/airport/${airport}`)).text();
    expect(body).toMatch(/as of \d{2}:\d{2} UTC/);
  });

  test("lastmod is honest — no future stamps from corrupt rows", async () => {
    const nowMs = Date.now();
    for (const a of namedAirports()) {
      expect(a.last_touched * 1000, a.airport).toBeLessThanOrEqual(nowMs);
    }
  });
});

describe("/airports index", () => {
  test("links exactly the airports that have their own page", async () => {
    const res = await get("/airports");
    expect(res.status).toBe(200);
    const body = await res.text();
    const linked = [...body.matchAll(/href="\/airport\/([A-Z]{3})"/g)].map((m) => m[1]);
    expect(new Set(linked).size).toBe(linked.length);
    expect(linked.slice().sort()).toEqual(
      namedAirports()
        .map((a) => a.airport)
        .sort()
    );
  });
});

describe("name gating", () => {
  test("an airport with real departures but no reference name still 404s", async () => {
    // ZZZ is a well-formed IATA shape the name table deliberately doesn't know:
    // data alone must not be enough to mint a bare-code page.
    const synthetic = makeSyntheticDb();
    const soon = Math.floor(Date.now() / 1000) + 3600;
    addPlane(synthetic, "N1TEST", "Starlink");
    addFlight(synthetic, "N1TEST", "UA9001", "ZZZ", soon, { arrivalAirport: "EWR" });
    addFlight(synthetic, "N1TEST", "UA9002", "DEN", soon, { arrivalAirport: "EWR" });
    const scoped = createApp(synthetic);
    const fetchPage = (p: string) =>
      scoped.dispatch(req(p, UA, { headers: { Accept: "text/html" } }));

    expect((await fetchPage("/airport/DEN")).status).toBe(200);
    expect((await fetchPage("/airport/ZZZ")).status).toBe(404);

    const sitemap = await (await scoped.dispatch(req("/sitemap.xml", UA))).text();
    expect(sitemap).not.toContain("/airport/ZZZ");
    synthetic.close();
  });
});

describe("live departures", () => {
  test("every flight the page links is a permalink that resolves", async () => {
    // The snapshot's rows sit outside the live window, so the upcoming-departures
    // section only has content against a DB seeded inside it.
    const synthetic = makeSyntheticDb();
    const soon = Math.floor(Date.now() / 1000) + 3600;
    addPlane(synthetic, "N3TEST", "Starlink");
    addFlight(synthetic, "N3TEST", "UA9301", "DEN", soon, { arrivalAirport: "EWR" });
    addFlight(synthetic, "N3TEST", "UA9302", "DEN", soon + 600, { arrivalAirport: "SFO" });
    const scoped = createApp(synthetic);

    const body = await (
      await scoped.dispatch(req("/airport/DEN", UA, { headers: { Accept: "text/html" } }))
    ).text();
    const flights = [...body.matchAll(/href="\/check-flight\/([A-Z0-9]+)"/g)].map((m) => m[1]);
    expect(flights.length).toBeGreaterThan(0);
    for (const fn of flights) {
      const res = await scoped.dispatch(
        req(`/check-flight/${fn}`, UA, { headers: { Accept: "text/html" } })
      );
      expect(res.status, fn).toBe(200);
    }
    // Per-tail pages ship on the sibling roadmap/tail-pages branch, so the
    // registration is rendered but NOT linked — this branch must be safe to
    // merge alone. The tail still appears; only the dead href is withheld.
    expect(SITES.united.features.tailPages).toBe(false);
    expect(body).toContain("N3TEST");
    expect(body).not.toContain('href="/tail/');
    synthetic.close();
  });
});

describe("cross-links", () => {
  test("every internal link a hub airport page emits resolves", async () => {
    // The hub leaderboard cross-link is the one that used to be gated on
    // "this is a hub" rather than on the board having rows, so it could point
    // at a page the rankings handler 404s.
    const synthetic = makeSyntheticDb();
    const soon = Math.floor(Date.now() / 1000) + 3600;
    addPlane(synthetic, "N4TEST", "Starlink");
    // DEN gets departures but none on an equipped tail: hub page, empty board.
    addFlight(synthetic, "N9NONE", "UA9401", "DEN", soon, { arrivalAirport: "EWR" });
    addFlight(synthetic, "N9NONE", "UA9402", "DEN", soon + 600, { arrivalAirport: "SFO" });
    // EWR gets an equipped one, so its board does have rows.
    addFlight(synthetic, "N4TEST", "UA9403", "EWR", soon, { arrivalAirport: "SFO" });
    const scoped = createApp(synthetic);
    const fetchPage = (p: string) =>
      scoped.dispatch(req(p, UA, { headers: { Accept: "text/html" } }));

    for (const iata of ["DEN", "EWR"]) {
      const res = await fetchPage(`/airport/${iata}`);
      expect(res.status, iata).toBe(200);
      const body = await res.text();
      const links = [...body.matchAll(/href="(\/rankings\/[a-z0-9-]+)"/g)].map((m) => m[1]);
      for (const href of links) {
        expect((await fetchPage(href)).status, `${iata} → ${href}`).toBe(200);
      }
    }
    // And the gate is real: DEN's board is empty, so DEN's page omits the link.
    expect(await (await fetchPage("/airport/DEN")).text()).not.toContain("/rankings/hub-den");
    expect((await fetchPage("/rankings/hub-den")).status).toBe(404);
    expect(await (await fetchPage("/airport/EWR")).text()).toContain("/rankings/hub-ewr");
    synthetic.close();
  });
});

describe("tenant gating", () => {
  test("the hub has no airport pages", async () => {
    expect((await get("/airports", HUB)).status).toBe(404);
    expect((await get("/airport/EWR", HUB)).status).toBe(404);
  });
});
