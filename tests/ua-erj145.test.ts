/**
 * United's ERJ-145s are outside the Starlink programme. They leave every
 * denominator, stay visible on /fleet as "Not in the programme" (not
 * "retiring"), and the CRJ-200s remain in the count.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { aircraftPagesFor, answerFor } from "../src/airlines/aircraft-pages";
import { fleetTargetSentence } from "../src/airlines/content/fleet-target";
import { content as uaContent } from "../src/airlines/content/ua";
import {
  isOutsideProgramme,
  programmeExclusionCaveat,
  programmeExclusionLabel,
  programmeExclusionReason,
} from "../src/airlines/registry";
import { SITES } from "../src/airlines/registry";
import { TypeBarsSection } from "../src/components/fleet/type-bars";
import {
  getFleetPageData,
  getFleetStats,
  getMeta,
  getTotalCount,
  getTypeProgress,
  refreshFleetMeta,
  refreshSheetOwnedFleetMeta,
  setMeta,
} from "../src/database/database";
import { fleetRoster, programmeRoster } from "../src/database/roster";
import { runSheetScrape } from "../src/scripts/sheet-scrape";
import { createApp } from "../src/server/app";
import { typeStatus } from "../src/server/community-wire";
import type { fetchAllSheets } from "../src/utils/utils";
import { addFleet, addPlane, bodyOf, jsonOf, makeSyntheticDb, mcpTool } from "./helpers";

const UA_ERJ145 = aircraftPagesFor("UA").find((d) => d.slug === "erj-145");

/** `listed: false` leaves starlink_planes empty, for a test where the scrape
 * itself writes the listings. */
function seeded({ listed = true } = {}) {
  const db = makeSyntheticDb();
  // 3 Starlink E175s, 2 unequipped CRJ-200s, 5 unequipped ERJ-145s, 2 mainline.
  for (let i = 0; i < 3; i++) {
    const tail = `N10${i}SY`;
    addFleet(db, tail, "confirmed", { aircraftType: "E175", verifiedWifi: "Starlink" });
    if (listed) addPlane(db, tail, "Starlink", { aircraft: "E175" });
  }
  for (let i = 0; i < 2; i++) {
    addFleet(db, `N20${i}SW`, "negative", { aircraftType: "CRJ-200", verifiedWifi: "None" });
  }
  for (let i = 0; i < 5; i++) {
    addFleet(db, `N30${i}AE`, "negative", { aircraftType: "ERJ-145", verifiedWifi: "None" });
  }
  addFleet(db, "N14105", "confirmed", {
    aircraftType: "Boeing 737-800",
    verifiedWifi: "Starlink",
  });
  if (listed) addPlane(db, "N14105", "Starlink", { aircraft: "Boeing 737-800" });
  addFleet(db, "N21306", "unknown", { aircraftType: "Boeing 737-900", verifiedWifi: null });
  db.query(
    "UPDATE united_fleet SET fleet = 'express' WHERE aircraft_type IN ('E175', 'CRJ-200', 'ERJ-145')"
  ).run();
  db.query(
    "UPDATE united_fleet SET fleet = 'mainline' WHERE aircraft_type LIKE 'Boeing 737%'"
  ).run();
  return db;
}

describe("United ERJ-145 programme exclusion", () => {
  test("the type is outside the programme; the CRJ-200 is not", () => {
    expect(isOutsideProgramme("UA", "ERJ-145")).toBe(true);
    expect(isOutsideProgramme("UA", "CRJ-200")).toBe(false);
    expect(isOutsideProgramme("UA", "E175")).toBe(false);
    expect(programmeExclusionReason("UA")).toBe("not_in_programme");
    expect(programmeExclusionLabel("UA")).toBe("Not in the programme");
  });

  test("Air France exclusions are unchanged", () => {
    expect(isOutsideProgramme("AF", "A330")).toBe(true);
    expect(isOutsideProgramme("AF", "A318")).toBe(true);
    expect(isOutsideProgramme("AF", "A350")).toBe(false);
    expect(programmeExclusionReason("AF")).toBe("retiring");
    expect(programmeExclusionLabel("AF")).toBe("Retiring");
  });

  test("the denominator drops the ERJ-145s and keeps the CRJ-200s", () => {
    const db = seeded();
    expect(fleetRoster(db, "UA").length).toBe(12);
    const roster = programmeRoster(db, "UA");
    expect(roster).toHaveLength(7);
    expect(roster.some((t) => t.family === "ERJ-145")).toBe(false);
    expect(roster.filter((t) => t.family === "CRJ-200")).toHaveLength(2);
    expect(roster.filter((t) => t.equipped).length).toBe(4);

    refreshFleetMeta(db, "UA");
    expect(getTotalCount(db, "UA")).toBe(7);
    const stats = getFleetStats(db, "UA");
    expect(stats.express.total).toBe(5); // 3 E175 + 2 CRJ-200
    expect(stats.mainline.total).toBe(2);
    db.close();
  });

  test("/fleet totals exclude them and the type row says Not in the programme", () => {
    const db = seeded();
    const page = getFleetPageData(db, ["UA"]);
    expect(page.totalFleet).toBe(7);
    expect(page.totalStarlink).toBe(4);
    expect(page.allTails).toHaveLength(7);
    expect(page.allTails.some((t) => t.family === "ERJ-145")).toBe(false);
    expect(page.families.reduce((s, f) => s + f.starlink, 0)).toBe(page.totalStarlink);

    const erj = page.families.find((f) => f.family === "ERJ-145");
    expect(erj).toBeDefined();
    expect(erj?.total).toBe(5);
    expect(erj?.starlink).toBe(0);
    expect(erj?.outsideProgramme?.label).toBe("Not in the programme");

    const crj = page.families.find((f) => f.family === "CRJ-200");
    expect(crj?.outsideProgramme).toBeUndefined();
    expect(crj?.total).toBe(2);

    const html = renderToStaticMarkup(
      TypeBarsSection({
        families: page.families,
        typeLinks: new Map([["ERJ-145", { family: "ERJ-145", slug: "erj-145", short: "ERJ-145" }]]),
      })
    );
    expect(html).toContain("Not in the programme");
    // The words are wider than the figure column: they must be free to wrap in it.
    const words = html.match(/<span class="([^"]*)">Not in the programme<\/span>/)?.[1];
    expect(words).toBeDefined();
    expect(words).not.toContain("whitespace-nowrap");
    expect(html).toContain("3 of 5 · 60%"); // regional total omits the five ERJ-145s
    expect(html).not.toContain("0/5");
    expect(html).toContain("0/2 ·"); // CRJ-200 still reads as pending
    db.close();
  });

  test("getTypeProgress flags the type as not_in_programme, not retiring", () => {
    const db = seeded();
    const types = getTypeProgress(db, "UA");
    const erj = types.find((t) => t.key === "ERJ-145" || t.label === "ERJ-145");
    expect(erj?.excluded).toBe(true);
    expect(erj?.exclusionReason).toBe("not_in_programme");
    expect(typeStatus(erj!)).toBe("not_in_programme");
    expect(types.filter((t) => !t.excluded).reduce((s, t) => s + t.total, 0)).toBe(7);
    db.close();
  });

  test("the type-page verdict is attributed and not in the rollout, not Not yet", () => {
    expect(UA_ERJ145).toBeDefined();
    const a = answerFor(
      {
        airline: "UA",
        family: "ERJ-145",
        total: 55,
        starlink: 0,
        equipped: 0,
        providers: {
          starlink: 0,
          starlink_listed: 0,
          viasat: 0,
          panasonic: 0,
          thales: 0,
          none: 55,
          unknown: 0,
        },
        checked: 55,
        knownOther: 55,
        unchecked: 0,
        tails: [],
        starlinkTails: [],
        variants: null,
        listedAwaitingVerification: [],
        firstSeen: null,
        recentInstalls: [],
        pipeline: null,
        routes: [],
        routeTotals: { departures: 0, pairs: 0 },
        flightNumbers: [],
        flightNumbersScope: "all",
        dataClock: 0,
        outsideProgramme: { label: "Not in the programme" },
      },
      UA_ERJ145!,
      null
    );
    expect(a.kind).toBe("not_in_programme");
    expect(a.headline).toBe("Not in the Starlink rollout.");
    expect(a.sentence).toContain("55 ERJ-145s");
    // Press reports, not United's own word: the sentence must not state intent.
    expect(a.sentence).toContain("reports say");
    expect(a.sentence).not.toMatch(/is not putting|will never|has ruled out/);
    expect(a.sentence).not.toMatch(/[Nn]ot yet/);
    expect(a.indexable).toBe(true);
  });
});

describe("United copy after the ERJ-145 exclusion", () => {
  test("the finish-date sentence no longer says every plane; Alaska still does", () => {
    expect(fleetTargetSentence("UA", "United")).toBe(
      "United plans to finish the rollout by the end of 2027. The ERJ-145s are not expected to be part of it."
    );
    expect(fleetTargetSentence("AS", "Alaska")).toBe(
      "Alaska plans to equip every plane by the end of 2027."
    );
  });

  test("the homepage intro and 2027 FAQ mention the ERJ-145s", () => {
    const intro = renderToStaticMarkup(uaContent.intro({} as never));
    expect(intro).toContain("ERJ-145");
    expect(intro).not.toContain("every plane");

    const faq = uaContent.faq
      .flatMap((s) => s.items)
      .find((i) => i.q === "When will all United flights have Starlink?");
    expect(faq).toBeDefined();
    const html = renderToStaticMarkup(
      faq!.a({ starlinkCount: 707, totalCount: 1632, asOf: null } as never)
    );
    expect(html).toContain("ERJ-145");
    expect(html).not.toContain("every United and United Express aircraft");
  });
});

/**
 * The sheet scrape is the hourly writer of United's published total. It counts
 * the sheet's rows (ERJ-145s and other carriers' aircraft included), so this
 * runs the scrape itself, with only the network fetch stubbed, and then reads
 * every surface that prints the fleet size.
 */
/**
 * United's own line is "the whole fleet by the end of 2027". Wherever that
 * line, or a count that leaves the ERJ-145s out, is printed, the sentence
 * that squares the two is printed with it.
 */
describe("United's whole-fleet line never sits beside the exclusion unexplained", () => {
  const UA = SITES.united.canonicalHost;
  const text = (html: string) =>
    html
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&#x27;/g, "'")
      .replace(/\s+/g, " ");

  test("the caveat is attributed, names the type, and exists only for a reported exclusion", () => {
    const ua = programmeExclusionCaveat("UA");
    expect(ua?.text).toContain("ERJ-145s");
    expect(ua?.text).toMatch(/Reports say/);
    expect(ua?.text).toMatch(/no United statement/);
    expect(ua?.short).toContain("ERJ-145s");
    expect(ua?.report?.url).toMatch(/^https:\/\//);
    // Retiring types contradict nothing Air France said.
    expect(programmeExclusionCaveat("AF")).toBeNull();
    expect(programmeExclusionCaveat("AS")).toBeNull();
  });

  test("/fleet/erj-145, /timeline and /install-rate carry it next to the whole-fleet line", async () => {
    const db = seeded();
    refreshFleetMeta(db, "UA");
    const app = createApp(db);
    const caveat = programmeExclusionCaveat("UA");

    const erj = text((await bodyOf(app, "/fleet/erj-145", UA)).text);
    expect(erj).toContain("Not in the Starlink rollout.");
    expect(erj).toContain("the whole fleet by the end of 2027");
    expect(erj).toContain(caveat?.text ?? "missing");

    const timeline = text((await bodyOf(app, "/timeline", UA)).text);
    expect(timeline).toContain("The whole fleet, mainline and United Express.");
    expect(timeline).toContain(caveat?.text ?? "missing");

    const rate = text((await bodyOf(app, "/install-rate", UA)).text);
    expect(rate).toContain("Entire fleet equipped");
    expect(rate).toContain(caveat?.short ?? "missing");
    db.close();
  });

  test("the home count says what it counts and that the ERJ-145s are out of it", async () => {
    const db = seeded();
    refreshFleetMeta(db, "UA");
    const home = text((await bodyOf(createApp(db), "/", UA)).text);
    expect(home).toMatch(/[\d,]+ of [\d,]+ United aircraft in the rollout/);
    expect(home).toContain("so the count leaves them out");
    expect(home).not.toMatch(/-plane fleet/);
    db.close();
  });
});

describe("one United total on every surface after the scrape's write", () => {
  const UA = SITES.united.canonicalHost;
  const SHEET_TOTAL = 1818;
  const sheetFetch = (async () => ({
    totalAircraftCount: SHEET_TOTAL,
    starlinkAircraft: [
      ...[0, 1, 2].map((i) => ({
        TailNumber: `N10${i}SY`,
        Aircraft: "E175",
        WiFi: "Starlink",
        fleet: "express" as const,
      })),
      { TailNumber: "N14105", Aircraft: "Boeing 737-800", WiFi: "Starlink", fleet: "mainline" },
    ],
    fleetStats: {
      express: { total: 674, starlink: 3, unverified: 0, percentage: 0.45 },
      mainline: { total: 1144, starlink: 1, unverified: 0, percentage: 0.09 },
    },
  })) as unknown as typeof fetchAllSheets;

  const visibleText = (html: string) =>
    html
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");

  test("home, badge, fleet-summary, get_fleet_stats and /fleet all say 4 of 7", async () => {
    const db = seeded({ listed: false });
    const result = await runSheetScrape(db, sheetFetch);
    expect(result.outcome).toBe("success");
    // The scrape reports what the sheet said; what it publishes is the roster.
    expect(result.total).toBe(SHEET_TOTAL);
    expect(getTotalCount(db, "UA")).toBe(7);

    const app = createApp(db);
    const home = visibleText((await bodyOf(app, "/", UA)).text);
    const badge = visibleText((await bodyOf(app, "/badge.svg", UA)).text);
    const fleet = visibleText((await bodyOf(app, "/fleet", UA)).text);
    const mcp = (await mcpTool(app, UA, "get_fleet_stats", {})).text;
    const summary = (await jsonOf(app, "/api/fleet-summary", UA)) as {
      airlines: Array<{
        code: string;
        installed: number;
        total: number;
        families: Array<{ family: string; total: number; excluded?: boolean; label?: string }>;
      }>;
    };
    const ua = summary.airlines.find((a) => a.code === "UA");

    expect(home).toContain("4 of 7 United aircraft");
    expect(badge).toContain("4 of 7 aircraft");
    expect(fleet).toContain("4 of 7 aircraft");
    expect(mcp).toContain("4 of 7 aircraft");
    expect(ua?.installed).toBe(4);
    expect(ua?.total).toBe(7);

    // Neither the sheet's tally nor the full roster (12, ERJ-145s in) leaks.
    for (const surface of [home, badge, fleet, mcp]) {
      expect(surface).not.toContain("1,818");
      expect(surface).not.toMatch(/\bof 12\b/);
    }

    // The excluded type is still listed, flagged, and outside the sum.
    const erj = ua?.families.find((f) => f.family === "ERJ-145");
    expect(erj).toMatchObject({ total: 5, excluded: true, label: "Not in the programme" });
    const inProgramme = ua?.families.filter((f) => !f.excluded) ?? [];
    expect(inProgramme.reduce((s, f) => s + f.total, 0)).toBe(ua?.total);
    expect(mcp).toContain("ERJ-145: Not in the programme (5)");
    db.close();
  });

  test("a restart moves the cached total without waiting on the sheet", async () => {
    // The state a deploy of the exclusion meets: meta still holds the total
    // the last scrape wrote under the old programme.
    const db = seeded();
    setMeta(db, "totalAircraftCount", 12, "UA");
    setMeta(db, "lastUpdated", "2026-01-01T00:00:00.000Z", "UA");

    refreshSheetOwnedFleetMeta(db);

    expect(getTotalCount(db, "UA")).toBe(7);
    expect(getFleetPageData(db, ["UA"]).totalFleet).toBe(7);
    // A restart is not fresh data: the scrape's stamp stays where it was.
    expect(getMeta(db, "lastUpdated", "UA")).toBe("2026-01-01T00:00:00.000Z");
    db.close();
  });

  test("the boot refresh leaves fleet-meta-owned airlines alone", () => {
    const db = seeded();
    addFleet(db, "N380HA", "confirmed", { airline: "HA", aircraftType: "Airbus A330-243" });
    setMeta(db, "totalAircraftCount", 99, "HA");
    refreshSheetOwnedFleetMeta(db);
    expect(getTotalCount(db, "HA")).toBe(99);
    db.close();
  });
});
