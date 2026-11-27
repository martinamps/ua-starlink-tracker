/**
 * A flight page scoped to one leg (?origin=&destination=), as the route
 * planner links it: a number that flies two legs a day opens on the asked leg
 * — its answer, its title, its next departure — and still canonicalizes to
 * the bare flight, so the scope never makes a second indexable page.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setAssignmentFetcher } from "../src/api/flight-verdict";
import { departureLocalDate } from "../src/database/assignment-log";
import { updateFlights } from "../src/database/database";
import { createApp } from "../src/server/app";
import { addPlane, bodyOf, makeSyntheticDb } from "./helpers";

const UA_HOST = "unitedstarlinktracker.com";

describe("leg-scoped flight page (synthetic)", () => {
  // Tomorrow at SBA, far enough ahead that both legs are still to come.
  const date = departureLocalDate("SBA", Math.floor(Date.now() / 1000) + 86400);
  const at = (hhmmZ: string) => Math.floor(Date.parse(`${date}T${hhmmZ}:00Z`) / 1000);
  const leg = (from: string, to: string, departure_time: number) => ({
    flight_number: "UA2305",
    departure_airport: from,
    arrival_airport: to,
    departure_time,
    arrival_time: departure_time + 2 * 3600,
  });
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    setAssignmentFetcher(async () => []);
    const db = makeSyntheticDb();
    // The morning SBA-SFO leg on a plane without Starlink, then SFO-IAH on one with it.
    addPlane(db, "N22222", "Thales");
    addPlane(db, "N11111", "Starlink");
    updateFlights(db, "N22222", [leg("SBA", "SFO", at("16:00"))]);
    updateFlights(db, "N11111", [leg("SFO", "IAH", at("20:00"))]);
    app = createApp(db);
  });
  afterAll(() => setAssignmentFetcher(null));

  const page = (path: string) => bodyOf(app, path, UA_HOST);
  const title = (html: string) => html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
  const canonical = (html: string) => html.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
  const answer = (html: string) => {
    const start = html.indexOf('id="flight-answer"');
    return start < 0 ? "" : html.slice(start, html.indexOf("</section>", start));
  };

  test("the dated page answers for the asked leg", async () => {
    const { status, text } = await page(`/check-flight/UA2305/${date}?origin=SFO&destination=IAH`);
    expect(status).toBe(200);
    expect(title(text)).toContain("(SFO → IAH)");
    const card = answer(text);
    expect(card).toContain("N11111");
    expect(card).not.toContain("N22222");
    expect(canonical(text)).toBe(`https://${UA_HOST}/check-flight/UA2305`);
    // The browser re-check asks the API for the same leg.
    expect(text).toMatch(/"leg":\{"origin":"SFO","destination":"IAH"\}/);
  });

  test("the other leg answers for itself", async () => {
    const { text } = await page(`/check-flight/UA2305/${date}?origin=SBA&destination=SFO`);
    expect(title(text)).toContain("(SBA → SFO)");
    const card = answer(text);
    expect(card).toContain("N22222");
    expect(card).not.toContain("N11111");
  });

  test("the undated page opens on the asked leg's next departure", async () => {
    const plain = await page("/check-flight/UA2305");
    const scoped = await page("/check-flight/UA2305?origin=SFO&destination=IAH");
    expect(scoped.status).toBe(200);
    expect(plain.text).toMatch(/from SBA to SFO on [^<]* is assigned N22222/);
    expect(scoped.text).toMatch(/from SFO to IAH on [^<]* is assigned N11111/);
    expect(canonical(scoped.text)).toBe(`https://${UA_HOST}/check-flight/UA2305`);
  });

  test("a leg that doesn't parse renders the unscoped page", async () => {
    const plain = await page(`/check-flight/UA2305/${date}`);
    for (const q of ["?origin=XXQ&destination=IAH", "?origin=SFO&destination=SFO"]) {
      const { status, text } = await page(`/check-flight/UA2305/${date}${q}`);
      expect(status).toBe(200);
      expect(title(text)).toBe(title(plain.text));
      expect(text).not.toContain('"leg":{');
    }
  });

  test("a spelling redirect keeps the leg", async () => {
    const r = await app.dispatch(
      new Request(`http://x/check-flight/ua2305/${date}?origin=SFO&destination=IAH`, {
        headers: { Host: UA_HOST },
      })
    );
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe(
      `https://${UA_HOST}/check-flight/UA2305/${date}?origin=SFO&destination=IAH`
    );
  });
});
