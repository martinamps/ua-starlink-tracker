#!/usr/bin/env bun
/**
 * Air France per-tail Starlink status from the FlyerTalk "Complete Guide to
 * the Air France Fleet" wikipost (thread #2213677, curated by hellolaurent).
 *
 * Unlike the AS/QR threads this is one curated list covering the whole fleet:
 * every tail sits under a section header naming its exact type, marked
 * ★ (Starlink), ☆ (legacy WiFi) or unmarked. It is community data, so it is
 * written at the "community" evidence tier — "likely", never "verified" — and
 * it never writes a negative: an unmarked tail is unknown to us, not a no.
 *
 * FlyerTalk 403s the prod ASN; ship through residential-sync.
 *
 *   bun run flyertalk-airfrance --dry-run            # fetch + parse, print counts
 *   bun run flyertalk-airfrance                      # fetch + apply to DB_PATH
 *   bun run flyertalk-airfrance --demote-delisted    # also apply curator removals
 */

import type { Database } from "bun:sqlite";
import { AIRLINES, COMMUNITY_SOURCE_UPDATED_META, programTypeOf } from "../airlines/registry";
import {
  type FleetGuideRow,
  type GuideMark,
  initializeDatabase,
  refreshFleetMeta,
  replaceFleetGuide,
  setMeta,
  stampLastUpdatedAt,
} from "../database/database";
import { BROWSER_USER_AGENT } from "../utils/constants";
import { info, error as logError, warn } from "../utils/logger";
import { type FlyertalkFetcher, applyFlyertalkTails, fetchFlyertalk } from "./flyertalk-common";

const AF = AIRLINES.AF;
const THREAD_ID = 2213677;
const THREAD_URL = `https://www.flyertalk.com/forum/air-france-frequence-plus/${THREAD_ID}-complete-guide-air-france-fleet.html`;
const GID = "flyertalk_af" as const;
const HOP_OPERATOR = "Air France HOP";

// Structural bounds on the parse. A layout change that the regexes survive
// must still fail these rather than ship a wrong list.
const MIN_SECTIONS = 15;
const MIN_TAILS = 200;
const MAX_TAILS = 400;
/** More curator removals than this in one run reads as a parse or curator
 * regression, not a fleet change — refuse rather than report them. */
export const MAX_DELISTED = 10;

const HEADERS = {
  "User-Agent": BROWSER_USER_AGENT,
  Accept: "text/html",
  "Accept-Language": "en-US,en;q=0.5",
};

export interface GuideTail {
  tail: string;
  mark: GuideMark;
  section: string;
  programType: string;
  operator: string | null;
}

export interface ParsedGuide {
  /** Curator's own "last updated" date, YYYY-MM-DD. */
  updatedAt: string;
  sections: number;
  tails: GuideTail[];
  /** ★ tails in sections whose Wi-Fi legend doesn't mention Starlink — the
   * curator's per-tail mark wins, but a drifting count is worth seeing. */
  legendMismatch: number;
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const TAIL_TOKEN = new RegExp(`^(${AF.tailPattern.source.slice(1, -1)})\\s*([★☆]?)$`);

function tailTokens(line: string): Array<{ tail: string; mark: GuideMark }> | null {
  const parts = line.split("/").map((p) => p.trim());
  const out: Array<{ tail: string; mark: GuideMark }> = [];
  for (const p of parts) {
    const m = p.match(TAIL_TOKEN);
    if (!m) return null;
    out.push({ tail: m[1], mark: m[2] === "★" ? "starlink" : m[2] === "☆" ? "legacy" : "none" });
  }
  return out;
}

const DETAIL_LINE = /^(Configuration|Wi-?Fi|[A-Z]{1,2} seat)\b/i;

export function parseAirFranceGuide(html: string): ParsedGuide {
  const block = html.match(
    new RegExp(`id="wikipost-${THREAD_ID}"[\\s\\S]*?END WIKIPOST`, "i")
  )?.[0];
  if (!block) throw new Error("wikipost block not found — page layout changed");

  // Tags out first, entities second: a decoded "<" must never read as a tag.
  const text = decodeEntities(block.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""));
  const footer = text.match(/last updated (\d{1,2}) ([A-Za-z]+) (\d{4})/i);
  const month = footer ? MONTHS.indexOf(footer[2].toLowerCase()) : -1;
  if (!footer || month < 0) throw new Error("wikipost footer not found — no curator date");
  const updatedAt = `${footer[3]}-${String(month + 1).padStart(2, "0")}-${footer[1].padStart(2, "0")}`;

  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const tails: GuideTail[] = [];
  const seen = new Set<string>();
  let sections = 0;
  let legendMismatch = 0;
  let operator: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const tokens = tailTokens(lines[i]);
    if (tokens) continue;
    const next = lines[i + 1] ? tailTokens(lines[i + 1]) : null;
    if (!next) {
      // A group heading ("Air France HOP!", "Narrow-body …:") scopes the
      // operator of every section under it.
      if (!DETAIL_LINE.test(lines[i])) operator = /\bHOP\b/i.test(lines[i]) ? HOP_OPERATOR : null;
      continue;
    }
    const header = lines[i];
    const { key } = programTypeOf(AF, header);
    if (key === "other" || key === "unknown") {
      throw new Error(`guide structure changed: section "${header}" names no known type`);
    }
    // The guide always names the 777 variant; a bare one would blend a type
    // that is mostly done with one that has not started.
    if (key === "B777") throw new Error(`guide structure changed: "${header}" has no 777 variant`);
    sections++;
    const legend = lines.slice(i + 2, i + 8).find((l) => /^Wi-?Fi/i.test(l)) ?? "";
    for (const t of next) {
      if (seen.has(t.tail)) throw new Error(`guide structure changed: ${t.tail} listed twice`);
      seen.add(t.tail);
      if (t.mark === "starlink" && !legend.includes("★")) legendMismatch++;
      tails.push({ ...t, section: header, programType: key, operator });
    }
    i++;
  }

  if (sections < MIN_SECTIONS) {
    throw new Error(`guide structure changed: ${sections} sections (< ${MIN_SECTIONS})`);
  }
  if (tails.length < MIN_TAILS || tails.length > MAX_TAILS) {
    throw new Error(
      `guide structure changed: ${tails.length} tails (outside ${MIN_TAILS}–${MAX_TAILS})`
    );
  }
  return { updatedAt, sections, tails, legendMismatch };
}

export async function fetchAirFranceGuide(fetcher?: FlyertalkFetcher): Promise<ParsedGuide> {
  const { html } = await fetchFlyertalk(THREAD_URL, THREAD_ID, HEADERS, fetcher);
  return parseAirFranceGuide(html);
}

export interface AirFranceApplyResult {
  written: number;
  starlink: number;
  /** ★ tails not on the FR24 roster (not delivered, or retired). */
  absent: string[];
  /** ★ tails whose roster type is a different programme type than their
   * guide section (e.g. a -200ER listed under -300ER). */
  mismatch: string[];
  /** Ingested ★ tails the guide no longer marks. */
  delisted: string[];
  demoted: number;
  legendMismatch: number;
}

export class AirFranceApplyRefused extends Error {
  override name = "AirFranceApplyRefused";
  readonly code = 2;
}

export function applyAirFranceGuide(
  db: Database,
  guide: ParsedGuide,
  opts: { demoteDelisted?: boolean } = {}
): AirFranceApplyResult {
  const roster = new Map(
    (
      db
        .query("SELECT tail_number, aircraft_type FROM united_fleet WHERE airline = ?")
        .all(AF.code) as { tail_number: string; aircraft_type: string | null }[]
    ).map((r) => [r.tail_number, r.aircraft_type])
  );
  if (roster.size < AF.minFleetSanity) {
    throw new AirFranceApplyRefused(
      `AF roster has ${roster.size} rows (< ${AF.minFleetSanity}); run fleet sync first`
    );
  }

  const starlink = guide.tails.filter((t) => t.mark === "starlink");
  const starSet = new Set(starlink.map((t) => t.tail));
  const ingested = (
    db
      .query("SELECT TailNumber FROM starlink_planes WHERE airline = ? AND sheet_gid = ?")
      .all(AF.code, GID) as { TailNumber: string }[]
  ).map((r) => r.TailNumber);
  const delisted = ingested.filter((t) => !starSet.has(t)).sort();
  if (delisted.length > MAX_DELISTED) {
    throw new AirFranceApplyRefused(
      `${delisted.length} ingested tails lost their ★ (> ${MAX_DELISTED}); refusing — check the guide by hand`
    );
  }

  const absent: string[] = [];
  const mismatch: string[] = [];
  const byTail = new Map(starlink.map((t) => [t.tail, t]));
  const written = applyFlyertalkTails(
    db,
    starlink.map((t) => t.tail),
    {
      airline: "AF",
      gid: GID,
      operator: AF.name,
      fleetOperator: null,
      evidence: "community",
      gateLabel: "roster + programme-type gated",
      gate: (tail) => {
        const g = byTail.get(tail);
        if (!g || !roster.has(tail)) {
          absent.push(tail);
          return null;
        }
        const aircraftType = roster.get(tail) ?? null;
        if (programTypeOf(AF, aircraftType).key !== g.programType) {
          mismatch.push(tail);
          return null;
        }
        return { aircraftType, ...(g.operator ? { operator: g.operator } : {}) };
      },
    }
  );

  const rows: FleetGuideRow[] = guide.tails.map((t) => ({
    tail: t.tail,
    section: t.section,
    programType: t.programType,
    mark: t.mark,
  }));
  const iso = new Date(`${guide.updatedAt}T00:00:00Z`).toISOString();
  replaceFleetGuide(db, AF.code, rows, iso);
  setMeta(db, COMMUNITY_SOURCE_UPDATED_META, iso, AF.code);
  stampLastUpdatedAt(db, AF.code, "community-sync", iso);

  let demoted = 0;
  if (opts.demoteDelisted && delisted.length > 0) {
    // A curator correction: back to unknown, never negative — the guide not
    // marking a tail is not evidence it lacks Starlink.
    db.transaction(() => {
      for (const tail of delisted) {
        db.query(
          "UPDATE united_fleet SET starlink_status = 'unknown' WHERE tail_number = ? AND airline = ? AND starlink_status = 'confirmed'"
        ).run(tail, AF.code);
        demoted += db
          .query(
            "DELETE FROM starlink_planes WHERE TailNumber = ? AND airline = ? AND sheet_gid = ?"
          )
          .run(tail, AF.code, GID).changes;
      }
    })();
    refreshFleetMeta(db, AF.code);
  } else if (delisted.length > 0) {
    warn(
      `FlyerTalk AF: ${delisted.length} ingested tail(s) no longer ★ (${delisted.join(" ")}) — reported, not demoted`
    );
  }

  return {
    written,
    starlink: starlink.length,
    absent: absent.sort(),
    mismatch: mismatch.sort(),
    delisted,
    demoted,
    legendMismatch: guide.legendMismatch,
  };
}

/** Per-programme-type ★/total, for --dry-run and the residential-sync report. */
export function guideTypeCounts(guide: ParsedGuide): Record<string, string> {
  const by = new Map<string, [number, number]>();
  for (const t of guide.tails) {
    const v = by.get(t.programType) ?? [0, 0];
    v[1]++;
    if (t.mark === "starlink") v[0]++;
    by.set(t.programType, v);
  }
  return Object.fromEntries([...by].sort().map(([k, [s, n]]) => [k, `${s}/${n}`]));
}

if (import.meta.main) {
  const argv = new Set(process.argv.slice(2));
  const run = async () => {
    const guide = await fetchAirFranceGuide();
    const stars = guide.tails.filter((t) => t.mark === "starlink").length;
    const summary = {
      updatedAt: guide.updatedAt,
      sections: guide.sections,
      tails: guide.tails.length,
      starlink: stars,
      legendMismatch: guide.legendMismatch,
      byType: guideTypeCounts(guide),
    };
    if (argv.has("--dry-run")) {
      console.log(JSON.stringify(summary, null, 2));
      console.log("\n(dry-run — pass without --dry-run to write)\n");
      return;
    }
    const db = initializeDatabase();
    try {
      const r = applyAirFranceGuide(db, guide, { demoteDelisted: argv.has("--demote-delisted") });
      info(`FlyerTalk AF sync: ${JSON.stringify({ ...summary, ...r })}`);
    } finally {
      db.close();
    }
  };
  run().catch((e) => {
    logError("FlyerTalk AF sync failed", e);
    process.exit((e as { code?: number }).code ?? 1);
  });
}
