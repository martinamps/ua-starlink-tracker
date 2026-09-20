/**
 * The type-page pass (~150ms on prod data) must never run inside a permalink
 * or /fleet request once warm. #115 rebuilt it synchronously in whichever
 * request found the 60s cache expired: /check-flight/{fn} p95 12->269ms.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { aircraftPagesFor } from "../src/airlines/aircraft-pages";
import { SITES } from "../src/airlines/registry";
import {
  aircraftTypePageBuildCount,
  getAircraftTypeGate,
  getAircraftTypePageData,
  getSitemapFlights,
  warmAircraftTypePages,
} from "../src/database/database";
import { createApp } from "../src/server/app";
import { openSnapshot, req } from "./helpers";

const UA = SITES.united.canonicalHost;

let snap: Database;
beforeAll(() => {
  snap = openSnapshot();
});
afterEach(() => setSystemTime());

describe("aircraft type page cache", () => {
  test("a cold-cache permalink render does not run the full type-page pass", async () => {
    const db = openSnapshot();
    const app = createApp(db);
    const [flight] = getSitemapFlights(db, "UA");
    expect(flight).toBeDefined();
    const before = aircraftTypePageBuildCount();
    const res = await app.dispatch(req(`/check-flight/${flight.flight_number}`, UA));
    expect(res.status).toBe(200);
    await res.text();
    expect(aircraftTypePageBuildCount()).toBe(before);
  });

  test("the served gate agrees with the full pass on existence and Starlink count", () => {
    for (const code of ["UA", "AS"]) {
      for (const def of aircraftPagesFor(code)) {
        const gate = getAircraftTypeGate(snap, code, def.slug);
        const full = getAircraftTypePageData(snap, code, def.slug);
        expect(gate === null, `${code} ${def.slug}`).toBe(full === null);
        if (gate && full) {
          expect(gate.starlink).toBe(full.starlink);
          expect(gate.total).toBe(full.total);
        }
      }
    }
  });

  test("an expired pass is served stale and rebuilt once after the request", async () => {
    const db = openSnapshot();
    warmAircraftTypePages(db);
    const [def] = aircraftPagesFor("UA");
    const warm = getAircraftTypePageData(db, "UA", def.slug);
    const before = aircraftTypePageBuildCount();

    setSystemTime(new Date(Date.now() + 61_000));
    expect(getAircraftTypePageData(db, "UA", def.slug)).toBe(warm);
    expect(getAircraftTypePageData(db, "UA", def.slug)).toBe(warm);
    expect(aircraftTypePageBuildCount()).toBe(before);

    await new Promise((r) => setTimeout(r, 0));
    expect(aircraftTypePageBuildCount()).toBe(before + 1);
    const fresh = getAircraftTypePageData(db, "UA", def.slug);
    expect(fresh).not.toBe(warm);
    expect(fresh?.family).toBe(def.family);
  });
});
