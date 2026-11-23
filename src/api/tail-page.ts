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
import { pipelinePhrase } from "../components/fleet/pipeline";
import { firstFlightLabel, operatorLabel } from "../components/newly-equipped-page";
import { capitalize, fmt, shortDate, zonedDeparture } from "../components/ui/format";
import type { Tone } from "../components/ui/tone-classes";
import type { ScopedReader } from "../database/reader";
import { unixNow } from "../database/sql/windows";
import type { TailAnswerKind, TailFlight, TailRecord } from "../database/tails";
import { TAIL_RECENT_DAYS, tailFlightPair } from "../database/tails";
import { airportTimezone } from "../utils/airport-tz";
import { article } from "../utils/grammar";

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

/** verified_wifi 'None' means no Wi-Fi installed; it is never a provider name. */
function wifiPhrase(raw: string | null): string {
  return !raw || /^none$/i.test(raw) ? "no Wi-Fi" : `${raw} Wi-Fi`;
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

function answerFor(r: TailRecord, site: string): { answer: string; note: string | null } {
  const { tail } = r;
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
    case "reported":
      return {
        answer: `The community fleet sheet lists ${tail} with Starlink, but our own check of ${site} still reads ${wifiPhrase(r.otherWifi)}.`,
        note: "It is not in our count. An airline's site can take several days to show a new install; this page changes when our check agrees.",
      };
    case "observed":
      return {
        answer: `Our check of ${site} read Starlink on ${tail}, but no fleet list names the plane yet.`,
        note: "It is not in our count until a listing stands behind the reading.",
      };
    case "other":
      return {
        answer: !r.otherWifi
          ? `${tail} does not have Starlink.`
          : /^none$/i.test(r.otherWifi)
            ? `${tail} does not have Starlink. ${capitalize(site)} lists no Wi-Fi on it.`
            : `${tail} does not have Starlink. It has ${wifiPhrase(r.otherWifi)}.`,
        note: null,
      };
    default:
      return {
        answer: `We have no Wi-Fi reading for ${tail} yet.`,
        note: "It is not on any Starlink list we read.",
      };
  }
}

function evidenceFacts(r: TailRecord, cfg: AirlineConfig, site: string): TailFact[] {
  const facts: TailFact[] = [];
  const { listing, checks, fleet } = r;
  const equipped = r.kind === "verified" || r.kind === "listed";
  if (listing?.found && (equipped || r.kind === "reported")) {
    const by = listing.ownDiscovery ? "found by our own check" : "from the community fleet sheet";
    facts.push({
      label: equipped ? "On our list since" : "Sheet listing first seen",
      value: `${shortDate(listing.found)}${listing.foundApprox ? " or earlier" : ""}, ${by}`,
    });
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
  if (r.pipeline) {
    facts.push({
      label: "Install status",
      value: `${capitalize(pipelinePhrase(r.pipeline.state, r.pipeline.mod_location))}, per the ${cfg.shortName} fleet progress sheet${r.pipeline.sheet_updated ? ` (${r.pipeline.sheet_updated})` : ""}`,
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
  return {
    tail,
    airline: cfg.shortName,
    kind: r.kind,
    indexable: r.indexable,
    ...VERDICT[r.kind],
    ...answerFor(r, site),
    typeName: raw ? aircraftName(raw) : null,
    typeHref,
    evidence: evidenceFacts(r, cfg, site),
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

/** "Does N12345 Have Starlink? United 737 MAX 9". */
export function tailPageTitle(m: TailPageModel): string {
  const plane = m.typeName ? `${m.airline} ${m.typeName}` : `${m.airline} aircraft`;
  return `Does ${m.tail} Have Starlink? ${plane}`;
}

/** The search snippet: the verdict, the answer, and the dates behind it. */
export function tailMetaDescription(m: TailPageModel): string {
  const plane = m.typeName ? ` ${m.tail} is ${article(m.airline)} ${m.airline} ${m.typeName}.` : "";
  return `${m.verdict}. ${m.answer}${m.dated ? ` ${m.dated}` : ""}${plane}`;
}
