/**
 * Input validation and crawl hygiene: impossible dates and same-airport plans
 * are refused, pasted callsigns resolve to the permalink, alias hosts land in
 * one hop, and robots/structured data agree with the sitemap.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { buildFlightLookupVariants } from "../src/airlines/flight-number";
import { AIRLINES, SITES } from "../src/airlines/registry";
import { flightNumberHasData, getSitemapRoutes, routeHasData } from "../src/database/database";
import { createReaderFactory } from "../src/database/reader";
import { createApp } from "../src/server/app";
import { flightDateWindow, isRealIsoDate } from "../src/utils/airport-tz";
import { bodyOf, openSnapshot, req } from "./helpers";

const UA = SITES.united.canonicalHost;
const WWW = `www.${UA}`;
let app: ReturnType<typeof createApp>;
let db: ReturnType<typeof openSnapshot>;
let realFlight = "";

beforeAll(() => {
  db = openSnapshot();
  app = createApp(db);
  realFlight = createReaderFactory(db)("UA").getSitemapFlights()[0]?.flight_number ?? "UA1126";
});

const html = (path: string, host = UA) =>
  app.dispatch(
    req(path, host, { headers: { Accept: "text/html", "x-forwarded-for": "127.0.0.1" } })
  );

async function hop(path: string, host = UA) {
  const res = await html(path, host);
  return { status: res.status, location: res.headers.get("location") };
}

describe("real calendar dates only", () => {
  test("isRealIsoDate rejects rolled-over and malformed dates", () => {
    expect(isRealIsoDate("2027-02-28")).toBe(true);
    expect(isRealIsoDate("2028-02-29")).toBe(true);
    for (const d of ["2027-02-29", "2026-02-30", "2026-09-31", "2026-13-01", "2026-9-1", ""]) {
      expect(isRealIsoDate(d), d).toBe(false);
      expect(flightDateWindow(d), d).toBeNull();
    }
  });

  test("/api/check-flight 400s an impossible date", async () => {
    for (const date of ["2026-02-30", "2026-09-31"]) {
      const { status, text } = await bodyOf(
        app,
        `/api/check-flight?flight_number=UA123&date=${date}`,
        UA
      );
      expect(status, date).toBe(400);
      expect(typeof JSON.parse(text).error).toBe("string");
    }
  });

  test("a past date keeps the contract shape but doesn't promise an assignment", async () => {
    const { status, text } = await bodyOf(
      app,
      `/api/check-flight?flight_number=${realFlight}&date=2025-01-01`,
      UA
    );
    expect(status).toBe(200);
    const body = JSON.parse(text);
    expect("hasStarlink" in body).toBe(true);
    expect(Array.isArray(body.flights)).toBe(true);
    if (typeof body.message === "string") {
      expect(body.message).not.toContain("not yet published");
    }
  });
});

describe("/api/plan-route", () => {
  test("same origin and destination is a 400", async () => {
    for (const q of ["origin=SFO&destination=SFO", "origin=sfo&destination=SFO"]) {
      const { status } = await bodyOf(app, `/api/plan-route?${q}`, UA);
      expect(status, q).toBe(400);
    }
  });
});

describe("/check-flight callsign and spacing spellings", () => {
  test("ICAO callsigns and encoded spaces 301 to the IATA permalink", async () => {
    for (const path of ["/check-flight/UAL675", "/check-flight/ual675", "/check-flight/UA%20675"]) {
      expect(await hop(path), path).toEqual({
        status: 301,
        location: `https://${UA}/check-flight/UA675`,
      });
    }
  });

  test("Alaska's host maps ASA the same way", async () => {
    const AS = SITES.alaska?.canonicalHost;
    if (!AS) return;
    expect(await hop("/check-flight/ASA100", AS)).toEqual({
      status: 301,
      location: `https://${AS}/check-flight/AS100`,
    });
  });
});

describe("alias host redirects land in one hop", () => {
  test("www + trailing slash + case collapses to the final URL", async () => {
    const cases: Array<[string, string]> = [
      ["/check-flight/ua675/", "/check-flight/UA675"],
      ["/check-flight/UAL675/2027-01-01/", "/check-flight/UA675/2027-01-01"],
      ["/route-planner/sfo/ewr/", "/route-planner/SFO/EWR"],
      ["/fleet/", "/fleet"],
      ["/", "/"],
    ];
    for (const [from, to] of cases) {
      expect(await hop(from, WWW), from).toEqual({ status: 301, location: `https://${UA}${to}` });
    }
  });

  test("the query string survives and /api paths are left alone", async () => {
    expect((await hop("/check-flight/ua675/?utm_source=x", WWW)).location).toBe(
      `https://${UA}/check-flight/UA675?utm_source=x`
    );
    expect((await hop("/api/data/", WWW)).location).toBe(`https://${UA}/api/data/`);
  });
});

describe("robots agrees with the sitemap on route pages", () => {
  const robots = (page: string) => page.match(/<meta name="robots" content="([^"]+)"/)?.[1];

  test("a sitemap route is indexable", async () => {
    const r = getSitemapRoutes(db, "UA")[0];
    if (!r) throw new Error("snapshot has no routes — run bun run test:setup");
    const res = await html(`/route-planner/${r.origin}/${r.destination}`);
    expect(res.status).toBe(200);
    expect(robots(await res.text())).toBe("index, follow");
  });

  test("a served pair outside the sitemap is noindex, follow", async () => {
    const inSitemap = new Set(
      getSitemapRoutes(db, "UA").map((r) => `${r.origin}-${r.destination}`)
    );
    const thin = (
      db
        .query(
          "SELECT DISTINCT origin, destination FROM flight_routes WHERE flight_number GLOB ? LIMIT 5000"
        )
        .all(`${AIRLINES.UA.iata}[0-9]*`) as { origin: string; destination: string }[]
    ).find(
      (r) =>
        /^[A-Z]{3}$/.test(r.origin) &&
        /^[A-Z]{3}$/.test(r.destination) &&
        r.origin !== r.destination &&
        !inSitemap.has(`${r.origin}-${r.destination}`) &&
        routeHasData(db, r.origin, r.destination, "UA")
    );
    if (!thin) return; // every served pair is in the sitemap on this snapshot
    const res = await html(`/route-planner/${thin.origin}/${thin.destination}`);
    expect(res.status).toBe(200);
    expect(robots(await res.text())).toBe("noindex, follow");
  });
});

describe("FAQPage JSON-LD only on indexable check-flight pages", () => {
  test("an unknown flight's noindex page keeps the breadcrumb, drops FAQPage", async () => {
    const cfg = AIRLINES.UA;
    let unknown = "";
    for (let n = 9999; n > 9000 && !unknown; n--) {
      const fn = `UA${n}`;
      if (!flightNumberHasData(db, buildFlightLookupVariants(cfg, fn), "UA")) unknown = fn;
    }
    if (!unknown) throw new Error("no unknown UA flight number in 9001-9999");
    const page = await (await html(`/check-flight/${unknown}`)).text();
    expect(page).toContain('content="noindex, follow"');
    expect(page).toContain('"@type":"BreadcrumbList"');
    expect(page).not.toContain('"@type":"FAQPage"');
  });

  test("an indexable permalink still carries FAQPage", async () => {
    const page = await (await html(`/check-flight/${realFlight}`)).text();
    expect(page).toContain('content="index, follow"');
    expect(page).toContain('"@type":"FAQPage"');
  });
});
