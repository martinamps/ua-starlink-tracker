/**
 * A renamed airport (West Palm Beach, PBI → DJT on 18 Aug 2026) is one place
 * on one page: old addresses 301 to the new code's twin with their query kept,
 * the forms answer PBI as DJT, and the sitemap and links name DJT only, even
 * where history still holds rows under PBI.
 */

import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import { AIRPORT_HISTORY_DAYS } from "../src/database/airports";
import { logFlightAssignments } from "../src/database/assignment-log";
import { createApp, parseAirportPath, parseRoutePath } from "../src/server/app";
import {
  currentAirportCode,
  formerAirportCodes,
  isRetiredAirportCode,
  routePlannerPath,
} from "../src/utils/airport-renames";
import { addFlight, addPlane, makeFreshDb, req } from "./helpers";

const UA = SITES.united.canonicalHost;
const HUB = SITES.airline.canonicalHost;
const HOUR = 3600;
const DAY = 86400;
const now = Math.floor(Date.now() / 1000);

let db: Database;
let app: ReturnType<typeof createApp>;

function addFlown(
  tail: string,
  fn: string,
  origin: string,
  destination: string,
  daysAgo: number,
  hoursBack = 3
) {
  const departure_time = now - daysAgo * DAY - hoursBack * HOUR;
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
        arrival_time: departure_time + 3 * HOUR,
      },
    ],
    now
  );
  db.query(
    "INSERT INTO departure_log (tail_number, airport, departed_at, airline) VALUES (?, ?, ?, 'UA')"
  ).run(tail, origin, departure_time);
}

beforeAll(() => {
  db = makeFreshDb();
  for (const tail of ["N1VER", "N2VER", "N3VER"]) addPlane(db, tail, "Starlink");
  addFlight(db, "N1VER", "UA1016", "DJT", now + 3 * HOUR, { arrivalAirport: "EWR" });
  addFlight(db, "N1VER", "UA1017", "EWR", now + 8 * HOUR, { arrivalAirport: "DJT" });
  // The same field's history on both codes, as the live tables hold it.
  for (let d = 0; d < AIRPORT_HISTORY_DAYS - 1; d++) {
    // Enough Starlink departures for DJT's page to index.
    addFlown("N1VER", "UA1016", "DJT", "EWR", d);
    addFlown("N2VER", "UA1020", "DJT", "EWR", d, 5);
    addFlown("N3VER", "UA1022", "DJT", "EWR", d, 7);
    addFlown("N1VER", "UA1018", "PBI", "EWR", d);
    addFlown("N1VER", "UA1017", "EWR", "DJT", d);
  }
  db.query(
    `INSERT INTO flight_routes (flight_number, origin, destination, duration_sec, first_seen_at, last_seen_at, seen_count)
     VALUES ('UA1018', 'PBI', 'EWR', 9000, ?, ?, 5), ('UA1016', 'DJT', 'EWR', 9000, ?, ?, 5)`
  ).run(now - 30 * DAY, now - HOUR, now - 30 * DAY, now - HOUR);
  db.query("INSERT INTO meta (key, value) VALUES ('UA:lastUpdated', ?)").run(
    new Date((now - HOUR) * 1000).toISOString()
  );
  app = createApp(db);
});

const get = (path: string, host = UA) => app.dispatch(req(path, host));

describe("the rename table", () => {
  test("PBI reads as DJT, both ways round, and nothing else moves", () => {
    expect(currentAirportCode("pbi")).toBe("DJT");
    expect(currentAirportCode("DJT")).toBe("DJT");
    expect(currentAirportCode("ord")).toBe("ORD");
    expect(isRetiredAirportCode("PBI")).toBe(true);
    expect(isRetiredAirportCode("DJT")).toBe(false);
    // Basel-Mulhouse has two codes in use at once: no rename.
    expect(isRetiredAirportCode("BSL") || isRetiredAirportCode("MLH")).toBe(false);
    expect(formerAirportCodes("DJT")).toEqual(["PBI"]);
    expect(routePlannerPath("PBI", "EWR")).toBe("/route-planner/DJT/EWR");
  });

  test("the address parsers answer the code now", () => {
    expect(parseAirportPath("/routes/pbi")).toBe("DJT");
    expect(parseRoutePath("/route-planner/PBI/EWR")).toEqual({ origin: "DJT", destination: "EWR" });
    expect(parseRoutePath("/route-planner/ewr/pbi")).toEqual({ origin: "EWR", destination: "DJT" });
    // One place at both ends is no route.
    expect(parseRoutePath("/route-planner/PBI/DJT")).toBeNull();
  });
});

describe("old addresses", () => {
  test("an airport page under PBI 301s to its DJT twin, query kept", async () => {
    for (const [path, to] of [
      ["/routes/PBI", "/routes/DJT"],
      ["/routes/pbi/", "/routes/DJT"],
      ["/routes/PBI?utm_source=x", "/routes/DJT?utm_source=x"],
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(301);
      expect(res.headers.get("location"), path).toBe(`https://${UA}${to}`);
    }
    expect((await get("/routes/DJT")).status).toBe(200);
  });

  test("a route page with PBI at either end 301s to the DJT pair, query kept", async () => {
    for (const [path, to] of [
      ["/route-planner/PBI/EWR", "/route-planner/DJT/EWR"],
      ["/route-planner/ewr/pbi", "/route-planner/EWR/DJT"],
      ["/route-planner/PBI/EWR?date=2026-12-01", "/route-planner/DJT/EWR?date=2026-12-01"],
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(301);
      expect(res.headers.get("location"), path).toBe(`https://${UA}${to}`);
    }
    expect((await get("/route-planner/DJT/EWR")).status).toBe(200);
    expect((await get("/route-planner/PBI/DJT")).status).toBe(404);
  });

  test("a mistyped host lands on the DJT page in one hop", async () => {
    const res = await get("/routes/pbi", "www.unitedstarlinktracker.com");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`https://${UA}/routes/DJT`);
  });
});

describe("the forms", () => {
  test("the plan address answers PBI as DJT", async () => {
    const plan = async (o: string) =>
      (await get(`/api/plan-route?origin=${o}&destination=EWR`)).json() as Promise<{
        itineraries: unknown[];
        message?: string;
      }>;
    const old = await plan("PBI");
    const now_ = await plan("DJT");
    expect(old.message).toBeUndefined();
    expect(old.itineraries).toEqual(now_.itineraries);
  });

  test("the route board answers PBI as DJT", async () => {
    const board = async (o: string) =>
      (await get(`/api/route-flights?origin=${o}&destination=EWR`)).json() as Promise<{
        origin: string;
        destination: string;
      }>;
    expect((await board("PBI")).origin).toBe("DJT");
    expect(await board("PBI")).toEqual(await board("DJT"));
  });

  test("the hub's route compare answers PBI as DJT", async () => {
    const res = await get("/api/compare-route?origin=pbi&destination=EWR", HUB);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { origin: string };
    expect(body.origin).toBe("DJT");
    expect((await get("/api/compare-route?origin=PBI&destination=DJT", HUB)).status).toBe(400);
  });
});

describe("search sees one page", () => {
  test("the sitemap lists DJT's pages and none under PBI", async () => {
    const xml = await (await get("/sitemap.xml")).text();
    expect(xml).not.toContain("PBI");
    expect(xml).toContain("/routes/DJT</loc>");
    expect(xml).toContain("/route-planner/DJT/EWR</loc>");
  });

  test("no page links a PBI address", async () => {
    for (const path of [
      "/routes",
      "/routes/DJT",
      "/route-planner/DJT/EWR",
      "/route-planner/EWR/DJT",
    ]) {
      const html = await (await get(path)).text();
      expect(html, path).not.toMatch(/href="[^"]*\/(routes|route-planner)\/[^"]*PBI/);
    }
  });
});
