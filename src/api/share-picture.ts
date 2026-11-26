/**
 * What a page's share picture says: /share/{flight|tail|airport}/….png, the
 * og:image of a flight answer, a tail page and an airport page.
 *
 * A picture never says more than its page. Each builder here reads the model
 * the page itself renders and copies the page's own words: the figure is the
 * page's verdict or headline number, the sentence is the page's sentence. A
 * page that is kept out of search, or has no answer, gets no picture (null),
 * and its og:image stays the site's card.
 */

import type { SiteConfig } from "../airlines/registry";
import { type FlightAnswer, datePassed, renderFlightAnswer } from "../client/flight-answer";
import { answerContext } from "../components/check-flight-page";
import type { DatedAnswer, FlightFacts } from "../components/check-flight/types";
import { usualAnswer } from "../components/check-flight/usual";
import { fmt, probLabel, shortDate } from "../components/ui/format";
import { PROB_TIER_TONE, type Tone } from "../components/ui/tone-classes";
import type { ShareCard } from "../share/card";
import { isRealIsoDate } from "../utils/airport-tz";
import { type AirportBoard, airportDek } from "./airport-board";
import type { TailPageModel } from "./tail-page";

export type ShareAnswer = Pick<
  ShareCard,
  "subject" | "context" | "figure" | "tone" | "caption" | "sentence"
>;

export type SharePictureKind = "flight" | "tail" | "airport";

export interface SharePictureRequest {
  kind: SharePictureKind;
  /** The path segment as sent: letters, digits and hyphens only. Still the
   * caller's text; the handler accepts it only as an identifier it resolves. */
  id: string;
  date: string | null;
}

const SHARE_PATH =
  /^\/share\/(flight|tail|airport)\/([A-Za-z0-9-]{2,10})(?:\/(\d{4}-\d{2}-\d{2}))?\.png$/;

/** One spelling per picture: anything else (a suffix, an escape, a query-only
 * variant of the path, a date on a tail) is not a picture address. */
export function parseSharePicturePath(pathname: string): SharePictureRequest | null {
  const m = SHARE_PATH.exec(pathname);
  if (!m) return null;
  const kind = m[1] as SharePictureKind;
  const date = m[3] ?? null;
  if (date && (kind !== "flight" || !isRealIsoDate(date))) return null;
  return { kind, id: m[2] as string, date };
}

export function sharePicturePath(kind: SharePictureKind, id: string, date?: string | null): string {
  return `/share/${kind}/${id}${date ? `/${date}` : ""}.png`;
}

const FLIGHT_QUESTION = "Does this flight have Starlink?";

const ODDS_CAPTION = "Chance of Starlink, no aircraft assignment yet";

const ANSWER_FIGURE: Record<
  FlightAnswer["tone"],
  { figure: string | null; tone: Tone; caption: string }
> = {
  yes: { figure: "Yes", tone: "success", caption: FLIGHT_QUESTION },
  no: { figure: "No", tone: "neutral", caption: FLIGHT_QUESTION },
  // A forecast prints its odds, never a yes.
  likely: { figure: null, tone: PROB_TIER_TONE.likely, caption: ODDS_CAPTION },
  maybe: { figure: null, tone: PROB_TIER_TONE.maybe, caption: ODDS_CAPTION },
  unlikely: { figure: null, tone: PROB_TIER_TONE.unlikely, caption: ODDS_CAPTION },
  unknown: { figure: "Not sure yet", tone: "neutral", caption: FLIGHT_QUESTION },
};

/**
 * The dated page's answer card as a picture, or null where the dated URL has
 * no answer of its own to show: no card rendered, an error, or a date that has
 * passed (that card only says we keep no old assignments). The page then
 * shares the flight's undated picture.
 */
function datedFlightShareAnswer(
  site: SiteConfig,
  dated: DatedAnswer | undefined,
  flight: FlightFacts
): ShareAnswer | null {
  if (!dated || dated.body.error) return null;
  const ctx = answerContext(site, dated, flight);
  if (datePassed(ctx)) return null;
  const answer = renderFlightAnswer(dated.body, ctx);
  const shape = ANSWER_FIGURE[answer.tone];
  const p = dated.body.prediction?.probability;
  const figure = shape.figure ?? (typeof p === "number" ? probLabel(p) : null);
  if (figure === null) return null;
  return {
    subject: dated.flightNumber,
    context: shortDate(dated.date),
    figure,
    tone: shape.tone,
    caption: shape.caption,
    sentence: answer.headline,
  };
}

function flightShareAnswer(flight: FlightFacts): ShareAnswer {
  const usual = usualAnswer(flight);
  const route = flight.routes[0];
  return {
    subject: flight.flightNumber,
    context: route ? `${route.departure_airport} to ${route.arrival_airport}` : null,
    figure: usual.figure,
    tone: usual.tone,
    caption: usual.caption,
    sentence: usual.sentence,
  };
}

/** Which picture a flight page shares: the dated answer's where the dated
 * URL has one, else the flight's undated one. */
export function flightSharePicture(
  site: SiteConfig,
  flight: FlightFacts,
  dated: DatedAnswer | undefined
): { path: string; answer: ShareAnswer } {
  const datedShare = datedFlightShareAnswer(site, dated, flight);
  return datedShare && dated
    ? { path: sharePicturePath("flight", flight.flightNumber, dated.date), answer: datedShare }
    : { path: sharePicturePath("flight", flight.flightNumber), answer: flightShareAnswer(flight) };
}

/** The verdict the page leads with. A tail in the install pipeline carries
 * its install status under the verdict, as its title does, never a bare no. */
export function tailShareAnswer(m: TailPageModel): ShareAnswer | null {
  if (!m.indexable) return null;
  return {
    subject: m.tail,
    context: m.typeName ? `${m.airline} ${m.typeName}` : `${m.airline} aircraft`,
    figure: m.verdict,
    tone: m.tone,
    caption: m.installStatus ? `Starlink: ${m.installStatus}` : "Does this plane have Starlink?",
    sentence: m.answer,
  };
}

/** The page's first stat: Starlink departures assigned in the window. */
export function airportShareAnswer(board: AirportBoard): ShareAnswer | null {
  const n = board.departures.length;
  if (!board.indexable || (n === 0 && board.history.starlink === 0)) return null;
  return {
    subject: board.airport,
    context: `${board.airline} departures`,
    figure: fmt(n),
    tone: n > 0 ? "success" : "neutral",
    caption: `Starlink ${n === 1 ? "departure" : "departures"} assigned in the next ${board.windowHours} hours`,
    sentence: airportDek(board),
  };
}

/** YYYY-MM-DD of a data stamp; null when it is missing or unparseable, and
 * then no picture is drawn: an undated picture could pass for today's. */
export function sharePictureDate(lastUpdated: string | null | undefined): string | null {
  const t = Date.parse(lastUpdated ?? "");
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}
