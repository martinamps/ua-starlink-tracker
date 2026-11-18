/**
 * United's ERJ-145s are outside the Starlink programme. They leave every
 * denominator, stay visible on /fleet as "No Starlink planned" (not
 * "retiring"), and the CRJ-200s remain in the count.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { aircraftPagesFor, answerFor } from "../src/airlines/aircraft-pages";
import { fleetTargetSentence } from "../src/airlines/content/fleet-target";
import { content as uaContent } from "../src/airlines/content/ua";
import {
  isOutsideProgramme,
  programmeExclusionLabel,
  programmeExclusionReason,
} from "../src/airlines/registry";
import { TypeBarsSection } from "../src/components/fleet/type-bars";
import {
  getFleetPageData,
  getFleetStats,
  getTotalCount,
  getTypeProgress,
  refreshFleetMeta,
} from "../src/database/database";
import { fleetRoster, programmeRoster } from "../src/database/roster";
import { typeStatus } from "../src/server/community-wire";
import { addFleet, addPlane, makeSyntheticDb } from "./helpers";

const UA_ERJ145 = aircraftPagesFor("UA").find((d) => d.slug === "erj-145");

function seeded() {
  const db = makeSyntheticDb();
  // 3 Starlink E175s, 2 unequipped CRJ-200s, 5 unequipped ERJ-145s, 2 mainline.
  for (let i = 0; i < 3; i++) {
    const tail = `N10${i}SY`;
    addFleet(db, tail, "confirmed", { aircraftType: "E175", verifiedWifi: "Starlink" });
    addPlane(db, tail, "Starlink", { aircraft: "E175" });
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
  addPlane(db, "N14105", "Starlink", { aircraft: "Boeing 737-800" });
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
    expect(programmeExclusionReason("UA")).toBe("not_planned");
    expect(programmeExclusionLabel("UA")).toBe("No Starlink planned");
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

  test("/fleet totals exclude them and the type row says No Starlink planned", () => {
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
    expect(erj?.outsideProgramme?.label).toBe("No Starlink planned");

    const crj = page.families.find((f) => f.family === "CRJ-200");
    expect(crj?.outsideProgramme).toBeUndefined();
    expect(crj?.total).toBe(2);

    const html = renderToStaticMarkup(
      TypeBarsSection({
        families: page.families,
        typeLinks: new Map([["ERJ-145", { family: "ERJ-145", slug: "erj-145", short: "ERJ-145" }]]),
      })
    );
    expect(html).toContain("No Starlink planned");
    expect(html).toContain("3 of 5 · 60%"); // regional total omits the five ERJ-145s
    expect(html).not.toContain("0/5");
    expect(html).toContain("0/2 ·"); // CRJ-200 still reads as pending
    db.close();
  });

  test("getTypeProgress flags the type as not_planned, not retiring", () => {
    const db = seeded();
    const types = getTypeProgress(db, "UA");
    const erj = types.find((t) => t.key === "ERJ-145" || t.label === "ERJ-145");
    expect(erj?.excluded).toBe(true);
    expect(erj?.exclusionReason).toBe("not_planned");
    expect(typeStatus(erj!)).toBe("not_planned");
    expect(types.filter((t) => !t.excluded).reduce((s, t) => s + t.total, 0)).toBe(7);
    db.close();
  });

  test("the type-page verdict is No Starlink planned, not Not yet", () => {
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
        outsideProgramme: { label: "No Starlink planned" },
      },
      UA_ERJ145!,
      null
    );
    expect(a.kind).toBe("not_planned");
    expect(a.headline).toBe("No Starlink planned.");
    expect(a.sentence).toContain("55 ERJ-145s");
    expect(a.sentence).not.toMatch(/[Nn]ot yet/);
    expect(a.indexable).toBe(true);
  });
});

describe("United copy after the ERJ-145 exclusion", () => {
  test("the finish-date sentence no longer says every plane; Alaska still does", () => {
    expect(fleetTargetSentence("UA", "United")).toBe(
      "United plans to finish the rollout by the end of 2027. The ERJ-145s are not part of that plan."
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
