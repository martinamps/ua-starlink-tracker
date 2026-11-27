/**
 * The plane swap on a dated flight answer page: built from the assignment log
 * alone, shown only when the aircraft the answer names is not the first one
 * logged on that departure, and never added to the API bodies.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setAssignmentFetcher } from "../src/api/flight-verdict";
import { departureLocalDate } from "../src/database/assignment-log";
import { updateFlights } from "../src/database/database";
import { createApp } from "../src/server/app";
import { addPlane, bodyOf, makeSyntheticDb } from "./helpers";

const UA_HOST = "unitedstarlinktracker.com";
const HA_HOST = "hawaiianstarlinktracker.com";

describe("plane swap on the dated answer page (synthetic)", () => {
  const date = departureLocalDate("SFO", Math.floor(Date.now() / 1000) + 86400);
  const at = (hhmmZ: string) => Math.floor(Date.parse(`${date}T${hhmmZ}:00Z`) / 1000);
  const leg = (flight_number: string, departure_time: number) => ({
    flight_number,
    departure_airport: "SFO",
    arrival_airport: "EWR",
    departure_time,
    arrival_time: departure_time + 5 * 3600,
  });
  const page = `/check-flight/UA123/${date}`;

  beforeAll(() => setAssignmentFetcher(async () => []));
  afterAll(() => setAssignmentFetcher(null));

  /** `first` flies the leg, then `second` replaces it an hour later. */
  function swapped(first: [string, string | null], second: [string, string | null]) {
    const db = makeSyntheticDb();
    addPlane(db, first[0], first[1]);
    addPlane(db, second[0], second[1]);
    updateFlights(db, first[0], [leg("UA123", at("19:00"))]);
    db.query("UPDATE flight_assignment_log SET first_seen = first_seen - 3600").run();
    updateFlights(db, second[0], [leg("UA123", at("19:00"))]);
    updateFlights(db, first[0], []);
    return db;
  }

  test("one tail only: no swap note", async () => {
    const db = makeSyntheticDb();
    addPlane(db, "N11111", "Starlink");
    updateFlights(db, "N11111", [leg("UA123", at("19:00"))]);
    const { text } = await bodyOf(createApp(db), page, UA_HOST);
    expect(text).toContain("N11111");
    expect(text).not.toContain('id="plane-swap"');
  });

  test("Starlink to Thales: both tails, when we saw it, and Starlink lost", async () => {
    const db = swapped(["N11111", "Starlink"], ["N22222", "Thales"]);
    const { text } = await bodyOf(createApp(db), page, UA_HOST);
    expect(text).toContain('id="plane-swap"');
    const note = text.slice(text.indexOf('id="plane-swap"'));
    expect(note).toContain("Plane changed");
    expect(note).toContain("Starlink lost");
    expect(note).toMatch(
      /This departure had N11111 first\. We first saw N22222 on it [A-Z][a-z]{2}, /
    );
    // Departure-airport time, labelled with its zone.
    expect(note).toMatch(/[AP]M P[DS]T\./);
  });

  test("Thales to Starlink: Starlink gained", async () => {
    const db = swapped(["N22222", "Thales"], ["N11111", "Starlink"]);
    const { text } = await bodyOf(createApp(db), page, UA_HOST);
    expect(text).toContain("Starlink gained");
    expect(text).toContain("This departure had N22222 first. We first saw N11111 on it");
  });

  test("Starlink to Starlink: no gained or lost, says both have it", async () => {
    const db = swapped(["N11111", "Starlink"], ["N33333", "Starlink"]);
    const { text } = await bodyOf(createApp(db), page, UA_HOST);
    expect(text).toContain('id="plane-swap"');
    expect(text).toContain("Both N11111 and N33333 have Starlink.");
    expect(text).not.toContain("Starlink gained");
    expect(text).not.toContain("Starlink lost");
  });

  /** Three planes in turn, each logged an hour after the one before. */
  function swappedTwice(...planes: Array<[string, string | null]>) {
    const db = makeSyntheticDb();
    for (const [tail, wifi] of planes) addPlane(db, tail, wifi);
    for (const [i, [tail]] of planes.entries()) {
      updateFlights(db, tail, [leg("UA123", at("19:00"))]);
      if (i > 0) updateFlights(db, planes[i - 1][0], []);
      if (i < planes.length - 1) {
        db.query("UPDATE flight_assignment_log SET first_seen = first_seen - 3600").run();
      }
    }
    return db;
  }

  // The rule: the note names the first plane logged, and the Starlink pill
  // compares the current plane against that first one, never the middle one.
  test("three planes: names the first, then the middle, and compares against the first", async () => {
    const db = swappedTwice(["N11111", "Thales"], ["N22222", "Starlink"], ["N33333", "Starlink"]);
    const { text } = await bodyOf(createApp(db), page, UA_HOST);
    const note = text.slice(text.indexOf('id="plane-swap"'));
    expect(note).toContain(
      "This departure had N11111 first, then N22222. We first saw N33333 on it"
    );
    expect(note).toContain("Starlink gained");
  });

  test("Starlink, then none, then Starlink again: no 'gained', the first plane had it", async () => {
    const db = swappedTwice(["N11111", "Starlink"], ["N22222", "Thales"], ["N33333", "Starlink"]);
    const { text } = await bodyOf(createApp(db), page, UA_HOST);
    const note = text.slice(text.indexOf('id="plane-swap"'));
    expect(note).toContain(
      "This departure had N11111 first, then N22222. We first saw N33333 on it"
    );
    expect(note).toContain("Both N11111 and N33333 have Starlink.");
    expect(note).not.toContain("Starlink gained");
    expect(note).not.toContain("Starlink lost");
  });

  test("swapped back to the first tail: no note, as the calendar feed", async () => {
    const db = swapped(["N11111", "Starlink"], ["N22222", "Thales"]);
    updateFlights(db, "N11111", [leg("UA123", at("19:00"))]);
    updateFlights(db, "N22222", []);
    const { text } = await bodyOf(createApp(db), page, UA_HOST);
    expect(text).not.toContain('id="plane-swap"');
  });

  test("another airline's site shows it too, in its departure airport's time", async () => {
    const hnlDate = departureLocalDate("HNL", Math.floor(Date.now() / 1000) + 86400);
    const dep = Math.floor(Date.parse(`${hnlDate}T22:00:00Z`) / 1000);
    const haLeg = {
      flight_number: "HA50",
      departure_airport: "HNL",
      arrival_airport: "SEA",
      departure_time: dep,
      arrival_time: dep + 6 * 3600,
    };
    const db = makeSyntheticDb();
    addPlane(db, "N380HA", "Starlink", { airline: "HA", aircraft: "Airbus A330-200" });
    addPlane(db, "N381HA", null, { airline: "HA", aircraft: "Airbus A330-200" });
    db.query("UPDATE starlink_planes SET verified_wifi = 'None' WHERE TailNumber = 'N381HA'").run();
    updateFlights(db, "N381HA", [haLeg]);
    db.query("UPDATE flight_assignment_log SET first_seen = first_seen - 3600").run();
    updateFlights(db, "N380HA", [haLeg]);
    updateFlights(db, "N381HA", []);
    const { text, status } = await bodyOf(createApp(db), `/check-flight/HA50/${hnlDate}`, HA_HOST);
    expect(status).toBe(200);
    const note = text.slice(text.indexOf('id="plane-swap"'));
    expect(text).toContain('id="plane-swap"');
    expect(note).toContain("Starlink gained");
    expect(note).toMatch(/This departure had N381HA first\. We first saw N380HA on it .*HST\./);
  });

  test("a flight of two legs: the note names the leg by its airports", async () => {
    const legs = (dep: number) => [
      { ...leg("UA123", dep), arrival_airport: "DEN", arrival_time: dep + 2 * 3600 },
      {
        flight_number: "UA123",
        departure_airport: "DEN",
        arrival_airport: "EWR",
        departure_time: dep + 3 * 3600,
        arrival_time: dep + 7 * 3600,
      },
    ];
    const db = makeSyntheticDb();
    addPlane(db, "N11111", "Starlink");
    addPlane(db, "N22222", "Thales");
    updateFlights(db, "N11111", legs(at("19:00")));
    db.query("UPDATE flight_assignment_log SET first_seen = first_seen - 3600").run();
    updateFlights(db, "N22222", legs(at("19:00")));
    updateFlights(db, "N11111", []);
    const { text } = await bodyOf(createApp(db), page, UA_HOST);
    expect(text).toContain('id="plane-swap"');
    const note = text.slice(text.indexOf('id="plane-swap"'));
    expect(note).toMatch(
      /The San Francisco \(SFO\) to Denver \(DEN\) leg had N11111 first\. We first saw N22222 on it /
    );
    expect(note).not.toContain("This departure had");
  });

  test("one leg: the note keeps 'This departure' and names no airports", async () => {
    const db = swapped(["N11111", "Starlink"], ["N22222", "Thales"]);
    const { text } = await bodyOf(createApp(db), page, UA_HOST);
    const note = text.slice(text.indexOf('id="plane-swap"'), text.indexOf('id="flight-answer"'));
    expect(note).toContain("This departure had N11111 first.");
    expect(note).not.toContain(" leg had ");
    expect(note).not.toContain("(SFO)");
  });

  test("the API bodies carry no swap key", async () => {
    const db = swapped(["N11111", "Starlink"], ["N22222", "Thales"]);
    const app = createApp(db);
    const api = await bodyOf(app, `/api/check-flight?flight_number=UA123&date=${date}`, UA_HOST);
    expect(api.text).not.toMatch(/swap/i);
  });
});
