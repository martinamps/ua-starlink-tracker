/**
 * One flight, one number: wherever the planner, the route list or the nonstop
 * baseline prints the percent of a flight number with no history, it is the
 * percent that flight's own answer prints.
 *
 * Such a number is a share of aircraft and rounds down
 * (tests/answer-share-rounding.test.ts). The flight's own answer followed
 * that rule first; a planner leg, a route-list line and a baseline still
 * rounded to the nearest, so UA5531 read 51% when asked about and 52% as a leg
 * of a connection. Each place below is compared with the answer itself, on a
 * fleet whose shares all round up (367 of 1,000 is 36.7%), so a place that
 * rounds to the nearest cannot pass. Odds that rest on flight history are held
 * to the form they had.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import type { RouteFlightBoard } from "../src/api/route-flights";
import { renderResults } from "../src/client/route-planner";
import { flightLabel, probLabel, shareLabel } from "../src/components/ui/format";
import { logFlightAssignments } from "../src/database/assignment-log";
import { createReaderFactory } from "../src/database/reader";
import { predictRoute, routeBaseline } from "../src/scripts/starlink-predictor";
import { createApp } from "../src/server/app";
import { jsonOf, makeFreshDb, mcpTool } from "./helpers";

const UA = SITES.united.canonicalHost;
const HUBS = ["SFO", "DEN", "ORD", "EWR"] as const;
const HOURS: Record<string, number> = {
  "SFO-DEN": 2.5,
  "SFO-ORD": 4.2,
  "SFO-EWR": 5.5,
  "DEN-ORD": 2.4,
  "DEN-EWR": 3.8,
  "ORD-EWR": 2.2,
  "LAX-DEN": 2.3,
  "IAH-ORD": 2.6,
  "LAX-IAH": 3.3,
};
/** Pairs whose only scheduled flight was never seen, so the planner has to
 * offer it: between the hubs a flight with history always ranks above one. */
const UNSEEN_ONLY = [
  ["LAX", "DEN"],
  ["DEN", "LAX"],
  ["IAH", "ORD"],
  ["ORD", "IAH"],
  ["LAX", "IAH"],
  ["IAH", "LAX"],
] as const;
/** On LAX-IAH, beside the unseen flight: checked twelve times, never fitted. */
const NEVER_FITTED = "UA1900";
const hoursOf = (a: string, b: string) => HOURS[`${a}-${b}`] ?? HOURS[`${b}-${a}`];
/** A pair with a flown duration and no flight on the schedule: its baseline is
 * the mainline share itself, with no flight number. */
const NO_SCHEDULE: [string, string] = ["SEA", "BOS"];

type Kind = "unseen" | "history" | "leg" | "leg-thin";
const kindOf = new Map<string, Kind>();

/**
 * United with 367 of 1,000 mainline and 777 of 1,000 express aircraft fitted,
 * and on every pair of four hubs: a mainline flight never seen, flights with a
 * verification history, and flights with a leg history (three or more logged
 * days, and one or two).
 */
function seed(): Database {
  const db = makeFreshDb();
  const now = Math.floor(Date.now() / 1000);
  let state = 12345;
  const rnd = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const tail = (i: number) => `N${10000 + i}`;
  const fleet = db.query(
    `INSERT INTO united_fleet (tail_number, aircraft_type, fleet, operated_by, first_seen_source,
       first_seen_at, last_seen_at, starlink_status, verified_wifi, verified_at, airline)
     VALUES (?, ?, ?, ?, 'test', ?, ?, ?, ?, ?, 'UA')`
  );
  const plane = db.query(
    `INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber,
       OperatedBy, fleet, verified_wifi, airline)
     VALUES (?, 'StrLnk', 'g', ?, '2026-06-01', ?, ?, ?, 'Starlink', 'UA')`
  );
  const FAMILIES = [
    ["Embraer E175", "express", "SkyWest Airlines", 777],
    ["Boeing 737-800", "mainline", "United Airlines", 367],
  ] as const;
  FAMILIES.forEach(([type, sub, op, fitted], f) => {
    for (let k = 0; k < 1000; k++) {
      const t = tail(f * 1000 + k);
      const on = k < fitted;
      fleet.run(
        t,
        type,
        sub,
        op,
        now - 90 * 86400,
        now - 3600,
        on ? "confirmed" : "negative",
        on ? "Starlink" : "None",
        now - 86400
      );
      if (on) plane.run(type, `UA-${sub}`, t, op, sub);
    }
  });
  const meta = db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
  meta.run("UA:totalAircraftCount", "2000");
  meta.run("UA:expressTotal", "1000");
  meta.run("UA:mainlineTotal", "1000");
  meta.run("UA:lastUpdated", new Date((now - 3600) * 1000).toISOString());

  const fitted = {
    express: () => tail(Math.floor(rnd() * 777)),
    mainline: () => tail(1000 + Math.floor(rnd() * 367)),
  };
  const bare = {
    express: () => tail(777 + Math.floor(rnd() * 223)),
    mainline: () => tail(1367 + Math.floor(rnd() * 633)),
  };
  const upcoming = db.query(
    `INSERT INTO upcoming_flights (tail_number, flight_number, departure_airport, arrival_airport,
       departure_time, arrival_time, last_updated, airline) VALUES (?, ?, ?, ?, ?, ?, ?, 'UA')`
  );
  const checked = db.query(
    `INSERT INTO starlink_verification_log (tail_number, source, checked_at, has_starlink,
       wifi_provider, flight_number, tail_confirmed, airline) VALUES (?, 'united', ?, ?, ?, ?, 1, 'UA')`
  );
  const flown = db.query(
    `INSERT OR IGNORE INTO flight_routes (flight_number, origin, destination, duration_sec,
       first_seen_at, last_seen_at, seen_count) VALUES (?, ?, ?, ?, ?, ?, 20)`
  );
  const tomorrow = Math.floor(now / 86400) * 86400 + 86400;
  let n = 0;
  for (const a of HUBS) {
    for (const b of HUBS) {
      if (a === b) continue;
      n++;
      const sec = hoursOf(a, b) * 3600;
      const flights: Array<[string, "mainline" | "express", Kind]> = [
        [`UA${200 + n}`, "mainline", "unseen"],
        [`UA${1000 + n}`, "mainline", "history"],
        [`UA${5000 + n}`, "express", "history"],
        [`UA${1500 + n}`, "mainline", n % 3 === 0 ? "leg-thin" : "leg"],
        [`UA${5500 + n}`, "express", n % 4 === 0 ? "leg-thin" : "leg"],
      ];
      flights.forEach(([fn, sub, kind], i) => {
        kindOf.set(fn, kind);
        const dep = tomorrow + (13 + i * 2 + (n % 3)) * 3600;
        upcoming.run(fitted[sub](), fn, a, b, dep, dep + sec, now - 3600);
        flown.run(fn, a, b, sec, now - 60 * 86400, now - 3600);
        if (kind === "history") {
          const count = 1 + Math.floor(rnd() * 24);
          const rate = rnd();
          for (let k = 0; k < count; k++) {
            const on = rnd() < rate;
            checked.run(
              (on ? fitted : bare)[sub](),
              now - Math.floor(rnd() * 80 * 86400) - 3600,
              on ? 1 : 0,
              on ? "Starlink" : "Viasat",
              fn
            );
          }
        }
        if (kind === "leg" || kind === "leg-thin") {
          const days = kind === "leg" ? 4 + Math.floor(rnd() * 16) : 1 + Math.floor(rnd() * 2);
          const rate = rnd();
          for (let k = 2; k < days + 2; k++) {
            const t = dep - k * 86400;
            logFlightAssignments(
              db,
              "UA",
              (rnd() < rate ? fitted : bare)[sub](),
              [
                {
                  flight_number: fn,
                  departure_airport: a,
                  arrival_airport: b,
                  departure_time: t,
                  arrival_time: t + sec,
                },
              ],
              t - 3600
            );
          }
        }
      });
    }
  }
  UNSEEN_ONLY.forEach(([a, b], i) => {
    const fn = `UA${300 + i}`;
    kindOf.set(fn, "unseen");
    const dep = tomorrow + (15 + i) * 3600;
    const sec = hoursOf(a, b) * 3600;
    upcoming.run(fitted.mainline(), fn, a, b, dep, dep + sec, now - 3600);
    flown.run(fn, a, b, sec, now - 60 * 86400, now - 3600);
  });
  kindOf.set(NEVER_FITTED, "history");
  upcoming.run(
    fitted.mainline(),
    NEVER_FITTED,
    "LAX",
    "IAH",
    tomorrow + 70000,
    tomorrow + 82000,
    now
  );
  flown.run(NEVER_FITTED, "LAX", "IAH", 12000, now - 60 * 86400, now - 3600);
  for (let k = 0; k < 12; k++) {
    checked.run(bare.mainline(), now - (k + 1) * 86400, 0, "Viasat", NEVER_FITTED);
  }
  flown.run("UA77", NO_SCHEDULE[0], NO_SCHEDULE[1], 5.2 * 3600, now - 60 * 86400, now - 3600);
  return db;
}

interface Leg {
  flight_number: string;
  route: string;
  probability: number;
  n_observations: number;
  confirmed?: boolean;
}
interface Plan {
  itineraries: Array<{ legs: Leg[]; via: string[]; joint_probability: number; coverage: string }>;
  baseline: { flight_number: string | null; probability: number; n_observations: number } | null;
}

/** The form history odds had in the MCP's planner and route list before this rule. */
const nearest = (p: number) => `${(p * 100).toFixed(0)}%`;
const PAIRS = HUBS.flatMap((a) => HUBS.filter((b) => b !== a).map((b) => [a, b] as const));
/** Every trip asked: the hub pairs, the unseen-only pairs, and connections over them. */
const TRIPS: ReadonlyArray<readonly [string, string]> = [
  ...PAIRS,
  ...UNSEEN_ONLY,
  ["LAX", "EWR"],
  ["LAX", "ORD"],
  ["IAH", "EWR"],
  ["IAH", "DEN"],
  ["SFO", "IAH"],
  ["EWR", "LAX"],
];

describe("a flight number with no history prints one percent everywhere", () => {
  let db: Database;
  let app: ReturnType<typeof createApp>;
  const own = new Map<string, string>();
  // Loopback is exempt from the rate limit these sweeps would trip.
  const get = (path: string) =>
    jsonOf(app, path, UA, { headers: { "x-forwarded-for": "127.0.0.1" } });

  /** The percent on the flight's own answer: the card's rule on the dated
   * API answer, checked against the sentence the MCP gives for the flight. */
  async function ownAnswer(fn: string): Promise<string> {
    const known = own.get(fn);
    if (known) return known;
    const dated = await get(`/api/check-flight?flight_number=${fn}&date=2099-01-01`);
    const label = flightLabel(dated.prediction.probability, dated.prediction.n_observations);
    const said = await mcpTool(app, UA, "predict_flight_starlink", { flight_number: fn });
    const lead = /\*\*: (\S+) Starlink probability/.exec(said.text)?.[1] ?? "";
    if (dated.prediction.n_observations === 0) {
      expect(said.text, fn).toContain("(fleet prior)");
      expect(lead.replace(/^~/, ""), fn).toBe(label);
    }
    own.set(fn, label);
    return label;
  }

  beforeAll(() => {
    db = seed();
    app = createApp(db);
  });
  afterAll(() => db.close());

  const plan = (o: string, d: string): Promise<Plan> =>
    get(`/api/plan-route?origin=${o}&destination=${d}`);

  test("the fixture's unseen estimate rounds up when rounded to the nearest", async () => {
    expect(await ownAnswer("UA201")).toBe("36%");
    expect(probLabel(367 / 1000)).toBe("37%");
  });

  test("MCP plan_starlink_itinerary: every leg, and a nonstop's own line", async () => {
    let unseen = 0;
    let nonstops = 0;
    let history = 0;
    for (const [o, d] of TRIPS) {
      const { text } = await mcpTool(app, UA, "plan_starlink_itinerary", {
        origin: o,
        destination: d,
      });
      const byFlight = new Map<string, Leg>();
      for (const it of (await plan(o, d)).itineraries) {
        for (const l of it.legs) byFlight.set(`${l.flight_number} ${l.route}`, l);
      }
      const lines = text.split("\n");
      for (const [i, line] of lines.entries()) {
        const m =
          /Leg (\d+).*?: (UA\d+)(?: \[Mainline\])? \(([A-Z]{3}-[A-Z]{3}).*\) — (\S+) \((\d+) observed departure/.exec(
            line
          );
        if (!m) continue;
        const [, legNo, fn, route, printed, observed] = m;
        if (observed === "0") {
          unseen++;
          expect(printed, `${o}-${d} ${fn}`).toBe(await ownAnswer(fn));
          const header = /\*\*DIRECT\*\* — (\S+) Starlink.*\((\S+)\)$/.exec(lines[i - 1]);
          if (legNo === "1" && header) {
            nonstops++;
            expect([header[1], header[2]], lines[i - 1]).toEqual([printed, printed]);
          }
        } else {
          const leg = byFlight.get(`${fn} ${route}`);
          if (!leg) continue;
          history++;
          expect(printed, `${o}-${d} ${fn}`).toBe(nearest(leg.probability));
        }
      }
    }
    expect(unseen).toBeGreaterThan(10);
    expect(nonstops).toBeGreaterThan(0);
    expect(history).toBeGreaterThan(10);
  });

  test("MCP predict_route_starlink: every listed flight", async () => {
    const reader = createReaderFactory(db)("UA");
    let unseen = 0;
    let history = 0;
    for (const [o, d] of [...PAIRS, ...UNSEEN_ONLY]) {
      const { text } = await mcpTool(app, UA, "predict_route_starlink", {
        origin: o,
        destination: d,
      });
      const odds = new Map<string, number>(
        predictRoute(reader, o, d).flights.map((f) => [f.flight_number, f.probability])
      );
      for (const line of text.split("\n")) {
        const m = /^ {2}(UA\d+)\s.*\([A-Z]{3}-[A-Z]{3}\) {2}\s*(\S+) {2}\((.*)\)$/.exec(line);
        if (!m) continue;
        const [, fn, printed, note] = m;
        if (note === "unobserved — fleet prior") {
          unseen++;
          expect(kindOf.get(fn), fn).toBe("unseen");
          expect(printed, `${o}-${d} ${fn}`).toBe(await ownAnswer(fn));
        } else {
          history++;
          expect(printed, `${o}-${d} ${fn}`).toBe(nearest(odds.get(fn) as number));
        }
      }
    }
    expect(unseen).toBe(PAIRS.length + UNSEEN_ONLY.length);
    expect(history).toBeGreaterThan(PAIRS.length);
  });

  test("the alternatives table: a nonstop that is one unseen flight", async () => {
    const { text } = await mcpTool(app, UA, "predict_flight_starlink", {
      flight_number: NEVER_FITTED,
    });
    const row = /^\| LAX→IAH \| (UA\d+) \| direct \| 0 \| (\S+) \|/m.exec(text);
    expect(row?.[1], text).toBe("UA304");
    expect(row?.[2]).toBe(await ownAnswer("UA304"));
  });

  test("a baseline with no flight history is the fleet's share, rounded down", async () => {
    const [o, d] = NO_SCHEDULE;
    const reader = createReaderFactory(db)("UA");
    const base = routeBaseline(reader, o, d);
    expect(base).toMatchObject({ flight_number: null, probability: 0.367, n_observations: 0 });

    // A mainline flight never seen is answered by that same share.
    const mainline = await ownAnswer("UA201");
    const planned = await mcpTool(app, UA, "plan_starlink_itinerary", {
      origin: o,
      destination: d,
    });
    expect(planned.text).toContain(`(typical nonstop): ~${mainline} Starlink`);
    const listed = await mcpTool(app, UA, "predict_route_starlink", { origin: o, destination: d });
    expect(listed.text).toContain(`| nonstop | direct — baseline | 0 | ~${mainline} |`);

    // The planner page's line for it, drawn from the API's own answer.
    const body = await plan(o, d);
    expect(body.baseline).toMatchObject({ probability: 0.367, n_observations: 0 });
    const out = { innerHTML: "" };
    renderResults(out, body as never, false);
    expect(out.innerHTML).toContain(`~${mainline} Starlink`);
    expect(out.innerHTML).not.toContain("37%");
  });

  test("a baseline carries its flight's observations, and history keeps its odds", async () => {
    const reader = createReaderFactory(db)("UA");
    let unseen = 0;
    let history = 0;
    for (const [o, d] of PAIRS) {
      const base = routeBaseline(reader, o, d);
      const body = await plan(o, d);
      expect(body.baseline?.n_observations).toBe(base?.n_observations as number);
      if (!base?.flight_number) continue;
      const dated = await get(
        `/api/check-flight?flight_number=${base.flight_number}&date=2099-01-01&origin=${o}&destination=${d}`
      );
      expect(base.n_observations, base.flight_number).toBe(dated.prediction.n_observations);
      if (base.n_observations === 0) unseen++;
      else history++;
    }
    expect(unseen + history).toBe(PAIRS.length);

    const line = (probability: number, n_observations?: number) => {
      const out = { innerHTML: "" };
      renderResults(
        out,
        {
          itineraries: [],
          baseline: {
            probability,
            n_observations,
            duration_hours: 4,
            duration_source: "route_history",
            expected_starlink_hours: probability * 4,
          },
        } as never,
        false
      );
      return /Nonstop baseline: ~(\S+) Starlink/.exec(out.innerHTML)?.[1];
    };
    expect(line(0.297, 0)).toBe("29%");
    expect(line(0.297, 6)).toBe("30%");
    // An answer cached before the key existed keeps the form it was drawn in.
    expect(line(0.297)).toBe("30%");
    expect(line(0.004, 0)).toBe("<1%");
  });

  test("the planner page: every leg, and a nonstop's headline", async () => {
    let unseen = 0;
    let nonstops = 0;
    let history = 0;
    for (const [o, d] of TRIPS) {
      const body = await plan(o, d);
      const out = { innerHTML: "" };
      renderResults(out, body as never, false);
      const cards = out.innerHTML.split('<div class="itin-card').slice(1);
      expect(cards.length).toBe(body.itineraries.length);
      for (const [i, it] of body.itineraries.entries()) {
        const legLabels = [...cards[i].matchAll(/tabular-nums" style="color:[^"]*">([^<]+)</g)].map(
          (m) => m[1]
        );
        const headline = /<div class="font-display text-right"[^>]*>(\S+) </.exec(cards[i])?.[1];
        expect(legLabels.length, `${o}-${d} #${i + 1}`).toBe(it.legs.length);
        for (const [j, leg] of it.legs.entries()) {
          if (leg.flight_number === "(any)") {
            expect(legLabels[j]).toBe(shareLabel(leg.probability));
          } else if (leg.n_observations === 0) {
            unseen++;
            expect(legLabels[j], `${o}-${d} ${leg.flight_number}`).toBe(
              await ownAnswer(leg.flight_number)
            );
          } else {
            history++;
            expect(legLabels[j], `${o}-${d} ${leg.flight_number}`).toBe(probLabel(leg.probability));
          }
        }
        if (it.legs.length === 1) {
          const [leg] = it.legs;
          if (leg.n_observations === 0) {
            nonstops++;
            expect(headline, `${o}-${d} ${leg.flight_number}`).toBe(legLabels[0]);
          } else {
            expect(headline).toBe(probLabel(it.joint_probability));
          }
        }
      }
    }
    expect(unseen).toBeGreaterThan(10);
    expect(nonstops).toBeGreaterThan(0);
    expect(history).toBeGreaterThan(10);
  });

  test("the route board: a leg short of history still has departures behind its odds", async () => {
    let thin = 0;
    let full = 0;
    for (const [o, d] of PAIRS) {
      const board: RouteFlightBoard = await get(`/api/route-flights?origin=${o}&destination=${d}`);
      for (const row of board.flights) {
        if (row.probability === null) continue;
        if (row.basis === "flight_history") {
          full++;
          expect(row.odds_label, row.flight_number).toBe(probLabel(row.probability));
          continue;
        }
        thin++;
        // A leg is only priced once a departure on it was logged, so its odds
        // are never the bare estimate of a flight number with no history.
        expect(row.n_observations, row.flight_number).toBeGreaterThan(0);
        expect(row.odds_label, row.flight_number).toBe(
          `~${flightLabel(row.probability, row.n_observations)}`
        );
        const dated = await get(
          `/api/check-flight?flight_number=${row.flight_number}&date=2099-01-01&origin=${o}&destination=${d}`
        );
        expect(dated.prediction.n_observations, row.flight_number).toBe(row.n_observations);
        expect(
          flightLabel(dated.prediction.probability, dated.prediction.n_observations),
          row.flight_number
        ).toBe(row.odds_label.slice(1));
      }
    }
    expect(thin).toBeGreaterThan(0);
    expect(full).toBeGreaterThan(0);
  });
});
