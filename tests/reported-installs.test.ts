/**
 * Reported installs: tails the community sheet lists as Starlink while our own
 * check still reads another provider. They are shown on the United log and in
 * its feed, marked and apart, and must never reach a count or the confirmed
 * list. Seeded rosters only: the snapshot's mismatches drift.
 */

import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import {
  REPORTED_MAX_AGE_DAYS,
  getRecentInstalls,
  getReportedInstalls,
  getWifiMismatches,
  logVerification,
} from "../src/database/database";
import { createApp } from "../src/server/app";
import { bodyOf, jsonOf, makeSyntheticDb, utc } from "./helpers";

const UA = SITES.united.canonicalHost;
const HUB = SITES.airline.canonicalHost;

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

function seed(
  db: Database,
  tail: string,
  o: { wifi?: string; verified: string | null; found: string; gid?: string; airline?: string }
) {
  db.query(
    `INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber, OperatedBy, fleet, verified_wifi, verified_at, airline)
     VALUES ('Boeing 737 MAX 9', ?, ?, '', ?, ?, 'United Airlines', 'mainline', ?, ?, ?)`
  ).run(
    o.wifi ?? "Starlink",
    o.gid ?? "4",
    o.found,
    tail,
    o.verified,
    o.verified === null ? null : utc(`${o.found}T12:00:00Z`),
    o.airline ?? "UA"
  );
}

let db: Database;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  db = makeSyntheticDb();
  seed(db, "N10001", { verified: "Starlink", found: daysAgo(4) });
  seed(db, "N10002", { verified: null, found: daysAgo(3) });
  seed(db, "N20001", { verified: "Viasat", found: daysAgo(2) });
  seed(db, "N20002", { verified: "Thales", found: daysAgo(1) });
  // Not reported: a regional None flap (a Starlink read on record, then
  // "None"), a contradicted listing past the age cap, a bulk
  // seed row, and a sheet row that never said Starlink.
  seed(db, "N30001", { verified: "None", found: daysAgo(2) });
  logVerification(db, {
    tail_number: "N30001",
    source: "united",
    checked_at: utc(`${daysAgo(9)}T12:00:00Z`),
    has_starlink: true,
    wifi_provider: "Starlink",
    aircraft_type: "Embraer E175",
    flight_number: "UA5000",
    error: null,
    tail_confirmed: 1,
    airline: "UA",
  });
  seed(db, "N30002", { verified: "Viasat", found: daysAgo(REPORTED_MAX_AGE_DAYS + 5) });
  seed(db, "N30003", { verified: "Viasat", found: daysAgo(2), gid: "ua_seed" });
  seed(db, "N30004", { wifi: "Viasat", verified: "Viasat", found: daysAgo(2) });
  // Ours, not the sheet's: a discovery row whose later check read another
  // provider, still in the table because the purge waits on a good scrape.
  seed(db, "N30005", { verified: "Viasat", found: daysAgo(1), gid: "discovery" });
  app = createApp(db);
});

describe("getReportedInstalls", () => {
  test("returns the sheet-yes, check-says-other rows, newest first", () => {
    const rows = getReportedInstalls(db, "UA");
    expect(rows.map((r) => r.TailNumber)).toEqual(["N20002", "N20001"]);
    expect(rows[0]).toMatchObject({ airline: "UA", observed_wifi: "Thales" });
    expect(typeof rows[0].observed_at).toBe("number");
  });

  test("never overlaps the confirmed log", () => {
    const confirmed = new Set(getRecentInstalls(db, "UA", 500).map((r) => r.TailNumber));
    for (const r of getReportedInstalls(db, "UA")) {
      expect(confirmed.has(r.TailNumber), `${r.TailNumber} is in both lists`).toBe(false);
    }
  });

  test("is a subset of /api/mismatches' own list", () => {
    const mismatched = new Set(getWifiMismatches(db, "UA").map((m) => m.TailNumber));
    for (const r of getReportedInstalls(db, "UA")) {
      expect(mismatched.has(r.TailNumber)).toBe(true);
    }
  });

  test("a listing ages out once it passes the cap", () => {
    const later = Math.floor(Date.now() / 1000) + (REPORTED_MAX_AGE_DAYS + 1) * 86_400;
    expect(getReportedInstalls(db, "UA", 25, later)).toEqual([]);
  });

  test("leaves out rows our own discovery wrote", () => {
    expect(getReportedInstalls(db, "UA").map((r) => r.TailNumber)).not.toContain("N30005");
  });

  test("is scoped to the airline asked for", () => {
    expect(getReportedInstalls(db, "AS")).toEqual([]);
  });
});

describe("/newly-equipped", () => {
  test("shows reported tails in their own section, after the confirmed list", async () => {
    const { status, text } = await bodyOf(app, "/newly-equipped", UA);
    expect(status).toBe(200);
    const split = text.indexOf("Reported, not yet confirmed");
    expect(split).toBeGreaterThan(-1);
    const confirmedHtml = text.slice(0, split);
    const reportedHtml = text.slice(split);
    for (const tail of ["N20001", "N20002"]) {
      expect(reportedHtml).toContain(`id="${tail}"`);
      expect(confirmedHtml).not.toContain(`id="${tail}"`);
    }
    for (const tail of ["N10001", "N10002"]) {
      expect(confirmedHtml).toContain(`id="${tail}"`);
      expect(reportedHtml).not.toContain(`id="${tail}"`);
    }
    expect(reportedHtml).toContain("not in our count");
    // DateFound is the day our scrape first read the listing, so the row and
    // the panel's footer must say that and never "Listed <date>".
    expect(reportedHtml).toContain("First seen ");
    expect(reportedHtml).not.toMatch(/Listed\s+[A-Z][a-z]{2} \d/);
    expect(reportedHtml).toContain("Dates are when we first saw the listing on the sheet");
    expect(reportedHtml).toContain("Viasat");
  });

  test("excluded rows appear nowhere on the page", async () => {
    const { text } = await bodyOf(app, "/newly-equipped", UA);
    for (const tail of ["N30001", "N30004", "N30005"]) {
      expect(text).not.toContain(`id="${tail}"`);
    }
  });

  test("a listing the sheet still keeps stays on the panel past the feed's age cap", async () => {
    const { text } = await bodyOf(app, "/newly-equipped", UA);
    const reportedHtml = text.slice(text.indexOf("Reported, not yet confirmed"));
    for (const tail of ["N30002", "N30003"]) {
      expect(reportedHtml).toContain(`id="${tail}"`);
    }
    const old = reportedHtml.slice(reportedHtml.indexOf('id="N30002"'));
    expect(old.slice(0, old.indexOf("Not confirmed"))).toContain("First seen ");
  });

  test("the panel's rows are /api/mismatches' own list", async () => {
    const { text } = await bodyOf(app, "/newly-equipped", UA);
    const reportedHtml = text.slice(text.indexOf("Reported, not yet confirmed"));
    const api = await jsonOf(app, "/api/mismatches", UA);
    const listed = (api.listed_not_counted as { tail_number: string }[]).map((r) => r.tail_number);
    expect(listed.length).toBeGreaterThan(0);
    const shown = [...reportedHtml.matchAll(/id="(N[0-9A-Z]+)"/g)].map((m) => m[1]);
    expect(new Set(shown)).toEqual(new Set(listed));
  });

  test("a listing the sheet drops leaves the panel", async () => {
    const dropped = makeSyntheticDb();
    seed(dropped, "N30002", { verified: "Viasat", found: daysAgo(REPORTED_MAX_AGE_DAYS + 5) });
    dropped.query("DELETE FROM starlink_planes WHERE TailNumber = 'N30002'").run();
    const { text } = await bodyOf(createApp(dropped), "/newly-equipped", UA);
    expect(text).not.toContain('id="N30002"');
    dropped.close();
  });

  test("with nothing reported the panel says so plainly", async () => {
    const clean = makeSyntheticDb();
    seed(clean, "N10001", { verified: "Starlink", found: daysAgo(4) });
    const { text } = await bodyOf(createApp(clean), "/newly-equipped", UA);
    const reportedHtml = text.slice(text.indexOf("Reported, not yet confirmed"));
    expect(text).toContain("Reported, not yet confirmed");
    expect(reportedHtml).toContain("None right now.");
    expect(reportedHtml).not.toContain("not in our count");
    clean.close();
  });

  test("the hub log stays confirmed-only", async () => {
    const { status, text } = await bodyOf(app, "/newly-equipped", HUB);
    expect(status).toBe(200);
    expect(text).not.toContain("Reported, not yet confirmed");
    expect(text).not.toContain('id="N20001"');
  });
});

describe("/feed.xml", () => {
  const entriesOf = (xml: string) => xml.split("<entry>").slice(1);

  test("reported entries are a kind of their own", async () => {
    const { text } = await bodyOf(app, "/feed.xml", UA);
    const entries = entriesOf(text);
    const reported = entries.filter((e) => e.includes('<category term="reported"/>'));
    const confirmed = entries.filter((e) => e.includes('<category term="confirmed"/>'));
    expect(reported.length).toBe(2);
    expect(confirmed.length).toBe(2);
    expect(reported.length + confirmed.length).toBe(entries.length);
    for (const e of reported) {
      expect(e).toContain("reported with Starlink, not yet confirmed</title>");
      expect(e).not.toContain("now has Starlink");
      expect(e).toContain("is not confirmed and is not in the tracker&apos;s Starlink count");
      expect(e).toContain("the date this tracker first read the listing");
      expect(e).toMatch(/<id>tag:[^<]+:reported:N2000\d<\/id>/);
      expect(e).toMatch(/<link href="https:\/\/[^"]+\/newly-equipped#N2000\d"\/>/);
    }
    for (const e of confirmed) {
      expect(e).toContain("now has Starlink</title>");
      expect(e).not.toContain("N2000");
    }
  });

  test("a tail's reported and confirmed entries never share an id", async () => {
    const { text } = await bodyOf(app, "/feed.xml", UA);
    const ids = [...text.matchAll(/<entry>\s*<title>[^<]*<\/title>\s*<id>([^<]+)<\/id>/g)].map(
      (m) => m[1]
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(`https://${UA}/newly-equipped#N20001`);
  });

  test("the feed's own <updated> covers the newest entry of either kind", async () => {
    const { text } = await bodyOf(app, "/feed.xml", UA);
    const feedUpdated = text.match(/<\/id>\s*<updated>([^<]+)<\/updated>\s*<author>/)?.[1];
    expect(feedUpdated).toBe(`${daysAgo(1)}T12:00:00Z`);
    expect(text).toMatch(/<subtitle>[^<]*community listings this tracker has not confirmed/);
  });

  test("the hub feed carries no reported entries", async () => {
    const { text } = await bodyOf(app, "/feed.xml", HUB);
    expect(text).not.toContain('term="reported"');
    expect(text).not.toContain("N20001");
  });

  test("a discovery row is in neither kind of entry", async () => {
    const { text } = await bodyOf(app, "/feed.xml", UA);
    expect(text).not.toContain("N30005");
  });
});

describe("counts and the confirmed list stay as they were", () => {
  test("reported tails are in no total, list or CSV", async () => {
    const data = await jsonOf(app, "/api/data", UA);
    const tails = (data.starlinkPlanes as { TailNumber: string }[]).map((p) => p.TailNumber);
    expect(tails.sort()).toEqual(["N10001", "N10002"]);
    const csv = await bodyOf(app, "/data/starlink-tails.csv", UA);
    expect(csv.text).not.toContain("N20001");
    expect(csv.text).not.toContain("N20002");
    const badge = await bodyOf(app, "/badge.svg", UA);
    expect(badge.status).toBe(200);
  });

  test("removing the reported rows changes no count", async () => {
    const before = await jsonOf(app, "/api/fleet-summary", UA);
    const twin = makeSyntheticDb();
    seed(twin, "N10001", { verified: "Starlink", found: daysAgo(4) });
    seed(twin, "N10002", { verified: null, found: daysAgo(3) });
    seed(twin, "N30001", { verified: "None", found: daysAgo(2) });
    seed(twin, "N30002", { verified: "Viasat", found: daysAgo(REPORTED_MAX_AGE_DAYS + 5) });
    seed(twin, "N30003", { verified: "Viasat", found: daysAgo(2), gid: "ua_seed" });
    seed(twin, "N30004", { wifi: "Viasat", verified: "Viasat", found: daysAgo(2) });
    seed(twin, "N30005", { verified: "Viasat", found: daysAgo(1), gid: "discovery" });
    const after = await jsonOf(createApp(twin), "/api/fleet-summary", UA);
    expect({ ...after, generatedAt: null }).toEqual({ ...before, generatedAt: null });
    twin.close();
  });
});
