/**
 * Leg scoping through dispatch: the no-param answer is byte-identical, bad
 * input never errors, and a scoped answer only carries its own leg. FR24 is
 * stubbed empty so the near-term dates (needed for sameDayAlternatives) never
 * touch the network.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { setAssignmentFetcher } from "../src/api/flight-verdict";
import { COUNTERS, metrics } from "../src/observability/metrics";
import { createApp } from "../src/server/app";
import {
  addFleet,
  addFlight,
  addPlane,
  bodyOf,
  jsonOf,
  makeSyntheticDb,
  openSnapshot,
  postMcp,
} from "./helpers";

const UA = "unitedstarlinktracker.com";
const HUB = "airlinestarlinktracker.com";
const AS = "alaskastarlinktracker.com";

const DAY_SEC = 86400;
const tomorrowStart = (Math.floor(Date.now() / 1000 / DAY_SEC) + 1) * DAY_SEC;
const D = new Date(tomorrowStart * 1000).toISOString().slice(0, 10);
const at = (hoursAfterUtcMidnight: number) => tomorrowStart + hoursAfterUtcMidnight * 3600;

const LEG_KEYS = new Set(["origin", "destination", "match", "reason", "otherLegs"]);
const REASONS = new Set(["invalid_airport", "same_airport", "no_timezone", "ambiguous_leg"]);

function negativeTail(db: Database, tail: string): void {
  addPlane(db, tail, "Viasat");
  addFleet(db, tail, "negative", { verifiedWifi: "Viasat" });
}

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  setAssignmentFetcher(() => Promise.resolve([]));
  const db = makeSyntheticDb();
  // UA540: SFO→DEN on Starlink, DEN→SAN (19:05 MDT, next UTC day) on Viasat.
  addPlane(db, "N2001", "Starlink");
  addFlight(db, "N2001", "UA540", "SFO", at(15), { arrivalAirport: "DEN" });
  negativeTail(db, "N2002");
  addFlight(db, "N2002", "UA540", "DEN", at(25.08), { arrivalAirport: "SAN" });
  // UA2222: first hop negative, second on Starlink.
  negativeTail(db, "N2003");
  addFlight(db, "N2003", "UA2222", "SFO", at(16), { arrivalAirport: "DEN" });
  addPlane(db, "N2004", "Starlink");
  addFlight(db, "N2004", "UA2222", "DEN", at(21), { arrivalAirport: "SAN" });
  // UA2333: a plain firm no.
  negativeTail(db, "N2005");
  addFlight(db, "N2005", "UA2333", "ORD", at(18), { arrivalAirport: "DEN" });
  // AS tail for the hub check-any-flight scheduled branch.
  addPlane(db, "N601AS", "Starlink", { airline: "AS" });
  addFlight(db, "N601AS", "AS100", "SEA", at(18), { arrivalAirport: "LAX", airline: "AS" });
  app = createApp(db);
});

afterAll(() => setAssignmentFetcher(null));

const check = (_host: string, fn: string, extra = "", path = "/api/check-flight") =>
  `${path}?flight_number=${fn}&date=${D}${extra}`;

const SURFACES: Array<{ host: string; path: string; fns: string[] }> = [
  { host: UA, path: "/api/check-flight", fns: ["UA540", "UA2333", "UA7777"] },
  { host: HUB, path: "/api/check-flight", fns: ["UA540", "UA2333", "UA7777", "AS123"] },
  {
    host: HUB,
    path: "/api/check-any-flight",
    fns: ["UA540", "UA2333", "UA7777", "AS100", "AS123"],
  },
  { host: AS, path: "/api/check-flight", fns: ["AS123"] },
];

describe("no-param identity", () => {
  test("empty origin/destination give the same bytes as no params, with no leg key", async () => {
    for (const { host, path, fns } of SURFACES) {
      for (const fn of fns) {
        const plain = await bodyOf(app, check(host, fn, "", path), host);
        const empty = await bodyOf(app, check(host, fn, "&origin=&destination=", path), host);
        expect(plain.status, `${host}${path} ${fn}`).toBe(200);
        expect(empty.text, `${host}${path} ${fn}`).toBe(plain.text);
        expect(plain.text.includes('"leg"'), `${host}${path} ${fn}`).toBe(false);
      }
    }
  });
});

describe("lenient input", () => {
  test("malformed legs answer 200 unscoped with a reason and today's hasStarlink", async () => {
    const base = await jsonOf(app, check(UA, "UA540"), UA);
    for (const extra of ["&origin=SF", "&origin=SFO1", "&origin=SFO&destination=SFO"]) {
      const r = await app.dispatch(
        new Request(`http://x${check(UA, "UA540", extra)}`, { headers: { Host: UA } })
      );
      expect(r.status, extra).toBe(200);
      expect(r.headers.get("access-control-allow-origin"), extra).toBe("*");
      const body = await r.json();
      expect(body.hasStarlink, extra).toBe(base.hasStarlink);
      expect(body.leg.match, extra).toBe("unscoped");
      expect(REASONS.has(body.leg.reason), extra).toBe(true);
    }
  });

  test("lowercase and ICAO origins scope", async () => {
    for (const origin of ["den", "KDEN"]) {
      const body = await jsonOf(app, check(UA, "UA540", `&origin=${origin}`), UA);
      expect(body.leg.origin).toBe("DEN");
      expect(body.leg.match).toBe("exact");
      expect(body.hasStarlink).toBe(false);
    }
  });
});

describe("scoped answers", () => {
  test("UA540 from DEN is the DEN→SAN tail's firm no", async () => {
    const unscoped = await jsonOf(app, check(UA, "UA540"), UA);
    expect(unscoped.hasStarlink).toBe(true);
    const body = await jsonOf(app, check(UA, "UA540", "&origin=DEN"), UA);
    expect(body.hasStarlink).toBe(false);
    expect(Object.keys(body.leg).every((k) => LEG_KEYS.has(k))).toBe(true);
    expect("reason" in body.leg).toBe(false);
    expect("predictionScope" in body).toBe(false);
    expect(body.message).toContain("UA540 DEN → ");
    const departures = [
      ...body.flights.map((f: { departure_airport: string }) => f.departure_airport),
      ...(body.fallback?.segments ?? []).map((s: { origin: string }) => s.origin),
    ];
    expect(departures.every((a: string) => a === "DEN")).toBe(true);
    expect(body.leg.otherLegs.map((l: { origin: string }) => l.origin)).toEqual(["SFO"]);
  });

  test("scoped yes carries only the answered leg's rows", async () => {
    const body = await jsonOf(app, check(UA, "UA540", "&origin=SFO&destination=DEN"), UA);
    expect(body.hasStarlink).toBe(true);
    expect(body.flights.length).toBe(1);
    expect(body.flights[0].departure_airport).toBe("SFO");
  });

  test("a whole-journey request across a connection answers unscoped, both ways", async () => {
    for (const fn of ["UA540", "UA2222"]) {
      const unscoped = await jsonOf(app, check(UA, fn), UA);
      const journey = await jsonOf(app, check(UA, fn, "&origin=SFO&destination=SAN"), UA);
      expect(journey.hasStarlink, fn).toBe(unscoped.hasStarlink);
      expect(journey.leg.match, fn).toBe("unscoped");
      expect(journey.leg.reason, fn).toBe("ambiguous_leg");
    }
  });

  test("an origin fallback names the hop it answered, without its alternatives", async () => {
    const exact = await jsonOf(app, check(UA, "UA2333", "&origin=ORD&destination=DEN"), UA);
    expect(exact.hasStarlink).toBe(false);
    expect(Array.isArray(exact.sameDayAlternatives)).toBe(true);
    const diverted = await jsonOf(app, check(UA, "UA2333", "&origin=ORD&destination=LAX"), UA);
    expect(diverted.hasStarlink).toBe(false);
    expect(diverted.leg.match).toBe("origin");
    expect(diverted.message).toContain("UA2333 ORD → DEN is assigned");
    expect(diverted.message).toContain("ORD → LAX");
    expect("sameDayAlternatives" in diverted).toBe(false);
  });

  test("hub check-any-flight keeps airline and gains leg", async () => {
    const body = await jsonOf(
      app,
      check(HUB, "UA540", "&origin=DEN", "/api/check-any-flight"),
      HUB
    );
    expect(typeof body.airline).toBe("string");
    expect(body.hasStarlink).toBe(false);
    expect(body.leg.match).toBe("exact");
    const as = await jsonOf(app, check(HUB, "AS100", "&origin=SEA", "/api/check-any-flight"), HUB);
    expect(as.hasStarlink).toBe(true);
    expect(as.leg.match).toBe("exact");
  });

  test("a prediction for an unmatched leg names the legs flown, not 'not yet published'", async () => {
    const body = await jsonOf(app, check(UA, "UA540", "&origin=LAX&destination=SFO"), UA);
    expect(body.hasStarlink).toBe(null);
    expect(body.leg.match).toBe("unmatched");
    expect(body.message).not.toContain("not yet published");
    expect(body.message).toContain(
      "We have no LAX → SFO leg for UA540 on this date; we see it flying SFO → DEN → SAN. This estimate is for flight UA540 overall."
    );
    const originOnly = await jsonOf(app, check(UA, "UA540", "&origin=LAX"), UA);
    expect(originOnly.message).toContain("We have no leg from LAX");
    const hub = await jsonOf(
      app,
      check(HUB, "UA540", "&origin=LAX&destination=SFO", "/api/check-any-flight"),
      HUB
    );
    expect(hub.reason).not.toContain("No schedule data");
    expect(hub.reason).toContain("we see it flying SFO → DEN → SAN");
  });

  test("a yes answered from another leg says so; the unscoped yes gains no message", async () => {
    const body = await jsonOf(app, check(UA, "UA540", "&origin=SFO&destination=LAX"), UA);
    expect(body.hasStarlink).toBe(true);
    expect(body.leg.match).toBe("origin");
    expect(body.message).toContain("this answer is for its SFO → DEN leg only");
    const hub = await jsonOf(
      app,
      check(HUB, "UA540", "&origin=SFO&destination=LAX", "/api/check-any-flight"),
      HUB
    );
    expect(hub.reason).toContain("this answer is for its SFO → DEN leg only");
    const exact = await jsonOf(app, check(UA, "UA540", "&origin=SFO&destination=DEN"), UA);
    expect("message" in exact).toBe(false);
    const plain = await jsonOf(app, check(UA, "UA540"), UA);
    expect(plain.hasStarlink).toBe(true);
    expect("message" in plain).toBe(false);
  });

  test("HEAD with a leg is 200", async () => {
    const r = await app.dispatch(
      new Request(`http://x${check(UA, "UA540", "&origin=DEN")}`, {
        method: "HEAD",
        headers: { Host: UA },
      })
    );
    expect(r.status).toBe(200);
  });
});

describe("FLIGHT_LEG_SCOPE", () => {
  const original = metrics.increment;
  let calls: Array<{ name: string; tags: Record<string, unknown> }> = [];
  beforeAll(() => {
    metrics.increment = (name, tags) => {
      calls.push({ name, tags: (tags ?? {}) as Record<string, unknown> });
    };
  });
  afterAll(() => {
    metrics.increment = original;
  });
  afterEach(() => {
    calls = [];
  });
  const legCalls = () => calls.filter((c) => c.name === COUNTERS.FLIGHT_LEG_SCOPE);

  test("fires once per scoped request with airline, days_out and client_class", async () => {
    await jsonOf(app, check(UA, "UA540", "&origin=DEN&client=ext-2.1.0"), UA);
    const [c, ...rest] = legCalls();
    expect(rest.length).toBe(0);
    expect(c.tags).toMatchObject({
      endpoint: "api_check",
      airline: "united",
      match: "exact",
      reason: "none",
      effect: "yes_to_no",
      days_out: "1",
      client_class: "extension",
      ext_version: "2.1",
    });
  });

  test("is not emitted without params", async () => {
    await jsonOf(app, check(UA, "UA540"), UA);
    await jsonOf(app, check(HUB, "UA540", "", "/api/check-any-flight"), HUB);
    expect(legCalls().length).toBe(0);
  });

  test("unscoped requests are counted as `same` with their reason", async () => {
    await jsonOf(app, check(HUB, "UA540", "&origin=SF", "/api/check-any-flight"), HUB);
    expect(legCalls()[0].tags).toMatchObject({
      endpoint: "api_check_any",
      match: "unscoped",
      reason: "invalid_airport",
      effect: "same",
    });
  });
});

describe("MCP check_flight", () => {
  const call = async (args: Record<string, string>) => {
    const r = await postMcp(app, UA, "tools/call", { name: "check_flight", arguments: args });
    return r.result.content[0].text as string;
  };

  test("a leg names itself in the answer", async () => {
    const text = await call({
      flight_number: "UA540",
      date: D,
      origin: "SFO",
      destination: "DEN",
    });
    expect(text).toContain("UA540 SFO → DEN");
    expect(text).toMatch(/Yes!/);
    const den = await call({ flight_number: "UA540", date: D, origin: "DEN" });
    expect(den).toMatch(/No Starlink/);
  });

  test("a whole journey is never the first hop's firm answer", async () => {
    const text = await call({
      flight_number: "UA540",
      date: D,
      origin: "SFO",
      destination: "SAN",
    });
    expect(text).not.toMatch(/No Starlink/);
    expect(text).not.toContain("UA540 SFO → SAN");
  });

  test("an origin fallback names its hop and offers no alternatives for it", async () => {
    const text = await call({
      flight_number: "UA2333",
      date: D,
      origin: "ORD",
      destination: "LAX",
    });
    expect(text).toContain("UA2333 ORD → DEN");
    expect(text.trimEnd()).toEndWith("leg only.");
  });

  test("without a leg the text is unchanged vs empty strings", async () => {
    const plain = await call({ flight_number: "UA540", date: D });
    const empty = await call({ flight_number: "UA540", date: D, origin: "", destination: "" });
    expect(empty).toBe(plain);
    expect(plain).not.toContain("→ DEN:");
  });
});

describe("snapshot shapes", () => {
  test("multi-leg UA flight-days answer every leg with a well-formed echo", async () => {
    const db = openSnapshot();
    const groups = db
      .query(
        `SELECT uf.flight_number AS fn, date(uf.departure_time, 'unixepoch') AS day,
                group_concat(DISTINCT uf.departure_airport) AS origins
           FROM upcoming_flights uf
           JOIN starlink_planes sp ON sp.TailNumber = uf.tail_number
          WHERE uf.airline = 'UA' AND uf.flight_number LIKE 'UA%'
          GROUP BY 1, 2
         HAVING COUNT(DISTINCT uf.departure_airport) >= 2
          LIMIT 20`
      )
      .all() as { fn: string; day: string; origins: string }[];
    db.close();
    if (groups.length === 0) return;
    const snap = createApp(openSnapshot());
    const matches = new Set(["exact", "origin", "unmatched", "no_data", "unscoped"]);
    for (const g of groups) {
      for (const origin of g.origins.split(",")) {
        const body = await jsonOf(
          snap,
          `/api/check-flight?flight_number=${g.fn}&date=${g.day}&origin=${origin}`,
          UA
        );
        expect([true, false, null]).toContain(body.hasStarlink);
        expect(Array.isArray(body.flights)).toBe(true);
        expect(matches.has(body.leg.match)).toBe(true);
        expect(Array.isArray(body.leg.otherLegs)).toBe(true);
        for (const l of body.leg.otherLegs) {
          expect(typeof l.origin).toBe("string");
          expect([true, false, null]).toContain(l.hasStarlink);
        }
        if (body.leg.match === "exact") {
          expect(body.leg.origin).toBe(origin.toUpperCase());
          const departures =
            body.flights.length > 0
              ? body.flights.map((f: { departure_airport: string }) => f.departure_airport)
              : (body.fallback?.segments ?? []).map((s: { origin: string }) => s.origin);
          expect(departures.every((a: string) => a.toUpperCase() === origin.toUpperCase())).toBe(
            true
          );
        }
      }
    }
  });
});
