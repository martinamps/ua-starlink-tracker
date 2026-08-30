/**
 * /aircraft/{family} — per-family rollout pages. The URL space is bounded by
 * the family vocabulary present in the tenant's fleet data; these tests pin
 * that the index, the per-family gate, and the sitemap all derive from the
 * same list, so an advertised page can never 404 and an unknown one always
 * does.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import React from "react";
import ReactDOMServer from "react-dom/server";
import {
  FAMILY_DISPLAY,
  familySlug,
  normalizeAircraftType,
} from "../src/airlines/aircraft-families";
import { AIRLINES, SITES } from "../src/airlines/registry";
import { AircraftFamilyPage } from "../src/components/aircraft-page";
import { getFleetPageData } from "../src/database/database";
import { createApp } from "../src/server/app";
import type { FleetFamily } from "../src/types";
import { AIRCRAFT_SPECS } from "../src/utils/aircraft-specs";
import { openSnapshot, req } from "./helpers";

let app: ReturnType<typeof createApp>;
let db: ReturnType<typeof openSnapshot>;

beforeAll(() => {
  db = openSnapshot();
  app = createApp(db);
});

const UA = SITES.united.canonicalHost;
const get = (path: string, host = UA) =>
  app.dispatch(req(path, host, { headers: { Accept: "text/html" } }));

function uaFamilies() {
  const fams = getFleetPageData(db, ["UA"]).families.filter((f) => f.family !== "unknown");
  if (fams.length === 0) throw new Error("snapshot has no UA fleet families — run test:setup");
  return fams;
}

describe("FAMILY_DISPLAY vocabulary", () => {
  test("every family the normalizer can emit has display copy", () => {
    // Sample real-world inputs across the matcher's whole output range.
    const inputs = [
      "Boeing 737-924(ER)",
      "737 MAX 8",
      "737-9 MAX",
      "737 MAX 10",
      "Boeing 737-724",
      "Boeing 737-824",
      "Boeing 717-22A",
      "Boeing 747-8F",
      "Boeing 747-400",
      "Boeing 757-224",
      "Boeing 767-322(ER)",
      "Boeing 777-F",
      "Boeing 777-222",
      "Boeing 787-9",
      "Airbus A319-131",
      "Airbus A320-232",
      "Airbus A321-271NX",
      "Airbus A330-243",
      "Airbus A350-941",
      "Airbus A380-861",
      "Embraer E175LR",
      "ERJ-145XR",
      "CRJ-200",
      "CRJ-550",
      "Mitsubishi CRJ-701ER",
    ];
    for (const raw of inputs) {
      const fam = normalizeAircraftType(raw);
      expect(fam, raw).not.toBe("other");
      expect(FAMILY_DISPLAY[fam], `no display copy for ${fam} (${raw})`).toBeDefined();
    }
  });

  test("slugs are unique, lowercase, and URL-safe", () => {
    const slugs = Object.keys(FAMILY_DISPLAY).map(familySlug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(s).toMatch(/^[a-z0-9-]+$/);
  });
});

describe("/aircraft", () => {
  test("index renders and links every data-backed family, nothing else", async () => {
    const res = await get("/aircraft");
    expect(res.status).toBe(200);
    const body = await res.text();
    const linked = [...body.matchAll(/href="\/aircraft\/([a-z0-9-]+)"/g)].map((m) => m[1]).sort();
    const expected = uaFamilies()
      .map((f) => familySlug(f.family))
      .sort();
    expect(linked).toEqual(expected);
  });

  test("a data-backed family renders its own page, listing every tail", async () => {
    const fam = uaFamilies()[0];
    const slug = familySlug(fam.family);
    const res = await get(`/aircraft/${slug}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`<link rel="canonical" href="https://${UA}/aircraft/${slug}"`);
    for (const t of fam.tails) expect(body, t.tail).toContain(t.tail);
  });

  test("tail registrations aren't linked until /tail/ exists", async () => {
    // This is the site's highest-fan-out crawl path (one link per tail); the
    // route ships on roadmap/tail-pages, so the flag keeps this branch safe to
    // merge alone rather than pointing a page-full of links at 404s.
    expect(SITES.united.features.tailPages).toBe(false);
    const slug = familySlug(uaFamilies()[0].family);
    const body = await (await get(`/aircraft/${slug}`)).text();
    expect(body).not.toContain('href="/tail/');
  });

  test("every carrier-specific spec figure names the carrier it belongs to", () => {
    // The panel is rendered on a carrier-branded page, so an unattributed
    // number reads as that carrier's own. Anything with a real seat count must
    // say whose cabin it is; only "—" rows (freighters) may go unattributed.
    for (const [family, spec] of Object.entries(AIRCRAFT_SPECS)) {
      if (String(spec.seats) !== "—") expect(spec.seats_airline, family).toBeTruthy();
      if (spec.seats_airline) expect(AIRLINES[spec.seats_airline], family).toBeDefined();
      if (spec.fun_fact_airline) expect(AIRLINES[spec.fun_fact_airline], family).toBeDefined();
    }
  });

  test("a family page suppresses another carrier's seat count and voice", () => {
    // Rendered directly for two tenants: the snapshot need not carry an Alaska
    // 737-900 for the rule to be the thing under test.
    const family = "B737-900";
    const spec = AIRCRAFT_SPECS[family];
    expect(spec.seats_airline).toBe("UA");
    const fam: FleetFamily = {
      family,
      body: "narrowbody",
      total: 2,
      starlink: 1,
      tails: [
        {
          tail: "N1TEST",
          type: "Boeing 737-900",
          family,
          provider: "starlink",
          fleet: "mainline",
          verified_at: null,
        },
        {
          tail: "N2TEST",
          type: "Boeing 737-900",
          family,
          provider: "viasat",
          fleet: "mainline",
          verified_at: null,
        },
      ],
    };
    const render = (site: (typeof SITES)[string]) =>
      ReactDOMServer.renderToString(
        React.createElement(AircraftFamilyPage, {
          family: fam,
          progress: [],
          lastUpdated: "2026-08-01T00:00:00.000Z",
          site,
        })
      );
    const onOwner = render(SITES.united);
    const onOther = render(SITES.alaska);
    expect(onOwner).toContain(String(spec.seats));
    expect(onOther).not.toContain(String(spec.seats));
    // Airframe facts are the type's, not a carrier's — they stay on both.
    expect(onOwner).toContain(String(spec.cruise_mph));
    expect(onOther).toContain(String(spec.cruise_mph));
  });

  test("fleet counts carry the data's own date, not the request time", () => {
    const fam: FleetFamily = {
      family: "E175",
      body: "regional",
      total: 1,
      starlink: 1,
      tails: [],
    };
    const html = ReactDOMServer.renderToString(
      React.createElement(AircraftFamilyPage, {
        family: fam,
        progress: [],
        lastUpdated: "2026-08-01T00:00:00.000Z",
        site: SITES.united,
      })
    );
    expect(html).toContain("as of August 1, 2026");
  });

  test("unknown families and junk 404 — bounded URL space", async () => {
    for (const path of [
      "/aircraft/zzz",
      "/aircraft/b737-max11",
      "/aircraft/unknown",
      "/aircraft/concorde",
    ]) {
      expect((await get(path)).status, path).toBe(404);
    }
  });

  test("one indexable URL per family: case variants and the bare prefix redirect", async () => {
    const slug = familySlug(uaFamilies()[0].family);
    const res = await get(`/aircraft/${slug.toUpperCase()}`);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`https://${UA}/aircraft/${slug}`);

    const bare = await get("/aircraft/");
    expect(bare.status).toBe(301);
    expect(bare.headers.get("location")).toBe(`https://${UA}/aircraft`);
  });

  test("sitemap advertises exactly the family pages that resolve", async () => {
    const body = await (await app.dispatch(req("/sitemap.xml", UA))).text();
    const advertised = [...body.matchAll(/<loc>[^<]*\/aircraft\/([a-z0-9-]+)<\/loc>/g)].map(
      (m) => m[1]
    );
    expect(advertised.sort()).toEqual(
      uaFamilies()
        .map((f) => familySlug(f.family))
        .sort()
    );
    for (const slug of advertised) {
      expect((await get(`/aircraft/${slug}`)).status, slug).toBe(200);
    }
  });

  test("feature-gated: the hub 404s", async () => {
    expect((await get("/aircraft", SITES.airline.canonicalHost)).status).toBe(404);
    expect((await get("/aircraft/e175", SITES.airline.canonicalHost)).status).toBe(404);
  });
});
