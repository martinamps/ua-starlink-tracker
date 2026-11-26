/**
 * The answer for an airline held by one dated statement of its own
 * (AirlineConfig.statementRule). It is the airline's word repeated with its
 * date: never a yes or odds of ours, and never a number, because the airline
 * gave none. A flight the statement doesn't cover gets the statement and no
 * verdict.
 */

import type { AirlineConfig, StatementRule } from "./registry";
import { formatFactDate } from "./rollout-facts";

/**
 *  - likely: the statement covers this route on this date.
 *  - needs_route: no schedule is held, so the flight number alone can't be
 *    placed on a route; the caller is asked for both airports.
 *  - not_covered: the route is one the statement doesn't speak for.
 *  - outside_dates: the flight is dated before the statement or past its
 *    end date, or the statement itself is past it and unread since.
 */
export type StatementOutcome = "likely" | "needs_route" | "not_covered" | "outside_dates";

export interface StatementAnswer {
  outcome: StatementOutcome;
  rule: StatementRule;
  /** The route asked about, when both airports were given. */
  route: { origin: string; destination: string } | null;
  sentence: string;
}

export interface StatementAsk {
  origin?: string | null;
  destination?: string | null;
  /** The flight's date, YYYY-MM-DD; absent on an undated ask. */
  date?: string | null;
  /** Today, YYYY-MM-DD. */
  today: string;
}

// "an EI number", "a VS number": by the letter's spoken name.
const article = (code: string) => (/^[AEFHILMNORSX]/.test(code) ? "an" : "a");

function outcomeOf(rule: StatementRule, ask: StatementAsk): StatementOutcome {
  if (ask.today > rule.validThrough) return "outside_dates";
  if (ask.date && (ask.date < rule.asOf || ask.date > rule.validThrough)) return "outside_dates";
  if (!ask.origin || !ask.destination) return "needs_route";
  return rule.covers(ask.origin, ask.destination) ? "likely" : "not_covered";
}

export function statementAnswer(
  cfg: Pick<AirlineConfig, "name" | "iata"> & { statementRule: StatementRule },
  ask: StatementAsk
): StatementAnswer {
  const rule = cfg.statementRule;
  const outcome = outcomeOf(rule, ask);
  const route =
    ask.origin && ask.destination ? { origin: ask.origin, destination: ask.destination } : null;
  const said = `${cfg.name} said on ${formatFactDate(rule.asOf)} that ${rule.claim}`;
  const through = formatFactDate(rule.validThrough);
  const sentence = (() => {
    switch (outcome) {
      case "likely":
        return `Likely yes. ${said}. That holds for flights ${cfg.name} itself operates, not for a flight a partner airline flies under ${article(cfg.iata)} ${cfg.iata} number, and a last-minute aircraft change can alter it.`;
      case "needs_route":
        return `${said}. ${rule.beyond}. We hold no ${cfg.name} schedule, so a flight number alone can't be placed on a route: give the origin and destination airports to get an answer for this flight.`;
      case "not_covered":
        return `No yes or no for ${route?.origin} → ${route?.destination}. ${said}. ${rule.beyond}. We apply its words only to ${rule.coversLabel}: that limit is our choice, not the airline's.`;
      case "outside_dates":
        return ask.today > rule.validThrough
          ? `No yes or no. ${said}. We applied that to flights through ${through}, ${rule.validThroughReason}, and have not read it again since.`
          : `No yes or no for this date. ${said}. We apply that to flights from ${formatFactDate(rule.asOf)} through ${through}, ${rule.validThroughReason}.`;
    }
  })();
  return { outcome, rule, route, sentence };
}

/** The additive wire key. `answer` is the only part that varies by flight. */
export function statementWireField(a: StatementAnswer): Record<string, unknown> {
  return {
    airline_statement: {
      answer: a.outcome,
      quote: a.rule.quote,
      as_of: a.rule.asOf,
      source: { label: a.rule.source.label, url: a.rule.source.url },
      valid_through: a.rule.validThrough,
    },
  };
}
