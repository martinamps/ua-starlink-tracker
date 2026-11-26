/**
 * The answer for an airline held by one dated statement of its own
 * (AirlineConfig.statementRule). It is the airline's word repeated with its
 * date: never a yes or odds of ours, and never a number, because the airline
 * gave none. A flight the statement doesn't cover gets the statement and no
 * verdict.
 */

import type { AirlineConfig, StatementRule, TypeStatementRule } from "./registry";
import { formatFactDate } from "./rollout-facts";
import { statedTypeEcho } from "./stated-type";

/**
 *  - likely: the statement covers this route, or the aircraft type the
 *    caller stated, on this date.
 *  - needs_route: no schedule is held, so the flight number alone can't be
 *    placed on a route; the caller is asked for both airports.
 *  - not_covered: the route is one the statement doesn't speak for.
 *  - needs_type: the statement is about one aircraft type and none was
 *    stated; the caller is asked for the type their booking shows.
 *  - unclear_type: the stated type can name the statement's type or another.
 *  - other_type: the stated type is not the statement's. Never a no.
 *  - outside_dates: the flight is dated before the statement or past its
 *    end date, or the statement itself is past it and unread since.
 */
export type StatementOutcome =
  | "likely"
  | "needs_route"
  | "not_covered"
  | "needs_type"
  | "unclear_type"
  | "other_type"
  | "outside_dates";

export interface StatementAnswer {
  outcome: StatementOutcome;
  rule: StatementRule;
  /** The route asked about, when both airports were given. */
  route: { origin: string; destination: string } | null;
  /** The aircraft type the caller stated, as it may be printed back; null
   * for a route rule and when none was stated. */
  statedType: string | null;
  sentence: string;
}

export interface StatementAsk {
  origin?: string | null;
  destination?: string | null;
  /** The aircraft type the caller's booking shows, for a type rule. */
  aircraftType?: string | null;
  /** The flight's date, YYYY-MM-DD; absent on an undated ask. */
  date?: string | null;
  /** Today, YYYY-MM-DD. */
  today: string;
}

// "an EI number", "a VS number": by the letter's spoken name.
const article = (code: string) => (/^[AEFHILMNORSX]/.test(code) ? "an" : "a");

function typeOutcome(rule: TypeStatementRule, stated: string | null): StatementOutcome {
  if (!stated) return "needs_type";
  const match = rule.matchType(stated);
  return match === "covered" ? "likely" : match === "unclear" ? "unclear_type" : "other_type";
}

function outcomeOf(
  rule: StatementRule,
  ask: StatementAsk,
  stated: string | null
): StatementOutcome {
  if (ask.today > rule.validThrough) return "outside_dates";
  if (ask.date && (ask.date < rule.asOf || ask.date > rule.validThrough)) return "outside_dates";
  if (rule.by === "type") return typeOutcome(rule, stated);
  if (!ask.origin || !ask.destination) return "needs_route";
  return rule.covers(ask.origin, ask.destination) ? "likely" : "not_covered";
}

export function statementAnswer(
  cfg: Pick<AirlineConfig, "name" | "iata"> & { statementRule: StatementRule },
  ask: StatementAsk
): StatementAnswer {
  const rule = cfg.statementRule;
  const statedType =
    rule.by === "type" && ask.aircraftType ? statedTypeEcho(ask.aircraftType) || null : null;
  const outcome = outcomeOf(rule, ask, statedType);
  const route =
    ask.origin && ask.destination ? { origin: ask.origin, destination: ask.destination } : null;
  const when = formatFactDate(rule.asOf);
  // An undated page is never given a day it "said" something on.
  const said =
    rule.asOfKind === "checked"
      ? `${cfg.name}'s own page, checked ${when}, says that ${rule.claim}`
      : `${cfg.name} said on ${when} that ${rule.claim}`;
  const through = formatFactDate(rule.validThrough);
  const partner = `a partner airline flies under ${article(cfg.iata)} ${cfg.iata} number`;
  const sentence = (() => {
    switch (outcome) {
      case "likely":
        return rule.by === "type"
          ? `Likely yes. That holds only if ${rule.typeName} that ${cfg.name} itself flies is on the flight. ${said}. We go by the aircraft type you gave and nothing else: we hold no ${cfg.name} schedule, so we can't check which aircraft flies it. An aircraft ${partner} is not covered, whatever its type, and an aircraft change can alter the answer.`
          : `Likely yes. ${said}. That holds for flights ${cfg.name} itself operates, not for a flight ${partner}, and a last-minute aircraft change can alter it.`;
      case "needs_route":
        return `${said}. ${rule.beyond}. We hold no ${cfg.name} schedule, so a flight number alone can't be placed on a route: give the origin and destination airports to get an answer for this flight.`;
      case "not_covered":
        return `No yes or no for ${route?.origin} → ${route?.destination}. ${said}. ${rule.beyond}. We apply its words only to ${rule.by === "route" ? rule.coversLabel : ""}: that limit is our choice, not the airline's.`;
      case "needs_type":
        return `It depends on the aircraft. ${said}. ${rule.beyond}. We hold no ${cfg.name} schedule, so a flight number alone can't tell us the aircraft: give the aircraft type your booking shows to get an answer for this flight.`;
      case "unclear_type":
        return `No yes or no for the aircraft type given (${statedType}). ${said}. ${rule.by === "type" && rule.unclearNote ? `${rule.unclearNote}. ` : ""}${rule.beyond}.`;
      case "other_type":
        return `No yes or no for the aircraft type given (${statedType}): that is not a no. ${said}. ${rule.beyond}.`;
      case "outside_dates":
        return ask.today > rule.validThrough
          ? `No yes or no. ${said}. We applied that to flights through ${through}, ${rule.validThroughReason}, and have not read it again since.`
          : `No yes or no for this date. ${said}. We apply that to flights from ${when} through ${through}, ${rule.validThroughReason}.`;
    }
  })();
  return { outcome, rule, route, statedType, sentence };
}

/** The additive wire key. `answer` and `aircraft_type` are the only parts
 * that vary by flight. A route rule's key is the five it has always had: the
 * type rule's extra keys appear only on an airline answered by type. */
export function statementWireField(a: StatementAnswer): Record<string, unknown> {
  return {
    airline_statement: {
      answer: a.outcome,
      quote: a.rule.quote,
      as_of: a.rule.asOf,
      source: { label: a.rule.source.label, url: a.rule.source.url },
      valid_through: a.rule.validThrough,
      ...(a.rule.asOfKind ? { as_of_kind: a.rule.asOfKind } : {}),
      ...(a.rule.by === "type" ? { by: "aircraft_type", aircraft_type: a.statedType } : {}),
    },
  };
}
