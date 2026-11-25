/**
 * "Does this plane have Starlink?": the model behind /fleet/{tail}. The answer
 * first, by the one equipped definition, then how we know, what the plane is,
 * and where it flies.
 *
 * Served from the DB only, and every line is one a stored row backs: a fact
 * the tables lack is left off rather than filled in. Flights exist for
 * Starlink planes alone (the updater follows that roster), so a plane without
 * Starlink shows none.
 */

import { aircraftName } from "../airlines/aircraft-families";
import type { AirlineConfig } from "../airlines/registry";
import { fittingPhrase, pipelinePhrase } from "../components/fleet/pipeline";
import { firstFlightLabel, operatorLabel } from "../components/newly-equipped-page";
import { capitalize, fmt, shortDate, zonedDeparture } from "../components/ui/format";
import type { Tone } from "../components/ui/tone-classes";
import type { ScopedReader } from "../database/reader";
import { unixNow } from "../database/sql/windows";
import type { TailAnswerKind, TailFlight, TailRecord } from "../database/tails";
import { TAIL_RECENT_DAYS, tailFlightPair } from "../database/tails";
import type { FleetProgressTailRow } from "../types";
import { airportTimezone } from "../utils/airport-tz";
import { article } from "../utils/grammar";
import { wifiPhrase } from "../utils/reported-reason";
import { utcToday } from "../utils/sheet-mod-note";

/** Rows in each flight list; a tail flies six or more legs a day. */
export const TAIL_FLIGHT_ROWS = 12;

/** Airports named under "where it flies". */
const TAIL_AIRPORT_ROWS = 8;

/** The site each airline's verifier reads, as a reader would name it. */
const CHECK_SITE: Record<NonNullable<AirlineConfig["verifierBackend"]>, string> = {
  united: "united.com",
  "alaska-json": "alaskaair.com",
  "qatar-fltstatus": "qatarairways.com",
};

export interface TailFact {
  label: string;
  value: string;
  href?: string;
}

export interface TailFlightRow {
  flight_number: string;
  /** /check-flight/{number}, when that page serves. */
  flightHref: string | null;
  route: string;
  /** /route-planner/{origin}/{destination}, when the pair is a clean one. */
  routeHref: string | null;
  /** "Mon, Nov 23" and "8:15 AM CST", local to the departure airport. */
  day: string;
  time: string;
  departure_time: number;
}

export interface TailPageModel {
  tail: string;
  /** Short airline name ("United"). */
  airline: string;
  kind: TailAnswerKind;
  indexable: boolean;
  /** The one-word answer and its tone. */
  verdict: string;
  tone: Tone;
  /** The answer in a sentence, then the caveat that belongs with it. */
  answer: string;
  note: string | null;
  /** The install pipeline's state for a tail we do not count ("being installed"). */
  installStatus: string | null;
  /** "737 MAX 9", null when no table names the type. */
  typeName: string | null;
  typeHref: string | null;
  evidence: TailFact[];
  plane: TailFact[];
  /** The dated facts in one sentence, for the search snippet. */
  dated: string | null;
  /** When the FAA rows were read, for the panel's footnote. */
  faaRead: string | null;
  upcoming: TailFlightRow[];
  upcomingTotal: number;
  recent: TailFlightRow[];
  recentTotal: number;
  recentDays: number;
  /** Where the plane left from over the last `days` days, busiest first. */
  departures: {
    days: number;
    total: number;
    airports: Array<{ airport: string; departures: number; href: string | null }>;
  };
}

interface TailPageOptions {
  /** The type page for a raw aircraft type, when this host serves one. */
  typeHrefFor?: (rawType: string) => string | null;
  /** Flight and route permalinks exist on this host. */
  flightLinks?: boolean;
  routeLinks?: boolean;
  /** Whether /routes/{airport} serves for an airport. */
  airportHref?: (airport: string) => string | null;
  nowSec?: number;
}

/** A reading as a noun: "Starlink", "Viasat Wi-Fi", "no Wi-Fi". */
const readingLabel = (raw: string) => (/^starlink$/i.test(raw) ? "Starlink" : wifiPhrase(raw));

const VERDICT: Record<TailAnswerKind, { verdict: string; tone: Tone }> = {
  verified: { verdict: "Yes", tone: "success" },
  listed: { verdict: "Yes, not yet verified", tone: "success" },
  reported: { verdict: "Not confirmed", tone: "warn" },
  observed: { verdict: "Not confirmed", tone: "warn" },
  other: { verdict: "No", tone: "neutral" },
  unchecked: { verdict: "Not checked yet", tone: "neutral" },
};

/** The provider as what our check read, never as what the plane has: the
 * reading can trail an install by days. */
function readingSentence(r: TailRecord, site: string): string {
  if (!r.otherWifi) return "";
  return /^none$/i.test(r.otherWifi)
    ? ` ${capitalize(site)} lists no Wi-Fi on it.`
    : ` Our check of ${site} reads ${wifiPhrase(r.otherWifi)}.`;
}

/**
 * A tail the install pipeline names is in search because of that state, so the
 * state leads its answer instead of a bare "No". "Not verified yet" is for an
 * install the sheet calls finished, "Not yet" for one under way or queued, as
 * on the type pages. Neither is a yes: the tail stays out of the count.
 *
 * The sentences are short on purpose: state, count and reading all have to
 * land inside the search snippet's length, so the mod station stays in the
 * "Install status" row.
 */
const PIPELINE_ANSWER: Record<
  FleetProgressTailRow["state"],
  { verdict: string; tone: Tone; lead: (tail: string) => string; note: string }
> = {
  in_mod: {
    verdict: "Not yet",
    tone: "neutral",
    lead: (tail) => `${tail} is being fitted with Starlink, per the community progress sheet.`,
    note: "This page changes when our own check reads Starlink on the plane.",
  },
  verification_needed: {
    verdict: "Not verified yet",
    tone: "warn",
    lead: (tail) =>
      `The community progress sheet lists ${tail} as fitted with Starlink, awaiting verification.`,
    note: "An airline's site can take several days to show a new install; this page changes when our own check reads Starlink on the plane.",
  },
  scheduled: {
    verdict: "Not yet",
    tone: "neutral",
    lead: (tail) => `${tail} is queued for a Starlink install, per the community progress sheet.`,
    note: "This page changes when our own check reads Starlink on the plane.",
  },
};

/** The pipeline's answer applies where the page would otherwise say "No" or
 * "Not checked yet"; a reported or observed tail keeps its own wording. */
function pipelineAnswer(r: TailRecord) {
  return r.pipeline && (r.kind === "other" || r.kind === "unchecked")
    ? PIPELINE_ANSWER[r.pipeline.state]
    : null;
}

/** A hangar note the sheet is sure of leads the answer the same way, wherever
 * the page would say "No", "Not checked yet" or "Not confirmed": the listing
 * (if any) ran ahead of the install, and the note says where the jet is. */
function fittingAnswer(r: TailRecord) {
  return r.fitting && !r.fitting.unsure && r.kind !== "observed" ? r.fitting : null;
}

const contradictedSentence = (tail: string, site: string, wifi: string | null) =>
  `The community fleet sheet lists ${tail} with Starlink, but our own check of ${site} still reads ${wifiPhrase(wifi)}.`;

/**
 * For a listing whose reads "have not settled" while the rows below show a
 * "Settled reading": that row is the roster's verdict on the plane, and the
 * unsettled one is the listing's. Empty when the row is not shown.
 */
function settledRowNote(r: TailRecord): string {
  const { fleet, listing } = r;
  if (!fleet?.verified_at || !fleet.verified_wifi) return "";
  const listedSec = listing?.found ? Date.parse(`${listing.found}T00:00:00Z`) / 1000 : Number.NaN;
  const reading = `The settled reading below, ${wifiPhrase(fleet.verified_wifi)},`;
  return fleet.verified_at < listedSec
    ? ` ${reading} was made before we saw the listing.`
    : ` ${reading} is our verdict on the plane; no verdict of ours stands on the listing itself yet.`;
}

function answerFor(
  r: TailRecord,
  site: string,
  nowSec: number
): { answer: string; note: string | null } {
  const { tail } = r;
  const fitting = fittingAnswer(r);
  if (fitting) {
    return {
      answer: `${tail} is ${fittingPhrase(fitting, utcToday(nowSec * 1000))}, per the community fleet sheet. Not in our count yet.${readingSentence(r, site)}`,
      note: "The date is the sheet's estimate. This page changes when our own check reads Starlink on the plane.",
    };
  }
  const inPipeline = pipelineAnswer(r);
  if (inPipeline) {
    return {
      answer: `${inPipeline.lead(tail)} Not in our count yet.${readingSentence(r, site)}`,
      note: inPipeline.note,
    };
  }
  switch (r.kind) {
    case "verified":
      return {
        answer: `${tail} has Starlink.`,
        note: `Our own check of ${site} has read Starlink on this plane.`,
      };
    case "listed":
      return {
        answer: `${tail} is listed with Starlink.`,
        note: `Our own check of ${site} has not confirmed it yet. It is in our count.`,
      };
    case "reported": {
      const reason = r.reported?.reason ?? "other_provider";
      const count = "It is not in our count.";
      if (reason === "awaiting_check") {
        const unchecked = (r.reported?.checks_since_listed ?? 0) === 0;
        const before =
          unchecked && r.fleet?.verified_wifi
            ? ` Our last settled reading, ${wifiPhrase(r.fleet.verified_wifi)}, dates from before we saw the listing.`
            : settledRowNote(r);
        return {
          answer: unchecked
            ? `The community fleet sheet lists ${tail} with Starlink. We have not checked it on ${site} since we first saw the listing.`
            : `The community fleet sheet lists ${tail} with Starlink. Our reads of it on ${site} since the listing have not settled on a reading.`,
          note: `${count} We have not confirmed that it has Starlink; this page changes when our own check reads it.${before}`,
        };
      }
      return {
        answer: contradictedSentence(tail, site, r.otherWifi),
        note:
          reason === "no_wifi"
            ? `${count} Our check has never read Starlink on this plane; this page changes when it does.`
            : `${count} An airline's site can take several days to show a new install; this page changes when our check agrees.`,
      };
    }
    case "observed":
      return {
        answer: `Our check of ${site} read Starlink on ${tail}, but no fleet list names the plane yet.`,
        note: "It is not in our count until a listing stands behind the reading.",
      };
    case "other":
      // Past the log's window /fleet still marks the cell, so the page still
      // names the listing. The answer stays "No" and the page out of search.
      if (r.sheetListing) {
        return {
          answer: contradictedSentence(tail, site, r.sheetListing.observed_wifi ?? r.otherWifi),
          note: "It is not in our count: our check has not agreed with the listing. This page changes if it does.",
        };
      }
      return { answer: `${tail} does not have Starlink.${readingSentence(r, site)}`, note: null };
    default:
      return {
        answer: `We have no Wi-Fi reading for ${tail} yet.`,
        note: "It is not on any Starlink list we read.",
      };
  }
}

function evidenceFacts(r: TailRecord, site: string, nowSec: number): TailFact[] {
  const facts: TailFact[] = [];
  const { listing, checks, fleet } = r;
  const equipped = r.kind === "verified" || r.kind === "listed";
  const marked = r.kind === "reported" || r.sheetListing !== null;
  if (listing?.found && (equipped || marked)) {
    const by = listing.ownDiscovery ? "found by our own check" : "from the community fleet sheet";
    facts.push({
      label: equipped ? "On our list since" : "Sheet listing first seen",
      value: `${shortDate(listing.found)}${listing.foundApprox ? " or earlier" : ""}, ${by}`,
    });
  } else if (r.sheetListing && r.kind !== "reported") {
    facts.push({ label: "Community fleet sheet", value: "Lists this plane with Starlink" });
  }
  // The settled reading is the consensus of several checks; the latest check
  // is one reading and can disagree with it, so each is shown under its name.
  if (fleet?.verified_at && fleet.verified_wifi) {
    facts.push({
      label: "Settled reading",
      value: `${capitalize(readingLabel(fleet.verified_wifi))}, as of ${shortDate(fleet.verified_at)}`,
    });
  }
  if (checks.last) {
    facts.push({
      label: "Latest check",
      value: `${shortDate(checks.last.checked_at)}: ${site} showed ${readingLabel(checks.last.wifi_provider)}`,
    });
    facts.push({
      label: "Checks on record",
      value: `${fmt(checks.starlink)} of ${fmt(checks.total)} read Starlink${checks.since ? `, since ${shortDate(checks.since)}` : ""}`,
    });
  }
  if (r.fitting) {
    facts.push({
      label: "Install status",
      value: `${capitalize(fittingPhrase(r.fitting, utcToday(nowSec * 1000)))}, per the community fleet sheet's notes`,
    });
  } else if (r.pipeline) {
    facts.push({
      label: "Install status",
      value: `${capitalize(pipelinePhrase(r.pipeline.state, r.pipeline.mod_location))}, per the community progress sheet${r.pipeline.sheet_updated ? ` (${r.pipeline.sheet_updated})` : ""}`,
    });
  }
  if (r.firstFlight) {
    facts.push({
      label: "First seen flying Starlink",
      value: `${firstFlightLabel(r.firstFlight)}, ${shortDate(r.firstFlight.departed_at)}`,
    });
  }
  return facts;
}

function datedSentence(r: TailRecord): string | null {
  const equipped = r.kind === "verified" || r.kind === "listed";
  const parts = [
    equipped && r.listing?.found
      ? `on our list since ${shortDate(r.listing.found)}${r.listing.foundApprox ? " or earlier" : ""}`
      : null,
    r.checks.last ? `last checked ${shortDate(r.checks.last.checked_at)}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? `${capitalize(parts.join(", "))}.` : null;
}

function planeFacts(r: TailRecord, cfg: AirlineConfig, typeHref: string | null): TailFact[] {
  const facts: TailFact[] = [];
  const raw = r.fleet?.aircraft_type ?? r.listing?.aircraft ?? null;
  if (raw) {
    const name = aircraftName(raw);
    facts.push({
      label: "Type",
      value: name === raw ? name : `${name} (${raw})`,
      ...(typeHref ? { href: typeHref } : {}),
    });
  }
  const subfleet = r.fleet?.fleet ?? r.listing?.fleet ?? null;
  const operator = operatorLabel(r.fleet?.operated_by ?? r.listing?.operated_by ?? null, cfg.name);
  if (subfleet === "mainline") {
    facts.push({ label: "Operated by", value: `${cfg.name} (mainline)` });
  } else if (operator) {
    facts.push({ label: "Operated by", value: operator });
  } else if (subfleet === "express") {
    facts.push({ label: "Operated by", value: `${cfg.shortName} Express` });
  }
  if (r.fleet?.ship_number) facts.push({ label: "Ship number", value: r.fleet.ship_number });
  const faa = r.faa;
  if (faa) {
    if (faa.faa_model) facts.push({ label: "FAA model", value: faa.faa_model });
    if (faa.year_mfr) facts.push({ label: "Built", value: faa.year_mfr });
    if (faa.serial) facts.push({ label: "Serial number", value: faa.serial });
    if (faa.registrant) facts.push({ label: "Registered owner", value: faa.registrant });
    if (faa.mode_s_hex) facts.push({ label: "Mode S code", value: faa.mode_s_hex });
    if (faa.dereg_date) facts.push({ label: "Deregistered", value: faa.dereg_date });
  }
  return facts;
}

function flightRow(f: TailFlight, opts: TailPageOptions): TailFlightRow {
  const at = zonedDeparture(f.departure_time, airportTimezone(f.origin));
  const pair = tailFlightPair(f);
  return {
    flight_number: f.flight_number,
    flightHref: opts.flightLinks && f.linkable ? `/check-flight/${f.flight_number}` : null,
    route: f.destination ? `${f.origin} to ${f.destination}` : `from ${f.origin}`,
    routeHref: opts.routeLinks && pair ? `/route-planner/${pair.origin}/${pair.destination}` : null,
    day: at.day,
    time: at.time,
    departure_time: f.departure_time,
  };
}

export function buildTailPage(
  cfg: AirlineConfig,
  reader: ScopedReader,
  tail: string,
  opts: TailPageOptions = {}
): TailPageModel | null {
  const nowSec = opts.nowSec ?? unixNow();
  const r = reader.getTailRecord(tail);
  if (!r) return null;
  const site = cfg.verifierBackend ? CHECK_SITE[cfg.verifierBackend] : `${cfg.shortName}'s site`;
  const equipped = r.kind === "verified" || r.kind === "listed";
  // Only an equipped tail is tracked; a stale row for one that left the list
  // would read as "this plane flies with Starlink".
  const upcoming = equipped ? reader.getTailUpcomingFlights(tail) : [];
  const recent = equipped ? reader.getTailRecentFlights(tail) : [];
  const departures = equipped
    ? reader.getTailDepartures(tail)
    : { days: 0, total: 0, airports: [] };
  const raw = r.fleet?.aircraft_type ?? r.listing?.aircraft ?? null;
  const typeHref = raw ? (opts.typeHrefFor?.(raw) ?? null) : null;
  const inPipeline = pipelineAnswer(r);
  const fitting = fittingAnswer(r);
  return {
    tail,
    airline: cfg.shortName,
    kind: r.kind,
    indexable: r.indexable,
    ...VERDICT[r.kind],
    ...(inPipeline ? { verdict: inPipeline.verdict, tone: inPipeline.tone } : {}),
    ...(fitting ? { verdict: "Not yet", tone: "neutral" as const } : {}),
    ...answerFor(r, site, nowSec),
    installStatus: fitting
      ? "being fitted"
      : inPipeline && r.pipeline
        ? pipelinePhrase(r.pipeline.state, null)
        : null,
    typeName: raw ? aircraftName(raw) : null,
    typeHref,
    evidence: evidenceFacts(r, site, nowSec),
    plane: planeFacts(r, cfg, typeHref),
    dated: datedSentence(r),
    faaRead: r.faa ? shortDate(r.faa.last_refreshed) : null,
    upcoming: upcoming
      .filter((f) => f.departure_time >= nowSec)
      .slice(0, TAIL_FLIGHT_ROWS)
      .map((f) => flightRow(f, opts)),
    upcomingTotal: upcoming.length,
    recent: recent.slice(0, TAIL_FLIGHT_ROWS).map((f) => flightRow(f, opts)),
    recentTotal: recent.length,
    recentDays: TAIL_RECENT_DAYS,
    departures: {
      ...departures,
      airports: departures.airports.slice(0, TAIL_AIRPORT_ROWS).map((a) => ({
        ...a,
        href: opts.airportHref?.(a.airport) ?? null,
      })),
    },
  };
}

/** "Does N12345 Have Starlink? United 737 MAX 9", with the install state
 * ahead of the plane for a tail in the pipeline ("Being installed, United…"). */
export function tailPageTitle(m: TailPageModel): string {
  const plane = m.typeName ? `${m.airline} ${m.typeName}` : `${m.airline} aircraft`;
  const status = m.installStatus ? `${capitalize(m.installStatus)}, ` : "";
  return `Does ${m.tail} Have Starlink? ${status}${plane}`;
}

/** The search snippet: the verdict, the answer, and the dates behind it. A
 * pipeline tail's answer opens on its install state, which is the verdict in
 * full, so the one-word form is left off to keep the reading inside the clamp. */
export function tailMetaDescription(m: TailPageModel): string {
  const plane = m.typeName ? ` ${m.tail} is ${article(m.airline)} ${m.airline} ${m.typeName}.` : "";
  const verdict = m.installStatus ? "" : `${m.verdict}. `;
  return `${verdict}${m.answer}${m.dated ? ` ${m.dated}` : ""}${plane}`;
}
