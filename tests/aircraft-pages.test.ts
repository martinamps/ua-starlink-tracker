/**
 * /fleet/{slug} aircraft-type pages. Shapes and invariants only: which types
 * serve, and every count, drifts with the data. What must hold is that the
 * page count equals the /fleet family row, the verdict never says "no" for
 * "not verified yet", zero-signal pages stay out of the index, and every link
 * a page renders resolves.
 */

import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import {
  AIRCRAFT_FAMILY_KEYS,
  isFreighterFamily,
  normalizeAircraftType,
} from "../src/airlines/aircraft-families";
import {
  AIRCRAFT_PAGES,
  type AircraftPageDef,
  MIN_TYPE_TAILS,
  type OfficialCount,
  SHEET_CODE_TO_FAMILY,
  aircraftPageForFamily,
  aircraftPagesFor,
  aircraftTypeFaq,
  aircraftTypeTitle,
  answerFor,
  officialCountFor,
  resolveAircraftSlug,
  typeFactsFor,
} from "../src/airlines/aircraft-pages";
import { AIRLINES, SITES } from "../src/airlines/registry";
import { pct } from "../src/components/layout";
import {
  bodyClassOf,
  getAircraftTypePageData,
  getSitemapFlights,
  getSitemapRoutes,
} from "../src/database/database";
import { createApp } from "../src/server/app";
import type { AircraftTypePageData, AircraftVerdictKind, WifiProvider } from "../src/types";
import { baseNormalizeAircraftType } from "./fixtures/aircraft-families-base";
import { addFleet, addFlight, addPlane, makeSyntheticDb, openSnapshot, req } from "./helpers";

const UA = SITES.united.canonicalHost;
const AS = SITES.alaska.canonicalHost;
const HUB = SITES.airline.canonicalHost;
const TENANTS = [
  ["UA", UA],
  ["AS", AS],
] as const;

let snap: Database;
let app: ReturnType<typeof createApp>;
beforeAll(() => {
  snap = openSnapshot();
  app = createApp(snap);
});

const get = (path: string, host: string, init?: RequestInit) => app.dispatch(req(path, host, init));

function unescapeHtml(s: string): string {
  return s
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function jsonLd(html: string): Array<Record<string, unknown>> {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) =>
    JSON.parse(m[1])
  );
}

async function sitemapPaths(host: string): Promise<Map<string, string | undefined>> {
  const xml = await (await get("/sitemap.xml", host)).text();
  const out = new Map<string, string | undefined>();
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = m[1].match(/<loc>https:\/\/[^/]+([^<]*)<\/loc>/)?.[1] ?? "";
    out.set(loc, m[1].match(/<lastmod>([^<]+)<\/lastmod>/)?.[1]);
  }
  return out;
}

async function servedDefs(code: "UA" | "AS", host: string): Promise<AircraftPageDef[]> {
  const out: AircraftPageDef[] = [];
  for (const def of aircraftPagesFor(code)) {
    if ((await get(`/fleet/${def.slug}`, host)).status === 200) out.push(def);
  }
  return out;
}

// ── 1. registry hygiene ─────────────────────────────────────────────────────

describe("page registry", () => {
  for (const [code] of TENANTS) {
    const defs = AIRCRAFT_PAGES[code];

    test(`${code}: families are real, passenger, and one page each`, () => {
      const families = defs.map((d) => d.family);
      expect(new Set(families).size).toBe(families.length);
      for (const d of defs) {
        expect(AIRCRAFT_FAMILY_KEYS).toContain(d.family);
        expect(isFreighterFamily(d.family)).toBe(false);
        expect(aircraftPageForFamily(code, d.family)).toBe(d);
      }
    });

    test(`${code}: slugs and aliases are URL-safe and never collide`, () => {
      const all = defs.flatMap((d) => [d.slug, ...d.aliases]);
      for (const s of all) expect(s).toMatch(/^[a-z0-9-]+$/);
      expect(new Set(all).size).toBe(all.length);
    });

    test(`${code}: ambiguous spellings are never aliases`, () => {
      const all = new Set(defs.flatMap((d) => d.aliases));
      for (const bad of ["737-8", "737-9", "737", "max"]) expect(all.has(bad)).toBe(false);
    });

    test(`${code}: slugs resolve in place, aliases and case variants redirect`, () => {
      for (const d of defs) {
        expect(resolveAircraftSlug(code, d.slug)).toEqual({ def: d, redirect: false });
        expect(resolveAircraftSlug(code, d.slug.toUpperCase())?.redirect).toBe(
          d.slug !== d.slug.toUpperCase()
        );
        for (const a of d.aliases)
          expect(resolveAircraftSlug(code, a)).toEqual({ def: d, redirect: true });
      }
    });

    test(`${code}: junk segments resolve to nothing`, () => {
      for (const bad of ["", "x".repeat(41), "737%2d800", "777f", "foo", "737-800/x"]) {
        expect(resolveAircraftSlug(code, bad)).toBeNull();
      }
    });
  }

  test("the hub has no type pages", () => {
    expect(aircraftPagesFor("ALL")).toEqual([]);
    expect(SITES.airline.features.aircraftPages).toBe(false);
  });
});

// ── 2. sheet codes ──────────────────────────────────────────────────────────

// Every column the United fleet progress sheet carried on the Aug 2026 prod
// snapshot, plus the fleet-progress test fixtures. A new column must be mapped
// (or it silently drops out of its type's pipeline).
const OBSERVED_SHEET_CODES = [
  ["319", "320", "73G", "738", "739", "38M", "39M", "753", "321", "321XLR", "752"],
  ["763A/Q", "763L", "764S/U", "788", "78X", "789", "789L", "772A/E", "PW", "GE", "77W"],
  ["E175", "E175SC", "E170", "CRJ7", "CRJ550", "E145X", "CRJ2"],
].flat();

describe("sheet-code coverage", () => {
  test("every observed code maps to a real family", () => {
    const snapCodes = (
      snap
        .query("SELECT DISTINCT type_code FROM fleet_progress WHERE type_code <> 'Totals'")
        .all() as { type_code: string }[]
    ).map((r) => r.type_code);
    for (const code of [...OBSERVED_SHEET_CODES, ...snapCodes]) {
      expect(SHEET_CODE_TO_FAMILY[code], code).toBeDefined();
      expect(AIRCRAFT_FAMILY_KEYS).toContain(SHEET_CODE_TO_FAMILY[code]);
    }
    expect(SHEET_CODE_TO_FAMILY.E170).toBe("E170");
    expect(SHEET_CODE_TO_FAMILY.CRJ7).toBe("CRJ-700");
  });
});

// ── 3. normalizer ───────────────────────────────────────────────────────────

// The only strings the E170 split and the coverage rules may move, as
// predicates over (raw, before, after).
const ALLOWED_MOVES: Array<(raw: string, before: string, after: string) => boolean> = [
  (raw, before, after) => /170/.test(raw) && before === "E175" && after === "E170",
  (raw, before, after) => /737-?M8/i.test(raw) && before === "other" && after === "B737-MAX8",
  (raw, before, after) => /737-?M9/i.test(raw) && before === "other" && after === "B737-MAX9",
  (raw, before, after) => /Airbus\s+320\b/i.test(raw) && before === "other" && after === "A320",
];

// Raw strings from the Aug 2026 prod snapshot's united_fleet and verification
// log, so the diff is exercised on production vocabulary, not just the
// fixture's handful. (upcoming_flights has no aircraft_type column.)
const PROD_TYPE_STRINGS = [
  ...["Embraer E170SE", "Embraer E-170", "Embraer E-175", "Embraer E175LL", "Embraer E175LR"],
  ...["ERJ-175", "E175SC", "E175", "737-M8E", "737-M9E", "737-800E", "737-900E", "737-900R"],
  ...["Airbus 320", "Airbus A320", "Airbus A321neo", "Airbus A321XLR", "Boeing 737"],
  ...["Boeing 737-924(ER)", "Boeing 737-900ER", "Bombardier CRJ-550", "Mitsubishi CRJ-701ER"],
  ...["Boeing 787-10 Dreamliner", "Boeing 777-300ER", "A321-NEO", "A330-200", "Unknown"],
];

describe("normalizeAircraftType after the E170 split", () => {
  test.each([
    ["Embraer E170SE", "E170"],
    ["ERJ-175", "E175"],
    ["E175SC", "E175"],
    ["Embraer E175LR", "E175"],
    ["Embraer E175LL", "E175"],
    ["E75L", "E175"],
    ["737-M8E", "B737-MAX8"],
    ["Airbus 320", "A320"],
  ])("%s → %s", (raw, family) => {
    expect(normalizeAircraftType(raw)).toBe(family);
  });

  test("E170 is a regional family", () => {
    expect(bodyClassOf("E170")).toBe("regional");
  });

  test("only the allowed strings change family versus the base rules", () => {
    const fromSnap = [
      "SELECT DISTINCT aircraft_type AS t FROM united_fleet",
      "SELECT DISTINCT aircraft_type AS t FROM starlink_verification_log",
    ].flatMap((sql) => (snap.query(sql).all() as { t: string | null }[]).map((r) => r.t ?? ""));
    const moved: string[] = [];
    for (const raw of new Set([...fromSnap, ...PROD_TYPE_STRINGS])) {
      const before = baseNormalizeAircraftType(raw);
      const after = normalizeAircraftType(raw);
      if (before === after) continue;
      moved.push(raw);
      expect(
        ALLOWED_MOVES.some((ok) => ok(raw, before, after)),
        `${raw}: ${before} → ${after}`
      ).toBe(true);
    }
    expect(moved.length).toBeGreaterThan(0);
  });
});

// ── 4. provider consistency ────────────────────────────────────────────────

describe("provider buckets (snapshot)", () => {
  for (const [code] of TENANTS) {
    test(`${code}: starlink tails and provider sums match the family count`, () => {
      let seen = 0;
      for (const def of aircraftPagesFor(code)) {
        const d = getAircraftTypePageData(snap, code, def.slug);
        if (!d) continue;
        seen++;
        expect(d.starlinkTails.length).toBe(d.starlink);
        expect(d.providers.starlink).toBe(d.starlink);
        const sum = Object.values(d.providers).reduce((a, b) => a + b, 0);
        expect(sum).toBe(d.total);
        expect(d.checked).toBe(d.total - d.unchecked);
        expect(d.total).toBeGreaterThanOrEqual(1);
      }
      expect(seen).toBeGreaterThan(0);
    });
  }
});

// ── 5. answerFor ────────────────────────────────────────────────────────────

const UA_E175 = aircraftPagesFor("UA").find((d) => d.slug === "e175") as AircraftPageDef;
const UA_787 = aircraftPagesFor("UA").find((d) => d.slug === "787") as AircraftPageDef;
const AS_MAX8 = aircraftPagesFor("AS").find((d) => d.slug === "737-max-8") as AircraftPageDef;
const AS_E175 = aircraftPagesFor("AS").find((d) => d.slug === "e175") as AircraftPageDef;
const AS_738 = aircraftPagesFor("AS").find((d) => d.slug === "737-800") as AircraftPageDef;

const CLOCK = Date.parse("2026-09-01T00:00:00Z") / 1000;

function input(over: Partial<AircraftTypePageData> = {}): AircraftTypePageData {
  const providers: Record<WifiProvider, number> = {
    starlink: 0,
    viasat: 0,
    panasonic: 0,
    thales: 0,
    none: 0,
    unknown: 0,
    ...(over.providers ?? {}),
  };
  return {
    airline: "UA",
    family: "E175",
    total: 10,
    starlink: 0,
    providers,
    checked: 10,
    knownOther: 0,
    unchecked: 0,
    tails: [],
    starlinkTails: [],
    variants: null,
    listedAwaitingVerification: [],
    firstSeen: null,
    recentInstalls: [],
    pipeline: null,
    routes: [],
    routeTotals: { departures: 0, pairs: 0 },
    flightNumbers: [],
    flightNumbersScope: "all",
    dataClock: CLOCK,
    ...over,
  };
}

const official = (count: number, asOf = "2026-08-28", all = false): OfficialCount => ({
  count,
  all,
  asOf,
  sourceLabel: "Alaska Airlines newsroom — Starlink tracker",
  url: "https://news.alaskaair.com/alaska-airlines-wifi-connectivity/",
});

const pipeline = (over: Partial<NonNullable<AircraftTypePageData["pipeline"]>> = {}) => ({
  total: 12,
  starlink_complete: 0,
  in_mod: 1,
  verification_needed: 0,
  sheet_updated: "8/29 1am",
  fetched_at: CLOCK - 86400,
  rows: [],
  tails: [],
  movements: [],
  ...over,
});

describe("answerFor", () => {
  const cases: Array<
    [AircraftVerdictKind, AircraftPageDef, AircraftTypePageData, OfficialCount | null]
  > = [
    ["all", UA_E175, input({ total: 10, starlink: 10 }), null],
    ["all_checked", UA_E175, input({ total: 10, starlink: 9, unchecked: 1, checked: 9 }), null],
    ["most", UA_E175, input({ total: 10, starlink: 6, knownOther: 4 }), null],
    ["some", UA_E175, input({ total: 10, starlink: 2, knownOther: 8 }), null],
    ["installing", UA_787, input({ knownOther: 10, pipeline: pipeline() }), null],
    [
      "verifying",
      UA_787,
      input({ knownOther: 10, pipeline: pipeline({ in_mod: 0, verification_needed: 1 }) }),
      null,
    ],
    [
      "verifying",
      UA_787,
      input({ knownOther: 9, unchecked: 1, listedAwaitingVerification: ["N1"] }),
      null,
    ],
    ["none", UA_787, input({ knownOther: 10 }), null],
    ["official_none", AS_738, input({ airline: "AS", unchecked: 10, checked: 0 }), official(0)],
    ["unknown", AS_738, input({ airline: "AS", unchecked: 10, checked: 0 }), null],
  ];

  test.each(cases)("%s", (kind, def, data, o) => {
    const a = answerFor(data, def, o);
    expect(a.kind).toBe(kind);
    expect(a.indexable).toBe(!["none", "official_none", "unknown"].includes(kind));
    expect(a.shareLine === null).toBe(
      ["verifying", "installing", "none", "official_none", "unknown"].includes(kind)
    );
    if (["verifying", "official_none", "unknown"].includes(kind)) {
      expect(a.headline).not.toMatch(/^No\b/);
      expect(a.sentence).not.toMatch(/^No\b/);
    }
    expect(`${a.headline} ${a.sentence}`).toContain(def.short);
    expect(`${a.headline} ${a.sentence}`).toMatch(/\d/);
  });

  test("the listed-driven verifying case names the listing", () => {
    const a = answerFor(
      input({ knownOther: 9, unchecked: 1, listedAwaitingVerification: ["N1"] }),
      UA_787,
      null
    );
    expect(a.sentence).toContain("awaiting a united.com check");
  });

  test("100% only when every tail has it; floors elsewhere", () => {
    expect(pct(10, 10)).toBe("100%");
    expect(pct(248, 249)).toBe(">99%");
    expect(pct(1, 173)).toBe("<1%");
    expect(pct(199, 200)).toBe(">99%");
    expect(pct(99, 100)).toBe("99%");
    expect(pct(2, 3)).toBe("66%");
    for (const [s, t] of [
      [248, 249],
      [6, 10],
      [1, 173],
    ]) {
      const a = answerFor(input({ total: t, starlink: s, knownOther: t - s }), UA_E175, null);
      expect(`${a.headline} ${a.sentence} ${a.shareLine}`).not.toContain("100%");
    }
  });

  test("an unchecked new tail keeps 'every one' — never 'most'", () => {
    const a = answerFor(
      input({ total: 249, starlink: 248, unchecked: 1, checked: 248 }),
      UA_E175,
      null
    );
    expect(a.kind).toBe("all_checked");
  });

  test("a tail verified on another provider is a conflict, never a positive word", () => {
    // N2 is listed with Starlink but united.com showed Viasat: it is knownOther,
    // not listed-awaiting, so a zero-Starlink type stays "none", not "verifying".
    const a = answerFor(input({ knownOther: 10, listedAwaitingVerification: [] }), UA_787, null);
    expect(a.kind).toBe("none");
    expect(a.sentence).not.toMatch(/listed with Starlink/);
  });

  test("AS MAX 8: Alaska's higher figure drives the verdict, attributed, with ours alongside", () => {
    const a = answerFor(
      input({ airline: "AS", total: 20, starlink: 7, unchecked: 13, checked: 7 }),
      AS_MAX8,
      official(12)
    );
    expect(a.kind).toBe("most");
    expect(a.effective).toBe(12);
    for (const s of [a.headline, a.shareLine ?? ""]) {
      expect(s).toContain("12");
      expect(s).toContain("60%");
    }
    expect(a.shareLine).toContain("Aug 28, 2026");
    expect(a.shareLine).toContain("7");
    expect(`${a.sentence} ${a.shareLine}`).not.toContain("united.com");
  });

  test("AS E175: Alaska's 93 and our 92 without a contradiction", () => {
    const a = answerFor(
      input({ airline: "AS", total: 92, starlink: 92, checked: 92 }),
      AS_E175,
      official(93, "2026-08-28", true)
    );
    expect(a.kind).toBe("all");
    expect(a.sentence).toContain("93");
    expect(a.sentence).toContain("92");
    expect(a.sentence).not.toMatch(/reports 93[^.]*confirmation for 92/);
  });

  test("an official figure older than 45 days says so", () => {
    const fresh = answerFor(
      input({ airline: "AS", unchecked: 10, checked: 0 }),
      AS_738,
      official(0)
    );
    const stale = answerFor(
      input({ airline: "AS", unchecked: 10, checked: 0 }),
      AS_738,
      official(0, "2026-06-01")
    );
    expect(fresh.sentence).not.toContain("hasn't been updated since");
    expect(stale.sentence).toContain("hasn't been updated since Jun 1, 2026");
  });
});

// ── 6. serve and render (snapshot) ──────────────────────────────────────────

describe("answerFor edge verdicts", () => {
  const fullyChecked = input({ total: 91, checked: 91, knownOther: 91 });

  test("an in-mod first install on an all-checked type states the no, not 'not verified'", () => {
    const a = answerFor({ ...fullyChecked, pipeline: pipeline({ in_mod: 1 }) }, UA_787, null);
    expect(a.kind).toBe("installing");
    expect(a.indexable).toBe(true);
    expect(a.headline).toMatch(/^Not yet/);
    expect(a.sentence).toMatch(/under way/);
    const title = aircraftTypeTitle(fullyChecked, UA_787, a);
    expect(title).not.toMatch(/Verified/);
    expect(title).toMatch(/Not Yet/);
  });

  test("a finished-but-unconfirmed install is still 'verifying'", () => {
    for (const over of [{ starlink_complete: 1 }, { verification_needed: 1 }]) {
      const a = answerFor(
        { ...fullyChecked, pipeline: pipeline({ in_mod: 0, ...over }) },
        UA_787,
        null
      );
      expect(a.kind).toBe("verifying");
    }
  });

  test("a type with no tail checked is never a 'no'", () => {
    for (const p of [null, pipeline({ in_mod: 2 })]) {
      const a = answerFor(
        input({ total: 10, checked: 0, unchecked: 10, pipeline: p }),
        UA_787,
        null
      );
      expect(a.kind).toBe("unknown");
      expect(a.indexable).toBe(false);
      expect(`${a.headline} ${a.sentence}`).not.toMatch(/Not yet|has Starlink yet/);
    }
  });

  test("Alaska listings never produce united.com wording", () => {
    const a = answerFor(
      input({ airline: "AS", checked: 0, unchecked: 10, listedAwaitingVerification: ["N1"] }),
      AS_738,
      official(0)
    );
    expect(a.kind).toBe("official_none");
    expect(`${a.headline} ${a.sentence}`).not.toContain("united.com");
  });

  test("an official count without 'all' never becomes 'every one' on a short roster", () => {
    const a = answerFor(
      input({ airline: "AS", total: 12, starlink: 7, checked: 7, unchecked: 5 }),
      AS_MAX8,
      official(12)
    );
    expect(a.kind).not.toBe("all");
    expect(a.rosterShort).toBe(true);
    expect(`${a.headline} ${a.sentence} ${a.shareLine}`).not.toMatch(/every one|100%|of its 12/i);
    expect(aircraftTypeTitle({ airline: "AS", total: 12, starlink: 7 }, AS_MAX8, a)).not.toMatch(
      /All|of 12/
    );
    const stated = answerFor(
      input({ airline: "AS", total: 92, starlink: 90, checked: 90, unchecked: 2 }),
      AS_E175,
      official(93, "2026-08-28", true)
    );
    expect(stated.kind).toBe("all");
    expect(aircraftTypeTitle({ airline: "AS", total: 92, starlink: 90 }, AS_E175, stated)).toMatch(
      /Yes, Every One$/
    );
  });

  test("'every one we've checked' needs the checked tails to cover the type", () => {
    const a = answerFor(input({ total: 21, starlink: 1, checked: 1, unchecked: 20 }), UA_787, null);
    expect(a.kind).toBe("some");
    expect(a.headline).toMatch(/^One does/);
    expect(a.sentence).toContain("20 tails not checked yet");
  });

  test("a lone equipped tail reads in the singular", () => {
    const data = input({
      total: 173,
      starlink: 1,
      checked: 172,
      knownOther: 171,
      unchecked: 1,
      providers: { starlink: 1, viasat: 171, unknown: 1 } as Record<WifiProvider, number>,
    });
    const a = answerFor(data, UA_787, null);
    expect(a.headline).toBe("One does: 1 of 173 (<1%).");
    const faq = aircraftTypeFaq(data, UA_787, [], null, { freeAccess: "Yes, free for all." });
    const text = faq.map((f) => f.a).join(" ");
    expect(text).toContain("the one equipped United 787:");
    expect(text).toContain("1 has Starlink");
    expect(text).not.toMatch(/\b1 have\b|1 equipped/);
  });
});

describe("serve and render", () => {
  for (const [code, host] of TENANTS) {
    test(`${code}: every served page renders its counts, canonical, and structured data`, async () => {
      const served = await servedDefs(code, host);
      expect(served.length).toBeGreaterThan(0);
      const summary = (await (await get("/api/fleet-summary", host)).json()) as {
        airlines: Array<{
          code: string;
          families: Array<{ family: string; installed: number; total: number }>;
        }>;
      };
      const families = summary.airlines.find((a) => a.code === code)?.families ?? [];
      const sitemap = await sitemapPaths(host);

      for (const def of served) {
        const path = `/fleet/${def.slug}`;
        const html = await (await get(path, host)).text();
        const canonical = `https://${host}${path}`;
        expect(html).toContain(`<link rel="canonical" href="${canonical}"`);
        expect(html.match(/<h1[\s>]/g)?.length).toBe(1);
        expect(html).toContain('id="answer"');

        const fam = families.find((f) => f.family === def.family);
        expect(fam, def.slug).toBeDefined();
        expect(html).toContain(`data-equipped="${fam?.installed}"`);
        expect(html).toContain(`data-total="${fam?.total}"`);

        const blocks = jsonLd(html);
        const crumb = blocks.find((b) => b["@type"] === "BreadcrumbList") as {
          itemListElement: Array<{ item: string }>;
        };
        expect(crumb.itemListElement.at(-1)?.item).toBe(canonical);

        const indexed = sitemap.has(path);
        expect(html.includes('content="noindex, follow"'), def.slug).toBe(!indexed);
        const faqLd = blocks.find((b) => b["@type"] === "FAQPage") as
          | { mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }> }
          | undefined;
        expect(Boolean(faqLd), def.slug).toBe(indexed);
        const visibleQuestions =
          html.match(/<dt class="font-display text-sm font-semibold text-secondary">/g) ?? [];
        expect(visibleQuestions.length).toBeGreaterThanOrEqual(2);
        expect(visibleQuestions.length).toBeLessThanOrEqual(5);
        if (faqLd) {
          expect(faqLd.mainEntity.length).toBe(visibleQuestions.length);
          for (const q of faqLd.mainEntity) {
            expect(unescapeHtml(html)).toContain(q.name);
            expect(q.acceptedAnswer.text).toContain(def.short);
            expect(q.acceptedAnswer.text).toMatch(/\d/);
          }
        }

        // One freshness story per URL: the sitemap's lastmod is the page's own.
        if (indexed) {
          const webPage = blocks.find((b) => b["@type"] === "WebPage") as { dateModified?: string };
          expect(webPage.dateModified, def.slug).toBe(sitemap.get(path));
        }

        // Bun.serve drops HEAD bodies on the wire; the handler just must not 405.
        expect((await get(path, host, { method: "HEAD" })).status).toBe(200);
      }
      expect([...sitemap.keys()].some((p) => p.startsWith("/fleet/"))).toBe(true);
    });

    test(`${code}: every served page's FAQ answers carry the type and a number`, () => {
      for (const def of aircraftPagesFor(code)) {
        const d = getAircraftTypePageData(snap, code, def.slug);
        if (!d) continue;
        const faq = aircraftTypeFaq(
          d,
          def,
          typeFactsFor(code, def.slug),
          officialCountFor(code, def.slug),
          {
            freeAccess: "Yes — free for members.",
          }
        );
        expect(faq.length).toBeGreaterThanOrEqual(1);
        expect(faq.length).toBeLessThanOrEqual(5);
        for (const item of faq) {
          expect(item.a, `${def.slug}: ${item.q}`).toContain(def.short);
          expect(item.a, `${def.slug}: ${item.q}`).toMatch(/\d/);
        }
      }
    });
  }
});

// ── 7. redirects and 404s ───────────────────────────────────────────────────

describe("redirects and 404s", () => {
  test("case, trailing slash and a served alias 301 to the canonical", async () => {
    const [def] = await servedDefs("UA", UA);
    const canonical = `https://${UA}/fleet/${def.slug}`;
    for (const p of [
      `/fleet/${def.slug.toUpperCase()}`,
      `/fleet/${def.slug}/`,
      `/fleet/${def.aliases[0]}?utm=x`,
    ]) {
      const res = await get(p, UA);
      expect(res.status, p).toBe(301);
      expect(res.headers.get("Location"), p).toBe(canonical);
    }
    const bare = await get("/fleet/", UA);
    expect(bare.status).toBe(301);
    expect(bare.headers.get("Location")).toBe(`https://${UA}/fleet`);
  });

  test("ambiguous, unknown, nested and unserved segments 404 without a Location", async () => {
    for (const [p, host] of [
      ["/fleet/737-8", UA],
      ["/fleet/zzz", UA],
      ["/fleet/737-800/x", UA],
      ["/fleet/crj-700", UA],
      ["/fleet/a320", AS],
      ["/fleet/737-700", AS],
    ] as const) {
      const res = await get(p, host);
      expect(res.status, `${host}${p}`).toBe(404);
      expect(res.headers.get("Location")).toBeNull();
    }
  });

  test("an alias of an unserved type 404s instead of redirecting", async () => {
    const db = makeSyntheticDb();
    for (let i = 0; i < MIN_TYPE_TAILS - 1; i++) {
      addFleet(db, `N${i}Q`, "confirmed", { aircraftType: "ERJ-175", verifiedWifi: "Starlink" });
    }
    const small = createApp(db);
    const res = await small.dispatch(req("/fleet/erj-175", UA));
    expect(res.status).toBe(404);
    expect(res.headers.get("Location")).toBeNull();
    db.close();
  });

  test("POST is 405", async () => {
    const [def] = await servedDefs("UA", UA);
    expect((await get(`/fleet/${def.slug}`, UA, { method: "POST" })).status).toBe(405);
  });
});

// ── 8. tenant isolation ────────────────────────────────────────────────────

describe("tenant isolation", () => {
  test("the hub serves, links and advertises no type pages", async () => {
    expect((await get("/fleet/737-800", HUB)).status).toBe(404);
    for (const p of ["/sitemap.xml", "/llms.txt", "/fleet"]) {
      expect(await (await get(p, HUB)).text(), p).not.toContain("/fleet/");
    }
  });

  test("Alaska pages never borrow United's evidence or the group-wide figure", async () => {
    for (const def of await servedDefs("AS", AS)) {
      const html = await (await get(`/fleet/${def.slug}`, AS)).text();
      for (const bad of ["united.com", "Unknown", "50 mainline"]) {
        expect(html, `${def.slug}: ${bad}`).not.toContain(bad);
      }
      if (def.family !== "E175") {
        expect(html, def.slug).toMatch(/updated [A-Z][a-z]{2} \d{1,2}, \d{4}/);
      }
    }
  });
});

// ── 9–15. synthetic data paths ─────────────────────────────────────────────

const NOW = Math.floor(Date.now() / 1000);

function vlog(
  db: Database,
  tail: string,
  fn: string,
  checkedAt: number,
  provider = "Starlink",
  airline = "UA"
) {
  db.query(
    `INSERT INTO starlink_verification_log
       (tail_number, source, checked_at, has_starlink, wifi_provider, flight_number, error, airline)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`
  ).run(
    tail,
    airline === "AS" ? "alaska" : "united",
    checkedAt,
    provider === "Starlink" ? 1 : 0,
    provider,
    fn,
    airline
  );
}

function listing(
  db: Database,
  tail: string,
  day: string,
  gid: string | null = "4",
  airline = "UA"
) {
  db.query(
    `INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, DateFound, TailNumber, OperatedBy, fleet, airline)
     VALUES ('ERJ-175', 'StrLnk', ?, ?, ?, 'SkyWest', 'express', ?)`
  ).run(gid, day, tail, airline);
}

/** Five E175s: two Starlink, one Viasat-verified negative, one unchecked, one None. */
function e175Fleet(db: Database) {
  addFleet(db, "N101SY", "confirmed", { aircraftType: "ERJ-175", verifiedWifi: "Starlink" });
  addFleet(db, "N102SY", "confirmed", { aircraftType: "ERJ-175", verifiedWifi: "Starlink" });
  addFleet(db, "N103SY", "negative", { aircraftType: "ERJ-175", verifiedWifi: "Viasat" });
  addFleet(db, "N104SY", "unknown", { aircraftType: "E175SC", verifiedWifi: null });
  addFleet(db, "N105SY", "negative", { aircraftType: "E175SC", verifiedWifi: "None" });
}

describe("routes and flight numbers (synthetic)", () => {
  test("only Starlink tails of the family fly the routes; hrefs all serve", () => {
    const db = makeSyntheticDb();
    e175Fleet(db);
    addFleet(db, "N200AS", "confirmed", {
      airline: "AS",
      aircraftType: "ERJ-175",
      verifiedWifi: "Starlink",
    });
    // Routes count equipped departures (starlink_planes + equippedFilter), the
    // same predicate as every other departure count.
    addPlane(db, "N101SY", "Starlink", { aircraft: "ERJ-175" });
    addPlane(db, "N103SY", "Viasat", { aircraft: "ERJ-175" });
    addPlane(db, "N200AS", "Starlink", { aircraft: "ERJ-175", airline: "AS" });
    addFlight(db, "N101SY", "UA5001", "DEN", NOW + 3600, { arrivalAirport: "ASE" });
    addFlight(db, "N101SY", "UA5002", "ASE", NOW + 7200, { arrivalAirport: "DEN" });
    addFlight(db, "N103SY", "UA5003", "ORD", NOW + 3600, { arrivalAirport: "MSN" });
    addFlight(db, "N200AS", "AS2001", "SEA", NOW + 3600, { arrivalAirport: "PDX", airline: "AS" });
    const d = getAircraftTypePageData(db, "UA", "e175");
    expect(d).not.toBeNull();
    const pairs = d?.routes.map((r) => `${r.origin}-${r.destination}`) ?? [];
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs).not.toContain("ORD-MSN");
    expect(pairs).not.toContain("SEA-PDX");
    const served = new Set(
      getSitemapRoutes(db, "UA").map((r) => `/route-planner/${r.origin}/${r.destination}`)
    );
    for (const r of d?.routes ?? []) if (r.href) expect(served.has(r.href)).toBe(true);
    db.close();
  });

  test("flight numbers are canonical, served, and mostly this type's", () => {
    const db = makeSyntheticDb();
    e175Fleet(db);
    addFlight(db, "N101SY", "UA5001", "DEN", NOW + 3600, { arrivalAirport: "ASE" });
    addFlight(db, "N101SY", "UA0061", "DEN", NOW + 3600, { arrivalAirport: "ASE" });
    addFleet(db, "N37500", "confirmed", {
      aircraftType: "Boeing 737-824",
      verifiedWifi: "Starlink",
    });
    for (let day = 0; day < 4; day++) {
      vlog(db, "N101SY", "UA5001", NOW - day * 86400);
      vlog(db, "N102SY", "UA0061", NOW - day * 86400);
      // UA9 flies mostly on a 737 — must not be listed as "usually an E175".
      vlog(db, "N37500", "UA9", NOW - day * 86400);
    }
    vlog(db, "N101SY", "UA9", NOW);
    const d = getAircraftTypePageData(db, "UA", "e175");
    const fns = d?.flightNumbers.map((f) => f.flightNumber) ?? [];
    expect(fns).toContain("UA5001");
    expect(fns).toContain("UA61");
    expect(fns).not.toContain("UA9");
    const served = new Set(
      getSitemapFlights(db, "UA").map((f) => `/check-flight/${f.flight_number}`)
    );
    for (const f of d?.flightNumbers ?? []) expect(served.has(f.href)).toBe(true);
    db.close();
  });

  test("an Alaska operating-carrier number is linked in its marketed form or not at all", () => {
    const db = makeSyntheticDb();
    for (let i = 0; i < 5; i++) {
      addFleet(db, `N60${i}QX`, "confirmed", {
        airline: "AS",
        aircraftType: "Embraer E175LR",
        verifiedWifi: "Starlink",
      });
    }
    addFlight(db, "N600QX", "QX2117", "SEA", NOW + 3600, { arrivalAirport: "PDX", airline: "AS" });
    for (const [tail, fn] of [
      ["N600QX", "QX2117"],
      ["N601QX", "OO4123"],
      ["N602QX", "QX2200"],
    ]) {
      vlog(db, tail, fn, NOW, "Starlink", "AS");
    }
    const d = getAircraftTypePageData(db, "AS", "e175");
    expect(d?.flightNumbersScope).toBe("starlink_only");
    const fns = d?.flightNumbers.map((f) => f.flightNumber) ?? [];
    expect(fns).toContain("AS2117");
    for (const fn of fns) expect(fn).toMatch(/^AS\d+$/);
    db.close();
  });
});

describe("first-seen and lastmod (synthetic)", () => {
  test("a mass-write day is invisible to first-seen, recent installs and lastmod", () => {
    const db = makeSyntheticDb();
    for (let i = 0; i < 100; i++) {
      const tail = `N${300 + i}YX`;
      addFleet(db, tail, "confirmed", { aircraftType: "ERJ-175", verifiedWifi: "Starlink" });
      listing(db, tail, "2025-12-03", "13");
    }
    // Organic rows on ordinary days, including one for a mass-imported tail.
    listing(db, "N300YX", "2026-03-01");
    listing(db, "N301YX", "2026-04-10");
    listing(db, "N302YX", "2026-05-20");
    for (let d = 1; d <= 20; d++) {
      const tail = `N${500 + d}YX`;
      addFleet(db, tail, "confirmed", { aircraftType: "ERJ-175", verifiedWifi: "Starlink" });
      listing(db, tail, `2026-02-${String(d).padStart(2, "0")}`);
    }
    const data = getAircraftTypePageData(db, "UA", "e175");
    expect(data?.recentInstalls.every((r) => r.date !== "2025-12-03")).toBe(true);
    expect(data?.firstSeen).not.toBe("2025-12-03");
    expect(data?.lastmodIso).toBe("2026-05-20T00:00:00.000Z");
    db.close();
  });

  test("a listing dated on a mass-write day still counts as awaiting verification", () => {
    const db = makeSyntheticDb();
    for (let i = 0; i < 100; i++) {
      const tail = `N${300 + i}YX`;
      addFleet(db, tail, "confirmed", { aircraftType: "ERJ-175", verifiedWifi: "Starlink" });
      listing(db, tail, "2025-12-03", "13");
    }
    addFleet(db, "N499YX", "unknown", { aircraftType: "ERJ-175", verifiedWifi: null });
    listing(db, "N499YX", "2025-12-03", "13");
    const data = getAircraftTypePageData(db, "UA", "e175");
    expect(data?.listedAwaitingVerification).toContain("N499YX");
    expect(data?.firstSeen).toBeNull();
    db.close();
  });

  test("other families' pipeline events never move a family's lastmod", () => {
    const build = (events: number) => {
      const db = makeSyntheticDb();
      e175Fleet(db);
      listing(db, "N101SY", "2026-06-01");
      for (let i = 0; i < 6; i++) {
        addFleet(db, `N7${i}800`, "negative", {
          aircraftType: "Boeing 737-824",
          verifiedWifi: "Viasat",
        });
      }
      for (let i = 0; i < events; i++) {
        db.query(
          `INSERT INTO pipeline_events (airline, tail, type_code, segment, event, mod_location, observed_at)
           VALUES ('UA', ?, '738', 'mainline_nb', 'entered_mod', 'MLB', ?)`
        ).run(`N7${i % 6}800`, NOW - i * 60);
      }
      const e175 = getAircraftTypePageData(db, "UA", "e175")?.lastmodIso;
      const b738 = getAircraftTypePageData(db, "UA", "737-800")?.lastmodIso;
      db.close();
      return { e175, b738 };
    };
    const quiet = build(0);
    const busy = build(20);
    expect(busy.e175).toBe(quiet.e175);
    expect(quiet.b738).toBeUndefined();
    expect(busy.b738).toBeDefined();
  });

  test("a bulk-only family has no lastmod and publishes no dateModified", async () => {
    const db = makeSyntheticDb();
    e175Fleet(db);
    listing(db, "N101SY", "2026-06-01", "as_seed");
    listing(db, "N102SY", "2026-06-01", "flyertalk_ua");
    expect(getAircraftTypePageData(db, "UA", "e175")?.lastmodIso).toBeUndefined();
    const html = await (await createApp(db).dispatch(req("/fleet/e175", UA))).text();
    const webPage = jsonLd(html).find((b) => b["@type"] === "WebPage");
    expect(webPage && "dateModified" in webPage).toBe(false);
    db.close();
  });
});

describe("pipeline (synthetic)", () => {
  function withSheet(fetchedAt: number) {
    const db = makeSyntheticDb();
    for (let i = 0; i < 6; i++) {
      addFleet(db, `N2${i}954`, "negative", {
        aircraftType: "Boeing 787-9 Dreamliner",
        verifiedWifi: "Panasonic",
      });
    }
    vlog(db, "N20954", "UA1", NOW, "Panasonic");
    db.query(
      `INSERT INTO fleet_progress (airline, segment, type_code, total, starlink_complete, in_mod,
         verification_needed, sheet_updated, fetched_at)
       VALUES ('UA', 'mainline_wb', '788', 12, 0, 1, 0, '8/29 1am', ?)`
    ).run(fetchedAt);
    return db;
  }

  test("a fresh in-mod install makes an all-checked zero-Starlink type 'installing'", () => {
    const db = withSheet(NOW - 86400);
    const d = getAircraftTypePageData(db, "UA", "787");
    expect(d?.pipeline?.in_mod).toBe(1);
    const a = answerFor(d as AircraftTypePageData, UA_787, null);
    expect(a.kind).toBe("installing");
    expect(a.indexable).toBe(true);
    db.close();
  });

  test("a sheet 14+ days older than the verifier's clock is dropped", () => {
    const db = withSheet(NOW - 15 * 86400);
    const d = getAircraftTypePageData(db, "UA", "787");
    expect(d?.pipeline).toBeNull();
    expect(answerFor(d as AircraftTypePageData, UA_787, null).kind).toBe("none");
    db.close();
  });

  test("variants that don't cover every tail are dropped, not shown partial", () => {
    const db = makeSyntheticDb();
    for (let i = 0; i < 5; i++) {
      addFleet(db, `N7${i}UA`, "negative", {
        aircraftType: "Boeing 777-222",
        verifiedWifi: "Panasonic",
      });
    }
    addFleet(db, "N79UA", "negative", { aircraftType: "Boeing 777", verifiedWifi: "Panasonic" });
    expect(getAircraftTypePageData(db, "UA", "777")?.variants).toBeNull();
    db.close();
  });
});

describe("degradation and cache (snapshot)", () => {
  test("Alaska has no organic first-seen history and no pipeline", () => {
    for (const def of aircraftPagesFor("AS")) {
      const d = getAircraftTypePageData(snap, "AS", def.slug);
      if (!d) continue;
      expect(d.pipeline).toBeNull();
      expect(d.listedAwaitingVerification).toEqual([]);
    }
  });

  test("sections render iff their data is non-empty", async () => {
    for (const [code, host] of TENANTS) {
      for (const def of await servedDefs(code, host)) {
        const d = getAircraftTypePageData(snap, code, def.slug) as AircraftTypePageData;
        const html = await (await get(`/fleet/${def.slug}`, host)).text();
        expect(html.includes(">Recently added</h2>"), def.slug).toBe(d.recentInstalls.length > 0);
        expect(html.includes("install pipeline"), def.slug).toBe(d.pipeline !== null);
        expect(html.includes("fly in the next 48 hours"), def.slug).toBe(d.routes.length > 0);
      }
    }
  });

  test("a second read within the TTL is the same object", () => {
    const [def] = aircraftPagesFor("UA");
    const a = getAircraftTypePageData(snap, "UA", def.slug);
    expect(getAircraftTypePageData(snap, "UA", def.slug)).toBe(a);
  });
});

describe("registry features", () => {
  test("only United and Alaska serve type pages", () => {
    const on = Object.values(SITES)
      .filter((s) => s.features.aircraftPages)
      .map((s) => s.scope)
      .sort();
    expect(on).toEqual(["AS", "UA"]);
    for (const code of on) expect(AIRLINES[code]).toBeDefined();
  });
});
