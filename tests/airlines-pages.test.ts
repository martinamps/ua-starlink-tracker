/**
 * Hub /airlines surfaces + cross-site footer links. Coverage derives from the
 * registry and the rollout-facts roster (every airline, every live site) —
 * shapes only, no value pins.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import {
  AIRLINES,
  SITES,
  airlineSlug,
  enabledAirlines,
  publicAirlines,
  siteForAirline,
} from "../src/airlines/registry";
import {
  AIRLINE_FACTS,
  contentOnlyFacts,
  factsBySlug,
  factsForCode,
  formatFactDate,
} from "../src/airlines/rollout-facts";
import { createApp } from "../src/server/app";
import { openSnapshot, req } from "./helpers";

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  app = createApp(openSnapshot());
});

const hub = SITES.airline;
const get = (path: string, host: string) =>
  app.dispatch(req(path, host, { headers: { Accept: "text/html" } }));

// The tracked roster on /airlines: public airlines plus enabled-but-hidden
// ones that carry a facts entry (QR today). Mirrors app.ts hubTrackedAirlines.
const trackedRoster = () => [
  ...publicAirlines(),
  ...enabledAirlines().filter((a) => !publicAirlines().includes(a) && factsForCode(a.code)),
];
// Anything enabled but neither public nor facts-covered stays invisible.
const invisibleAirlines = () => Object.values(AIRLINES).filter((a) => !trackedRoster().includes(a));

describe("hub /airlines index", () => {
  test("serves on the hub and lists the tracked roster plus every facts entry", async () => {
    const res = await get("/airlines", hub.canonicalHost);
    expect(res.status).toBe(200);
    const body = await res.text();
    for (const cfg of trackedRoster()) {
      expect(body, `index missing ${cfg.name}`).toContain(cfg.name);
      expect(body, `index missing link to ${airlineSlug(cfg)}`).toContain(
        `/airlines/${airlineSlug(cfg)}`
      );
    }
    for (const entry of contentOnlyFacts()) {
      expect(body, `index missing ${entry.name}`).toContain(entry.name);
      expect(body, `index missing link to ${entry.slug}`).toContain(`/airlines/${entry.slug}`);
    }
    for (const cfg of invisibleAirlines()) {
      expect(body, `index leaks ${cfg.name}`).not.toContain(cfg.name);
    }
  });

  test("negative entries are grouped under an explicit not-Starlink section", async () => {
    const body = await (await get("/airlines", hub.canonicalHost)).text();
    expect(body).toContain("Not Starlink");
    for (const entry of contentOnlyFacts().filter((e) => e.status === "not_starlink")) {
      expect(body, `negatives section missing ${entry.name}`).toContain(entry.name);
    }
  });

  test("404s on every airline-scoped site", async () => {
    for (const site of Object.values(SITES).filter((s) => s.scope !== "ALL")) {
      const res = await get("/airlines", site.canonicalHost);
      expect(res.status, site.key).toBe(404);
    }
  });
});

describe("hub /airlines/{slug} detail pages (tracked airlines)", () => {
  test("every tracked airline serves, funneling to its live tracker where one exists", async () => {
    for (const cfg of trackedRoster()) {
      const res = await get(`/airlines/${airlineSlug(cfg)}`, hub.canonicalHost);
      expect(res.status, cfg.code).toBe(200);
      const body = await res.text();
      expect(body, cfg.code).toContain(cfg.name);
      expect(body, cfg.code).toContain(cfg.rollout.statusLabel);
      const liveHost = siteForAirline(cfg.code, true)?.canonicalHost;
      if (liveHost) {
        expect(body, `${cfg.code} page missing tracker CTA`).toContain(liveHost);
      }
    }
  });

  test("tracked pages render their dated facts with source links", async () => {
    for (const cfg of trackedRoster()) {
      const entry = factsForCode(cfg.code);
      if (!entry) continue;
      const body = await (await get(`/airlines/${airlineSlug(cfg)}`, hub.canonicalHost)).text();
      for (const fact of entry.facts) {
        expect(body, `${cfg.code} missing as-of ${fact.asOf}`).toContain(formatFactDate(fact.asOf));
        expect(body, `${cfg.code} missing source ${fact.source.url}`).toContain(fact.source.url);
      }
    }
  });

  test("IATA and case variants 301 to the canonical slug", async () => {
    for (const cfg of trackedRoster()) {
      for (const variant of [cfg.iata.toLowerCase(), airlineSlug(cfg).toUpperCase()]) {
        const res = await get(`/airlines/${variant}`, hub.canonicalHost);
        expect(res.status, variant).toBe(301);
        expect(res.headers.get("Location"), variant).toBe(
          `https://${hub.canonicalHost}/airlines/${airlineSlug(cfg)}`
        );
      }
    }
  });

  test("unknown airline 404s — no invented content", async () => {
    for (const slug of ["ryanair", "easyjet", "not-an-airline"]) {
      expect(factsBySlug(slug)).toBeNull();
      const res = await get(`/airlines/${slug}`, hub.canonicalHost);
      expect(res.status, slug).toBe(404);
    }
  });
});

describe("hub /airlines/{slug} facts pages (content-level roster)", () => {
  test("every entry serves with an as-of stamp and a source link per fact", async () => {
    for (const entry of contentOnlyFacts()) {
      const res = await get(`/airlines/${entry.slug}`, hub.canonicalHost);
      expect(res.status, entry.slug).toBe(200);
      const body = await res.text();
      expect(body, entry.slug).toContain(entry.name);
      expect(body, entry.slug).toContain("as of");
      for (const fact of entry.facts) {
        expect(body, `${entry.slug} missing as-of ${fact.asOf}`).toContain(
          formatFactDate(fact.asOf)
        );
        expect(body, `${entry.slug} missing source ${fact.source.url}`).toContain(fact.source.url);
      }
    }
  });

  test("negative pages answer the question with a 'No' headline and the alternative", async () => {
    for (const entry of contentOnlyFacts().filter((e) => e.status === "not_starlink")) {
      const body = await (await get(`/airlines/${entry.slug}`, hub.canonicalHost)).text();
      expect(body, entry.slug).toContain("Have Starlink? No");
      expect(body, `${entry.slug} missing insteadOf`).toContain(entry.insteadOf as string);
    }
  });

  test("the Delta explainer names what Delta chose instead", async () => {
    const body = await (await get("/airlines/delta", hub.canonicalHost)).text();
    expect(body).toContain("Does Delta Have Starlink? No");
    expect(body).toContain("Amazon Leo");
  });

  test("the American page states the Airbus-only scope and 2027 start", async () => {
    const body = await (await get("/airlines/american", hub.canonicalHost)).text();
    expect(body).toContain("Airbus");
    expect(body).toContain("2027");
    // Built to age into a tracker: the page says tracking begins with installs.
    expect(body).toContain("grows into a live tracker");
  });

  test("aliases 301 to their canonical entry", async () => {
    for (const entry of AIRLINE_FACTS) {
      for (const alias of entry.aliases ?? []) {
        const res = await get(`/airlines/${alias}`, hub.canonicalHost);
        expect(res.status, alias).toBe(301);
        expect(res.headers.get("Location"), alias).toBe(
          `https://${hub.canonicalHost}/airlines/${entry.slug}`
        );
      }
    }
  });

  test("facts pages 404 on every airline-scoped site", async () => {
    for (const site of Object.values(SITES).filter((s) => s.scope !== "ALL")) {
      const res = await get("/airlines/delta", site.canonicalHost);
      expect(res.status, site.key).toBe(404);
    }
  });
});

describe("sitemaps", () => {
  test("hub sitemap advertises the index, every tracked airline, and every facts page", async () => {
    const res = await get("/sitemap.xml", hub.canonicalHost);
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain(`<loc>https://${hub.canonicalHost}/airlines</loc>`);
    for (const cfg of trackedRoster()) {
      expect(xml, cfg.code).toContain(
        `<loc>https://${hub.canonicalHost}/airlines/${airlineSlug(cfg)}</loc>`
      );
    }
    for (const entry of contentOnlyFacts()) {
      expect(xml, entry.slug).toContain(
        `<loc>https://${hub.canonicalHost}/airlines/${entry.slug}</loc>`
      );
    }
  });

  test("facts pages carry a lastmod derived from their newest dated claim", async () => {
    const xml = await (await get("/sitemap.xml", hub.canonicalHost)).text();
    // Shape, not values: each facts <url> block has exactly one lastmod and it
    // parses to a past instant (fact dates are by construction not in the future).
    const blocks = xml.split("<url>").filter((b) => b.includes("/airlines/delta</loc>"));
    expect(blocks.length).toBe(1);
    const stamps = [...blocks[0].matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1]);
    expect(stamps.length).toBe(1);
    expect(Date.parse(stamps[0])).toBeLessThanOrEqual(Date.now());
  });

  test("airline-site sitemaps do not advertise /airlines", async () => {
    for (const site of Object.values(SITES).filter((s) => s.scope !== "ALL")) {
      const res = await get("/sitemap.xml", site.canonicalHost);
      expect(res.status, site.key).toBe(200);
      expect(await res.text(), site.key).not.toContain("/airlines");
    }
  });
});

describe("cross-site footer links", () => {
  test("every live site's homepage links its live sisters and the hub /airlines page", async () => {
    for (const site of Object.values(SITES).filter((s) => s.live)) {
      const res = await get("/", site.canonicalHost);
      expect(res.status, site.key).toBe(200);
      const body = await res.text();
      expect(body, `${site.key} missing cross-site block`).toContain("data-cross-site-links");
      for (const other of Object.values(SITES).filter(
        (s) => s.live && s.scope !== "ALL" && s.key !== site.key
      )) {
        expect(body, `${site.key} missing link to ${other.key}`).toContain(
          `https://${other.canonicalHost}/`
        );
      }
      const airlinesHref =
        site.scope === "ALL" ? "/airlines" : `https://${SITES.airline.canonicalHost}/airlines`;
      expect(body, `${site.key} missing all-airlines link`).toContain(airlinesHref);
    }
  });
});
