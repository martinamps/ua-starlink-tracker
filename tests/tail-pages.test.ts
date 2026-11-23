/**
 * Tail pages at /fleet/{tail}: one page per aircraft.
 *
 * Seeded on a fresh database, so each rule is pinned on rows the test wrote:
 * the answer follows the one equipped definition, the URL space is bounded by
 * the roster (unknown tails 404, one spelling per tail), a tail with nothing
 * beyond its type and a "no" serves but stays out of the index and the
 * sitemap, and the tail never becomes a metric tag.
 */

import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { AIRLINES, SITES } from "../src/airlines/registry";
import { buildTailPage, tailMetaDescription, tailPageTitle } from "../src/api/tail-page";
import { type AnswerContext, renderFlightAnswer } from "../src/client/flight-answer";
import { logFlightAssignments } from "../src/database/assignment-log";
import { logVerification } from "../src/database/database";
import { createReaderFactory } from "../src/database/reader";
import {
  TAIL_RECENT_SQL,
  type TailAnswerKind,
  classifyTail,
  getTailIndex,
  tailIndexable,
} from "../src/database/tails";
import { createApp } from "../src/server/app";
import { addFleet, addFlight, addPlane, makeFreshDb, openSnapshot, req } from "./helpers";

const UA = SITES.united.canonicalHost;
const HOUR = 3600;
const DAY = 86400;
const now = Math.floor(Date.now() / 1000);
const isoDay = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);

let db: Database;
let app: ReturnType<typeof createApp>;

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

function addCheck(tail: string, provider: string, daysAgo: number) {
  logVerification(db, {
    tail_number: tail,
    source: "united",
    checked_at: now - daysAgo * DAY,
    has_starlink: provider === "Starlink",
    wifi_provider: provider,
    aircraft_type: "Boeing 737-900",
    flight_number: "UA100",
    error: null,
    tail_confirmed: 1,
    airline: "UA",
  });
}

beforeAll(() => {
  db = makeFreshDb();

  // N1VER: listed, observed on Starlink, flying.
  addPlane(db, "N1VER", "Starlink");
  addFleet(db, "N1VER", "confirmed", { verifiedWifi: "Starlink", verifiedAt: now - DAY });
  db.query(
    "UPDATE united_fleet SET fleet = 'mainline', ship_number = '3501' WHERE tail_number = ?"
  ).run("N1VER");
  addCheck("N1VER", "Starlink", 9);
  addCheck("N1VER", "Starlink", 2);
  addFlight(db, "N1VER", "UAL200", "DEN", now + 3 * HOUR, { arrivalAirport: "ORD" });
  addFlight(db, "N1VER", "UA201", "ORD", now + 8 * HOUR, { arrivalAirport: "DEN" });
  addFlown("N1VER", "UA210", "DEN", "SFO", 1);
  addFlown("N1VER", "UA211", "SFO", "DEN", 2);
  // Logged for N1VER, but it never left on it.
  logFlightAssignments(
    db,
    "UA",
    "N1VER",
    [
      {
        flight_number: "UA299",
        departure_airport: "DEN",
        arrival_airport: "LAX",
        departure_time: now - DAY,
        arrival_time: now - DAY + HOUR,
      },
    ],
    now
  );
  db.query(
    `INSERT INTO faa_registry (tail_number, mode_s_hex, serial, year_mfr, faa_status, registrant, faa_model, last_refreshed)
     VALUES ('N1VER', 'A0B1C2', '61234', '2019', 'V', 'UNITED AIRLINES INC', 'BOEING 737-9', ?)`
  ).run(now - DAY);
  db.query(
    `INSERT INTO first_flights (tail_number, airline, flight_number, origin, destination, departed_at, recorded_at)
     VALUES ('N1VER', 'UA', 'UAL220', 'DEN', 'YYZ', ?, ?)`
  ).run(now - 40 * DAY, now - 40 * DAY);

  // N2LIST: listed, never observed.
  addPlane(db, "N2LIST", null);

  // N3REP: the sheet lists it, our check reads Viasat.
  db.query(
    `INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, DateFound, TailNumber, OperatedBy, fleet, verified_wifi, verified_at, airline)
     VALUES ('Boeing 737-900', 'Starlink', '4', ?, 'N3REP', 'United Airlines', 'mainline', 'Viasat', ?, 'UA')`
  ).run(isoDay(now - 5 * DAY), now - DAY);
  addFleet(db, "N3REP", "unknown");

  // N4VIA: on the roster, settled on another provider. Type and a "no".
  addFleet(db, "N4VIA", "negative", { verifiedWifi: "Viasat", verifiedAt: now - 3 * DAY });
  // N5NEW: on the roster, never read.
  addFleet(db, "N5NEW", "unknown", { verifiedAt: null });
  // N6MOD: not equipped, but the install pipeline names it.
  addFleet(db, "N6MOD", "unknown", { verifiedAt: null });
  db.query(
    `INSERT INTO fleet_progress_tails (airline, segment, type_code, tail, state, mod_location, sheet_updated, fetched_at)
     VALUES ('UA', 'mainline', '739', 'N6MOD', 'in_mod', 'MLB', '2026-11-20', ?)`
  ).run(now);
  // N9FIT, N9DON, N9QUE: read on another provider while the pipeline has them
  // in mod, finished and awaiting verification, and queued.
  for (const [tail, state, loc] of [
    ["N9FIT", "in_mod", "RFD"],
    ["N9DON", "verification_needed", null],
    ["N9QUE", "scheduled", null],
  ] as const) {
    addFleet(db, tail, "negative", { verifiedWifi: "Viasat", verifiedAt: now - 3 * DAY });
    db.query(
      `INSERT INTO fleet_progress_tails (airline, segment, type_code, tail, state, mod_location, sheet_updated, fetched_at)
       VALUES ('UA', 'mainline', '739', ?, ?, ?, '2026-11-20', ?)`
    ).run(tail, state, loc, now);
  }
  // N8NEG: still listed, but the verifier settled it negative. A stale
  // schedule row must not read as a Starlink flight.
  addPlane(db, "N8NEG", null);
  addFleet(db, "N8NEG", "negative", { verifiedWifi: "None", verifiedAt: now - 2 * DAY });
  addFlight(db, "N8NEG", "UA800", "DEN", now + 4 * HOUR, { arrivalAirport: "ORD" });

  // Another airline's tail: no page on United's site.
  addFleet(db, "N7AS", "confirmed", { airline: "AS", verifiedWifi: "Starlink" });
  addPlane(db, "N7AS", "Starlink", { airline: "AS" });

  db.query("INSERT INTO meta (key, value) VALUES ('UA:lastUpdated', ?)").run(
    new Date((now - HOUR) * 1000).toISOString()
  );
  app = createApp(db);
});

const get = (path: string, host = UA) =>
  app.dispatch(
    req(path, host, { headers: { Accept: "text/html", "x-forwarded-for": "127.0.0.1" } })
  );
const page = async (path: string) => (await get(path)).text();
const metaDescription = (doc: string) =>
  doc.match(/<meta name="description" content="([^"]*)"/)?.[1]?.replace(/&#x27;|&#39;/g, "'");
const model = (tail: string) => {
  const m = buildTailPage(AIRLINES.UA, createReaderFactory(db)("UA"), tail);
  if (!m) throw new Error(`no page for ${tail}`);
  return m;
};
const robots = (doc: string) => doc.match(/<meta name="robots" content="([^"]*)"/)?.[1];
const verdict = (doc: string) => doc.match(/id="tail-answer"[^>]*>([^<]*)</)?.[1];
const sitemapEntries = async () => {
  const xml = await (await app.dispatch(req("/sitemap.xml", UA))).text();
  return [...xml.matchAll(/<url>\s*<loc>[^<]*\/fleet\/(N[A-Z0-9]+)<\/loc>([\s\S]*?)<\/url>/g)].map(
    (m) => ({ tail: m[1], lastmod: m[2].match(/<lastmod>([^<]*)</)?.[1] })
  );
};

describe("classifyTail", () => {
  const cases: Array<[string, Parameters<typeof classifyTail>[0], TailAnswerKind]> = [
    [
      "listed and observed",
      { listing: { verified_wifi: "Starlink" }, fleet: null, reported: false },
      "verified",
    ],
    [
      "listed, the roster observed it",
      {
        listing: { verified_wifi: null },
        fleet: { starlink_status: "confirmed", verified_wifi: "Starlink" },
        reported: false,
      },
      "verified",
    ],
    ["listed only", { listing: { verified_wifi: null }, fleet: null, reported: false }, "listed"],
    [
      "a settle outranks the listing",
      {
        listing: { verified_wifi: null },
        fleet: { starlink_status: "negative", verified_wifi: "Viasat" },
        reported: false,
      },
      "other",
    ],
    [
      "a contradicted sheet listing",
      { listing: { verified_wifi: "Viasat" }, fleet: null, reported: true },
      "reported",
    ],
    [
      "a contradicted listing past the reported window",
      { listing: { verified_wifi: "Viasat" }, fleet: null, reported: false },
      "other",
    ],
    [
      "a reading with no listing",
      {
        listing: null,
        fleet: { starlink_status: "confirmed", verified_wifi: "Starlink" },
        reported: false,
      },
      "observed",
    ],
    [
      "on the roster, never read",
      {
        listing: null,
        fleet: { starlink_status: "unknown", verified_wifi: null },
        reported: false,
      },
      "unchecked",
    ],
  ];
  for (const [name, input, kind] of cases) {
    test(name, () => expect(classifyTail(input)).toBe(kind));
  }

  test("only an answer with something behind it indexes", () => {
    const kinds: TailAnswerKind[] = [
      "verified",
      "listed",
      "reported",
      "observed",
      "other",
      "unchecked",
    ];
    expect(kinds.filter((k) => tailIndexable(k, false))).toEqual([
      "verified",
      "listed",
      "reported",
    ]);
    expect(kinds.filter((k) => tailIndexable(k, true))).toEqual(kinds);
  });
});

describe("/fleet/{tail}", () => {
  test("the answer comes first, by the one equipped definition", async () => {
    const answers: Record<string, string> = {
      N1VER: "Yes",
      N2LIST: "Yes, not yet verified",
      N3REP: "Not confirmed",
      N4VIA: "No",
      N5NEW: "Not checked yet",
      N6MOD: "Not yet",
      N8NEG: "No",
    };
    for (const [tail, expected] of Object.entries(answers)) {
      const body = await page(`/fleet/${tail}`);
      expect(verdict(body), tail).toBe(expected);
      expect(body, tail).toContain(`Does ${tail} have Starlink?`);
      expect(body, tail).toContain(`<link rel="canonical" href="https://${UA}/fleet/${tail}"`);
    }
  });

  test("a verified tail says how we know, what it is and where it flies", async () => {
    const reader = createReaderFactory(db)("UA");
    const m = buildTailPage(AIRLINES.UA, reader, "N1VER", { flightLinks: true, routeLinks: true });
    if (!m) throw new Error("no model");
    expect(m.evidence.map((f) => f.label)).toEqual([
      "On our list since",
      "Settled reading",
      "Latest check",
      "Checks on record",
      "First seen flying Starlink",
    ]);
    expect(m.evidence.find((f) => f.label === "Checks on record")?.value).toStartWith(
      "2 of 2 read Starlink"
    );
    expect(m.evidence.at(-1)?.value).toStartWith("UA220 DEN → YYZ");
    expect(m.plane.map((f) => f.label)).toEqual([
      "Type",
      "Operated by",
      "Ship number",
      "FAA model",
      "Built",
      "Serial number",
      "Registered owner",
      "Mode S code",
    ]);
    // The operating spelling UAL200 is the marketed UA200.
    expect(m.upcoming.map((f) => [f.flight_number, f.flightHref, f.routeHref])).toEqual([
      ["UA200", "/check-flight/UA200", "/route-planner/DEN/ORD"],
      ["UA201", "/check-flight/UA201", "/route-planner/ORD/DEN"],
    ]);
    // Newest first; the leg it was swapped off is not a flight it flew.
    expect(m.recent.map((f) => f.flight_number)).toEqual(["UA210", "UA211"]);
    expect(m.departures.total).toBe(2);
    expect(m.departures.airports.map((a) => a.airport).sort()).toEqual(["DEN", "SFO"]);
    expect(tailMetaDescription(m)).toStartWith("Yes. N1VER has Starlink.");
  });

  test("a reported tail says the sheet lists it and our check does not agree", async () => {
    const body = await page("/fleet/N3REP");
    expect(body).toContain(
      "The community fleet sheet lists N3REP with Starlink, but our own check of united.com still reads Viasat Wi-Fi."
    );
    expect(body).toContain("It is not in our count.");
    expect(body).toContain("Sheet listing first seen");
  });

  test("a tail without Starlink names the provider and shows no flights", async () => {
    const body = await page("/fleet/N4VIA");
    expect(body).toContain(
      "N4VIA does not have Starlink. Our check of united.com reads Viasat Wi-Fi."
    );
    expect(verdict(body)).toBe("No");
    const m = model("N4VIA");
    expect(tailPageTitle(m)).toMatch(/^Does N4VIA Have Starlink\? United /);
    expect(tailMetaDescription(m)).toStartWith(
      "No. N4VIA does not have Starlink. Our check of united.com reads Viasat Wi-Fi."
    );
    expect(body).not.toContain('id="upcoming"');
    // Listed, settled negative, with a schedule row still cached.
    const neg = await page("/fleet/N8NEG");
    expect(neg).toContain("United.com lists no Wi-Fi on it.");
    expect(neg).not.toContain("/check-flight/UA800");
    expect(neg).not.toContain('id="upcoming"');
  });

  test("a tail in the install pipeline says where the sheet has it", async () => {
    const body = await page("/fleet/N6MOD");
    expect(body).toContain("Install status");
    expect(body).toContain("Being installed at MLB");
  });

  test("a tail being fitted says so in the answer, the title and the description", async () => {
    const body = await page("/fleet/N9FIT");
    expect(verdict(body)).toBe("Not yet");
    const answer =
      "N9FIT is being fitted with Starlink, per the community progress sheet. Not in our count yet. Our check of united.com reads Viasat Wi-Fi.";
    expect(body).toContain(answer);
    expect(body).toContain("<title>Does N9FIT Have Starlink? Being installed, United ");
    expect(metaDescription(body)).toStartWith(answer);
    expect(body).toContain(
      "Being installed at RFD (Rockford, IL), per the community progress sheet"
    );
    expect(robots(body)).not.toContain("noindex");
    expect(model("N9FIT").kind).toBe("other");
  });

  test("a tail fitted and awaiting verification says so, and is not a yes", async () => {
    const body = await page("/fleet/N9DON");
    expect(verdict(body)).toBe("Not verified yet");
    const answer =
      "The community progress sheet lists N9DON as fitted with Starlink, awaiting verification. Not in our count yet. Our check of united.com reads Viasat Wi-Fi.";
    expect(body).toContain(answer);
    expect(body).toContain("<title>Does N9DON Have Starlink? Awaiting verification, United ");
    // The clamp trims the closing stop when more follows; the reading is whole.
    expect(metaDescription(body)).toStartWith(answer.slice(0, -1));
    expect(body).not.toContain('id="upcoming"');
    expect(model("N9DON").kind).toBe("other");
  });

  test("a queued tail, and one in the pipeline with no reading, name the state too", async () => {
    const queued = model("N9QUE");
    expect(queued.verdict).toBe("Not yet");
    expect(queued.answer).toStartWith(
      "N9QUE is queued for a Starlink install, per the community progress sheet. Not in our count yet."
    );
    expect(tailPageTitle(queued)).toContain("Queued for install, United ");
    const unread = model("N6MOD");
    expect(unread.kind).toBe("unchecked");
    expect(unread.verdict).toBe("Not yet");
    expect(unread.answer).toBe(
      "N6MOD is being fitted with Starlink, per the community progress sheet. Not in our count yet."
    );
  });

  test("no answer words a provider as what the plane has", () => {
    for (const { tail } of getTailIndex(db, "UA")) {
      const m = model(tail);
      expect(`${m.answer} ${m.note ?? ""}`).not.toMatch(/\bIt has\b/);
      expect(m.installStatus === null).toBe(!["Not yet", "Not verified yet"].includes(m.verdict));
    }
  });

  test("lowercase, a missing N and a trailing slash 301 to the one address", async () => {
    for (const path of ["/fleet/n1ver", "/fleet/N1VER/", "/fleet/1VER", "/fleet/1ver/"]) {
      const res = await get(path);
      expect(res.status, path).toBe(301);
      expect(res.headers.get("location"), path).toBe(`https://${UA}/fleet/N1VER`);
    }
    expect((await get("/fleet/N1VER")).status).toBe(200);
  });

  test("an unknown or malformed tail is the plain 404, and echoes nothing typed", async () => {
    const plain = await page("/fleet/N9ZZZ");
    for (const path of [
      "/fleet/N9ZZZ",
      "/fleet/NOPE",
      "/fleet/N1VER/extra",
      "/fleet/N1VERTOOLONG",
      "/fleet/N1-VER",
      "/fleet/%3Cscript%3Ealert(1)%3C%2Fscript%3E",
      "/fleet/N1VER%22%3E%3Cimg%20src%3Dx%3E",
      "/fleet/'%20OR%201=1--",
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      const body = await res.text();
      expect(body, path).toContain("Page not found");
      expect(body, path).not.toMatch(/alert\(1\)|<img src=x|OR 1=1|TOOLONG|N9ZZZ|NOPE/);
      expect(body.length, path).toBe(plain.length);
    }
  });

  test("another airline's tail has no page here, and the family is United's only", async () => {
    expect((await get("/fleet/N7AS")).status).toBe(404);
    expect((await get("/fleet/N7AS", SITES.alaska.canonicalHost)).status).toBe(404);
    expect((await get("/fleet/N1VER", SITES.alaska.canonicalHost)).status).toBe(404);
    expect((await get("/fleet/N1VER", SITES.airline.canonicalHost)).status).toBe(404);
  });

  test("the tail is never a metric tag: the family rides the /fleet entry", () => {
    expect(app.routeTags.filter((t) => /N\d|N1VER/.test(t))).toEqual([]);
    expect(app.routeTags).toContain("/fleet");
  });
});

describe("index rule", () => {
  test("a thin tail serves, follows links, and stays out of the index", async () => {
    for (const tail of ["N4VIA", "N5NEW", "N8NEG"]) {
      const res = await get(`/fleet/${tail}`);
      expect(res.status, tail).toBe(200);
      expect(robots(await res.text()), tail).toBe("noindex, follow");
    }
  });

  test("a tail with an answer behind it indexes", async () => {
    for (const tail of ["N1VER", "N2LIST", "N3REP", "N6MOD"]) {
      expect(robots(await page(`/fleet/${tail}`)), tail).toBe("index, follow");
    }
  });

  test("the sitemap lists exactly the tails whose page indexes", async () => {
    const listed = (await sitemapEntries()).map((e) => e.tail).sort();
    expect(listed).toEqual(["N1VER", "N2LIST", "N3REP", "N6MOD", "N9DON", "N9FIT", "N9QUE"]);
    for (const entry of getTailIndex(db, "UA")) {
      const body = await page(`/fleet/${entry.tail}`);
      expect(robots(body), entry.tail).toBe(entry.indexable ? "index, follow" : "noindex, follow");
      expect(listed.includes(entry.tail), entry.tail).toBe(entry.indexable);
    }
  });

  test("lastmod is the day an equipped tail joined the list, and nothing else", async () => {
    const byTail = new Map((await sitemapEntries()).map((e) => [e.tail, e.lastmod]));
    expect(byTail.get("N1VER")).toBe("2026-01-01");
    expect(byTail.get("N3REP")).toBeUndefined();
    expect(byTail.get("N6MOD")).toBeUndefined();
  });

  test("llms.txt names a tail page the sitemap lists", async () => {
    const txt = await (await app.dispatch(req("/llms.txt", UA))).text();
    const linked = txt.match(new RegExp(`https://${UA}/fleet/(N[A-Z0-9]+)`))?.[1];
    expect((await sitemapEntries()).map((e) => e.tail)).toContain(linked as string);
  });

  test("on the snapshot, the index list and every page agree", async () => {
    const snapshot = openSnapshot();
    const snapshotApp = createApp(snapshot);
    const index = getTailIndex(snapshot, "UA");
    expect(index.length).toBeGreaterThan(0);
    for (const entry of index) {
      const res = await snapshotApp.dispatch(
        req(`/fleet/${entry.tail}`, UA, { headers: { Accept: "text/html" } })
      );
      expect(res.status, entry.tail).toBe(200);
      expect(robots(await res.text()), entry.tail).toBe(
        entry.indexable ? "index, follow" : "noindex, follow"
      );
    }
    snapshot.close();
  });
});

describe("recent flights query plan", () => {
  test("reads the log by tail and probes departure_log by index", () => {
    const plan = (
      db.query(`EXPLAIN QUERY PLAN ${TAIL_RECENT_SQL}`).all("N1VER", 0, now, "UA") as {
        detail: string;
      }[]
    ).map((r) => r.detail);
    expect(plan.some((d) => /SEARCH fal USING INDEX idx_fal_tail/.test(d))).toBe(true);
    expect(plan.some((d) => /SEARCH dl .*USING INDEX idx_dl_tail/.test(d))).toBe(true);
    expect(plan.filter((d) => /SCAN (fal|dl)\b/.test(d))).toEqual([]);
  });
});

describe("links into the family", () => {
  test("the fleet registry, the install log and the home list link each tail to its page", async () => {
    const fleet = await page("/fleet");
    expect(fleet).toContain('id="t-N1VER" href="/fleet/N1VER"');
    expect(fleet).toContain('id="t-N4VIA" href="/fleet/N4VIA"');
    expect(fleet).not.toContain("flightaware.com/live/flight/N1VER");
    expect(await page("/newly-equipped")).toContain('href="/fleet/N1VER"');
    expect(await page("/")).toContain('href="/fleet/N1VER"');
    for (const path of ["/fleet", "/newly-equipped", "/"]) {
      const body = await page(path);
      const tails = new Set([...body.matchAll(/href="(\/fleet\/N[A-Z0-9]+)"/g)].map((m) => m[1]));
      expect(tails.size, path).toBeGreaterThan(0);
      for (const href of tails) expect((await get(href)).status, `${path} links ${href}`).toBe(200);
    }
  });

  test("a host without tail pages keeps the registry on FlightAware", async () => {
    const body = await (await get("/fleet", SITES.airline.canonicalHost)).text();
    expect(body).not.toMatch(/href="\/fleet\/N[A-Z0-9]+"/);
  });

  test("a flight answer links the listed plane only where the host has tail pages", () => {
    const ctx = (tailPages: boolean): AnswerContext => ({
      flightNumber: "UA200",
      date: isoDay(now),
      daysOut: 0,
      nowSec: now,
      airlineName: "United Airlines",
      zoneFor: () => undefined,
      liveTv: null,
      watchEnabled: false,
      routePlannerEnabled: false,
      tailPages,
      host: UA,
    });
    const body = {
      hasStarlink: true,
      confidence: "verified",
      flights: [{ tail_number: "N1VER", aircraft_type: "Boeing 737-900" }],
    };
    expect(renderFlightAnswer(body, ctx(true)).html).toContain('<a href="/fleet/N1VER"');
    expect(renderFlightAnswer(body, ctx(false)).html).not.toContain("/fleet/N1VER");
    // A registration that is not a US tail never becomes a path.
    const odd = { ...body, flights: [{ tail_number: 'N1"><b>' }] };
    expect(renderFlightAnswer(odd, ctx(true)).html).not.toContain("<b>");
    expect(renderFlightAnswer(odd, ctx(true)).html).not.toContain('href="/fleet/');
  });
});
