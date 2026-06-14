// Pins the FAA registry parsing/flagging rules: serial-filtered dereg matches,
// NOT_IN_MASTER handling, and the wrong-yes flag for Starlink-marked tails.

import { describe, expect, test } from "bun:test";
import { getFaaRegistryByTail, replaceFaaRegistry } from "../src/database/database";
import {
  buildFaaRecords,
  collectAcftref,
  collectDereg,
  collectMasterRows,
  runFaaRegistrySync,
} from "../src/scripts/faa-registry";
import { makeSyntheticDb } from "./helpers";

const MASTER_LINES = [
  "N-NUMBER,SERIAL NUMBER,MFR MDL CODE,ENG MFR MDL,YEAR MFR,TYPE REGISTRANT,NAME,STREET,STREET2,CITY,STATE,ZIP CODE,REGION,COUNTY,COUNTRY,LAST ACTION DATE,CERT ISSUE DATE,CERTIFICATION,TYPE AIRCRAFT,TYPE ENGINE,STATUS CODE,MODE S CODE,FRACT OWNER,AIR WORTH DATE,OTHER NAMES(1),OTHER NAMES(2),OTHER NAMES(3),OTHER NAMES(4),OTHER NAMES(5),EXPIRATION DATE,UNIQUE ID,KIT MFR, KIT MODEL,MODE S CODE HEX",
  "73275,30581,1387815,30030,2001,3,UNITED AIRLINES INC,233 S WACKER DR,,CHICAGO,IL,60606,3,031,US,20240105,20011019,,5,5,V,52624414,,20011102,,,,,,20310131,01089105,,,A98D0C",
  "868AS,7474,3160009,52021,2001,3,SKYWEST AIRLINES INC,444 S RIVER RD,,ST GEORGE,UT,84790,4,053,US,20231002,20011207,,5,5,9,52764363,,20011219,,,,,,20261231,00569204,,,ABC123",
  "99999,1234,9999999,11111,1990,1,SOMEONE ELSE,1 MAIN ST,,AUSTIN,TX,78701,2,453,US,20200101,19900101,,4,1,V,50000001,,19900201,,,,,,20270101,00000001,,,A00001",
].join("\n");

const ACFTREF_LINES = [
  "CODE,MFR,MODEL,TYPE-ACFT,TYPE-ENG,AC-CAT,BUILD-CERT-IND,NO-ENG,NO-SEATS,AC-WEIGHT,SPEED,TC-DATA-SHEET,TC-DATA-HOLDER",
  "1387815,BOEING,737-824,5,5,1,0,2,166,CLASS 3,0,A16WE,THE BOEING COMPANY",
  "3160009,BOMBARDIER INC,CL-600-2B19,5,5,1,0,2,50,CLASS 3,0,A21EA,BOMBARDIER INC",
].join("\n");

const DEREG_LINES = [
  "N-NUMBER,SERIAL-NUMBER,MFR MDL CODE,STATUS-CODE,NAME,STREET-MAIL,STREET2-MAIL,CITY-MAIL,STATE-ABBREV-MAIL,ZIP-CODE-MAIL,ENG MFR MDL,YEAR MFR,CERTIFICATION,REGION,COUNTY-MAIL,COUNTRY-MAIL,AIR-WORTH-DATE,CANCEL-DATE,MODE-S-CODE,INDICATOR-GROUP,EXP-COUNTRY,LAST-ACT-DATE,CERT-ISSUE-DATE,STREET-PHYSICAL,STREET2-PHYSICAL,CITY-PHYSICAL,STATE-ABBREV-PHYSICAL,ZIP-CODE-PHYSICAL,COUNTY-PHYSICAL,COUNTRY-PHYSICAL,OTHER-NAMES(1),OTHER-NAMES(2),OTHER-NAMES(3),OTHER-NAMES(4),OTHER-NAMES(5)",
  // Historical N-number reuse on a different airframe — must be ignored
  "73275,OLD-CESSNA-1,2072702,A,OLD OWNER,1 RD,,TULSA,OK,74100,,1965,,2,143,US,,19890301,,,,19890301,19650101,,,,,,,,,,,,",
  // Same airframe (serial matches) — must be flagged
  "868AS,7474,3160009,A,SKYWEST AIRLINES INC,444 S RIVER RD,,ST GEORGE,UT,84790,,2001,,4,053,US,,20231002,,,,20231002,20011207,,,,,,,,,,,,",
  // Tail not in MASTER at all — dereg counts
  "652BR,7429,3160009,A,SKYWEST AIRLINES INC,444 S RIVER RD,,ST GEORGE,UT,84790,,2001,,4,053,US,,20231103,,,,20231103,20011207,,,,,,,,,,,,",
].join("\n");

async function fixtures() {
  const wanted = new Set(["73275", "868AS", "652BR", "7943SK"]);
  const master = await collectMasterRows(MASTER_LINES.split("\n"), wanted);
  const acftref = await collectAcftref(
    ACFTREF_LINES.split("\n"),
    new Set([...master.values()].map((m) => m.mfrMdlCode))
  );
  const dereg = await collectDereg(DEREG_LINES.split("\n"), wanted);
  return { master, acftref, dereg };
}

describe("FAA registry parsing", () => {
  test("collects only wanted tails and resolves model names via ACFTREF", async () => {
    const { master, acftref } = await fixtures();
    expect([...master.keys()].sort()).toEqual(["73275", "868AS"]);
    expect(acftref.get("1387815")).toBe("BOEING 737-824");
  });

  test("buildFaaRecords applies serial-filtered dereg and flags Starlink-marked problem tails", async () => {
    const { master, acftref, dereg } = await fixtures();
    const { rows, flags } = buildFaaRecords({
      tails: ["N73275", "N868AS", "N652BR", "N7943SK"],
      starlinkTails: new Set(["N73275", "N7943SK", "N868AS"]),
      master,
      acftref,
      dereg,
    });

    const byTail = new Map(rows.map((r) => [r.tail_number, r]));
    // Valid registration with a historical-reuse dereg record: no dereg date.
    expect(byTail.get("N73275")).toMatchObject({
      faa_status: "V",
      mode_s_hex: "A98D0C",
      faa_model: "BOEING 737-824",
      dereg_date: null,
    });
    // Same-airframe dereg (serial match) carries the cancel date.
    expect(byTail.get("N868AS")?.dereg_date).toBe("20231002");
    // Tail absent from MASTER entirely.
    expect(byTail.get("N7943SK")?.faa_status).toBe("NOT_IN_MASTER");
    expect(byTail.get("N652BR")?.dereg_date).toBe("20231103");

    expect(flags.missingFromMaster.sort()).toEqual(["N652BR", "N7943SK"]);
    // Starlink-marked tails that aren't validly registered: the fabricated tail
    // and the deregistered one; the valid N73275 must NOT be flagged.
    expect(flags.wrongYes.map((f) => f.tail).sort()).toEqual(["N7943SK", "N868AS"]);
  });
});

describe("faa_registry storage and sync", () => {
  test("runFaaRegistrySync writes rows for tracked tails using injected line sources", async () => {
    const db = makeSyntheticDb();
    db.query(
      "INSERT INTO united_fleet (tail_number, fleet, starlink_status, first_seen_source, first_seen_at, last_seen_at, airline) VALUES ('N73275', 'mainline', 'confirmed', 'test', 1, 1, 'UA')"
    ).run();
    db.query(
      "INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber, OperatedBy, fleet, airline) VALUES ('Boeing 737-824', 'Starlink', '4', '', '2026-06-04', 'N73275', 'United Airlines', 'mainline', 'UA')"
    ).run();

    const loadLines = (file: string) =>
      (file === "MASTER.txt"
        ? MASTER_LINES
        : file === "ACFTREF.txt"
          ? ACFTREF_LINES
          : DEREG_LINES
      ).split("\n");
    const result = await runFaaRegistrySync(db, { loadLines });
    expect(result).toMatchObject({ outcome: "success", tracked: 1, resolved: 1, flagged: 0 });

    const row = getFaaRegistryByTail(db, "N73275");
    expect(row).toMatchObject({ faa_status: "V", mode_s_hex: "A98D0C" });
    expect(row?.last_refreshed).toBeGreaterThan(0);
  });

  test("replaceFaaRegistry fully replaces the previous pull", () => {
    const db = makeSyntheticDb();
    const bareRow = (tail_number: string) => ({
      tail_number,
      mode_s_hex: null,
      serial: null,
      year_mfr: null,
      faa_status: "V",
      registrant: null,
      faa_model: null,
      expiration_date: null,
      dereg_date: null,
    });
    replaceFaaRegistry(db, [bareRow("N1")]);
    replaceFaaRegistry(db, [bareRow("N2")]);
    expect(getFaaRegistryByTail(db, "N1")).toBeNull();
    expect(getFaaRegistryByTail(db, "N2")).not.toBeNull();
  });
});
