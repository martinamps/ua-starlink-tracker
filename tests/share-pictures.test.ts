/**
 * Share pictures at /static/share/{flight|tail|airport}/….png: the og:image of
 * a flight answer, a tail page and an airport page.
 *
 * Seeded on a fresh database. The rules pinned here: a picture says what its
 * page says and no more (a forecast shows odds, an unknown shows unknown, a
 * tail mid-install shows its install status); a page kept out of search, or
 * with no answer, keeps the site's card; a caller's text never reaches a
 * drawing, a cache key or a metric tag unless it resolves to a real page; and
 * the drawings a process holds and makes are both bounded.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { AIRLINES, SITES } from "../src/airlines/registry";
import { airportDek, buildAirportBoard } from "../src/api/airport-board";
import {
  airportShareAnswer,
  flightSharePicture,
  parseSharePicturePath,
  sharePictureDate,
  tailShareAnswer,
} from "../src/api/share-picture";
import { buildTailPage } from "../src/api/tail-page";
import type { DatedAnswer, FlightFacts } from "../src/components/check-flight/types";
import { usualAnswer, usualSummary } from "../src/components/check-flight/usual";
import { fmt } from "../src/components/ui/format";
import { logFlightAssignments } from "../src/database/assignment-log";
import { logVerification } from "../src/database/database";
import { createReaderFactory } from "../src/database/reader";
import { metrics } from "../src/observability/metrics";
import { createApp } from "../src/server/app";
import { CACHE } from "../src/server/respond";
import {
  SHARE_CARD_HEIGHT,
  SHARE_CARD_WIDTH,
  type ShareCard,
  drawShareCard,
  wrapSentences,
} from "../src/share/card";
import { lruCache } from "../src/utils/ttl-cache";
import { addFleet, addFlight, addPlane, makeFreshDb, req } from "./helpers";

const UA = SITES.united.canonicalHost;
const HOUR = 3600;
const DAY = 86400;
const now = Math.floor(Date.now() / 1000);
const isoDay = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);
const STAMP = new Date((now - HOUR) * 1000).toISOString();
const SITE_CARD = /^\/static\/social-image[\w-]*\.webp$/;

let db: Database;
let app: ReturnType<typeof createApp>;

const get = (path: string, host = UA, init?: RequestInit) => app.dispatch(req(path, host, init));

function addFlown(tail: string, fn: string, origin: string, destination: string, daysAgo: number) {
  const departure_time = now - daysAgo * DAY + HOUR;
  logFlightAssignments(
    db,
    "UA",
    tail,
    [
      {
        flight_number: fn,
        departure_airport: origin,
        arrival_airport: destination,
        departure_time,
        arrival_time: departure_time + 2 * HOUR,
      },
    ],
    now
  );
  db.query(
    "INSERT INTO departure_log (tail_number, airport, departed_at, airline) VALUES (?, ?, ?, 'UA')"
  ).run(tail, origin, departure_time);
}

function addCheck(tail: string, provider: string, daysAgo: number, flight = "UA100") {
  logVerification(db, {
    tail_number: tail,
    source: "united",
    checked_at: now - daysAgo * DAY,
    has_starlink: provider === "Starlink",
    wifi_provider: provider,
    aircraft_type: "Boeing 737-900",
    flight_number: flight,
    error: null,
    tail_confirmed: 1,
    airline: "UA",
  });
}

beforeAll(() => {
  db = makeFreshDb();
  db.query("INSERT INTO meta (key, value) VALUES ('UA:lastUpdated', ?)").run(STAMP);

  // N1VER: listed, read on Starlink, flying. Its page indexes.
  addPlane(db, "N1VER", "Starlink");
  addFleet(db, "N1VER", "confirmed", { verifiedWifi: "Starlink", verifiedAt: now - DAY });
  addCheck("N1VER", "Starlink", 9);
  addCheck("N1VER", "Starlink", 2);
  addFlight(db, "N1VER", "UA100", "DEN", now + 3 * HOUR, { arrivalAirport: "ORD" });
  addFlight(db, "N1VER", "UA101", "DEN", now + 30 * HOUR, { arrivalAirport: "ORD" });
  for (let d = 1; d < 7; d++) {
    addFlown("N1VER", "UA100", "DEN", "ORD", d);
    addFlown("N1VER", "UA110", "DEN", "SFO", d);
  }

  // N4VIA: on the roster, settled on another provider: served, not indexed.
  addFleet(db, "N4VIA", "negative", { verifiedWifi: "Viasat", verifiedAt: now - 3 * DAY });
  // N5NEW: on the roster, never read.
  addFleet(db, "N5NEW", "unknown", { verifiedAt: null });
  // N6MOD: in the hangar for its install. N9DON: installed, awaiting our check.
  addFleet(db, "N6MOD", "negative", { verifiedWifi: "Viasat", verifiedAt: now - 3 * DAY });
  addFleet(db, "N9DON", "unknown", { verifiedAt: null });
  for (const [tail, state] of [
    ["N6MOD", "in_mod"],
    ["N9DON", "verification_needed"],
  ]) {
    db.query(
      `INSERT INTO fleet_progress_tails (airline, segment, type_code, tail, state, mod_location, sheet_updated, fetched_at)
       VALUES ('UA', 'mainline', '739', ?, ?, NULL, '2026-11-20', ?)`
    ).run(tail, state, now);
  }

  // GJT: one Starlink departure, one flown. Served, not indexed.
  addPlane(db, "N2LIST", null);
  addFlight(db, "N2LIST", "UA400", "GJT", now + 8 * HOUR, { arrivalAirport: "DEN" });
  addFlown("N2LIST", "UA400", "GJT", "DEN", 2);

  app = createApp(db);
});

/** Width and height from IHDR, and the pixel rows IDAT inflates to. */
function readPng(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(String.fromCharCode(...bytes.subarray(12, 16))).toBe("IHDR");
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  let at = 8;
  let idat: Uint8Array | null = null;
  while (at < bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (type === "IDAT") idat = bytes.subarray(at + 8, at + 8 + length);
    at += 12 + length;
  }
  if (!idat) throw new Error("no IDAT chunk");
  return { width, height, raw: inflateSync(idat) };
}

async function expectPicture(res: Response) {
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(res.headers.get("cache-control")).toBe(CACHE.fifteenMinutes);
  const png = readPng(new Uint8Array(await res.arrayBuffer()));
  expect(png.width).toBe(SHARE_CARD_WIDTH);
  expect(png.height).toBe(SHARE_CARD_HEIGHT);
  expect(png.raw.length).toBe((SHARE_CARD_WIDTH * 3 + 1) * SHARE_CARD_HEIGHT);
  // More than one colour: something was drawn on the background.
  expect(new Set(png.raw.subarray(0, 400_000)).size).toBeGreaterThan(3);
}

function expectSiteCard(res: Response, label: string) {
  expect(res.status, label).toBe(302);
  expect(res.headers.get("location") ?? "", label).toMatch(SITE_CARD);
}

/** og:image, twitter:image and the alt text a page declares, entity-decoded. */
async function pageImages(path: string) {
  const res = await get(path);
  const html = await res.text();
  const meta = (attr: string, name: string) =>
    html.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`))?.[1] ?? null;
  const decode = (s: string | null) =>
    s
      ?.replace(/&quot;/g, '"')
      .replace(/&#x27;|&#39;/g, "'")
      .replace(/&amp;/g, "&") ?? null;
  return {
    status: res.status,
    html,
    og: meta("property", "og:image"),
    twitter: meta("name", "twitter:image"),
    alt: decode(meta("property", "og:image:alt")),
  };
}

const pathOf = (imageUrl: string | null) => {
  const u = new URL(imageUrl ?? "");
  return `${u.pathname}${u.search}`;
};

const ua = () => createReaderFactory(db)("UA");
const tailModel = (tail: string) => {
  const m = buildTailPage(AIRLINES.UA, ua(), tail);
  if (!m) throw new Error(`no tail page for ${tail}`);
  return m;
};

describe("each kind of page points at a picture of its own answer", () => {
  test("a tail page", async () => {
    const page = await pageImages("/fleet/N1VER");
    expect(page.status).toBe(200);
    expect(page.og).toBe(`https://${UA}/static/share/tail/N1VER.png?d=${isoDay(now - HOUR)}`);
    expect(page.twitter).toBe(page.og);
    await expectPicture(await get(pathOf(page.og)));

    const m = tailModel("N1VER");
    const said = tailShareAnswer(m);
    expect(said?.subject).toBe("N1VER");
    expect(said?.figure).toBe(m.verdict);
    expect(said?.sentence).toBe(m.answer);
    expect(said?.context).toContain(m.typeName ?? "aircraft");
    // The picture's sentence is one the page itself prints.
    expect(page.alt).toBe(m.answer);
    expect(page.html.split("<body")[1]).toContain(m.answer);
  });

  test("an airport page", async () => {
    const page = await pageImages("/routes/DEN");
    expect(page.status).toBe(200);
    expect(pathOf(page.og)).toStartWith("/static/share/airport/DEN.png?d=");
    expect(page.twitter).toBe(page.og);
    await expectPicture(await get(pathOf(page.og)));

    const board = buildAirportBoard(AIRLINES.UA, ua(), "DEN");
    const said = airportShareAnswer(board);
    // The page's own lead figure and its own lead sentence.
    expect(said?.figure).toBe(fmt(board.departures.length));
    expect(said?.caption).toContain(`next ${board.windowHours} hours`);
    expect(said?.sentence).toBe(airportDek(board));
    expect(page.alt).toBe(airportDek(board));
    expect(page.html.split("<body")[1]).toContain(airportDek(board));
  });

  test("a flight page, with and without a date", async () => {
    const undated = await pageImages("/check-flight/UA100");
    expect(undated.status).toBe(200);
    expect(pathOf(undated.og)).toStartWith("/static/share/flight/UA100.png?d=");
    expect(undated.twitter).toBe(undated.og);
    await expectPicture(await get(pathOf(undated.og)));
    expect(undated.html.split("<body")[1]).toContain(undated.alt ?? "missing alt");

    // Today or tomorrow, whichever date UA100's seeded departure falls on.
    const dates = [isoDay(now), isoDay(now + DAY)];
    const dated = await Promise.all(dates.map((d) => pageImages(`/check-flight/UA100/${d}`)));
    const withAnswer = dated.filter((p) => /\/UA100\/\d{4}-\d\d-\d\d\.png/.test(p.og ?? ""));
    expect(withAnswer.length).toBeGreaterThan(0);
    for (const page of withAnswer) {
      await expectPicture(await get(pathOf(page.og)));
      // The dated picture carries the answer card's own headline.
      expect(page.html).toContain(
        (page.alt ?? "missing alt").replace(/&/g, "&amp;").replace(/'/g, "&#39;")
      );
    }
  });
});

describe("a picture never says more than its page", () => {
  const SITE = SITES.united;
  const facts = (over: Partial<FlightFacts> = {}): FlightFacts => ({
    flightNumber: "UA100",
    airlineName: "United Airlines",
    observedTotal: 0,
    observedStarlink: 0,
    aircraftTypes: [],
    lastStarlink: null,
    routes: [],
    upcoming: [],
    siblings: [],
    ...over,
  });
  const dated = (body: DatedAnswer["body"], daysOut = 5): DatedAnswer => ({
    flightNumber: "UA100",
    date: isoDay(now + daysOut * DAY),
    daysOut,
    body,
  });

  test("a forecast shows odds, never a yes", () => {
    for (const probability of [0.02, 0.41, 0.74, 0.97]) {
      const d = dated({
        hasStarlink: null,
        confidence: "predicted",
        prediction: { probability, n_observations: 30 },
      });
      const { path, answer } = flightSharePicture(SITE, facts(), d);
      expect(path).toBe(`/share/flight/UA100/${d.date}.png`);
      expect(answer.figure).toMatch(/^[<>]?\d+%$/);
      expect(answer.figure).not.toMatch(/yes/i);
      expect(answer.caption).toMatch(/chance/i);
      expect(answer.caption).toMatch(/no aircraft assignment yet/i);
      expect(answer.sentence).toContain("chance");
    }
  });

  test("an undated forecast is odds too, in the page's own sentence", () => {
    const f = facts({ prediction: { probability: 0.62, n_observations: 40, confidence: "high" } });
    const { path, answer } = flightSharePicture(SITE, f, undefined);
    expect(path).toBe("/share/flight/UA100.png");
    expect(answer.figure).toMatch(/^\d+%$/);
    expect(answer.caption).toMatch(/odds/i);
    expect(answer.sentence).toBe(usualSummary(f));
  });

  test("an assigned aircraft is a plain yes or no", () => {
    const yes = flightSharePicture(
      SITE,
      facts(),
      dated({ hasStarlink: true, confidence: "verified", flights: [{ tail_number: "N1VER" }] }, 1)
    ).answer;
    expect(yes.figure).toBe("Yes");
    expect(yes.tone).toBe("success");
    expect(yes.sentence).toContain("N1VER");
    const no = flightSharePicture(
      SITE,
      facts(),
      dated({ hasStarlink: false, confidence: "verified", message: "not Starlink" }, 1)
    ).answer;
    expect(no.figure).toBe("No");
    expect(no.tone).toBe("neutral");
  });

  test("an unknown shows unknown", () => {
    const unsure = flightSharePicture(SITE, facts(), dated({ hasStarlink: null })).answer;
    expect(unsure.figure).toBe("Not sure yet");
    expect(unsure.tone).toBe("neutral");
    expect(unsure.sentence).toMatch(/not sure yet/i);

    const noHistory = flightSharePicture(SITE, facts(), undefined).answer;
    expect(noHistory.figure).toBe(usualAnswer(facts()).figure);
    expect(noHistory.figure).toMatch(/no history/i);
    expect(noHistory.tone).toBe("neutral");

    // A plane we have never read.
    const unchecked = tailModel("N5NEW");
    expect(unchecked.kind).toBe("unchecked");
    expect(unchecked.verdict).not.toMatch(/^(yes|no)$/i);
  });

  test("a date with no answer of its own shares the undated picture", () => {
    const prediction = { probability: 0.5, n_observations: 9 };
    const passed = dated({ hasStarlink: null, confidence: "predicted", prediction }, -4);
    expect(flightSharePicture(SITE, facts(), passed).path).toBe("/share/flight/UA100.png");
    const failed = dated({ error: "lookup failed" });
    expect(flightSharePicture(SITE, facts(), failed).path).toBe("/share/flight/UA100.png");
  });

  test("a tail mid-install shows its install status, never a flat no", async () => {
    for (const tail of ["N6MOD", "N9DON"]) {
      const m = tailModel(tail);
      expect(m.installStatus, tail).toBeTruthy();
      const said = tailShareAnswer(m);
      expect(said?.figure, tail).toBe(m.verdict);
      expect(said?.figure, tail).not.toMatch(/^no$/i);
      expect(said?.figure, tail).toMatch(/not (yet|verified yet)/i);
      expect(said?.caption, tail).toContain(m.installStatus as string);
      expect(said?.tone, tail).not.toBe("success");
      const page = await pageImages(`/fleet/${tail}`);
      expect(pathOf(page.og), tail).toStartWith(`/static/share/tail/${tail}.png`);
      await expectPicture(await get(pathOf(page.og)));
    }
  });
});

describe("a page with no picture keeps the site's card", () => {
  test("a page kept out of search", async () => {
    for (const [page, picture] of [
      ["/fleet/N4VIA", "/static/share/tail/N4VIA.png"],
      ["/routes/GJT", "/static/share/airport/GJT.png"],
      ["/check-flight/UA7777", "/static/share/flight/UA7777.png"],
    ]) {
      const p = await pageImages(page);
      expect(p.html, page).toContain("noindex");
      expect(new URL(p.og ?? "").pathname, page).toMatch(SITE_CARD);
      expect(p.twitter, page).toBe(p.og);
      expectSiteCard(await get(picture), picture);
    }
    expect(tailShareAnswer(tailModel("N4VIA"))).toBeNull();
    expect(airportShareAnswer(buildAirportBoard(AIRLINES.UA, ua(), "GJT"))).toBeNull();
  });

  test("an unknown flight, tail or airport is answered without drawing", async () => {
    const drawn = countOutcomes();
    for (const path of [
      "/static/share/flight/UA9.png",
      "/static/share/flight/UA9/2026-12-01.png",
      "/static/share/tail/N999ZZ.png",
      "/static/share/airport/ZZZ.png",
    ]) {
      const res = await get(path);
      expectSiteCard(res, path);
      expect(res.headers.get("cache-control"), path).toBe(CACHE.hour);
    }
    expect(drawn.outcomes()).toEqual(["site_card"]);
  });

  test("a site without the page has no picture of it", async () => {
    for (const host of [SITES.alaska.canonicalHost, SITES.airline.canonicalHost]) {
      expectSiteCard(await get("/static/share/tail/N1VER.png", host), host);
      expectSiteCard(await get("/static/share/airport/DEN.png", host), host);
    }
    expectSiteCard(
      await get("/static/share/flight/UA100.png", SITES.airline.canonicalHost),
      "hub flight"
    );
    // Another carrier's number on this host: not confirmed, not drawn.
    expectSiteCard(await get("/static/share/flight/AS118.png"), "foreign prefix");
  });

  test("no data stamp, no picture: an undated one could pass for today's", async () => {
    const bare = makeFreshDb();
    addPlane(bare, "N1VER", "Starlink");
    addFleet(bare, "N1VER", "confirmed", { verifiedWifi: "Starlink", verifiedAt: now - DAY });
    const bareApp = createApp(bare);
    const res = await bareApp.dispatch(req("/static/share/tail/N1VER.png", UA));
    expectSiteCard(res, "unstamped");
    const html = await (await bareApp.dispatch(req("/fleet/N1VER", UA))).text();
    expect(html).not.toContain("/static/share/");
    expect(sharePictureDate(null)).toBeNull();
    expect(sharePictureDate("not a date")).toBeNull();
    expect(sharePictureDate(STAMP)).toBe(isoDay(now - HOUR));
  });

  test("a passed date moves to the flight's undated picture", async () => {
    const res = await get(`/static/share/flight/UA100/${isoDay(now - 9 * DAY)}.png`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/static/share/flight/UA100.png");
  });
});

/** Every share_picture.request emitted until the test ends. */
function countOutcomes() {
  const seen: Array<Record<string, unknown>> = [];
  const original = metrics.increment;
  metrics.increment = (name, tags) => {
    if (name === "share_picture.request") seen.push({ ...tags });
    return original.call(metrics, name, tags);
  };
  restore = () => {
    metrics.increment = original;
  };
  return {
    seen,
    outcomes: () => [...new Set(seen.map((t) => String(t.outcome)))],
  };
}
let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("hostile input", () => {
  const HOSTILE = [
    "/static/share/",
    "/static/share/tail/",
    "/static/share/tail/N1VER",
    "/static/share/tail/N1VER.svg",
    "/static/share/tail/N1VER.png/",
    "/static/share/tail/N1VER.png.png",
    "/static/share/tail/n1ver.png",
    "/static/share/tail/1VER.png",
    "/static/share/tail/N1VER/2026-12-01.png",
    "/static/share/tail/N1VERTOOLONGTOBEATAIL.png",
    "/static/share/tail/..%2F..%2Fetc%2Fpasswd.png",
    "/static/share/tail/../../social-image.webp.png",
    "/static/share/tail/%3Csvg%20onload%3Dalert(1)%3E.png",
    "/static/share/tail/N1VER%00.png",
    "/static/share/tail/N1VER%0d%0aSet-Cookie:x.png",
    "/static/share/plane/N1VER.png",
    "/static/share/airport/den.png",
    "/static/share/airport/DENVER.png",
    "/static/share/airport/D'N.png",
    "/static/share/flight/ua100.png",
    "/static/share/flight/UA0100.png",
    "/static/share/flight/UAL100.png",
    "/static/share/flight/UA100/2026-02-31.png",
    "/static/share/flight/UA100/20261201.png",
    "/static/share/flight/UA100/2026-12-01/x.png",
    "/static/share/flight/UA100%22%3E%3Cscript%3E.png",
    "/static/share/flight/{{siteTitle}}.png",
    "/static/share/flight/UA100;DROP TABLE meta.png",
  ];

  test("anything but one exact spelling is the site's card, never a drawing", async () => {
    const counted = countOutcomes();
    for (const path of HOSTILE) {
      const res = await get(path);
      // The traversal spellings normalise out of the family and 404 as files.
      if (res.status === 404) continue;
      expectSiteCard(res, path);
      expect(res.headers.get("content-type") ?? "", path).not.toContain("image/png");
    }
    expect(counted.outcomes()).toEqual(["site_card"]);
    // Tag values come from the fixed vocabulary, never from the address.
    for (const tags of counted.seen) {
      expect(["flight", "tail", "airport", "invalid"]).toContain(String(tags.kind));
      expect(String(tags.airline)).toBe("united");
      expect(Object.keys(tags).sort()).toEqual(["airline", "kind", "outcome"]);
    }
  });

  test("the address parser admits identifiers only", () => {
    expect(parseSharePicturePath("/share/tail/N1VER.png")).toEqual({
      kind: "tail",
      id: "N1VER",
      date: null,
    });
    expect(parseSharePicturePath("/share/flight/UA100/2026-12-01.png")?.date).toBe("2026-12-01");
    for (const path of HOSTILE) {
      const parsed = parseSharePicturePath(
        decodeURI(path.replace(/%(?![0-9a-f]{2})/gi, "%25")).slice(7)
      );
      if (parsed) expect(parsed.id, path).toMatch(/^[A-Za-z0-9-]{2,10}$/);
    }
  });

  test("a query string mints no second drawing", async () => {
    await get("/static/share/tail/N1VER.png");
    const counted = countOutcomes();
    for (const query of ["?d=2020-01-01", "?x=<script>", "?d=1&d=2", `?${"a".repeat(2000)}`]) {
      await expectPicture(await get(`/static/share/tail/N1VER.png${query}`));
    }
    expect(counted.outcomes()).toEqual(["cached"]);
  });

  test("only GET and HEAD", async () => {
    const res = await get("/static/share/tail/N1VER.png", UA, { method: "POST" });
    expect(res.status).toBe(405);
    expect((await get("/static/share/tail/N1VER.png", UA, { method: "HEAD" })).status).toBe(200);
  });

  test("the drawer survives any text and stays one size", () => {
    const base: ShareCard = {
      label: "United Starlink Tracker",
      domain: UA,
      accent: "#0ea5e9",
      asOf: "2026-11-24",
      subject: "N1VER",
      context: "United 737 MAX 9",
      figure: "Yes",
      tone: "success",
      caption: "Does this plane have Starlink?",
      sentence: "N1VER has Starlink.",
    };
    for (const over of [
      {},
      { context: null, caption: null, sentence: "" },
      { figure: "", subject: "" },
      { figure: "W".repeat(400), subject: "W".repeat(400), sentence: "word ".repeat(2000) },
      { sentence: "<svg onload=alert(1)>&amp;\u0000‮🚀 日本語 \n\t x" },
      { accent: "not-a-colour", asOf: "<b>", figure: "🚀" },
    ] as Array<Partial<ShareCard>>) {
      const png = readPng(drawShareCard({ ...base, ...over }));
      expect(png.width).toBe(SHARE_CARD_WIDTH);
      expect(png.height).toBe(SHARE_CARD_HEIGHT);
    }
  });
});

describe("the sentence on a picture is whole", () => {
  test("a full stop inside a word does not split it", () => {
    const text = "Not in our count yet. Our check of united.com reads Viasat Wi-Fi.";
    expect(wrapSentences(text, 80, 3).join(" ")).toBe(text);
  });

  test("a sentence that does not fit is left off, not cut", () => {
    const lines = wrapSentences("One short sentence. A second one that is rather longer.", 20, 1);
    expect(lines).toEqual(["One short sentence."]);
  });

  test("a first sentence too long for the box is cut at a word, and says so", () => {
    const lines = wrapSentences("word ".repeat(60).trim().concat("."), 20, 2);
    expect(lines.length).toBe(2);
    expect(lines[1]).toEndWith("…");
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(20);
  });
});

describe("the cost is bounded", () => {
  test("the cache holds at most its ceiling, dropping what was read longest ago", () => {
    const cache = lruCache<number>({ ttlSec: 60, maxEntries: 3 });
    for (let i = 0; i < 50; i++) cache.set(`k${i}`, i, 1000);
    expect(cache.size).toBe(3);
    expect(cache.get("k46", 1000)).toBeUndefined();
    expect(cache.get("k47", 1000)).toBe(47);
    // k47 was just read, so k48 is now the oldest.
    cache.set("fresh", 1, 1000);
    expect(cache.get("k48", 1000)).toBeUndefined();
    expect(cache.get("k47", 1000)).toBe(47);
    expect(cache.size).toBe(3);
  });

  test("an entry past its age is gone, and a zero ceiling holds nothing", () => {
    const cache = lruCache<number>({ ttlSec: 60, maxEntries: 3 });
    cache.set("a", 1, 1000);
    expect(cache.get("a", 1059)).toBe(1);
    expect(cache.get("a", 1060)).toBeUndefined();
    expect(cache.size).toBe(0);
    const none = lruCache<number>({ ttlSec: 60, maxEntries: 0 });
    none.set("a", 1, 1000);
    expect(none.size).toBe(0);
  });

  test("past the drawing budget a request gets the site's card, a held picture still serves", async () => {
    const small = createApp(db, { sharePictures: { maxEntries: 1, drawsPerMinute: 2 } });
    const fetch = (path: string) => small.dispatch(req(path, UA));
    const counted = countOutcomes();
    await expectPicture(await fetch("/static/share/tail/N1VER.png"));
    await expectPicture(await fetch("/static/share/airport/DEN.png"));
    // One slot: the tail picture was dropped, and the budget is spent.
    const shed = await fetch("/static/share/tail/N1VER.png");
    expectSiteCard(shed, "over budget");
    expect(shed.headers.get("cache-control")).toBe(CACHE.fiveMinutes);
    await expectPicture(await fetch("/static/share/airport/DEN.png"));
    expect(counted.seen.map((t) => t.outcome)).toEqual(["drawn", "drawn", "shed", "cached"]);
  });

  test("the pictures take no route tag of their own", () => {
    expect(app.routeTags.filter((t) => t.includes("share"))).toEqual([]);
    expect(app.routeTags).toContain("/static");
  });

  test("a burst of picture requests is metered like the pages", async () => {
    const metered = createApp(db);
    const hit = () =>
      metered.dispatch(
        req("/static/share/tail/N999ZZ.png", UA, { headers: { "x-forwarded-for": "203.0.113.9" } })
      );
    const statuses = new Set<number>();
    for (let i = 0; i < 130; i++) statuses.add((await hit()).status);
    expect(statuses.has(429)).toBe(true);
  });
});
