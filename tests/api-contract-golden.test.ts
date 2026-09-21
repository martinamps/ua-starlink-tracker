/**
 * Byte pins for the public flight-lookup contracts: /api/check-flight,
 * /api/check-any-flight and MCP check_flight, one synthetic flight per verdict
 * branch. Hermetic — fixed clock, synthetic DB, FR24 stubbed, fetch refused —
 * so the bytes never drift with data. A diff here is a contract change: review
 * it, then regenerate with `UPDATE_GOLDEN=1 bun test tests/api-contract-golden.test.ts`.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setAssignmentFetcher } from "../src/api/flight-verdict";
import { Fr24UnavailableError } from "../src/api/flightradar24-api";
import { qatarEquipmentToWifi } from "../src/api/qatar-status";
import { addDaysISO } from "../src/api/qatar-verdict";
import { upsertQatarEquipmentHistory, upsertQatarSchedule } from "../src/database/database";
import { createApp } from "../src/server/app";
import { airportLocalDate } from "../src/utils/airport-tz";
import { addFleet, addFlight, addPlane, makeSyntheticDb, utc } from "./helpers";

const FIXTURE = "tests/golden/api-contracts.json";
const UA = "unitedstarlinktracker.com";
const HUB = "airlinestarlinktracker.com";
const AS = "alaskastarlinktracker.com";
const QR = "qatarstarlinktracker.com";

const NOW = utc("2026-09-19T08:00:00Z");
const TODAY = "2026-09-19";
const D1 = addDaysISO(TODAY, 1);
const FAR = addDaysISO(TODAY, 10);
const PAST = addDaysISO(TODAY, -5);
const at = (date: string, hhmm: string) => utc(`${date}T${hhmm}:00Z`);

type Leg = {
  tail_number: string;
  origin: string;
  destination: string;
  departure_time: number;
  arrival_time: number;
  aircraft_model: string | null;
};
const leg = (tail: string, origin: string, destination: string, dep: number): Leg => ({
  tail_number: tail,
  origin,
  destination,
  departure_time: dep,
  arrival_time: dep + 3 * 3600,
  aircraft_model: "Boeing 737-800",
});

const FR24: Record<string, Leg[] | "down"> = {
  UA1005: [leg("N3001", "IAH", "DEN", at(D1, "14:00"))],
  UA1006: [leg("N3005", "IAH", "ORD", at(D1, "14:00"))],
  UA1007: [leg("N3999", "IAH", "SFO", at(D1, "14:00"))],
  UA1008: "down",
};

function observations(db: Database, fn: string, tails: [string, 0 | 1][]): void {
  const q = db.query(
    `INSERT INTO starlink_verification_log (tail_number, source, checked_at, has_starlink, wifi_provider, flight_number, tail_confirmed, airline)
     VALUES (?, 'united', ?, ?, ?, ?, 1, 'UA')`
  );
  tails.forEach(([tail, yes], i) =>
    q.run(tail, NOW - (i + 1) * 86400, yes, yes ? "Starlink" : "Viasat", fn)
  );
}

function route(db: Database, fn: string, origin: string, destination: string): void {
  db.query(
    `INSERT INTO flight_routes (flight_number, origin, destination, duration_sec, first_seen_at, last_seen_at, seen_count)
     VALUES (?, ?, ?, 10800, ?, ?, 3)`
  ).run(fn, origin, destination, NOW - 86400, NOW);
}

function qrSchedule(
  db: Database,
  fn: string,
  date: string,
  eq: string,
  status = "SCHEDULED"
): void {
  const dep = at(date, "06:40");
  upsertQatarSchedule(db, {
    flight_number: fn,
    scheduled_date: date,
    departure_airport: "DOH",
    arrival_airport: "LHR",
    departure_time: dep,
    arrival_time: dep + 7 * 3600,
    equipment_code: eq,
    wifi_verdict: qatarEquipmentToWifi(eq),
    flight_status: status,
    last_updated: NOW,
  });
}

function qrHistory(db: Database, fn: string, date: string, eq: string): void {
  const dep = at(date, "06:40");
  upsertQatarEquipmentHistory(
    db,
    {
      flight_number: fn,
      departure_airport: "DOH",
      service_date: airportLocalDate("DOH", dep) ?? date,
      arrival_airport: "LHR",
      departure_time: dep,
      arrival_time: dep + 7 * 3600,
      equipment_code: eq,
      flight_status: "ARRIVED",
      fetch_origin: "DOH",
      fetch_destination: "LHR",
      fetch_date: date,
    },
    NOW
  );
}

function seed(): Database {
  const db = makeSyntheticDb();
  // Scheduled yes, verified and spreadsheet-only.
  addPlane(db, "N3001", "Starlink");
  addFlight(db, "N3001", "UA1001", "SFO", at(D1, "15:00"), { arrivalAirport: "EWR" });
  addPlane(db, "N3002", null);
  addFlight(db, "N3002", "UA1002", "SFO", at(D1, "16:00"), { arrivalAirport: "DEN" });
  // Firm no, with a same-day Starlink alternative on the pair.
  addPlane(db, "N3003", "Viasat");
  addFleet(db, "N3003", "negative", { verifiedWifi: "Viasat" });
  addFlight(db, "N3003", "UA1003", "ORD", at(D1, "18:00"), { arrivalAirport: "DEN" });
  addPlane(db, "N3004", "Starlink");
  addFlight(db, "N3004", "UA1004", "ORD", at(D1, "20:00"), { arrivalAirport: "DEN" });
  // FR24 no: a settled-negative roster tail.
  addFleet(db, "N3005", "negative", { verifiedWifi: "Thales" });
  // Informed prediction.
  observations(db, "UA1009", [
    ["N3101", 1],
    ["N3102", 1],
    ["N3103", 1],
    ["N3104", 0],
    ["N3105", 1],
  ]);
  for (const fn of ["UA1007", "UA1008", "UA1010"]) route(db, fn, "IAH", "SFO");
  // AS: a scheduled yes on the hub + AS host.
  addPlane(db, "N601AS", "Starlink", { airline: "AS" });
  addFlight(db, "N601AS", "AS100", "SEA", at(D1, "18:00"), {
    arrivalAirport: "LAX",
    airline: "AS",
  });
  // QR: published yes / no / rolling / cancelled, history beyond the window, and no data.
  qrSchedule(db, "QR1", D1, "77W");
  qrSchedule(db, "QR3", D1, "388");
  qrSchedule(db, "QR5", D1, "788");
  qrSchedule(db, "QR9", D1, "789");
  qrSchedule(db, "QR11", D1, "77W", "CANCELLED");
  for (let i = 1; i <= 20; i++) qrHistory(db, "QR7", addDaysISO(TODAY, -i), "77W");
  return db;
}

interface Case {
  name: string;
  host: string;
  path: string;
  method?: string;
}

const api = (host: string, path: string, fn: string, date: string, extra = ""): Case => ({
  name: `${host} ${path} ${fn} ${date}${extra}`,
  host,
  path: `${path}?flight_number=${fn}&date=${date}${extra}`,
});

const UA_FLIGHTS: [string, string][] = [
  ["UA1001", D1], // scheduled verified
  ["UA1002", D1], // scheduled likely
  ["UA1003", D1], // scheduled_no + alternatives
  ["UA1005", D1], // fr24 yes
  ["UA1006", D1], // fr24 no
  ["UA1007", D1], // fr24 unknown tail → prediction
  ["UA1008", D1], // fr24 outage → degraded prediction
  ["UA1009", FAR], // informed prediction
  ["UA1010", FAR], // cold prediction
  ["UA1010", PAST], // past date
];

const CASES: Case[] = [
  ...UA_FLIGHTS.map(([fn, d]) => api(UA, "/api/check-flight", fn, d)),
  api(UA, "/api/check-flight", "UA1003", D1, "&origin=ORD"),
  api(UA, "/api/check-flight", "UA1001", D1, "&origin=XX"),
  api(UA, "/api/check-flight", "UA1001", "2026-13-40"),
  api(UA, "/api/check-flight", "UA12345", D1),
  api(UA, "/api/check-flight", "DL100", D1),
  api(UA, "/api/check-flight", "AS100", D1),
  { name: "UA missing params", host: UA, path: "/api/check-flight?flight_number=UA1" },
  { ...api(UA, "/api/check-flight", "UA1001", D1), name: "UA POST", method: "POST" },
  { ...api(UA, "/api/check-flight", "UA1001", D1), name: "UA OPTIONS", method: "OPTIONS" },
  ...(
    [
      ["UA1001", D1],
      ["UA1003", D1],
      ["UA1009", FAR],
      ["UA1010", FAR],
      ["AS100", D1],
      ["AS200", FAR],
      ["HA100", FAR],
      ["QR1", D1],
    ] as [string, string][]
  ).map(([fn, d]) => api(HUB, "/api/check-flight", fn, d)),
  ...(
    [
      ["UA1001", D1],
      ["UA1002", D1],
      ["UA1003", D1],
      ["UA1009", FAR],
      ["UA1010", FAR],
      ["AS100", D1],
      ["AS200", FAR],
      ["QR1", D1],
      ["QR3", D1],
      ["QR5", D1],
      ["QR9", D1],
      ["QR11", D1],
      ["QR7", addDaysISO(TODAY, 20)],
      ["QR8888", D1],
      ["QR8888", addDaysISO(TODAY, 20)],
      ["HA100", FAR],
      ["DL100", D1],
      ["UA12345", D1],
    ] as [string, string][]
  ).map(([fn, d]) => api(HUB, "/api/check-any-flight", fn, d)),
  api(HUB, "/api/check-any-flight", "UA1001", "bad"),
  { name: "HUB any missing params", host: HUB, path: "/api/check-any-flight?date=2026-09-20" },
  api(UA, "/api/check-any-flight", "UA1001", D1),
  ...(
    [
      ["AS100", D1],
      ["AS200", D1],
      ["AS200", FAR],
    ] as [string, string][]
  ).map(([fn, d]) => api(AS, "/api/check-flight", fn, d)),
  ...(
    [
      ["QR1", D1],
      ["QR3", D1],
      ["QR5", D1],
      ["QR9", D1],
      ["QR11", D1],
      ["QR7", addDaysISO(TODAY, 20)],
      ["QR8888", D1],
    ] as [string, string][]
  ).map(([fn, d]) => api(QR, "/api/check-flight", fn, d)),
];

const MCP_CASES: { host: string; args: Record<string, string> }[] = [
  ...UA_FLIGHTS.map(([fn, d]) => ({ host: UA, args: { flight_number: fn, date: d } })),
  { host: UA, args: { flight_number: "UA1003", date: D1, origin: "ORD" } },
  { host: UA, args: { flight_number: "UA12345", date: D1 } },
  { host: UA, args: { flight_number: "DL100", date: D1 } },
  { host: UA, args: { flight_number: "UA1001", date: "nope" } },
  { host: UA, args: { flight_number: "UA1001" } },
  ...(
    [
      ["UA1001", D1],
      ["UA1003", D1],
      ["UA1010", D1],
      ["AS100", D1],
      ["AS200", FAR],
      ["QR1", D1],
      ["QR5", D1],
      ["QR9", D1],
      ["QR11", D1],
      ["QR7", addDaysISO(TODAY, 20)],
      ["QR8888", D1],
      ["HA100", FAR],
      ["DL100", D1],
      ["OO4000", D1],
    ] as [string, string][]
  ).map(([fn, d]) => ({ host: HUB, args: { flight_number: fn, date: d } })),
];

const PINNED_HEADERS = [
  "content-type",
  "cache-control",
  "access-control-allow-origin",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "vary",
];

interface Pinned {
  status: number;
  headers: Record<string, string>;
  body: string;
}

async function capture(app: ReturnType<typeof createApp>): Promise<Record<string, Pinned>> {
  const out: Record<string, Pinned> = {};
  const send = async (name: string, req: Request) => {
    const r = await app.dispatch(req);
    const headers: Record<string, string> = {};
    for (const h of PINNED_HEADERS) {
      const v = r.headers.get(h);
      if (v !== null) headers[h] = v;
    }
    out[name] = { status: r.status, headers, body: await r.text() };
  };
  for (const c of CASES) {
    await send(
      c.name,
      new Request(`http://x${c.path}`, {
        method: c.method ?? "GET",
        headers: { Host: c.host, "cf-connecting-ip": "127.0.0.1" },
      })
    );
  }
  for (const c of MCP_CASES) {
    await send(
      `${c.host} mcp check_flight ${JSON.stringify(c.args)}`,
      new Request("http://x/mcp", {
        method: "POST",
        headers: {
          Host: c.host,
          "Content-Type": "application/json",
          "cf-connecting-ip": "127.0.0.1",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "check_flight", arguments: c.args },
        }),
      })
    );
  }
  return out;
}

let live: Record<string, Pinned>;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  setSystemTime(new Date(NOW * 1000));
  globalThis.fetch = (() =>
    Promise.reject(new Error("network disabled in contract goldens"))) as unknown as typeof fetch;
  setAssignmentFetcher(async (fn) => {
    const legs = FR24[fn];
    if (legs === "down") throw new Fr24UnavailableError("FR24 down");
    return (legs ?? []).map((l) => ({ ...l, flight_number: fn })) as never;
  });
  live = await capture(createApp(seed()));
  if (process.env.UPDATE_GOLDEN || !existsSync(FIXTURE)) {
    writeFileSync(FIXTURE, `${JSON.stringify(live, null, 2)}\n`);
  }
});

afterAll(() => {
  setAssignmentFetcher(null);
  globalThis.fetch = realFetch;
  setSystemTime();
});

describe("public flight-lookup contracts", () => {
  test("every case matches the pinned status, headers and body bytes", () => {
    const pinned = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, Pinned>;
    expect(Object.keys(live).sort()).toEqual(Object.keys(pinned).sort());
    for (const name of Object.keys(pinned)) expect(live[name], name).toEqual(pinned[name]);
  });

  test("the fixture exercises every verdict branch", () => {
    const bodies = Object.values(live).map((p) => p.body);
    for (const marker of [
      '"confidence":"verified"',
      '"confidence":"likely"',
      '"method":"fr24_tail_lookup"',
      '"confidence":"predicted"',
      '"sameDayAlternatives"',
      '"basis":"history"',
      '"confidence":"no_data"',
      '"confidence":"rolling"',
      "not tracked",
    ]) {
      expect(
        bodies.some((b) => b.includes(marker)),
        marker
      ).toBe(true);
    }
  });
});
