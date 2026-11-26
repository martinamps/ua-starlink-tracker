/**
 * Three things a visitor is owed: who runs the site (every page, per site),
 * one fleet total wherever a total is given, and a plain account of the check
 * the United site runs from a Starlink visitor's browser.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AIRLINES, SITES, liveAirlineSites } from "../src/airlines/registry";
import { independenceLine } from "../src/components/layout";
import MethodologyPage, { hasMethodology } from "../src/components/methodology-page";
import { getFleetDiscoveryStats, getTotalCount, refreshFleetMeta } from "../src/database/database";
import { fleetRoster, programmeRoster } from "../src/database/roster";
import { createApp } from "../src/server/app";
import { PROBE_SNIPPET, handlePassengerProbe } from "../src/server/passenger-detect";
import {
  ONBOARD_CHECK_NOTICE,
  ONBOARD_CHECK_OUTCOMES,
  ONBOARD_PORTAL_HOST,
  PASSENGER_REPORT_COLUMNS,
} from "../src/server/passenger-report-fields";
import { PROBE_CONNECT_ORIGINS } from "../src/utils/constants";
import { addFleet, addPlane, bodyOf, jsonOf, makeSyntheticDb, openSnapshot } from "./helpers";

const plain = (html: string) =>
  html
    .replace(/<!--.*?-->/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

describe("who runs the site", () => {
  const sites = Object.values(SITES);
  const airlineNames = Object.values(AIRLINES).map((a) => a.name);

  test.each(sites.map((s) => [s.key, s] as const))(
    "%s: the line names its own airline and no other",
    (_key, site) => {
      const line = independenceLine(site);
      expect(line).toContain("Independent");
      // One person runs the site: it is for a community, not run by one.
      expect(line).toContain("community-oriented");
      expect(line).not.toContain("community-run");
      expect(line).toContain("Not affiliated with");
      expect(line).toContain("SpaceX");
      const named = airlineNames.filter((n) => line.includes(n));
      expect(named).toEqual(site.scope === "ALL" ? [] : [AIRLINES[site.scope].name]);
    }
  );

  test("every live site carries it once on the home page and on a sub-page", async () => {
    const app = createApp(openSnapshot());
    const live = [SITES.airline, ...liveAirlineSites().map((s) => s.site)];
    for (const site of live) {
      for (const path of ["/", "/fleet"]) {
        const { status, text } = await bodyOf(app, path, site.canonicalHost);
        if (status !== 200) continue;
        expect([site.key, path, text.split("data-independence").length - 1]).toEqual([
          site.key,
          path,
          1,
        ]);
        expect(plain(text)).toContain(independenceLine(site));
      }
    }
  });

  test("llms.txt tells an assistant the same, and never that a community runs the site", async () => {
    const app = createApp(openSnapshot());
    for (const site of sites.filter((s) => s.live)) {
      const { status, text } = await bodyOf(app, "/llms.txt", site.canonicalHost);
      expect(status).toBe(200);
      expect(text).not.toMatch(/community-(run|maintained),/);
      expect(text).toContain("independent, community-oriented and open source");
    }
  });

  test("a page that does not exist carries it too", async () => {
    const app = createApp(openSnapshot());
    const { status, text } = await bodyOf(app, "/no-such-page", SITES.united.canonicalHost);
    expect(status).toBe(404);
    expect(plain(text)).toContain(independenceLine(SITES.united));
  });
});

describe("/api/fleet-discovery gives the pages' total", () => {
  function seeded() {
    const db = makeSyntheticDb();
    for (let i = 0; i < 3; i++) {
      addFleet(db, `N10${i}SY`, "confirmed", { aircraftType: "E175", verifiedWifi: "Starlink" });
      addPlane(db, `N10${i}SY`, "Starlink", { aircraft: "E175" });
    }
    for (let i = 0; i < 2; i++) {
      addFleet(db, `N20${i}SW`, "negative", { aircraftType: "CRJ-200", verifiedWifi: "None" });
    }
    for (let i = 0; i < 4; i++) {
      addFleet(db, `N30${i}AE`, i < 3 ? "negative" : "unknown", {
        aircraftType: "ERJ-145",
        verifiedWifi: i < 3 ? "None" : null,
      });
    }
    addFleet(db, "N21306", "unknown", { aircraftType: "Boeing 737-900", verifiedWifi: null });
    refreshFleetMeta(db, "UA");
    return db;
  }

  test("the total is the programme roster, and the tails outside it are counted apart", async () => {
    const db = seeded();
    const programme = programmeRoster(db, "UA").length;
    const outside = fleetRoster(db, "UA").length - programme;
    expect(outside).toBeGreaterThan(0);

    const stats = getFleetDiscoveryStats(db, "UA");
    expect(stats.total_fleet).toBe(programme);
    expect(stats.total_fleet).toBe(getTotalCount(db, "UA"));
    expect(stats.outside_programme).toBe(outside);
    expect(stats.verified_starlink + stats.verified_non_starlink + stats.pending_verification).toBe(
      stats.total_fleet
    );

    const app = createApp(db);
    const host = SITES.united.canonicalHost;
    const api = (await jsonOf(app, "/api/fleet-discovery", host)) as {
      verification: Record<string, number>;
    };
    const summary = (await jsonOf(app, "/api/fleet-summary", host)) as {
      airlines: Array<{ code: string; total: number }>;
    };
    expect(api.verification.total_fleet).toBe(programme);
    expect(api.verification.outside_programme).toBe(outside);
    expect(api.verification.total_fleet).toBe(summary.airlines.find((a) => a.code === "UA")?.total);
  });

  test("on the snapshot the two totals agree for United", async () => {
    const db = openSnapshot();
    expect(getFleetDiscoveryStats(db, "UA").total_fleet).toBe(programmeRoster(db, "UA").length);
  });
});

describe("the onboard check is told to visitors", () => {
  const render = (site: (typeof SITES)[keyof typeof SITES], onboardCheck: boolean) =>
    plain(
      renderToStaticMarkup(
        MethodologyPage({ site, lastUpdated: "2026-11-01T00:00:00.000Z", onboardCheck })
      )
    );

  test("United's methodology page says what is checked, when, and what is kept", async () => {
    const app = createApp(openSnapshot());
    const { status, text } = await bodyOf(app, "/methodology", SITES.united.canonicalHost);
    expect(status).toBe(200);
    expect(text).toContain('id="onboard-check"');
    const page = plain(text);
    for (const sentence of Object.values(ONBOARD_CHECK_NOTICE)) expect(page).toContain(sentence);
  });

  test("a site that runs no check says nothing of one", async () => {
    const app = createApp(openSnapshot());
    for (const { site } of liveAirlineSites()) {
      if (site.scope === "UA" || !hasMethodology(site.scope)) continue;
      const { text } = await bodyOf(app, "/methodology", site.canonicalHost);
      expect(text).not.toContain("onboard-check");
      expect(plain(text)).not.toContain(ONBOARD_PORTAL_HOST);
    }
    expect(render(SITES.united, false)).not.toContain(ONBOARD_PORTAL_HOST);
  });

  test("the sentences describe the script that runs", () => {
    expect(PROBE_CONNECT_ORIGINS).toEqual([`https://${ONBOARD_PORTAL_HOST}`]);
    expect(PROBE_SNIPPET).toContain(`https://${ONBOARD_PORTAL_HOST}/`);
    // "no cookies and no sign-in, and reads nothing back"
    expect(PROBE_SNIPPET).toContain('credentials:"omit"');
    expect(PROBE_SNIPPET).toContain('mode:"no-cors"');
    // "no answer within four seconds"
    expect(PROBE_SNIPPET).toContain("},4000)");
    const sent = [...PROBE_SNIPPET.matchAll(/outcome:"([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(sent).toEqual(Object.keys(ONBOARD_CHECK_OUTCOMES).sort());
    for (const words of Object.values(ONBOARD_CHECK_OUTCOMES)) {
      expect(ONBOARD_CHECK_NOTICE.what).toContain(words);
    }
    // Nothing else leaves the browser: one field besides the fixed source.
    expect(PROBE_SNIPPET).not.toMatch(/claimed_|navigator\.userAgent|document\.cookie/);
  });

  test("a check's row holds what the page names and nothing else", () => {
    const db = makeSyntheticDb();
    const ip = "74.244.242.9";
    expect(
      handlePassengerProbe(db, ip, true, { source: "probe", outcome: "onboard_reachable" })
    ).toBe("stored");
    const row = db.query("SELECT * FROM passenger_reports").get() as Record<string, unknown>;

    expect(row.source).toBe("probe");
    expect(row.outcome).toBe("onboard_reachable");
    expect(row.in_geofeed).toBe(1);
    expect(typeof row.reported_at).toBe("number");
    expect(row.ip_prefix).toMatch(/^h:[0-9a-f]{32}$/);
    expect(row.airborne_match).toBe(0);
    for (const col of [
      "ip",
      "claimed_flight",
      "claimed_tail",
      "claimed_date",
      "router_id",
      "ua_hash",
    ]) {
      expect([col, row[col] ?? ""]).toEqual([col, ""]);
    }
    expect(JSON.stringify(row)).not.toContain("74.244");

    for (const col of ["reported_at", "in_geofeed", "ip_prefix"]) {
      const use = PASSENGER_REPORT_COLUMNS[col];
      expect(use.kind).toBe("disclosed");
      if (use.kind === "disclosed") expect(ONBOARD_CHECK_NOTICE.kept).toContain(use.says);
    }
    expect(ONBOARD_CHECK_NOTICE.kept).toContain("erase it within a day");
  });
});
