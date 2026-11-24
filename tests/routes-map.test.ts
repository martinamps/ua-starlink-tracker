/**
 * The /routes network map: every equipped route in the live window, drawn
 * from the same rows the page's tables count, on a coastline served once from
 * /static. Seeded on a fresh database so each count is one the test wrote.
 */

import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import { buildRouteNetwork } from "../src/components/routes-map/network";
import { getRouteNetworkRows } from "../src/database/database";
import { createApp } from "../src/server/app";
import { MAP_HEIGHT, MAP_WIDTH, onMap, projectToMap } from "../src/utils/map-projection";
import { addFlight, addPlane, bodyOf, makeFreshDb, sectionOf } from "./helpers";

const UA = SITES.united.canonicalHost;
const HOUR = 3600;
const now = Math.floor(Date.now() / 1000);

let db: Database;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  db = makeFreshDb();
  addPlane(db, "N1VER", "Starlink");
  addPlane(db, "N2VER", "Starlink");
  addFlight(db, "N1VER", "UA1", "DEN", now + HOUR, { arrivalAirport: "ORD" });
  addFlight(db, "N1VER", "UA2", "ORD", now + 4 * HOUR, { arrivalAirport: "DEN" });
  addFlight(db, "N2VER", "UA3", "SFO", now + 2 * HOUR, { arrivalAirport: "HNL" });
  addFlight(db, "N2VER", "UA4", "SFO", now + 6 * HOUR, { arrivalAirport: "EWR" });
  // Not a Starlink plane: never on the map.
  addFlight(db, "N9NONE", "UA9", "IAH", now + HOUR, { arrivalAirport: "MCO" });
  app = createApp(db);
});

describe("projection", () => {
  test("the frame holds the mainland hubs and leaves Hawaii and Guam off", () => {
    for (const [lat, lon] of [
      [41.98, -87.9], // ORD
      [37.62, -122.38], // SFO
      [29.98, -95.34], // IAH
      [40.69, -74.17], // EWR
      [4.7, -74.15], // BOG
    ])
      expect(onMap(projectToMap(lat, lon))).toBe(true);
    expect(onMap(projectToMap(21.32, -157.92))).toBe(false);
    expect(onMap(projectToMap(13.48, 144.8))).toBe(false);
    expect(MAP_HEIGHT).toBeGreaterThan(0);
    expect(MAP_HEIGHT).toBeLessThan(MAP_WIDTH);
  });
});

describe("buildRouteNetwork", () => {
  test("one arc per pair, both directions summed; off-map ends listed, not drawn", () => {
    const net = buildRouteNetwork(getRouteNetworkRows(db, "UA", now).rows);
    expect(net.totalDepartures).toBe(4);
    expect(net.drawnDepartures).toBe(3);
    expect(net.arcs.map((a) => [a.key, a.departures])).toEqual([
      ["EWR-SFO", 1],
      ["DEN-ORD", 2],
    ]);
    expect(net.offMap).toEqual([{ code: "HNL", flights: 1, departs: false }]);
    // SFO's dot counts its departure to Hawaii too.
    expect(net.airports.find((a) => a.code === "SFO")?.departures).toBe(2);
    expect(net.airports.find((a) => a.code === "EWR")?.departures).toBe(0);
    expect(net.airports.some((a) => a.code === "IAH")).toBe(false);
    for (const a of net.arcs) expect(a.d).toMatch(/^M-?\d+ -?\d+Q-?\d+ -?\d+ -?\d+ -?\d+$/);
  });

  test("an airport with no coordinates is neither drawn nor listed", () => {
    const net = buildRouteNetwork([
      { origin: "ORD", destination: "ZZZ", departures: 3, flight_numbers: 1, next_departure: now },
    ]);
    expect(net.arcs).toEqual([]);
    expect(net.offMap).toEqual([]);
    expect(net.totalDepartures).toBe(3);
    expect(net.drawnDepartures).toBe(0);
  });
});

describe("/routes", () => {
  test("draws the map, links departing airports, and lists what lies beyond", async () => {
    const { status, text } = await bodyOf(app, "/routes", UA);
    expect(status).toBe(200);
    const map = sectionOf(text, "The Starlink network");
    expect(map).toContain("2 routes between 4 airports");
    expect(map).toContain('href="/routes/DEN"');
    expect(map).toContain('href="/routes/SFO"');
    // EWR has arrivals only here, so no page to link.
    expect(map).not.toContain('href="/routes/EWR"');
    expect(map).toContain("75% of 4 departures are on this map");
    expect(map).toContain("HNL");
    expect(map).not.toContain("<script");
  });

  test("airport links reach screen readers and have phone-sized tap targets", async () => {
    const { text } = await bodyOf(app, "/routes", UA);
    const map = sectionOf(text, "The Starlink network");
    // role="img" would hide every link inside the picture.
    expect(map).not.toContain('role="img"');
    expect(map).toMatch(/<a href="\/routes\/SFO" aria-label="SFO: 2 Starlink departures"/);
    // Busiest first: focus order follows the labels.
    expect(map.indexOf('href="/routes/SFO"')).toBeLessThan(map.indexOf('href="/routes/ORD"'));
    // The tap circle on phones: 41 map units is 12 px on a 300 px wide map.
    const sfo = map.slice(map.indexOf('href="/routes/SFO"'));
    const phoneR = Number(sfo.match(/r="([\d.]+)"[^>]*class="sm:hidden"/)?.[1]);
    expect(phoneR).toBeGreaterThanOrEqual(27);
    expect(phoneR).toBeLessThanOrEqual(41);
    // Every linked airport is also one tap away in the phone list.
    const list = map.slice(map.indexOf("<details"), map.indexOf("</details>"));
    expect(list).toContain("All 3 airports on the map");
    for (const code of ["DEN", "ORD", "SFO"]) expect(list).toContain(`href="/routes/${code}"`);
    expect(list).not.toContain('href="/routes/EWR"');
  });

  test("the coastline is a year-cached SVG under /static", async () => {
    const { text } = await bodyOf(app, "/routes", UA);
    const href = text.match(/\/static\/routes-map\.[a-z0-9]+\.svg/)?.[0];
    expect(href).toBeDefined();
    const r = await app.dispatch(new Request(`http://x${href}`, { headers: { Host: UA } }));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("image/svg+xml");
    expect(r.headers.get("cache-control")).toContain("immutable");
    expect(await r.text()).toStartWith("<svg");
  });
});
