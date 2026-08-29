/**
 * Wave 1+2 content surfaces: /timeline, the /how-to-check + /is-starlink-free
 * intent pages, the popular-flights / sibling-link blocks that un-orphan the
 * flight permalink corpus, and the structured-data additions (per-page
 * og:type, Dataset on /methodology, ItemList on /fleet and /routes).
 *
 * Shape-only where data is involved — counts come from the snapshot and must
 * survive drift.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import { getTimeline, hasTimeline } from "../src/components/timeline-page";
import { cacheFlightRoute, getPopularFlights, seedFleetAnchors } from "../src/database/database";
import { createReaderFactory } from "../src/database/reader";
import { createApp } from "../src/server/app";
import { makeSyntheticDb, openSnapshot, req } from "./helpers";

let app: ReturnType<typeof createApp>;
let db: ReturnType<typeof openSnapshot>;
let getReader: ReturnType<typeof createReaderFactory>;

beforeAll(() => {
  db = openSnapshot();
  app = createApp(db);
  getReader = createReaderFactory(db);
});

const UA = SITES.united.canonicalHost;
const AS = SITES.alaska.canonicalHost;

// React SSR interleaves `<!-- -->` between adjacent text expressions; strip
// them so assertions see the text the way crawlers extract it.
const visible = (html: string) => html.replace(/<!--.*?-->/g, "");

const getText = async (path: string, host: string) => {
  const res = await app.dispatch(req(path, host, { headers: { Accept: "text/html" } }));
  return { status: res.status, text: visible(await res.text()) };
};

// ─────────────────────────────────────────────────────────────────────────────

describe("/timeline", () => {
  test("timeline data exists for UA and stays chronological", () => {
    expect(hasTimeline("UA")).toBe(true);
    const t = getTimeline("UA");
    expect(t).not.toBeNull();
    expect(t?.milestones.length).toBeGreaterThan(0);
    expect(t?.targets.length).toBeGreaterThan(0);
    const dates = (t?.milestones ?? []).map((m) => m.date);
    expect([...dates].sort()).toEqual(dates);
    for (const d of dates) expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("united: renders milestones, targets, and the live count", async () => {
    const { status, text } = await getText("/timeline", UA);
    expect(status).toBe(200);
    // Machine-readable milestone dates survive into the markup (React SSR
    // keeps the camelCase spelling; HTML attribute names are case-insensitive).
    for (const m of getTimeline("UA")?.milestones ?? []) {
      expect(text, m.title).toContain(`dateTime="${m.date}"`);
    }
    // Targets stay labeled as targets, never as accomplished milestones.
    expect(text).toContain("Stated target");
    // Closes with the live number, not a hardcoded one.
    const count = getReader("UA").getStarlinkPlanes().length;
    expect(text).toContain(`${count.toLocaleString("en-US")} of `);
    expect(text).toContain("have Starlink installed");
    // Links into the live surfaces.
    expect(text).toContain('href="/check-flight"');
    expect(text).toContain('href="/fleet"');
    // ItemList of milestones for structured data.
    expect(text).toContain('"@type":"ItemList"');
  });

  test("sitemap + llms.txt advertise /timeline only where it serves", async () => {
    for (const site of Object.values(SITES)) {
      const { text } = await getText("/sitemap.xml", site.canonicalHost);
      expect(text.includes(`https://${site.canonicalHost}/timeline`), `${site.key} sitemap`).toBe(
        site.features.timelinePage
      );
    }
    const { text } = await getText("/llms.txt", UA);
    expect(text).toContain("/timeline");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("intent pages", () => {
  test("united /how-to-check: steps, checker links, HowTo JSON-LD", async () => {
    const { status, text } = await getText("/how-to-check", UA);
    expect(status).toBe(200);
    expect(text).toContain('href="/check-flight"');
    expect(text).toContain('"@type":"HowTo"');
    expect(text).toContain('"@type":"HowToStep"');
    // Cross-links its sibling intent page.
    expect(text).toContain('href="/is-starlink-free"');
  });

  test("united /is-starlink-free: direct answer, live count, FAQ JSON-LD", async () => {
    const { status, text } = await getText("/is-starlink-free", UA);
    expect(status).toBe(200);
    expect(text).toContain("MileagePlus");
    expect(text).toContain('"@type":"FAQPage"');
    expect(text).toContain('href="/check-flight"');
    const count = getReader("UA").getStarlinkPlanes().length;
    expect(text).toContain(`${count.toLocaleString("en-US")} of `);
  });

  test("intent pages 404 where the feature is off", async () => {
    for (const path of ["/how-to-check", "/is-starlink-free"]) {
      expect((await getText(path, AS)).status, `${path} on alaska`).toBe(404);
      expect((await getText(path, SITES.airline.canonicalHost)).status, `${path} on hub`).toBe(404);
    }
  });

  test("sitemap advertises intent pages only where they serve", async () => {
    for (const site of Object.values(SITES)) {
      const { text } = await getText("/sitemap.xml", site.canonicalHost);
      for (const path of ["/how-to-check", "/is-starlink-free"]) {
        expect(
          text.includes(`https://${site.canonicalHost}${path}`),
          `${site.key} sitemap ${path}`
        ).toBe(site.features.intentPages);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("og:type is per-page", () => {
  const ogType = (html: string) => html.match(/property="og:type" content="([^"]*)"/)?.[1];

  test("tool and index pages stay website", async () => {
    for (const path of ["/", "/check-flight", "/fleet", "/routes"]) {
      const { text } = await getText(path, UA);
      expect(ogType(text), path).toBe("website");
    }
  });

  test("editorial pages are article", async () => {
    for (const path of ["/timeline", "/how-to-check", "/is-starlink-free", "/methodology"]) {
      const { text } = await getText(path, UA);
      expect(ogType(text), path).toBe("article");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("structured data blocks", () => {
  test("/methodology carries Dataset JSON-LD pointing at /api/data", async () => {
    const { text } = await getText("/methodology", UA);
    expect(text).toContain('"@type":"Dataset"');
    expect(text).toContain(`https://${UA}/api/data`);
    expect(text).toContain('"@type":"DataDownload"');
  });

  test("Dataset cites SEC filing source_urls once anchors are seeded", async () => {
    const sdb = makeSyntheticDb();
    seedFleetAnchors(sdb, [
      {
        airline: "UA",
        as_of_date: "2025-12-31",
        scope: "Mainline fleet in service",
        metric: "mainline_fleet_total",
        value: "1066",
        source_form: "UAL 10-K FY2025",
        source_url: "https://www.sec.gov/Archives/edgar/data/100517/test-filing.htm",
      },
    ]);
    const sapp = createApp(sdb);
    const res = await sapp.dispatch(req("/methodology", UA));
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain(
      '"citation":["https://www.sec.gov/Archives/edgar/data/100517/test-filing.htm"]'
    );
    expect(text).toContain('"temporalCoverage":"2025-12-31/.."');
    sdb.close();
  });

  test("/fleet and /routes carry ItemList JSON-LD", async () => {
    for (const path of ["/fleet", "/routes"]) {
      const { text } = await getText(path, UA);
      expect(text, path).toContain('"@type":"ItemList"');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("popular flights (permalink un-orphaning)", () => {
  test("getPopularFlights returns canonical marketing numbers with route context", () => {
    const flights = getPopularFlights(db, "UA");
    expect(flights.length).toBeGreaterThan(0);
    for (const f of flights) {
      expect(f.flight_number).toMatch(/^UA[1-9]\d{0,3}$/);
      expect(f.times).toBeGreaterThan(0);
      if (f.origin !== null) {
        expect(f.origin).toMatch(/^[A-Z]{3}$/);
        expect(f.destination).toMatch(/^[A-Z]{3}$/);
      }
    }
    // Ranked: times never increases down the list.
    const times = flights.map((f) => f.times);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  test("hub reader returns none (permalinks are tenant pages)", () => {
    expect(getReader("ALL").getPopularFlights()).toEqual([]);
  });

  test("normalization: padded spellings collapse, foreign prefixes drop", () => {
    const sdb = makeSyntheticDb();
    cacheFlightRoute(sdb, "UA0042", "SFO", "EWR", 3600);
    cacheFlightRoute(sdb, "UA42", "SFO", "EWR", 3600);
    cacheFlightRoute(sdb, "UAL99", "DEN", "ORD", 3600);
    const flights = getPopularFlights(sdb, "UA");
    expect(flights.map((f) => f.flight_number)).toEqual(["UA42"]);
    expect(flights[0].times).toBe(2);
    expect(flights[0].origin).toBe("SFO");
    sdb.close();
  });

  test("/, /check-flight and /routes render the block, and its links resolve", async () => {
    const flights = getPopularFlights(db, "UA");
    expect(flights.length).toBeGreaterThan(0);
    const first = flights[0];
    for (const path of ["/", "/check-flight", "/routes"]) {
      const { status, text } = await getText(path, UA);
      expect(status, path).toBe(200);
      expect(text, `${path} popular block`).toContain("data-popular-flights");
      expect(text, `${path} links ${first.flight_number}`).toContain(
        `href="/check-flight/${first.flight_number}"`
      );
    }
    // Every advertised permalink actually serves (same gate as the sitemap).
    for (const f of flights.slice(0, 5)) {
      const { status } = await getText(`/check-flight/${f.flight_number}`, UA);
      expect(status, f.flight_number).toBe(200);
    }
  });

  test("hub homepage renders no popular-flights block", async () => {
    const { text } = await getText("/", SITES.airline.canonicalHost);
    expect(text).not.toContain("data-popular-flights");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("sibling links between same-route flight numbers", () => {
  test("a permalink links laterally to other numbers on its route", async () => {
    const sdb = makeSyntheticDb();
    cacheFlightRoute(sdb, "UA111", "SFO", "EWR", 3600);
    cacheFlightRoute(sdb, "UA222", "SFO", "EWR", 3600);
    cacheFlightRoute(sdb, "UA333", "SFO", "EWR", 3600);
    const sapp = createApp(sdb);
    const res = await sapp.dispatch(req("/check-flight/UA111", UA));
    const text = visible(await res.text());
    expect(res.status).toBe(200);
    expect(text).toContain("Other flights on SFO");
    expect(text).toContain('href="/check-flight/UA222"');
    expect(text).toContain('href="/check-flight/UA333"');
    // Never links itself.
    expect(text).not.toContain('href="/check-flight/UA111"');
    sdb.close();
  });

  test("a flight with no recorded route renders no sibling block", async () => {
    const sdb = makeSyntheticDb();
    cacheFlightRoute(sdb, "UA555", "SFO", "EWR", 3600);
    const sapp = createApp(sdb);
    const res = await sapp.dispatch(req("/check-flight/UA555", UA));
    const text = visible(await res.text());
    expect(res.status).toBe(200);
    expect(text).not.toContain("Other flights on");
    sdb.close();
  });
});
