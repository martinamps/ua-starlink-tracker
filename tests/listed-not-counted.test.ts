/**
 * "The sheet lists it and we don't count it": one rule, every surface.
 *
 * Seeded on a fresh database with the cases the November 2026 tail match
 * found on neither public list (a listing our check has not reached, a
 * lasting "no Wi-Fi") beside the ones that already showed and the regional
 * flap that must stay hidden. The count is pinned on the same rows: nothing
 * the rule returns is in it, and deleting every row it returns moves no figure.
 */

import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import {
  REPORTED_MAX_AGE_DAYS,
  equippedCountsByAirline,
  getListedNotCounted,
  getReportedInstalls,
} from "../src/database/database";
import { tailEquippedSql } from "../src/database/sql/equipped";
import {
  type UncountedInput,
  type UncountedReason,
  independentListingSql,
  uncountedReason,
} from "../src/database/sql/listed-not-counted";
import { createApp } from "../src/server/app";
import { addFleet, bodyOf, jsonOf, makeFreshDb } from "./helpers";

const UA = SITES.united.canonicalHost;
const DAY = 86400;
const now = Math.floor(Date.now() / 1000);
const isoDay = (daysAgo: number) =>
  new Date((now - daysAgo * DAY) * 1000).toISOString().slice(0, 10);

let db: Database;
let app: ReturnType<typeof createApp>;

function list(
  tail: string,
  o: { verified: string | null; foundDaysAgo: number; gid?: string; aircraft?: string }
) {
  db.query(
    `INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber, OperatedBy, fleet, verified_wifi, verified_at, airline)
     VALUES (?, 'Starlink', ?, '', ?, ?, 'United Airlines', 'mainline', ?, ?, 'UA')`
  ).run(
    o.aircraft ?? "Boeing 737 MAX 9",
    o.gid ?? "4",
    isoDay(o.foundDaysAgo),
    tail,
    o.verified,
    o.verified === null ? null : now - DAY
  );
}

// A direct insert: logVerification stamps the row with the current time.
function read(tail: string, provider: string, daysAgo: number) {
  db.query(
    `INSERT INTO starlink_verification_log
       (tail_number, source, checked_at, has_starlink, wifi_provider, aircraft_type, flight_number, error, tail_confirmed, airline)
     VALUES (?, 'united', ?, ?, ?, 'Boeing 737 MAX 9', 'UA100', NULL, 1, 'UA')`
  ).run(tail, now - daysAgo * DAY, provider === "Starlink" ? 1 : 0, provider);
}

/** Tail → the reason the rule must give it. */
const SHOWN: Record<string, UncountedReason> = {
  N17AWT: "awaiting_check",
  N79PRK: "awaiting_check",
  N5OLDA: "awaiting_check",
  N71NON: "no_wifi",
  N3OTH: "other_provider",
  N4OLD: "other_provider",
  N4OLDN: "no_wifi",
  N4SEED: "other_provider",
  N4NODT: "other_provider",
  N7NEWR: "awaiting_check",
};
/** Shown, but not in the dated log: past its window, or on a tab it never dates. */
const OFF_LOG = ["N4OLD", "N4OLDN", "N4SEED", "N4NODT", "N5OLDA"];
/** Sheet-listed, uncounted, and hidden on purpose: united.com's regional flap. */
const FLAPS = ["N72FLP", "N73FLP"];
const COUNTED = ["N1CNT", "N2LST", "N8DUP"];

beforeAll(() => {
  db = makeFreshDb();

  list("N1CNT", { verified: "Starlink", foundDaysAgo: 8 });
  addFleet(db, "N1CNT", "confirmed", { verifiedWifi: "Starlink", verifiedAt: now - DAY });
  list("N2LST", { verified: null, foundDaysAgo: 3 });
  addFleet(db, "N2LST", "unknown", { verifiedAt: null });

  // Listed two days ago; every read of ours is older, and settled it Viasat.
  list("N17AWT", { verified: null, foundDaysAgo: 2 });
  addFleet(db, "N17AWT", "negative", { verifiedWifi: "Viasat", verifiedAt: now - 20 * DAY });
  for (const d of [25, 22, 20]) read("N17AWT", "Viasat", d);

  // Parked: one read since the listing, too few to settle; the verdict it had was cleared.
  list("N79PRK", { verified: null, foundDaysAgo: 6, aircraft: "Boeing 777-200" });
  addFleet(db, "N79PRK", "negative", { verifiedWifi: "Panasonic", verifiedAt: now - 40 * DAY });
  read("N79PRK", "Panasonic", 40);
  read("N79PRK", "Panasonic", 3);

  // Unchecked and old: off the dated log, still reported on its own page.
  list("N5OLDA", { verified: null, foundDaysAgo: REPORTED_MAX_AGE_DAYS + 15 });
  addFleet(db, "N5OLDA", "negative", { verifiedWifi: "Viasat", verifiedAt: now - 90 * DAY });

  // "No Wi-Fi" every time, never Starlink: lasting.
  list("N71NON", { verified: "None", foundDaysAgo: 10, aircraft: "CRJ-550" });
  addFleet(db, "N71NON", "negative", { verifiedWifi: "None", verifiedAt: now - DAY });
  for (let d = 1; d <= 15; d++) read("N71NON", "None", d);

  // The flap: Starlink on record, then "None". With a verdict, and without one.
  list("N72FLP", { verified: "None", foundDaysAgo: 10, aircraft: "Embraer E175" });
  addFleet(db, "N72FLP", "negative", { verifiedWifi: "None", verifiedAt: now - DAY });
  read("N72FLP", "Starlink", 12);
  for (const d of [3, 2, 1]) read("N72FLP", "None", d);
  list("N73FLP", { verified: null, foundDaysAgo: 10, aircraft: "Embraer E175" });
  addFleet(db, "N73FLP", "negative", { verifiedWifi: "None", verifiedAt: now - DAY });
  read("N73FLP", "Starlink", 12);
  read("N73FLP", "None", 1);

  list("N3OTH", { verified: "Viasat", foundDaysAgo: 4 });
  addFleet(db, "N3OTH", "negative", { verifiedWifi: "Viasat", verifiedAt: now - DAY });
  list("N4OLD", { verified: "Viasat", foundDaysAgo: REPORTED_MAX_AGE_DAYS + 15 });
  addFleet(db, "N4OLD", "negative", { verifiedWifi: "Viasat", verifiedAt: now - DAY });

  // The same past the window with a lasting "no Wi-Fi", and a listing on a
  // bulk tab, which the log never dates.
  list("N4OLDN", { verified: "None", foundDaysAgo: REPORTED_MAX_AGE_DAYS + 15 });
  addFleet(db, "N4OLDN", "negative", { verifiedWifi: "None", verifiedAt: now - DAY });
  read("N4OLDN", "None", 1);
  list("N4SEED", { verified: "Viasat", foundDaysAgo: 3, gid: "ua_seed" });
  addFleet(db, "N4SEED", "negative", { verifiedWifi: "Viasat", verifiedAt: now - DAY });
  // Contradicted, and undated: no log can place it.
  list("N4NODT", { verified: "Viasat", foundDaysAgo: 3 });
  db.run("UPDATE starlink_planes SET DateFound = NULL WHERE TailNumber = 'N4NODT'");
  addFleet(db, "N4NODT", "negative", { verifiedWifi: "Viasat", verifiedAt: now - DAY });

  // No verdict on the listing; the roster settled Viasat on reads since it.
  list("N7NEWR", { verified: null, foundDaysAgo: 8 });
  addFleet(db, "N7NEWR", "negative", { verifiedWifi: "Viasat", verifiedAt: now - DAY });
  for (const d of [3, 2, 1]) read("N7NEWR", "Viasat", d);

  // Ours, not the sheet's.
  list("N6DISC", { verified: "Viasat", foundDaysAgo: 1, gid: "discovery" });
  addFleet(db, "N6DISC", "negative", { verifiedWifi: "Viasat", verifiedAt: now - DAY });

  // Listed twice: one row contradicted, one observed on Starlink. Counted.
  list("N8DUP", { verified: "Viasat", foundDaysAgo: 30 });
  list("N8DUP", { verified: "Starlink", foundDaysAgo: 30 });
  addFleet(db, "N8DUP", "confirmed", { verifiedWifi: "Starlink", verifiedAt: now - DAY });

  // Not on the sheet; the progress workbook colours it "verification needed".
  addFleet(db, "N9NOT", "negative", { verifiedWifi: "Viasat", verifiedAt: now - 6 * DAY });
  db.query(
    `INSERT INTO fleet_progress_tails (airline, segment, type_code, tail, state, mod_location, sheet_updated, fetched_at)
     VALUES ('UA', 'mainline', '739', 'N9NOT', 'verification_needed', NULL, '2026-11-20', ?)`
  ).run(now);

  db.query("INSERT INTO meta (key, value) VALUES ('UA:lastUpdated', ?)").run(
    new Date((now - 3600) * 1000).toISOString()
  );
  app = createApp(db);
});

describe("uncountedReason", () => {
  const cases: Array<[string, UncountedInput, UncountedReason | null]> = [
    [
      "no verdict, older settle on another provider",
      { listingWifi: null, settledWifi: "Viasat", everReadStarlink: false },
      "awaiting_check",
    ],
    [
      "no verdict, nothing settled",
      { listingWifi: null, settledWifi: null, everReadStarlink: false },
      "awaiting_check",
    ],
    [
      "a named provider",
      { listingWifi: "Thales", settledWifi: "Thales", everReadStarlink: true },
      "other_provider",
    ],
    [
      "no Wi-Fi, never Starlink",
      { listingWifi: "None", settledWifi: "None", everReadStarlink: false },
      "no_wifi",
    ],
    [
      "no Wi-Fi after a Starlink read: the flap",
      { listingWifi: "None", settledWifi: "None", everReadStarlink: true },
      null,
    ],
    [
      "no verdict, settled no Wi-Fi after a Starlink read: the flap",
      { listingWifi: null, settledWifi: "None", everReadStarlink: true },
      null,
    ],
    [
      "listing reads Starlink under a negative settle: the settle stands",
      { listingWifi: "Starlink", settledWifi: "Viasat", everReadStarlink: true },
      "other_provider",
    ],
  ];
  test.each(cases)("%s", (_name, input, expected) => {
    expect(uncountedReason(input)?.reason ?? null).toBe(expected);
  });

  test("only a contrary reading carries a provider", () => {
    for (const [, input] of cases) {
      const r = uncountedReason(input);
      if (r) expect(r.observedWifi === null).toBe(r.reason === "awaiting_check");
    }
  });
});

describe("getListedNotCounted", () => {
  test("gives each uncounted sheet listing its reason, once", () => {
    const rows = getListedNotCounted(db, "UA");
    expect(Object.fromEntries(rows.map((r) => [r.TailNumber, r.reason]))).toEqual(SHOWN);
    expect(new Set(rows.map((r) => r.TailNumber)).size).toBe(rows.length);
  });

  test("a row awaiting our check names no provider and no date", () => {
    for (const r of getListedNotCounted(db, "UA")) {
      if (r.reason === "awaiting_check") {
        expect(r.observed_wifi).toBeNull();
        expect(r.observed_at).toBeNull();
      } else {
        expect(typeof r.observed_wifi).toBe("string");
      }
    }
  });

  test("counts our reads since the listing was first seen", () => {
    const by = Object.fromEntries(
      getListedNotCounted(db, "UA").map((r) => [r.TailNumber, r.checks_since_listed])
    );
    expect(by.N17AWT).toBe(0);
    expect(by.N79PRK).toBe(1);
  });

  test("every sheet-listed tail is counted, shown, or a flap", () => {
    const listed = (
      db
        .query(
          `SELECT DISTINCT TailNumber AS tail, ${tailEquippedSql("sp.TailNumber", "sp.airline")} AS equipped
           FROM starlink_planes sp WHERE sp.airline = 'UA' AND ${independentListingSql("sp")}`
        )
        .all() as Array<{ tail: string; equipped: number }>
    ).sort((a, b) => a.tail.localeCompare(b.tail));
    const shown = new Set(getListedNotCounted(db, "UA").map((r) => r.TailNumber));
    for (const { tail, equipped } of listed) {
      const places = [equipped === 1, shown.has(tail), FLAPS.includes(tail)].filter(Boolean);
      expect(places.length, tail).toBe(1);
    }
    expect(listed.filter((l) => l.equipped).map((l) => l.tail)).toEqual(COUNTED);
  });

  test("the log ages out old listings; a tail's page keeps an unchecked one", () => {
    const log = getReportedInstalls(db, "UA", 100).map((r) => r.TailNumber);
    expect(log.sort()).toEqual(
      Object.keys(SHOWN)
        .filter((t) => !OFF_LOG.includes(t))
        .sort()
    );
    const page = getListedNotCounted(db, "UA", { scope: "tail" }).map((r) => r.TailNumber);
    expect(page).toContain("N5OLDA");
    expect(page).not.toContain("N4OLD");
  });

  test("an airline without a sheet has nothing to report", () => {
    expect(getListedNotCounted(db, "AS")).toEqual([]);
    expect(getListedNotCounted(db, undefined).every((r) => r.airline === "UA")).toBe(true);
  });
});

describe("the count stays as it was", () => {
  const figures = async (a: ReturnType<typeof createApp>) => {
    const data = await jsonOf(a, "/api/data", UA);
    const summary = await jsonOf(a, "/api/fleet-summary", UA);
    const csv = await bodyOf(a, "/data/starlink-tails.csv", UA);
    return {
      total: data.totalCount,
      planes: (data.starlinkPlanes as { TailNumber: string }[]).map((p) => p.TailNumber).sort(),
      summary: { ...summary, generatedAt: null },
      csv: csv.text,
    };
  };

  test("no shown tail is in the count, the list or the CSV", async () => {
    const f = await figures(app);
    expect(f.planes).toEqual(COUNTED);
    for (const tail of [...Object.keys(SHOWN), ...FLAPS]) {
      expect(f.csv, tail).not.toContain(tail);
    }
    expect(equippedCountsByAirline(db)).toEqual([{ airline: "UA", equipped: COUNTED.length }]);
  });

  test("deleting every row the rule returns moves no figure", async () => {
    const before = await figures(app);
    const copy = makeFreshDb();
    for (const table of ["starlink_planes", "united_fleet", "starlink_verification_log", "meta"]) {
      const rows = db.query(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
      for (const row of rows) {
        const cols = Object.keys(row);
        copy
          .query(
            `INSERT OR REPLACE INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`
          )
          .run(...(Object.values(row) as (string | number | null)[]));
      }
    }
    const shown = getListedNotCounted(copy, "UA").map((r) => r.TailNumber);
    expect(shown.length).toBe(Object.keys(SHOWN).length);
    for (const tail of shown) {
      copy.query("DELETE FROM starlink_planes WHERE TailNumber = ?").run(tail);
    }
    const after = await figures(createApp(copy));
    expect(after.planes).toEqual(before.planes);
    expect(after.total).toBe(before.total);
    expect(after.summary).toEqual(before.summary);
    expect(after.csv).toBe(before.csv);
    copy.close();
  });
});

describe("/api/mismatches", () => {
  test("`mismatches` keeps a provider and a date on every row", async () => {
    const body = await jsonOf(app, "/api/mismatches", UA);
    const rows = body.mismatches as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    for (const m of rows) {
      expect(Object.keys(m).sort()).toEqual([
        "aircraft",
        "date_found",
        "operated_by",
        "spreadsheet_says",
        "tail_number",
        "verified_as",
        "verified_at",
      ]);
      expect(typeof m.verified_as).toBe("string");
      expect(m.verified_as).not.toBe("None");
      expect(Number.isNaN(Date.parse(m.verified_at as string))).toBe(false);
    }
    expect(rows.map((m) => m.tail_number)).not.toContain("N17AWT");
  });

  test("`listed_not_counted` carries every shown tail with its reason", async () => {
    const body = await jsonOf(app, "/api/mismatches", UA);
    const rows = body.listed_not_counted as Array<Record<string, unknown>>;
    expect(Object.fromEntries(rows.map((r) => [r.tail_number, r.reason]))).toEqual(SHOWN);
    const awaiting = rows.find((r) => r.tail_number === "N17AWT");
    expect(awaiting).toMatchObject({
      spreadsheet_says: "Starlink",
      verified_as: null,
      verified_at: null,
      checks_since_listed: 0,
    });
    expect(rows.find((r) => r.tail_number === "N71NON")?.verified_as).toBe("None");
    for (const tail of FLAPS) expect(rows.map((r) => r.tail_number)).not.toContain(tail);
  });
});

describe("/newly-equipped and its feed", () => {
  test("the reported panel words each reason, and never says the plane has Starlink", async () => {
    const { text } = await bodyOf(app, "/newly-equipped", UA);
    const panel = text.slice(text.indexOf("Reported, not yet confirmed"));
    const row = (tail: string) => {
      const at = panel.indexOf(`id="${tail}"`);
      expect(at, tail).toBeGreaterThan(-1);
      return panel.slice(at, panel.indexOf("</div></div>", at));
    };
    expect(row("N17AWT")).toContain("we have not checked it since first seeing the listing");
    expect(row("N79PRK")).toContain("our reads since the listing have not settled on a reading");
    expect(row("N71NON")).toContain("our check reads no Wi-Fi, and has never read Starlink on it");
    expect(row("N3OTH")).toContain("our check still reads Viasat");
    for (const tail of [...FLAPS, "N4OLD", "N5OLDA", "N6DISC", "N9NOT"]) {
      expect(text, tail).not.toContain(`id="${tail}"`);
    }
    expect(panel).toContain("They are not in our count");
    expect(panel).not.toMatch(/has Starlink/);
  });

  test("feed entries for reported tails say what we have and haven't read", async () => {
    const { text } = await bodyOf(app, "/feed.xml", UA);
    const entry = (tail: string) =>
      text.split("<entry>").find((e) => e.includes(`:reported:${tail}</id>`)) ?? "";
    expect(entry("N17AWT")).toContain(
      "This tracker has not checked it since first seeing the listing, so the aircraft is not confirmed"
    );
    expect(entry("N71NON")).toContain(
      "This tracker&apos;s own check of the airline&apos;s site reads no Wi-Fi"
    );
    expect(entry("N3OTH")).toContain(
      "This tracker&apos;s own check of the airline&apos;s site still reads Viasat"
    );
    for (const tail of Object.keys(SHOWN).filter((t) => !OFF_LOG.includes(t))) {
      expect(entry(tail), tail).toContain("reported with Starlink, not yet confirmed</title>");
      expect(entry(tail), tail).not.toContain("now has Starlink");
    }
    for (const tail of FLAPS) expect(text).not.toContain(tail);
  });
});

/** The hover line of a tail's cell on /fleet. */
const titleOf = (html: string, tail: string) =>
  html.match(new RegExp(`id="t-${tail}"[^>]*title="([^"]*)"`))?.[1] ??
  html.match(new RegExp(`title="([^"]*)"[^>]*id="t-${tail}"`))?.[1] ??
  "";

describe("/fleet", () => {
  test("every shown tail carries the mark and its reason", async () => {
    const { status, text } = await bodyOf(app, "/fleet", UA);
    expect(status).toBe(200);
    for (const tail of Object.keys(SHOWN)) {
      expect(titleOf(text, tail), tail).toContain("sheet lists Starlink, not counted: ");
    }
    expect(titleOf(text, "N17AWT")).toContain("we have not checked it");
    expect(titleOf(text, "N4OLD")).toContain("our check still reads Viasat");
  });

  test("a flap, a counted tail and an unlisted one carry no such mark", async () => {
    const { text } = await bodyOf(app, "/fleet", UA);
    for (const tail of [...FLAPS, ...COUNTED, "N6DISC", "N9NOT"]) {
      expect(titleOf(text, tail), tail).not.toContain("sheet lists Starlink");
    }
    // The progress workbook still speaks for a tail the sheet does not list.
    expect(titleOf(text, "N9NOT")).toContain("awaiting verification");
  });
});

describe("/fleet/{tail}", () => {
  const page = async (tail: string) => (await bodyOf(app, `/fleet/${tail}`, UA)).text;

  test("an unchecked listing says what the sheet says and that we haven't checked", async () => {
    const body = await page("N17AWT");
    expect(body).toContain("Not confirmed");
    expect(body).toContain(
      "The community fleet sheet lists N17AWT with Starlink. We have not checked it on united.com since we first saw the listing."
    );
    expect(body).toContain("It is not in our count.");
    expect(body).toContain(
      "Our last settled reading, Viasat Wi-Fi, dates from before we saw the listing."
    );
    expect(body).not.toContain("N17AWT has Starlink");
    expect(body).not.toContain("N17AWT does not have Starlink");
  });

  test("a listing with unsettled reads says so", async () => {
    const body = await page("N79PRK");
    expect(body).toContain(
      "Our reads of it on united.com since the listing have not settled on a reading."
    );
    expect(body).not.toContain("dates from before we saw the listing");
  });

  test("unsettled reads above a settled-reading row say which reading is which", async () => {
    // The roster's verdict on N79PRK is older than the listing.
    const older = await page("N79PRK");
    expect(older).toContain("Settled reading");
    expect(older).toContain(
      "The settled reading below, Panasonic Wi-Fi, was made before we saw the listing."
    );
    // N7NEWR's is newer: the roster settled, the listing has no verdict yet.
    const newer = await page("N7NEWR");
    expect(newer).toContain("have not settled on a reading");
    expect(newer).toContain("Settled reading");
    expect(newer).toContain(
      "The settled reading below, Viasat Wi-Fi, is our verdict on the plane; no verdict of ours stands on the listing itself yet."
    );
    expect(newer).not.toContain("was made before we saw the listing");
  });

  test("a lasting no Wi-Fi says we have never read Starlink on it", async () => {
    const body = await page("N71NON");
    expect(body).toContain(
      "The community fleet sheet lists N71NON with Starlink, but our own check of united.com still reads no Wi-Fi."
    );
    expect(body).toContain("Our check has never read Starlink on this plane");
  });

  test("an unchecked listing past the log's window is still reported on its own page", async () => {
    expect(await page("N5OLDA")).toContain("The community fleet sheet lists N5OLDA with Starlink.");
  });

  test("a flap keeps its plain no", async () => {
    for (const tail of FLAPS) {
      const body = await page(tail);
      expect(body, tail).toContain(`${tail} does not have Starlink.`);
      expect(body, tail).not.toContain("The community fleet sheet lists");
    }
  });

  test("a contradicted listing past the window still names the sheet, as /fleet's mark does", async () => {
    const fleet = (await bodyOf(app, "/fleet", UA)).text;
    for (const [tail, reads] of [
      ["N4OLD", "Viasat Wi-Fi"],
      ["N4OLDN", "no Wi-Fi"],
      ["N4SEED", "Viasat Wi-Fi"],
      ["N4NODT", "Viasat Wi-Fi"],
    ]) {
      expect(titleOf(fleet, tail), tail).toContain("sheet lists Starlink, not counted");
      const body = await page(tail);
      expect(body, tail).toContain(
        `The community fleet sheet lists ${tail} with Starlink, but our own check of united.com still reads ${reads}.`
      );
      expect(body, tail).toContain("It is not in our count");
      expect(body, tail).toContain(
        tail === "N4NODT" ? "Lists this plane with Starlink" : "Sheet listing first seen"
      );
      // Still a "No", still out of search: only the wording moved.
      expect(body, tail).not.toContain("Not confirmed");
      expect(body, tail).not.toContain(`${tail} does not have Starlink.`);
      expect(body, tail).toMatch(/<meta name="robots" content="noindex/);
    }
  });

  test("every tail /fleet marks names the sheet on its own page", async () => {
    for (const r of getListedNotCounted(db, "UA")) {
      expect(await page(r.TailNumber), r.TailNumber).toContain(
        `The community fleet sheet lists ${r.TailNumber} with Starlink`
      );
    }
  });
});
