/**
 * Homepage flight pills point at this site's own flight permalinks.
 *
 * The pills carry OPERATING-carrier callsigns (OO4757, G74561, SKW5366) while
 * permalinks are filed under the marketing code, so the interesting cases are
 * all normalization: the mapping must go through ensureAirlinePrefix, and every
 * href it emits has to be a URL the permalink handler actually serves — not a
 * 301 to a canonical spelling and not the noindex generic fallback.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "../src/server/app";
import { addFleet, addFlight, addPlane, makeSyntheticDb, req } from "./helpers";

const UA_HOST = "unitedstarlinktracker.com";
const AS_HOST = "alaskastarlinktracker.com";
const HUB_HOST = "airlinestarlinktracker.com";

const PILL_RE = /<a\b[^>]*?class="[^"]*flight-pill[^"]*"[^>]*?>([\s\S]*?)<\/a>/g;
const HREF_RE = /href="([^"]*)"/;
const TOOLTIP_RE = /data-flight-tooltip="([^"]*)"/;
const ARIA_RE = /aria-label="([^"]*)"/;

interface Pill {
  tag: string;
  href: string;
  tooltip: string;
  ariaLabel: string;
  /** Words a sighted user actually reads on the pill, arrows dropped. */
  visibleWords: string[];
}

function pillsOf(html: string): Pill[] {
  return [...html.matchAll(PILL_RE)].map((m) => {
    const tag = m[0].slice(0, m[0].indexOf(">") + 1);
    return {
      tag,
      href: tag.match(HREF_RE)?.[1] ?? "",
      tooltip: tag.match(TOOLTIP_RE)?.[1] ?? "",
      ariaLabel: tag.match(ARIA_RE)?.[1] ?? "",
      visibleWords: m[1]
        .replace(/<[^>]*>/g, " ")
        .replace(/&rarr;|→|&#x2192;/g, " ")
        .split(/\s+/)
        .filter(Boolean),
    };
  });
}

/** The row `<div>` carrying the client-side search index for one tail. */
function searchIndexFor(html: string, tail: string): string {
  const row = html.match(new RegExp(`<div\\b[^>]*data-tail="${tail.toLowerCase()}"[^>]*>`))?.[0];
  return row?.match(/data-flights="([^"]*)"/)?.[1] ?? "";
}

/** The substring test the inline search script runs against `data-flights`. */
const searchFinds = (index: string, term: string) => index.includes(term.toLowerCase());

/** Pills whose row flight number is `fn` — matched via the tooltip, which
 * carries either the marketing number (when linked) or the raw callsign. */
function pillFor(pills: Pill[], tooltip: string): Pill | undefined {
  return pills.find((p) => p.tooltip === tooltip);
}

// Departures are only "upcoming" while departure_time > now, so every fixture
// is minted relative to the run.
const soon = (hours: number) => Math.floor(Date.now() / 1000) + hours * 3600;

// Frozen at module load so repeated seedDb() calls mint identical fixtures and
// a test can check a rendered clock against the exact epoch behind it.
const seedFlightTimes = {
  UA123: soon(1),
  OO4757: soon(2),
  G74561: soon(3),
  SKW394Y: soon(4),
  UA0100: soon(5),
  HA11: soon(2),
  QX2304: soon(2),
};

/**
 * One UA tail carrying every flight-number spelling the pill mapper has to
 * survive, plus a Hawaiian tail so the hub renders a second carrier.
 */
function seedDb() {
  const db = makeSyntheticDb();
  addPlane(db, "N100UA", "Starlink");
  addFleet(db, "N100UA", "confirmed", { verifiedWifi: "Starlink" });
  addFlight(db, "N100UA", "UA123", "SFO", seedFlightTimes.UA123);
  addFlight(db, "N100UA", "OO4757", "GSP", seedFlightTimes.OO4757, { arrivalAirport: "ORD" });
  // G7 is the two-char prefix that a naive /^[A-Z]+/ strip mangles into
  // UA74561; the correct mapping drops only the prefix.
  addFlight(db, "N100UA", "G74561", "IAH", seedFlightTimes.G74561, { arrivalAirport: "DEN" });
  // Non-numeric callsign suffix: normalizes to itself, so no permalink exists.
  addFlight(db, "N100UA", "SKW394Y", "DEN", seedFlightTimes.SKW394Y, { arrivalAirport: "ASE" });
  // Zero-padded spelling: the permalink handler 301s UA0100 → UA100, so the
  // link must already be canonical.
  addFlight(db, "N100UA", "UA0100", "EWR", seedFlightTimes.UA0100, { arrivalAirport: "TLV" });

  addPlane(db, "N999HA", "Starlink", { airline: "HA", aircraft: "Airbus A330-243" });
  addFleet(db, "N999HA", "confirmed", {
    airline: "HA",
    aircraftType: "Airbus A330-243",
    verifiedWifi: "Starlink",
  });
  addFlight(db, "N999HA", "HA11", "HNL", seedFlightTimes.HA11, {
    arrivalAirport: "LAX",
    airline: "HA",
  });

  // Horizon flies AS metal under QX — the same operating/marketing split as UA,
  // under a different carrier, so it proves the mapping reads each site's own
  // airline rather than a pinned UA.
  addPlane(db, "N654QX", "Starlink", { airline: "AS", aircraft: "Embraer ERJ-175LR" });
  addFleet(db, "N654QX", "confirmed", {
    airline: "AS",
    aircraftType: "Embraer ERJ-175LR",
    verifiedWifi: "Starlink",
  });
  addFlight(db, "N654QX", "QX2304", "SEA", seedFlightTimes.QX2304, {
    arrivalAirport: "PDX",
    airline: "AS",
  });
  return db;
}

describe("homepage flight pills link to flight permalinks", () => {
  let app: ReturnType<typeof createApp>;
  let pills: Pill[];
  let html: string;

  beforeAll(async () => {
    app = createApp(seedDb());
    const res = await app.dispatch(req("/", UA_HOST));
    expect(res.status).toBe(200);
    html = await res.text();
    pills = pillsOf(html);
    expect(pills.length).toBeGreaterThan(0);
  });

  test("every pill href is either an own-site permalink or an outbound tracker link", () => {
    for (const p of pills) {
      expect(p.href).toMatch(
        /^(\/check-flight\/UA\d{1,4}|https:\/\/www\.flightaware\.com\/live\/flight\/[A-Z0-9]+)$/
      );
    }
  });

  test("at least one pill became an internal permalink", () => {
    expect(pills.filter((p) => p.href.startsWith("/check-flight/")).length).toBeGreaterThan(0);
  });

  test("internal pills drop the outbound-link attributes; outbound pills keep them", () => {
    for (const p of pills) {
      const internal = p.href.startsWith("/check-flight/");
      expect(p.tag.includes('target="_blank"')).toBe(!internal);
      expect(p.tag.includes("nofollow")).toBe(!internal);
    }
  });

  test("operating-carrier callsigns map to the marketing number", () => {
    expect(pillFor(pills, "UA4757")?.href).toBe("/check-flight/UA4757");
  });

  test("a two-letter carrier prefix is stripped as a prefix, not as leading letters", () => {
    // Regression guard: a /^[A-Z]+/ strip yields UA74561, which no permalink
    // serves and which the permalink path regex rejects outright.
    const pill = pillFor(pills, "UA4561");
    expect(pill?.href).toBe("/check-flight/UA4561");
    expect(pills.some((p) => p.href.includes("UA74561"))).toBe(false);
  });

  test("a marketing-coded flight number links to itself", () => {
    expect(pillFor(pills, "UA123")?.href).toBe("/check-flight/UA123");
  });

  test("zero-padded numbers link to the canonical spelling, not a 301", () => {
    expect(pillFor(pills, "UA100")?.href).toBe("/check-flight/UA100");
    expect(pills.some((p) => p.href.includes("UA0100"))).toBe(false);
  });

  test("a callsign with a non-numeric suffix keeps its outbound link", () => {
    const pill = pillFor(pills, "SKW394Y");
    expect(pill?.href).toBe("https://www.flightaware.com/live/flight/SKW394Y");
  });

  test("every distinct permalink the homepage emits serves an indexable flight page", async () => {
    const hrefs = [...new Set(pills.map((p) => p.href))].filter((h) =>
      h.startsWith("/check-flight/")
    );
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      const res = await app.dispatch(req(href, UA_HOST));
      // A 301 would mean the link used a non-canonical spelling; the generic
      // noindex fallback would mean the flight has no data behind it.
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain("noindex");
      expect(html).toContain(`<link rel="canonical" href="https://${UA_HOST}${href}"`);
      expect(html).toContain(href.slice("/check-flight/".length));
    }
  });

  test("the hover label names the permalink target", () => {
    for (const p of pills) {
      if (!p.href.startsWith("/check-flight/")) continue;
      expect(p.tooltip).toBe(p.href.slice("/check-flight/".length));
    }
  });

  test("the link's accessible name carries the flight number, not just a route", () => {
    // The pill's visible text is an airport pair and a clock time; the flight
    // number is the target page's whole subject, so it has to reach a screen
    // reader and a crawler reading link text — the hover tooltip is a data
    // attribute and does neither.
    for (const p of pills) {
      expect(p.ariaLabel).toContain(p.tooltip);
      expect(p.ariaLabel).not.toBe("");
    }
    expect(pillFor(pills, "UA4561")?.ariaLabel).toContain("UA4561");
  });

  test("the accessible name restates every visible word (WCAG 2.5.3)", () => {
    // aria-label replaces the visible text for AT and speech input, so dropping
    // a word a sighted user can see would break "click GSP to ORD".
    for (const p of pills) {
      expect(p.visibleWords.length).toBeGreaterThan(0);
      for (const word of p.visibleWords) expect(p.ariaLabel).toContain(word);
    }
  });

  test("the row search index finds every number the pills advertise", () => {
    const index = searchIndexFor(html, "N100UA");
    for (const p of pills) {
      // Regression: the index used to be built with a /^[A-Z]+/ strip, so the
      // row advertised UA4561 while indexing UA74561 — typing the number the
      // page had just shown matched nothing.
      expect(searchFinds(index, p.tooltip)).toBe(true);
    }
    // The operating callsign stays searchable too; this adds, never replaces.
    expect(searchFinds(index, "G74561")).toBe(true);
    expect(searchFinds(index, "OO4757")).toBe(true);
    expect(searchFinds(index, "UA74561")).toBe(false);
  });
});

describe("each tenant normalizes to its own marketing code", () => {
  test("Alaska's homepage maps QX pills to AS permalinks, and never to UA", async () => {
    const app = createApp(seedDb());
    const res = await app.dispatch(req("/", AS_HOST));
    expect(res.status).toBe(200);
    const pills = pillsOf(await res.text());
    expect(pills.length).toBeGreaterThan(0);
    expect(pillFor(pills, "AS2304")?.href).toBe("/check-flight/AS2304");
    for (const p of pills) {
      if (p.href.startsWith("/check-flight/")) expect(p.href).toStartWith("/check-flight/AS");
    }
  });
});

/**
 * The pill's aria-label speaks its clock time as a departure claim and links to
 * the page that states the same departure, so the two have to be one clock.
 * Pinning a non-UTC TZ makes a server-zone regression fail everywhere rather
 * than only on machines that happen not to run in UTC.
 */
describe("the pill states a departure the permalink page agrees with", () => {
  // Resolved rather than read straight off the env, because under `bun test`
  // TZ is unset (the runner defaults ICU to UTC without exporting it) and
  // restoring `undefined` would store the STRING "undefined". Bun happens to
  // hand each test file its own env, so the pin can't reach another file
  // today — the restore keeps that from being load-bearing.
  const originalTz = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Chosen for the widest disagreement: +14 puts a UTC-morning departure on the
  // server's previous calendar day, so a server-zone render gets both the
  // weekday and the hour wrong.
  beforeAll(() => {
    process.env.TZ = "Pacific/Kiritimati";
  });
  afterAll(() => {
    process.env.TZ = originalTz;
  });

  test("the pill names its zone and matches /check-flight/{fn}", async () => {
    const app = createApp(seedDb());
    const pills = pillsOf(await app.dispatch(req("/", UA_HOST)).then((r) => r.text()));
    const linked = pills.filter((p) => p.href.startsWith("/check-flight/"));
    expect(linked.length).toBeGreaterThan(0);

    for (const p of linked) {
      // Visible text, hover text and accessible name all read the same clock —
      // an unlabeled time reads as the viewer's own zone to everyone.
      const stamped = p.visibleWords.join(" ").match(/([A-Z]{3}) (\d{2}:\d{2}) UTC$/);
      expect(stamped).not.toBeNull();
      expect(p.ariaLabel).toContain(`departs ${stamped?.[1]} ${stamped?.[2]} UTC`);

      const page = await app.dispatch(req(p.href, UA_HOST)).then((r) => r.text());
      const onPage = page.match(/[A-Z][a-z]{2} \d{1,2} · (\d{2}:\d{2}) UTC/);
      expect(onPage).not.toBeNull();
      expect(stamped?.[2]).toBe(onPage?.[1] as string);
    }
  });

  test("the weekday comes from the same zone as the hour", async () => {
    const app = createApp(seedDb());
    const html = await app.dispatch(req("/", UA_HOST)).then((r) => r.text());
    const pill = pillFor(pillsOf(html), "UA123");
    // Reading day and time in different zones is the subtler half of the bug:
    // the hour can look right while the weekday belongs to a neighbouring day.
    const stamped = pill?.visibleWords.join(" ").match(/([A-Z]{3}) (\d{2}:\d{2}) UTC$/);
    expect(stamped).not.toBeNull();
    const departure = seedFlightTimes.UA123;
    expect(stamped?.[1]).toBe(
      new Date(departure * 1000)
        .toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })
        .toUpperCase()
    );
    expect(stamped?.[2]).toBe(new Date(departure * 1000).toISOString().slice(11, 16));
  });
});

describe("sites without a flight-permalink page keep pills outbound", () => {
  test("the hub emits no permalink hrefs", async () => {
    const app = createApp(seedDb());
    const res = await app.dispatch(req("/", HUB_HOST));
    expect(res.status).toBe(200);
    const html = await res.text();
    const pills = pillsOf(html);
    expect(pills.length).toBeGreaterThan(0);
    for (const p of pills) {
      expect(p.href).toStartWith("https://www.flightaware.com/live/flight/");
    }
    // The hub 404s /check-flight entirely, so linking there would be a dead end.
    expect(await app.dispatch(req("/check-flight/UA123", HUB_HOST)).then((r) => r.status)).toBe(
      404
    );
  });
});
