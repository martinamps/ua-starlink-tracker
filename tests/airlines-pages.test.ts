/**
 * Hub /airlines surfaces + cross-site footer links. Coverage derives from the
 * registry and the rollout-facts roster (every airline, every live site) —
 * shapes only, no value pins.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import {
  AIRLINES,
  type AirlineConfig,
  SITES,
  airlineSlug,
  hubContentAirlines,
  isHubContent,
  siteForAirline,
} from "../src/airlines/registry";
import {
  AIRLINE_FACTS,
  contentOnlyFacts,
  factStamp,
  factsBySlug,
  factsForCode,
  formatFactDate,
} from "../src/airlines/rollout-facts";
import { factsHeadline } from "../src/components/airlines-page";
import { createReaderFactory } from "../src/database/reader";
import { createApp, hubUrlFamilies } from "../src/server/app";
import { openSnapshot, req } from "./helpers";

let app: ReturnType<typeof createApp>;
let getReader: ReturnType<typeof createReaderFactory>;

beforeAll(() => {
  const db = openSnapshot();
  app = createApp(db);
  getReader = createReaderFactory(db);
});

const hub = SITES.airline;
const get = (path: string, host: string) =>
  app.dispatch(req(path, host, { headers: { Accept: "text/html" } }));

// Brand names carry ampersands ("British Airways, Iberia ... & LEVEL"); React
// escapes them on the way out, so assert against the escaped form rather than
// forbidding the character in content.
const html = (s: string) => s.replace(/&/g, "&amp;");

// The tracked roster on /airlines — the registry's declared hub CONTENT
// population (publicInHub, plus hubContentOnly airlines like QR).
const trackedRoster = () => hubContentAirlines();
// Anything the registry does not publish on the hub stays invisible there.
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
      expect(body, `index missing ${entry.name}`).toContain(html(entry.name));
      expect(body, `index missing link to ${entry.slug}`).toContain(`/airlines/${entry.slug}`);
    }
    for (const cfg of invisibleAirlines()) {
      expect(body, `index leaks ${cfg.name}`).not.toContain(cfg.name);
    }
  });

  // The loop above is empty whenever every registry airline is published, so
  // it cannot be the guard on its own. This pins the rule itself against flag
  // combinations no live airline currently has — including the one that
  // matters: publicInHub false without hubContentOnly must stay off the hub,
  // and `enabled: false` must never be published whatever the other flags say.
  test("the hub-content rule keeps unpublished airlines out, whatever the flags", () => {
    const flags = (
      enabled: boolean,
      publicInHub: boolean,
      hubContentOnly?: boolean
    ): Pick<AirlineConfig, "enabled" | "publicInHub" | "hubContentOnly"> => ({
      enabled,
      publicInHub,
      hubContentOnly,
    });
    expect(isHubContent(flags(true, true))).toBe(true);
    expect(isHubContent(flags(true, false, true))).toBe(true);
    expect(isHubContent(flags(true, false)), "hidden airline leaked onto the hub").toBe(false);
    expect(isHubContent(flags(true, false, false)), "hidden airline leaked onto the hub").toBe(
      false
    );
    for (const hidden of [flags(false, true), flags(false, false, true), flags(false, false)]) {
      expect(isHubContent(hidden), "disabled airline published").toBe(false);
    }
    // And the registry actually routes through that rule.
    expect(hubContentAirlines().every(isHubContent)).toBe(true);
    expect(Object.values(AIRLINES).filter(isHubContent)).toEqual(hubContentAirlines());
  });

  test("negative entries are grouped under an explicit not-Starlink section", async () => {
    const body = await (await get("/airlines", hub.canonicalHost)).text();
    expect(body).toContain("Not Starlink");
    for (const entry of contentOnlyFacts().filter((e) => e.status === "not_starlink")) {
      expect(body, `negatives section missing ${entry.name}`).toContain(html(entry.name));
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
        const { date } = factStamp(fact);
        expect(body, `${cfg.code} missing stamp ${date}`).toContain(formatFactDate(date));
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
      expect(body, entry.slug).toContain(html(entry.name));
      for (const fact of entry.facts) {
        const { label, date } = factStamp(fact);
        // Dated claims read "as of"; claims resting on an undated evergreen
        // source read "checked" — the reader must be able to tell them apart.
        expect(body, `${entry.slug} missing "${label}" stamp`).toContain(label);
        expect(body, `${entry.slug} missing stamp ${date}`).toContain(formatFactDate(date));
        expect(body, `${entry.slug} missing source ${fact.source.url}`).toContain(fact.source.url);
      }
    }
  });

  test("negative pages answer the question without overstating the negative", async () => {
    for (const entry of contentOnlyFacts().filter((e) => e.status === "not_starlink")) {
      const body = await (await get(`/airlines/${entry.slug}`, hub.canonicalHost)).text();
      // Question form always — but only an airline that announced an
      // alternative gets the flat "No". Where we have merely found no
      // announcement, the headline says so, because a page whose own body
      // reads "treat this as unconfirmed" must not headline a verified No.
      expect(body, entry.slug).toContain("Have Starlink?");
      expect(body, entry.slug).toContain(html(factsHeadline(entry)));
      if (entry.negative === "unannounced") {
        expect(factsHeadline(entry), entry.slug).toContain("No Deal Announced");
      } else {
        expect(factsHeadline(entry), entry.slug).toContain("Have Starlink? No");
      }
      expect(body, `${entry.slug} missing insteadOf`).toContain(entry.insteadOf as string);
    }
  });

  // The honest statusLabel ("First aircraft flying") must survive onto the page
  // next to the headline: a one-aircraft rollout and a finished one both derive
  // "Yes" from `status` alone, and only the label separates them.
  test("every facts page shows its status label beside the headline", async () => {
    for (const entry of contentOnlyFacts()) {
      const body = await (await get(`/airlines/${entry.slug}`, hub.canonicalHost)).text();
      expect(body, `${entry.slug} missing statusLabel`).toContain(entry.statusLabel);
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

  // One URL must not tell crawlers two different stories about when it
  // changed. The sitemap publishes the content's own date while the WebPage
  // JSON-LD used to publish the request clock, so every static facts page
  // claimed "modified right now" on every fetch.
  test("WebPage dateModified matches the URL's own sitemap lastmod", async () => {
    const xml = await (await get("/sitemap.xml", hub.canonicalHost)).text();
    const lastmodFor = (path: string) => {
      const block = xml
        .split("<url>")
        .find((b) => b.includes(`<loc>https://${hub.canonicalHost}${path}</loc>`));
      return block?.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1];
    };
    const paths = [
      ...contentOnlyFacts().map((e) => `/airlines/${e.slug}`),
      ...trackedRoster().map((cfg) => `/airlines/${airlineSlug(cfg)}`),
    ];
    let checked = 0;
    let unstamped = 0;
    for (const path of paths) {
      const lastmod = lastmodFor(path);
      const body = await (await get(path, hub.canonicalHost)).text();
      const modified = body.match(/"dateModified":"([^"]+)"/)?.[1];
      // Absence has to survive as absence. A page whose every claim rests on an
      // undated source omits <lastmod>; the WebPage must omit dateModified too
      // rather than fall through to the request clock, which is how the two
      // unstamped roster pages came to assert they changed this second.
      expect(modified, `${path} publishes a dateModified the sitemap does not`).toBe(lastmod);
      if (lastmod) checked++;
      else unstamped++;
    }
    expect(checked, "no page exercised the freshness invariant").toBeGreaterThan(0);
    expect(unstamped + checked, "roster shrank to nothing").toBe(paths.length);
  });

  // The whole point of the hub freshness model: a live page's dateModified is
  // its DATA's stamp, the same one the sitemap gives that URL — never the
  // clock, which would make every fetch look like a change.
  test("SITE_PAGES publish the data stamp, not the request clock", async () => {
    const xml = await (await get("/sitemap.xml", hub.canonicalHost)).text();
    const block = xml
      .split("<url>")
      .find((b) => b.includes(`<loc>https://${hub.canonicalHost}/</loc>`));
    const lastmod = block?.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1];
    const body = await (await get("/", hub.canonicalHost)).text();
    const modified = body.match(/"@type":"WebPage".*?"dateModified":"([^"]+)"/)?.[1];
    expect(modified).toBe(lastmod);
    expect(Date.parse(modified as string)).toBeLessThan(Date.now() - 1000);
  });

  // An /airlines/{slug} that serves 200 while nothing advertises it is an
  // orphan: indexable, unreachable, and invisible to the only lists a
  // maintainer edits. Unpublishing an airline has to take its page with it.
  test("no /airlines page serves outside the sitemap's population", async () => {
    const xml = await (await get("/sitemap.xml", hub.canonicalHost)).text();
    for (const entry of AIRLINE_FACTS) {
      const advertised = xml.includes(
        `<loc>https://${hub.canonicalHost}/airlines/${entry.slug}</loc>`
      );
      const res = await get(`/airlines/${entry.slug}`, hub.canonicalHost);
      expect(
        res.status === 200,
        `${entry.slug}: served=${res.status} advertised=${advertised}`
      ).toBe(advertised);
      // The IATA alias must answer the same way — the two halves of the lookup
      // diverging is exactly how the orphan survived.
      const byIata = await get(`/airlines/${entry.iata.toLowerCase()}`, hub.canonicalHost);
      expect([advertised ? 301 : 404], entry.iata).toContain(byIata.status);
    }
  });

  test("hub llms.txt never advertises a URL the sitemap withholds", async () => {
    const xml = await (await get("/sitemap.xml", hub.canonicalHost)).text();
    const llms = await (await app.dispatch(req("/llms.txt", hub.canonicalHost))).text();
    const linked = new Set(
      [
        ...llms.matchAll(
          new RegExp(`https://${hub.canonicalHost}(/(?:airlines|compare)[a-z0-9/-]*)`, "g")
        ),
      ].map((m) => m[1])
    );
    expect(linked.size, "llms.txt links no hub pages at all").toBeGreaterThan(0);
    for (const path of linked) {
      expect(xml, `llms.txt links ${path}, sitemap does not`).toContain(
        `<loc>https://${hub.canonicalHost}${path}</loc>`
      );
    }
  });

  test("airline-site sitemaps do not advertise /airlines", async () => {
    for (const site of Object.values(SITES).filter((s) => s.scope !== "ALL")) {
      const res = await get("/sitemap.xml", site.canonicalHost);
      expect(res.status, site.key).toBe(200);
      expect(await res.text(), site.key).not.toContain("/airlines");
    }
  });
});

// Every live SITES entry is all-on (hub) or all-off (tenant), so the flag
// combinations that broke llms.txt cannot be reached through a real host.
// Exercise the shared gate directly instead — it is the single place both the
// sitemap and llms.txt read their URL families from.
describe("hub URL families are gated once, for every surface", () => {
  const withFeatures = (over: Partial<typeof hub.features>) => ({
    ...hub,
    features: { ...hub.features, ...over },
  });

  test("both flags on: all three families populated", () => {
    const f = hubUrlFamilies(hub, getReader);
    expect(f.trackedAirlines.length).toBeGreaterThan(0);
    expect(f.factsRoster.length).toBeGreaterThan(0);
    expect(f.comparePairs.length).toBeGreaterThan(0);
  });

  test("airlinesPages off drops both /airlines families, comparePages off drops /compare", () => {
    const noAirlines = hubUrlFamilies(withFeatures({ airlinesPages: false }), getReader);
    expect(noAirlines.trackedAirlines).toEqual([]);
    expect(noAirlines.factsRoster).toEqual([]);
    const noCompare = hubUrlFamilies(withFeatures({ comparePages: false }), getReader);
    expect(noCompare.comparePairs).toEqual([]);
    const neither = hubUrlFamilies(
      withFeatures({ airlinesPages: false, comparePages: false }),
      getReader
    );
    expect([neither.trackedAirlines, neither.factsRoster, neither.comparePairs]).toEqual([
      [],
      [],
      [],
    ]);
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
