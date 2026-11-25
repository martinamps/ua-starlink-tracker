/**
 * Qatar's words against Qatar's numbers. The by-type table is built from the
 * phase table and the held-back list; every sentence that calls a type done
 * must be built from the same two, so a type with aircraft held back is never
 * called complete, and the own-figure line never quotes a retired count.
 * Hermetic: a fresh DB seeded from the hub's tail list of 2026-11-23.
 */

import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ownFigureNote } from "../src/airlines/published-count";
import {
  AIRLINES,
  heldBackCount,
  qatarEquipment,
  qatarHeldBackTails,
  qatarPhaseNote,
  qatarProgrammeState,
  wifiPhaseFamilies,
} from "../src/airlines/registry";
import { airlineOwnCount, factsForCode, formatFactDate } from "../src/airlines/rollout-facts";
import { reconcileTypeDeterministicFleets } from "../src/database/database";
import { createApp } from "../src/server/app";
import { bodyOf, makeFreshDb, mcpTool } from "./helpers";

const HUB = "airlinestarlinktracker.com";
const QR_HOST = "qatarstarlinktracker.com";

const LISTED = readFileSync(
  join(import.meta.dir, "fixtures", "qatar-listed-tails-2026-11-23.csv"),
  "utf8"
)
  .trim()
  .split("\n")
  .slice(1)
  .map((l) => l.split(",") as [string, string]);

function seed(): Database {
  const db = makeFreshDb();
  const fleet = db.query(
    `INSERT INTO united_fleet (tail_number, aircraft_type, fleet, first_seen_source, first_seen_at, last_seen_at, starlink_status, airline)
     VALUES (?, ?, 'mainline', 'test', 1, 1, 'confirmed', 'QR')`
  );
  const listing = db.query(
    `INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, TailNumber, OperatedBy, fleet, airline)
     VALUES (?, 'StrLnk', 'type_deterministic', 'type_deterministic', ?, 'Qatar Airways', 'mainline', 'QR')`
  );
  for (const [tail, type] of LISTED) {
    fleet.run(tail, type);
    listing.run(type, tail);
  }
  reconcileTypeDeterministicFleets(db);
  return db;
}

/** Visible text: tags dropped, entities decoded, whitespace collapsed. */
const textOf = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const shortName = (family: string) => family.replace(/^B(?=7)/, "");
/** Types the phase table calls done that have aircraft held back: 777, 787-8. */
const HELD_TYPES = [
  ...new Set(qatarHeldBackTails().map(([, h]) => shortName(qatarEquipment(h.equipment)!.family))),
];
const HELD = qatarHeldBackTails().length;

/** A wording that calls `type` finished with no exception beside it. */
function callsComplete(text: string, type: string): string | null {
  const t = type.replace(/[-]/g, "\\-");
  const clauses = text.split(/[.;·]|\n/);
  for (const clause of clauses) {
    if (!new RegExp(`\\b${t}\\b`).test(clause)) continue;
    const says =
      /\b(done|complete|completed|fully fitted|fully equipped|whole fleet)\b/i.test(clause) ||
      new RegExp(`\\bevery\\b[^.;]*\\b${t}\\b`, "i").test(clause);
    const excepts = /\bexcept\b|\bunless\b|aren't confirmed|leaving out/i.test(clause);
    // What Qatar itself reports is Qatar's claim, not this site's.
    const attributed = /Qatar (Airways )?reports|Qatar Airways reached/i.test(clause);
    if (says && !excepts && !attributed) return clause.trim();
  }
  return null;
}

describe("the programme state is read from the phase table and the held-back list", () => {
  test("a type is 'done' only while none of its aircraft is held back", () => {
    const s = qatarProgrammeState();
    expect(HELD).toBeGreaterThan(0);
    expect(s.held).toBe(HELD);
    expect(s.doneExcept.map((t) => t.name).sort()).toEqual([...HELD_TYPES].sort());
    expect(s.doneExcept.reduce((n, t) => n + t.held, 0)).toBe(HELD);
    for (const type of HELD_TYPES) expect(s.done).not.toContain(type);
    const confirmed = Object.entries(wifiPhaseFamilies("QR") ?? {})
      .filter(([, phase]) => phase === "confirmed")
      .map(([family]) => shortName(family));
    expect([...s.done, ...s.doneExcept.map((t) => t.name)].sort()).toEqual(confirmed.sort());
    expect(heldBackCount("QR")).toBe(HELD);
    expect(heldBackCount("HA")).toBe(0);
  });

  test("with the list emptied, every finished type is done and no exception is worded", () => {
    const phases = wifiPhaseFamilies("QR") ?? {};
    const full = qatarProgrammeState(phases, []);
    expect(full.doneExcept).toEqual([]);
    expect(full.held).toBe(0);
    expect(qatarPhaseNote(full)).toBe(
      "777, A350 and 787-8 fleets done; 787-9 installs due by the end of 2026. The A380, A330, narrowbodies and freighters are not in the announced programme."
    );
    const finished = qatarProgrammeState({ ...phases, "B787-9": "confirmed" }, []);
    expect(finished.installing).toEqual([]);
    expect(qatarPhaseNote(finished)).not.toContain("installs due");
    expect(qatarPhaseNote(finished)).toContain("787-9 fleets done");
  });

  test("the phase note is today's state, and names the held-back count", () => {
    const note = AIRLINES.QR.rollout.phaseNote;
    expect(note).toBe(qatarPhaseNote());
    expect(note).toContain(`except ${HELD} `);
    for (const type of HELD_TYPES) expect(callsComplete(note, type), type).toBeNull();
  });

  test("the checker itself catches the old wordings", () => {
    for (const old of [
      "777, A350 and 787-8 fleets done; 787-9 installs due by the end of 2026.",
      "Qatar Airways has free Starlink Wi-Fi on every Boeing 777, Airbus A350 and 787-8, and is fitting its 787-9s now.",
      "777 and A350 done",
      "777 and A350 complete",
    ]) {
      expect(callsComplete(old, "777"), old).not.toBeNull();
    }
    expect(callsComplete("787-8 done · 787-9 installing", "787-8")).not.toBeNull();
  });
});

describe("no Qatar page or MCP answer calls a type complete beside a table that says otherwise", () => {
  let app: ReturnType<typeof createApp>;
  let home: string;
  let stats: string;
  let list: string;

  beforeAll(async () => {
    app = createApp(seed());
    const page = await bodyOf(app, "/", QR_HOST);
    expect(page.status).toBe(200);
    home = textOf(page.text);
    stats = (await mcpTool(app, QR_HOST, "get_fleet_stats")).text;
    list = (await mcpTool(app, QR_HOST, "list_starlink_aircraft", { limit: 1 })).text;
  });

  test("the table itself reads short of full for the held-back types", () => {
    const rows = [...stats.matchAll(/^- (\S+): (\d+) of (\d+)/gm)].map((m) => ({
      family: m[1],
      starlink: Number(m[2]),
      total: Number(m[3]),
    }));
    const short = rows.filter((r) => /777|787/.test(r.family) && r.starlink < r.total);
    expect(short.length).toBeGreaterThan(0);
    expect(rows.reduce((n, r) => n + r.starlink, 0)).toBe(LISTED.length - HELD);
  });

  test("the Qatar site: first line, header strip, status tile and answers", () => {
    for (const type of HELD_TYPES) expect(callsComplete(home, type), type).toBeNull();
    expect(home).toContain(`except ${HELD} second-hand or leased aircraft that aren't confirmed`);
    expect(home).toContain("A350 done");
    expect(home).not.toContain("777 and A350");
  });

  test("MCP get_fleet_stats", () => {
    expect(stats).not.toContain("whose whole fleet has Starlink");
    expect(stats).toContain(
      `${LISTED.length - HELD} aircraft on the fleet list are of a type the airline reports finished, after leaving out ${HELD} aircraft of those types that aren't confirmed`
    );
    expect(stats).toContain(
      `**Rollout**: ${AIRLINES.QR.rollout.statusLabel} — ${qatarPhaseNote()}`
    );
    for (const type of HELD_TYPES) expect(callsComplete(stats, type), type).toBeNull();
  });

  test("the hub's Qatar page and both llms.txt carry the same phase note", async () => {
    const old = "777, A350 and 787-8 fleets done";
    for (const [path, host] of [
      ["/airlines/qatar", HUB],
      ["/llms.txt", HUB],
      ["/llms.txt", QR_HOST],
    ] as const) {
      const page = await bodyOf(app, path, host);
      expect(page.status, `${host}${path}`).toBe(200);
      const text = textOf(page.text);
      expect(text, `${host}${path}`).toContain(qatarPhaseNote());
      expect(text, `${host}${path}`).not.toContain(old);
    }
  });

  test("MCP list_starlink_aircraft", () => {
    const header = list.split("\n")[0];
    expect(header).not.toContain("fully equipped types");
    expect(header).toContain(`leaving out ${HELD} that aren't confirmed`);
    expect(header).toContain("counted by aircraft type, not checked plane by plane");
  });

  test("the site quotes Qatar's newest dated figure, never a retired one", () => {
    const note = ownFigureNote("QR");
    expect(note).not.toBeNull();
    const facts = factsForCode("QR")?.facts ?? [];
    const newest = facts
      .filter((f) => !f.superseded && f.asOf)
      .map((f) => f.asOf as string)
      .sort()
      .at(-1) as string;
    const own = airlineOwnCount("QR");
    if (note?.kind === "count") {
      expect(note.own).toEqual(own as NonNullable<typeof own>);
      expect(home).toContain(
        `Qatar's own figure is ${note.own.count} as of ${formatFactDate(note.own.asOf)}`
      );
    } else if (note?.kind === "fact") {
      expect(own).toBeNull();
      expect(note.fact.asOf).toBe(newest);
      expect(home).toContain(
        `Newest report on file (${formatFactDate(newest)}): ${note.fact.fact}`
      );
      expect(home).toContain(note.fact.source.label);
    }
    for (const f of facts.filter((f) => f.superseded && f.officialFleetCount !== undefined)) {
      expect(home).not.toContain(`figure was ${f.officialFleetCount}`);
      expect(home).not.toContain(`figure is ${f.officialFleetCount} `);
    }
    expect(home).not.toContain("150 in August 2026");
  });
});

describe("the own-figure line for any by-type airline", () => {
  test("a current counted fact wins; otherwise the newest current dated fact is quoted", () => {
    for (const code of Object.keys(AIRLINES)) {
      const note = ownFigureNote(code);
      const own = airlineOwnCount(code);
      if (own) expect(note).toEqual({ kind: "count", own });
      else if (note) {
        expect(note.kind).toBe("fact");
        if (note.kind === "fact") expect(note.fact.superseded).toBeUndefined();
      }
    }
  });
});
