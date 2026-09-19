/**
 * SEO copy and routing defects found live in production:
 *  - "All 1 scheduled ABQ → PDX departures" on ~10% of route pages
 *  - "Enter a Alaska flight number" in the AS check-flight description
 *  - "Tracked Fleets Fleet Starlink Rollout" on the hub /fleet title
 *  - the hub homepage's only broken internal link (href="/route-planner",
 *    which 404s on the hub host)
 *  - /mcp answering 405 to any GET without Accept: text/html, despite being
 *    sitemap-advertised
 *  - /route-planner case/trailing-slash variants answering 200 instead of 301
 *  - ~43% of route pages leading with the 48h-window negative even when the
 *    route has durable history
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { TITLE_MAX, aircraftPagesFor, aircraftTypeTitle } from "../src/airlines/aircraft-pages";
import { SITES } from "../src/airlines/registry";
import { routeVerdict } from "../src/components/route-page";
import { getSitemapRoutes } from "../src/database/database";
import type { RouteSummary } from "../src/database/database";
import { clampMetaDescription, createApp } from "../src/server/app";
import type { AircraftVerdictKind } from "../src/types";
import { article } from "../src/utils/grammar";
import { openSnapshot, req } from "./helpers";

let app: ReturnType<typeof createApp>;
let db: ReturnType<typeof openSnapshot>;
beforeAll(() => {
  db = openSnapshot();
  app = createApp(db);
});

const UA = SITES.united.canonicalHost;
const HUB = SITES.airline.canonicalHost;
const AS = SITES.alaska.canonicalHost;

const summary = (over: Partial<RouteSummary>): RouteSummary => ({
  origin: "ABQ",
  destination: "PDX",
  flightNumbers: [],
  durationSec: null,
  equippedDepartures: 0,
  totalDepartures: 0,
  windowLabel: "next 48 hours",
  ...over,
});

describe("routeVerdict", () => {
  test("a single departure is never pluralized", () => {
    const one = routeVerdict(
      summary({ totalDepartures: 1, equippedDepartures: 1 }),
      "United Airlines"
    );
    expect(one).toMatch(/^1 Starlink-equipped United Airlines departure on /);
    expect(one).not.toContain("departures on");
  });

  test("an empty window with history leads with the history, not the negative", () => {
    const v = routeVerdict(
      summary({
        flightNumbers: [
          { flight_number: "UA123", times: 9, scheduled: 0 },
          { flight_number: "UA456", times: 3, scheduled: 0 },
        ],
      }),
      "United Airlines"
    );
    expect(v).toMatch(/^United Airlines flies ABQ → PDX/);
    expect(v).toContain("UA123");
    expect(v).not.toMatch(/^No United Airlines departures/);
  });

  test("an empty window with no history keeps the honest no-data copy", () => {
    expect(routeVerdict(summary({}), "United Airlines")).toMatch(
      /^No Starlink-equipped United Airlines departures/
    );
  });

  test("equipped departures never claim a denominator we do not observe", () => {
    const v = routeVerdict(
      summary({ totalDepartures: 4, equippedDepartures: 4 }),
      "United Airlines"
    );
    expect(v).toMatch(/^4 Starlink-equipped United Airlines departures on ABQ → PDX/);
    expect(v).toContain("check your flight number");
  });

  test("no combination of counts produces coverage claims", () => {
    const claim = /\b(All|None of the) \d+ scheduled|\d+ of \d+ scheduled|only scheduled/;
    const history = [
      [],
      [{ flight_number: "UA123", times: 9, scheduled: 1 }],
      [
        { flight_number: "UA123", times: 9, scheduled: 0 },
        { flight_number: "UA456", times: 3, scheduled: 1 },
      ],
    ];
    for (let total = 0; total <= 6; total++) {
      for (let equipped = 0; equipped <= total; equipped++) {
        for (const flightNumbers of history) {
          const v = routeVerdict(
            summary({ totalDepartures: total, equippedDepartures: equipped, flightNumbers }),
            "United Airlines"
          );
          expect(v).not.toMatch(claim);
          expect(v.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe("page copy", () => {
  test("AS check-flight description uses 'an Alaska', not 'a Alaska'", async () => {
    const body = await (
      await app.dispatch(req("/check-flight", AS, { headers: { Accept: "text/html" } }))
    ).text();
    expect(body).not.toContain("Enter a Alaska");
    expect(body).toContain("Enter an Alaska");
  });

  test("hub /fleet title does not read 'Fleets Fleet'", async () => {
    const body = await (
      await app.dispatch(req("/fleet", HUB, { headers: { Accept: "text/html" } }))
    ).text();
    expect(body).not.toContain("Fleets Fleet");
    expect(body).not.toContain("every tracked airlines aircraft");
  });

  test("the hub homepage has no relative /route-planner link (it 404s there)", async () => {
    const body = await (
      await app.dispatch(req("/", HUB, { headers: { Accept: "text/html" } }))
    ).text();
    expect(body).not.toContain('href="/route-planner"');
  });

  test("hub free FAQ does not claim every airline is free with no login", async () => {
    const body = await (
      await app.dispatch(req("/", HUB, { headers: { Accept: "text/html" } }))
    ).text();
    expect(body).not.toContain("no login wall or loyalty requirement");
    expect(body).not.toContain("free to every passenger, gate-to-gate, with no login");
    expect(body).toContain("MileagePlus");
    expect(body).toContain("Hawaiian");
    expect(body).toContain("Alaska");
  });
});

describe("/mcp content negotiation", () => {
  test("plain GET (curl, link checkers) gets the page, not 405", async () => {
    const res = await app.dispatch(req("/mcp", UA, { headers: { Accept: "*/*" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
  });

  test("an MCP-protocol GET still reaches the protocol handler", async () => {
    const res = await app.dispatch(req("/mcp", UA, { headers: { Accept: "text/event-stream" } }));
    expect((res.headers.get("content-type") ?? "").includes("text/html")).toBe(false);
  });
});

describe("/route-planner canonical spelling", () => {
  test("lowercase and trailing-slash variants 301 to the canonical form", async () => {
    const r = getSitemapRoutes(db, "UA")[0];
    const canonical = `https://${UA}/route-planner/${r.origin}/${r.destination}`;
    const lower = await app.dispatch(
      req(`/route-planner/${r.origin.toLowerCase()}/${r.destination.toLowerCase()}`, UA)
    );
    expect(lower.status).toBe(301);
    expect(lower.headers.get("location")).toBe(canonical);
    const slash = await app.dispatch(req(`/route-planner/${r.origin}/${r.destination}/`, UA));
    expect(slash.status).toBe(301);
    expect(slash.headers.get("location")).toBe(canonical);
  });

  test("the canonical spelling still renders 200 directly", async () => {
    const r = getSitemapRoutes(db, "UA")[0];
    const res = await app.dispatch(req(`/route-planner/${r.origin}/${r.destination}`, UA));
    expect(res.status).toBe(200);
  });
});

async function samplePages(host: string): Promise<string[]> {
  const xml = await (await app.dispatch(req("/sitemap.xml", host))).text();
  const paths = [...xml.matchAll(/<loc>https?:\/\/[^/]+([^<]*)<\/loc>/g)].map((m) => m[1] || "/");
  const byShape = new Map<string, string>();
  for (const p of paths) {
    const shape = p.split("/").slice(0, 3).join("/");
    if (!byShape.has(shape)) byShape.set(shape, p);
  }
  return [...byShape.values(), "/check-flight/NOTAFLIGHT", "/check-flight/XX123"];
}

const HOSTS = [UA, AS, SITES.hawaiian.canonicalHost, HUB];
const html = async (path: string, host: string) =>
  (await app.dispatch(req(path, host, { headers: { Accept: "text/html" } }))).text();
const metaContent = (doc: string, attr: string) =>
  doc.match(new RegExp(`<meta ${attr} content="([^"]*)"`))?.[1] ?? null;

describe("article()", () => {
  test("follows the spoken sound, not just the letter", () => {
    expect(article("Alaska")).toBe("an");
    expect(article("Hawaiian")).toBe("a");
    expect(article("United")).toBe("a");
    expect(article("Emirates")).toBe("an");
    expect(article("flight")).toBe("a");
  });

  test("no rendered title reads 'a' before a vowel sound", async () => {
    const bad = / a (?:[AEIO]|U(?!ni|se|su))/;
    for (const host of HOSTS) {
      for (const path of await samplePages(host)) {
        const doc = await html(path, host);
        const title = doc.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
        expect({ host, path, title, bad: bad.test(title) }).toEqual({
          host,
          path,
          title,
          bad: false,
        });
      }
    }
  });
});

describe("meta description clamp", () => {
  test("short copy is untouched and long copy ends on a word with an ellipsis", () => {
    expect(clampMetaDescription("Short and sweet.")).toBe("Short and sweet.");
    const long = "word ".repeat(80).trim();
    const out = clampMetaDescription(long);
    expect(out.length).toBeLessThanOrEqual(158);
    expect(out.endsWith("word…")).toBe(true);
  });

  test("every sampled page keeps description and og:description within 160 chars", async () => {
    for (const host of HOSTS) {
      for (const path of await samplePages(host)) {
        const doc = await html(path, host);
        for (const attr of ['name="description"', 'property="og:description"']) {
          const v = metaContent(doc, attr);
          if (v === null) continue;
          expect({ host, path, attr, ok: v.length <= 160 }).toEqual({ host, path, attr, ok: true });
        }
      }
    }
  });
});

describe("SoftwareApplication JSON-LD", () => {
  test("ships only on /how-to-check", async () => {
    const flight = (await samplePages(UA)).find((p) => /^\/check-flight\/./.test(p));
    for (const path of ["/", "/route-planner", "/check-flight", flight ?? "/check-flight/UA1"]) {
      expect({ path, has: (await html(path, UA)).includes('"SoftwareApplication"') }).toEqual({
        path,
        has: false,
      });
    }
    const guide = await html("/how-to-check", UA);
    expect(guide).toContain('"SoftwareApplication"');
    expect(guide).toContain("Google Flights Starlink Indicator");
  });
});

describe("aircraft-type page titles", () => {
  const KINDS: AircraftVerdictKind[] = [
    "all",
    "all_checked",
    "most",
    "some",
    "verifying",
    "installing",
    "none",
    "official_none",
    "unknown",
  ];

  // withClampedMeta clamps descriptions only, so the ladder alone keeps titles
  // in budget — including at the longest counts and the attributed Alaska form.
  test("every def and verdict fits 60 chars at worst-case counts", () => {
    for (const code of ["UA", "AS"]) {
      for (const def of aircraftPagesFor(code)) {
        for (const kind of KINDS) {
          for (const official of [
            null,
            { count: 1173, all: false, asOf: "2026-08-28", sourceLabel: "x", url: "x" },
          ]) {
            const title = aircraftTypeTitle({ airline: code, total: 1175, starlink: 1173 }, def, {
              kind,
              effective: 1174,
              official,
              rosterShort: official !== null,
            });
            expect({
              code,
              slug: def.slug,
              kind,
              title,
              ok: title.length <= TITLE_MAX,
            }).toMatchObject({
              ok: true,
            });
            expect(title).toContain(def.short);
            if (kind === "verifying") expect(title).not.toMatch(/Not Yet/);
          }
        }
      }
    }
  });

  test("every served type page's <title> is within budget", async () => {
    for (const [code, host] of [
      ["UA", UA],
      ["AS", AS],
    ] as const) {
      for (const def of aircraftPagesFor(code)) {
        const res = await app.dispatch(req(`/fleet/${def.slug}`, host));
        if (res.status !== 200) continue;
        const title = (await res.text()).match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
        expect(title.length, title).toBeLessThanOrEqual(TITLE_MAX);
        expect(title.length).toBeGreaterThan(0);
      }
    }
  });
});
