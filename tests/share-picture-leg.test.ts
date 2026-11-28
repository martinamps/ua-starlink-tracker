/**
 * The share picture of a flight page opened on one leg. A number that flies
 * two legs a day can say "Yes" on one and "No" on the other; the page answers
 * for the asked leg, so the picture a chat app pastes beside its link has to
 * answer for that leg too, never for the other one. The plain page keeps the
 * picture address it always had.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setAssignmentFetcher } from "../src/api/flight-verdict";
import { departureLocalDate } from "../src/database/assignment-log";
import { setMeta, updateFlights } from "../src/database/database";
import { createApp } from "../src/server/app";
import { addPlane, makeSyntheticDb, req } from "./helpers";

const UA_HOST = "unitedstarlinktracker.com";
const SITE_CARD = /^\/static\/social-image[\w-]*\.webp(?:\?v=[0-9a-z]+)?$/;

describe("leg-scoped flight page share picture", () => {
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
    // SBA-SFO flies the Starlink plane; SFO-IAH a plane without it.
    addPlane(db, "N22222", "Starlink");
    addPlane(db, "N11111", "Thales");
    updateFlights(db, "N22222", [leg("SBA", "SFO", at("16:00"))]);
    updateFlights(db, "N11111", [leg("SFO", "IAH", at("20:00"))]);
    setMeta(db, "lastUpdated", new Date().toISOString(), "UA");
    app = createApp(db);
  });
  afterAll(() => setAssignmentFetcher(null));

  const get = (path: string) => app.dispatch(req(path, UA_HOST));
  const images = async (path: string) => {
    const html = await (await get(path)).text();
    const og = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1] ?? "";
    const alt = html.match(/<meta property="og:image:alt" content="([^"]+)"/)?.[1] ?? "";
    return { path: new URL(og).pathname, alt };
  };
  const bytes = async (path: string) => {
    const res = await get(path);
    expect(res.status, path).toBe(200);
    expect(res.headers.get("content-type"), path).toContain("image/png");
    return Buffer.from(await res.arrayBuffer());
  };

  test("the plain dated page keeps its picture address", async () => {
    const plain = await images(`/check-flight/UA2305/${date}`);
    expect(plain.path).toBe(`/static/share/flight/UA2305/${date}.png`);
  });

  test("each leg's page shares a picture of that leg's answer", async () => {
    const plain = await images(`/check-flight/UA2305/${date}`);
    const yes = await images(`/check-flight/UA2305/${date}?origin=SBA&destination=SFO`);
    const no = await images(`/check-flight/UA2305/${date}?origin=SFO&destination=IAH`);
    expect(yes.path).toBe(`/static/share/flight/UA2305/${date}/SBA-SFO.png`);
    expect(no.path).toBe(`/static/share/flight/UA2305/${date}/SFO-IAH.png`);
    expect(yes.alt).toStartWith("Yes");
    expect(no.alt).toStartWith("No");

    // The plain page answers for both legs, so it is neither leg's yes or no,
    // and its picture is neither leg's drawing.
    expect(plain.alt).toContain("SBA → SFO (N22222");
    expect(plain.alt).toContain("not on SFO → IAH (N11111)");
    expect(plain.alt).not.toStartWith("Yes");
    const plainPng = await bytes(plain.path);
    expect((await bytes(yes.path)).equals(plainPng)).toBe(false);
    expect((await bytes(no.path)).equals(plainPng)).toBe(false);
  });

  test("an undated leg page shares the leg's undated picture", async () => {
    const page = await images("/check-flight/UA2305?origin=SFO&destination=IAH");
    expect(page.path).toBe("/static/share/flight/UA2305/SFO-IAH.png");
    await bytes(page.path);
    const origin = await images("/check-flight/UA2305?origin=SFO");
    expect(origin.path).toBe("/static/share/flight/UA2305/SFO-.png");
    await bytes(origin.path);
  });

  test("a leg the page would not scope to gets no picture of its own", async () => {
    // The page answers these unscoped, so it shares the plain picture...
    for (const q of ["?origin=SFO&destination=SFO", "?origin=ZZZ", "?origin=<b>"]) {
      expect((await images(`/check-flight/UA2305/${date}${q}`)).path).toBe(
        `/static/share/flight/UA2305/${date}.png`
      );
    }
    // ...and an address no page minted is the site's card, never a drawing.
    for (const path of [
      `/static/share/flight/UA2305/${date}/SFO-SFO.png`,
      `/static/share/flight/UA2305/${date}/QQQ-ZZZ.png`,
      `/static/share/flight/UA2305/${date}/sfo-iah.png`,
      `/static/share/flight/UA2305/${date}/-.png`,
      `/static/share/flight/UA2305/SFO-IAH/${date}.png`,
      `/static/share/flight/UA2305/${date}/SFO-IAH-DEN.png`,
      "/static/share/tail/N22222/SFO-IAH.png",
      "/static/share/airport/SFO/SFO-IAH.png",
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(302);
      expect(res.headers.get("location") ?? "", path).toMatch(SITE_CARD);
    }
  });
});
