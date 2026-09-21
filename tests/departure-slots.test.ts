/**
 * One physical departure = (flight key, departure airport, departure time),
 * newest refreshed row wins, THEN the equipped test. Every departure count and
 * departure list reads through getDepartureSlots, so these synthetic cases pin
 * the rule once for /routes, route pages, the airports panel, type pages, the
 * /fleet pulse, MCP search_starlink_flights and the permalink upcoming list.
 */

import { describe, expect, test } from "bun:test";
import { slotFlightKey } from "../src/airlines/flight-number";
import {
  getAircraftTypePageData,
  getAirportDepartures,
  getDepartureSlots,
  getFleetPageData,
  getRouteDepartures,
  getRouteStarlinkSchedule,
  getRouteSummary,
} from "../src/database/database";
import { createApp } from "../src/server/app";
import { addFleet, addFlight, addPlane, makeSyntheticDb, postMcp, req } from "./helpers";

const UA_HOST = "unitedstarlinktracker.com";
const AS_HOST = "alaskastarlinktracker.com";
const NOW = Math.floor(Date.now() / 1000);
const T = NOW + 6 * 3600;

function equippedTail(db: ReturnType<typeof makeSyntheticDb>, tail: string, airline = "UA") {
  addPlane(db, tail, "Starlink", { airline, aircraft: "ERJ-175" });
  addFleet(db, tail, "confirmed", { airline, aircraftType: "ERJ-175", verifiedWifi: "Starlink" });
}

describe("slot flight key", () => {
  const spellings = [
    "UA1377",
    "UAL1377",
    "SKW3440",
    "OO3440",
    "G74561",
    "GJS4561",
    "UA0100",
    "HA0011",
    "HAL11",
    "ASA832",
    "AS832",
    "QXE2304",
    "SKW302M",
    "KL1234",
    "UA",
  ];

  test("spellings of one departure collapse; callsigns and unknown codes stay themselves", () => {
    expect(slotFlightKey("UAL1377")).toBe(slotFlightKey("UA1377"));
    expect(slotFlightKey("SKW3440")).toBe(slotFlightKey("OO3440"));
    expect(slotFlightKey("GJS4561")).toBe(slotFlightKey("G74561"));
    expect(slotFlightKey("G74561")).not.toBe(slotFlightKey("UA74561"));
    expect(slotFlightKey("UA0100")).toBe(slotFlightKey("UA100"));
    expect(slotFlightKey("ASA832")).toBe(slotFlightKey("AS832"));
    expect(slotFlightKey("SKW302M")).toBe("SKW302M");
    expect(slotFlightKey(null)).toBeNull();
  });

  test("the SQL key agrees with the TS key for every spelling", () => {
    const db = makeSyntheticDb();
    spellings.forEach((fn, i) => {
      addFlight(db, "N1", fn, "DEN", T + i * 60);
    });
    spellings.forEach((fn, i) => {
      addFlight(db, "N2", fn, "SEA", T + i * 60, { airline: "AS" });
    });
    const rows = getDepartureSlots(db, undefined, { from: NOW, to: T + 86400 });
    expect(rows.length).toBe(spellings.length * 2);
    for (const r of rows) expect(r.slot_flight).toBe(slotFlightKey(r.flight_number, r.airline));
    db.close();
  });

  test("an operator code collapses to the row's airline, a carrier's own code to that carrier", () => {
    expect(slotFlightKey("OO3448", "AS")).toBe("AS3448");
    expect(slotFlightKey("SKW3448", "AS")).toBe("AS3448");
    expect(slotFlightKey("OO3448", "UA")).toBe("UA3448");
    expect(slotFlightKey("AS864", "HA")).toBe("AS864");
    expect(slotFlightKey("ASA864", "HA")).toBe("AS864");
    expect(slotFlightKey("HAL11", "HA")).toBe("HA11");
  });
});

describe("one tail, one airport, one time is one departure", () => {
  test("a registration echo under a second number collapses onto the regional-range number", () => {
    const db = makeSyntheticDb();
    equippedTail(db, "N741YX");
    addFlight(db, "N741YX", "RPA3453", "IAD", T, { arrivalAirport: "YYZ" });
    addFlight(db, "N741YX", "RPA741", "IAD", T, { arrivalAirport: "YYZ" });
    addFlight(db, "N741YX", "RPA3466", "YYZ", T + 7200, { arrivalAirport: "IAD" });
    const slots = getDepartureSlots(db, "UA", { from: NOW, to: T + 86400 });
    expect(slots.map((s) => s.slot_flight)).toEqual(["UA3453", "UA3466"]);
    expect(getRouteStarlinkSchedule(db, "UA", NOW).totalDepartures).toBe(2);
    db.close();
  });

  test("a tail listed under two airlines joins only its own airline's listing", () => {
    const db = makeSyntheticDb();
    equippedTail(db, "N100SY");
    addPlane(db, "N100SY", "Starlink", { airline: "AS", aircraft: "ERJ-175" });
    addFlight(db, "N100SY", "SKW5236", "GDL", T, { arrivalAirport: "IAH" });
    const slots = getDepartureSlots(db, "UA", { from: NOW, to: T + 86400 });
    expect(slots).toHaveLength(1);
    expect(getRouteStarlinkSchedule(db, "UA", NOW).totalDepartures).toBe(1);
    expect(getAirportDepartures(db, "UA", NOW).rows).toEqual([{ airport: "GDL", count: 1 }]);
    db.close();
  });
});

describe("route page departures", () => {
  test("list marketed numbers only: operator codes map, callsigns drop", () => {
    const db = makeSyntheticDb();
    equippedTail(db, "N195SY", "AS");
    equippedTail(db, "N117SY");
    addFlight(db, "N195SY", "SKW3015", "ACV", T, { arrivalAirport: "SEA", airline: "AS" });
    addFlight(db, "N195SY", "OO3015", "ACV", T + 86400, { arrivalAirport: "SEA", airline: "AS" });
    addFlight(db, "N117SY", "SKW312R", "DEN", T, { arrivalAirport: "FAR" });
    addFlight(db, "N117SY", "OO4688", "DEN", T + 3600, { arrivalAirport: "FAR" });
    expect(getRouteDepartures(db, "AS", "ACV", "SEA", NOW).map((d) => d.flight_number)).toEqual([
      "AS3015",
      "AS3015",
    ]);
    expect(getRouteDepartures(db, "UA", "DEN", "FAR", NOW).map((d) => d.flight_number)).toEqual([
      "UA4688",
    ]);
    db.close();
  });

  test("every flight link on a SkyWest-for-Alaska route page resolves", async () => {
    const db = makeSyntheticDb();
    equippedTail(db, "N195SY", "AS");
    addFlight(db, "N195SY", "SKW3015", "ACV", T, { arrivalAirport: "SEA", airline: "AS" });
    addFlight(db, "N195SY", "OO3016", "ACV", T + 86400, { arrivalAirport: "SEA", airline: "AS" });
    const app = createApp(db);
    const html = await (await app.dispatch(req("/route-planner/ACV/SEA", AS_HOST))).text();
    const links = [
      ...new Set([...html.matchAll(/href="\/check-flight\/([^"]+)"/g)].map((m) => m[1])),
    ];
    expect(links.sort()).toEqual(["AS3015", "AS3016"]);
    for (const fn of links) {
      const res = await app.dispatch(
        req(`/check-flight/${fn}`, AS_HOST, { headers: { "x-forwarded-for": "127.0.0.1" } })
      );
      expect(res.status, fn).toBe(200);
    }
    expect(html).not.toMatch(/(SKW|OO)30\d\d/);
    db.close();
  });
});

describe("a tail swap onto a non-Starlink tail removes the departure", () => {
  function swapped() {
    const db = makeSyntheticDb();
    equippedTail(db, "N716EV");
    addPlane(db, "N786SK", "None", { aircraft: "CRJ-550" });
    addFleet(db, "N786SK", "negative", { verifiedWifi: "None" });
    addFlight(db, "N716EV", "SKW5763", "LNK", T, {
      arrivalAirport: "DEN",
      lastUpdated: NOW - 3 * 3600,
    });
    addFlight(db, "N786SK", "SKW5763", "LNK", T, {
      arrivalAirport: "DEN",
      lastUpdated: NOW - 3600,
    });
    // A second, untouched departure on the same pair.
    addFlight(db, "N716EV", "OO5764", "LNK", T + 7200, { arrivalAirport: "DEN" });
    return db;
  }

  test("counts: route page, /routes, airports panel", () => {
    const db = swapped();
    const route = getRouteSummary(db, "LNK", "DEN", "UA", NOW);
    expect(route.equippedDepartures).toBe(1);
    expect(route.totalDepartures).toBe(2);
    const sched = getRouteStarlinkSchedule(db, "UA", NOW);
    expect(sched.totalDepartures).toBe(1);
    expect(sched.rows[0]).toMatchObject({ origin: "LNK", destination: "DEN", departures: 1 });
    expect(getAirportDepartures(db, "UA", NOW).rows).toEqual([{ airport: "LNK", count: 1 }]);
    db.close();
  });

  test("MCP search lists the departure once, only while its current tail is Starlink", async () => {
    const app = createApp(swapped());
    const res = await postMcp(app, UA_HOST, "tools/call", {
      name: "search_starlink_flights",
      arguments: { origin: "LNK", destination: "DEN" },
    });
    const text: string = res.result.content[0].text;
    expect(text).toMatch(/^Found 1 confirmed Starlink flight /);
    expect(text).not.toContain("UA5763");
  });

  test("the permalink lists the current assignment only, with the verdict's wifi answer", async () => {
    const app = createApp(swapped());
    const html = (await (await app.dispatch(req("/check-flight/UA5763", UA_HOST))).text()).replace(
      /<!-- -->/g,
      ""
    );
    const block = html.slice(html.indexOf("Next UA5763 departures"));
    expect(block).toContain("N786SK");
    expect(block).not.toContain("N716EV");
    expect(block).toContain("No Wi-Fi");
    expect(block).toMatch(
      /· [A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}[^<]*\d{1,2}:\d{2}\s[AP]M [A-Z]{2,5}</
    );
  });
});

describe("one departure under several spellings counts once", () => {
  test("IATA + ICAO and two operator codes collapse; the flight-number count follows", () => {
    const db = makeSyntheticDb();
    equippedTail(db, "N100SY");
    equippedTail(db, "N101SY");
    addFlight(db, "N100SY", "UAL1377", "DEN", T, { arrivalAirport: "ORD" });
    addFlight(db, "N100SY", "UA1377", "DEN", T, { arrivalAirport: "ORD" });
    addFlight(db, "N101SY", "SKW3440", "SFO", T, { arrivalAirport: "SNA" });
    addFlight(db, "N101SY", "OO3440", "SFO", T, { arrivalAirport: "SNA" });
    addFlight(db, "N101SY", "OO3440", "SFO", T + 86400, { arrivalAirport: "SNA" });
    const sched = getRouteStarlinkSchedule(db, "UA", NOW);
    const row = (o: string) => sched.rows.find((r) => r.origin === o);
    expect(row("DEN")).toMatchObject({ departures: 1, flight_numbers: 1 });
    expect(row("SFO")).toMatchObject({ departures: 2, flight_numbers: 1 });
    expect(sched.totalDepartures).toBe(3);
    db.close();
  });

  test("type pages credit a swapped departure to one tail, once", () => {
    const db = makeSyntheticDb();
    for (const t of ["N100SY", "N101SY", "N102SY", "N103SY", "N104SY"]) equippedTail(db, t);
    addFlight(db, "N100SY", "SKW5236", "GDL", T, {
      arrivalAirport: "IAH",
      lastUpdated: NOW - 7200,
    });
    addFlight(db, "N101SY", "OO5236", "GDL", T, { arrivalAirport: "IAH", lastUpdated: NOW - 3600 });
    const page = getAircraftTypePageData(db, "UA", "e175");
    expect(page).not.toBeNull();
    const leg = page?.routes.find((r) => r.origin === "GDL" && r.destination === "IAH");
    expect(leg?.departures).toBe(1);
    expect(page?.routeTotals.departures).toBe(1);
    db.close();
  });

  test("the /fleet pulse counts a swapped departure's airborne hours once", () => {
    const db = makeSyntheticDb();
    equippedTail(db, "N100SY");
    equippedTail(db, "N101SY");
    const dep = NOW - 3600;
    addFlight(db, "N100SY", "SKW5236", "GDL", dep, {
      arrivalAirport: "IAH",
      lastUpdated: NOW - 7200,
    });
    addFlight(db, "N101SY", "OO5236", "GDL", dep, {
      arrivalAirport: "IAH",
      lastUpdated: NOW - 3600,
    });
    const pulse = getFleetPageData(db, "UA").pulse;
    expect(pulse.peak).toBe(1);
    expect(pulse.totalHours).toBe(3);
    db.close();
  });
});

describe("operating partners on route surfaces", () => {
  test("AS-marketed departures on Hawaiian metal count on Alaska's routes, HA numbers don't", () => {
    const db = makeSyntheticDb();
    equippedTail(db, "N373HA", "HA");
    addFlight(db, "N373HA", "AS832", "HND", T, { arrivalAirport: "HNL", airline: "HA" });
    addFlight(db, "N373HA", "ASA864", "HND", T + 3600, { arrivalAirport: "HNL", airline: "HA" });
    addFlight(db, "N373HA", "HA11", "HNL", T + 86400, { arrivalAirport: "SFO", airline: "HA" });
    const route = getRouteSummary(db, "HND", "HNL", "AS", NOW);
    expect(route.equippedDepartures).toBe(2);
    const sched = getRouteStarlinkSchedule(db, ["AS"], NOW);
    expect(sched.totalDepartures).toBe(2);
    expect(sched.rows.some((r) => r.origin === "HNL")).toBe(false);
    // Hawaiian's own scope is unchanged: every HA row is its own.
    expect(getRouteStarlinkSchedule(db, ["HA"], NOW).totalDepartures).toBe(3);
    db.close();
  });

  test("the route page lists the same partner slots /routes counts", async () => {
    const db = makeSyntheticDb();
    equippedTail(db, "N373HA", "HA");
    addFlight(db, "N373HA", "AS832", "HND", T, { arrivalAirport: "HNL", airline: "HA" });
    addFlight(db, "N373HA", "ASA864", "HND", T + 3600, { arrivalAirport: "HNL", airline: "HA" });
    const res = await createApp(db).dispatch(req("/route-planner/HND/HNL", AS_HOST));
    expect(res.status).toBe(200);
    const html = (await res.text()).replace(/<!-- -->/g, "");
    const rows = html.match(/N373HA/g) ?? [];
    expect(rows.length).toBeGreaterThanOrEqual(
      getRouteSummary(db, "HND", "HNL", "AS", NOW).equippedDepartures
    );
    db.close();
  });

  test("partner rows join an Alaska flight's slots; type-rule tails read as Starlink", async () => {
    const db = makeSyntheticDb();
    equippedTail(db, "N388HA", "HA");
    // Type-rule tail: listed, never verified (verified_wifi NULL), still equipped.
    addPlane(db, "N644QX", null, { airline: "AS", aircraft: "Embraer E175LR" });
    addFlight(db, "N388HA", "AS850", "KIX", T, { arrivalAirport: "HNL", airline: "HA" });
    addFlight(db, "N644QX", "QXE2092", "PDX", T, { arrivalAirport: "SEA", airline: "AS" });
    const partner = getDepartureSlots(db, ["AS"], {
      from: NOW,
      to: T + 3600,
      partners: true,
      flightNumbers: ["AS850", "ASA850"],
    });
    expect(partner.map((r) => [r.tail_number, r.equipped])).toEqual([["N388HA", 1]]);
    expect(
      getDepartureSlots(db, ["AS"], { from: NOW, to: T + 3600, flightNumbers: ["AS850"] })
    ).toEqual([]);

    const app = createApp(db);
    const html = (await (await app.dispatch(req("/check-flight/AS2092", AS_HOST))).text()).replace(
      /<!-- -->/g,
      ""
    );
    const block = html.slice(html.indexOf("Next AS2092 departures"));
    expect(block).toContain("N644QX");
    expect(block).toMatch(/text-success">Starlink</);
    expect(block).not.toContain("Install pending");
    db.close();
  });
});
