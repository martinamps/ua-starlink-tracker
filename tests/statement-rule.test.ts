/**
 * An airline answered from its own dated statement alone (Aer Lingus): the
 * route the caller gives is the whole of what places the flight. The answer
 * is the airline's word with its date, never a yes, a no or a number of ours,
 * it reads nothing outside the process, and it ends on the rule's end date.
 */
import { describe, expect, test } from "bun:test";
import { AIRLINES, hubContentAirlines, publicAirlines } from "../src/airlines/registry";
import { factsBySlug } from "../src/airlines/rollout-facts";
import { statementAnswer } from "../src/airlines/statement-rule";
import {
  type FlightVerdict,
  parseLegQuery,
  resolveFlightVerdict,
  verdictSummary,
  verdictTelemetry,
  withLeg,
} from "../src/api/check-flight-core";
import { VALID_SCOPES } from "../src/api/mcp-server";
import { carrierCode, checkAnyHtml } from "../src/client/flight-search";
import { createReaderFactory } from "../src/database/reader";
import { carrierPrediction, describeCarrierPrediction } from "../src/scripts/starlink-predictor";
import { createApp } from "../src/server/app";
import { bodyOf, elementAttrs, jsonOf, makeFreshDb, mcpTool, postMcp } from "./helpers";

const HUB = "airlinestarlinktracker.com";
const UA = "unitedstarlinktracker.com";
const EI = AIRLINES.EI;
const rule = EI.statementRule;
if (!rule) throw new Error("Aer Lingus has no statement rule");
const cfg = { name: EI.name, iata: EI.iata, statementRule: rule };

// Inside the rule's dates whatever day the suite runs.
const TODAY = "2026-11-26";
const FLIGHT_DAY = "2026-12-01";
const NOW = Date.parse(`${TODAY}T12:00:00Z`) / 1000;

const db = makeFreshDb();
const app = createApp(db);
const reader = createReaderFactory(db)("EI");

const ask = (origin?: string, destination?: string, date: string | null = FLIGHT_DAY) =>
  statementAnswer(cfg, { origin, destination, date, today: TODAY });

// Aer Lingus's North American destinations, from its destination list.
const NORTH_AMERICA = [
  "JFK",
  "EWR",
  "BOS",
  "ORD",
  "PHL",
  "IAD",
  "MCO",
  "MIA",
  "SFO",
  "LAX",
  "SEA",
  "LAS",
  "BDL",
  "CLE",
  "IND",
  "PIT",
  "RDU",
  "BNA",
  "MSP",
  "DEN",
  "YYZ",
  "CUN",
];

describe("the registry entry", () => {
  test("answers hub lookups and joins no fleet, homepage or content surface", () => {
    expect(EI.hubFlightLookup).toBe(true);
    expect(publicAirlines()).not.toContain(EI);
    expect(hubContentAirlines()).not.toContain(EI);
    expect(EI.fr24Slug).toBeUndefined();
    expect(EI.verifierBackend ?? null).toBeNull();
    expect(EI.communitySource).toBeUndefined();
    expect(EI.flightHistoryModel).toBe(false);
  });

  test("the statement is one of the dated facts on file, from the same page", () => {
    const facts = factsBySlug("aer-lingus")?.facts ?? [];
    const fact = facts.find((f) => f.source.url === rule.source.url);
    expect(fact?.asOf).toBe(rule.asOf);
    expect(fact?.superseded).toBeFalsy();
    expect(rule.source.url).toMatch(/^https:\/\/mediacentre\.aerlingus\.com\//);
  });

  test("the claim says no more than the quote: routes, never aircraft or a fleet", () => {
    expect(rule.quote).toContain("transatlantic routes");
    expect(rule.claim).toContain("transatlantic routes");
    for (const words of [rule.claim, rule.beyond, rule.coversLabel]) {
      expect(words).not.toMatch(/every aircraft|all aircraft|whole fleet|entire fleet|\d+%/i);
    }
  });

  test("it ends on a real date after the statement", () => {
    expect(rule.validThrough).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(rule.validThrough > rule.asOf).toBe(true);
  });

  test("no scoped MCP server exists for it", () => {
    expect(VALID_SCOPES).not.toContain("EI");
  });
});

describe("which routes the statement covers", () => {
  test.each(NORTH_AMERICA)("Ireland and %s, either way round", (far) => {
    for (const home of ["DUB", "SNN"]) {
      expect(rule.covers(home, far)).toBe(true);
      expect(rule.covers(far, home)).toBe(true);
    }
  });

  test.each([
    ["DUB", "LHR", "a European flight"],
    ["DUB", "CDG", "a European flight"],
    ["DUB", "SNN", "a flight inside Ireland"],
    ["LHR", "JFK", "Britain to North America: a partner's aircraft under an EI number"],
    ["MAN", "MCO", "Manchester, which Aer Lingus no longer flies the Atlantic from"],
    ["DUB", "BGI", "the Caribbean, which it doesn't fly"],
    ["JFK", "BOS", "two North American airports"],
    ["DUB", "ZZZ", "an airport we don't know"],
    ["QQQ", "JFK", "an airport we don't know"],
    ["DUB", "DUB", "the same airport twice"],
  ])("%s to %s is not covered (%s)", (o, d) => {
    expect(rule.covers(o, d)).toBe(false);
    expect(rule.covers(d, o)).toBe(false);
  });
});

describe("statementAnswer", () => {
  test("a covered route is a likely yes in the airline's dated words, with both cautions", () => {
    const a = ask("DUB", "JFK");
    expect(a.outcome).toBe("likely");
    expect(a.sentence).toStartWith("Likely yes. Aer Lingus said on Nov 18, 2026 that ");
    expect(a.sentence).toContain(rule.claim);
    expect(a.sentence).toContain("flights Aer Lingus itself operates");
    expect(a.sentence).toContain("partner airline");
    expect(a.sentence).toContain("aircraft change");
    expect(a.route).toEqual({ origin: "DUB", destination: "JFK" });
  });

  test.each([
    [undefined, undefined],
    ["DUB", undefined],
    [undefined, "JFK"],
  ])("without both airports (%s, %s) it asks for the route and gives no verdict", (o, d) => {
    const a = ask(o, d);
    expect(a.outcome).toBe("needs_route");
    expect(a.route).toBeNull();
    expect(a.sentence).toContain("Aer Lingus said on Nov 18, 2026");
    expect(a.sentence).toContain("origin and destination");
    expect(a.sentence).not.toMatch(/likely|yes/i);
  });

  test("a route the statement doesn't cover gets the statement and no yes or no", () => {
    const a = ask("DUB", "LHR");
    expect(a.outcome).toBe("not_covered");
    expect(a.sentence).toStartWith("No yes or no for DUB → LHR.");
    expect(a.sentence).toContain(rule.coversLabel);
    expect(a.sentence).not.toMatch(/likely/i);
  });

  test("the first and last days it answers, and the days either side", () => {
    expect(ask("DUB", "JFK", rule.asOf).outcome).toBe("likely");
    expect(ask("DUB", "JFK", rule.validThrough).outcome).toBe("likely");
    expect(ask("DUB", "JFK", "2026-11-17").outcome).toBe("outside_dates");
    const after = ask("DUB", "JFK", "2027-03-28");
    expect(after.outcome).toBe("outside_dates");
    expect(after.sentence).toStartWith("No yes or no for this date.");
    expect(after.sentence).toContain("Mar 27, 2027");
    // A date outside it is refused before a route is asked for.
    expect(ask(undefined, undefined, "2027-03-28").outcome).toBe("outside_dates");
  });

  test("past its end date it answers nothing, however the flight is dated", () => {
    for (const date of [FLIGHT_DAY, "2027-03-28", null]) {
      const a = statementAnswer(cfg, {
        origin: "DUB",
        destination: "JFK",
        date,
        today: "2027-03-28",
      });
      expect(a.outcome).toBe("outside_dates");
      expect(a.sentence).toContain("have not read it again since");
      expect(a.sentence).not.toMatch(/likely/i);
    }
    expect(
      statementAnswer(cfg, {
        origin: "DUB",
        destination: "JFK",
        date: null,
        today: rule.validThrough,
      }).outcome
    ).toBe("likely");
  });

  test("no sentence carries a number of ours", () => {
    const all = [
      ask("DUB", "JFK"),
      ask(),
      ask("DUB", "LHR"),
      ask("DUB", "JFK", "2027-04-01"),
      statementAnswer(cfg, { today: "2027-06-01" }),
    ];
    expect(new Set(all.map((a) => a.outcome)).size).toBe(4);
    for (const a of all) expect(a.sentence).not.toMatch(/%|probab|odds|\bverified\b/i);
  });
});

describe("the flight verdict", () => {
  const explode = () => {
    throw new Error("a statement airline must never reach the live lookup");
  };
  const verdict = (leg?: { origin?: string; destination?: string }, date = FLIGHT_DAY) =>
    resolveFlightVerdict(EI, reader, "EI105", date, {
      now: NOW,
      // Not null: the default on an airline's own MCP server would run it.
      lookupTail: explode as never,
      predict: explode as never,
      ...(leg ? { leg } : {}),
    });
  const answered = (v: FlightVerdict) => {
    if (v.kind !== "no_model" || v.answer.kind !== "statement") throw new Error(v.kind);
    return v;
  };

  test("it reads no live lookup and no predictor, with or without a route", async () => {
    expect(answered(await verdict()).answer.answer.outcome).toBe("needs_route");
    expect(
      answered(await verdict({ origin: "DUB", destination: "JFK" })).answer.answer.outcome
    ).toBe("likely");
  });

  test("it is never a yes or a no, carries no probability, and names no aircraft", async () => {
    for (const leg of [
      undefined,
      { origin: "DUB", destination: "JFK" },
      { origin: "DUB", destination: "LHR" },
    ]) {
      const s = verdictSummary(answered(await verdict(leg)));
      expect(s.hasStarlink).toBeNull();
      expect(s.probability).toBeNull();
      expect(s.assignment).toBeNull();
      expect(s.confidence).toBe("statement");
    }
  });

  test("only a covered route counts as an answer in telemetry", async () => {
    expect(
      verdictTelemetry(answered(await verdict({ origin: "DUB", destination: "JFK" })))
    ).toEqual({
      outcome: "predicted",
      confidence: "low",
    });
    for (const leg of [undefined, { origin: "DUB", destination: "LHR" }]) {
      expect(verdictTelemetry(answered(await verdict(leg)))).toEqual({
        outcome: "no_data",
        confidence: "none",
      });
    }
  });

  test("leg appears only when one was sent, and claims no row", async () => {
    expect(await verdict()).not.toHaveProperty("leg");
    const v = answered(await verdict({ origin: "DUB", destination: "JFK" }));
    expect(v.leg?.match).toBe("no_data");
    expect(v.leg?.otherLegs).toEqual([]);
  });

  test("a leg that can't be used is answered as no route, and says why", async () => {
    const v = await resolveFlightVerdict(
      EI,
      reader,
      "EI105",
      FLIGHT_DAY,
      withLeg({ now: NOW, lookupTail: null }, parseLegQuery("XXQ", "JFK"))
    );
    expect(answered(v).answer.answer.outcome).toBe("needs_route");
    expect(v.kind === "no_model" && v.leg?.match).toBe("unscoped");
  });

  test("an impossible flight number is refused before the statement is read", async () => {
    expect((await resolveFlightVerdict(EI, reader, "EI12345", FLIGHT_DAY, { now: NOW })).kind).toBe(
      "invalid_flight_number"
    );
  });

  test("the undated answer asks for the route", () => {
    const a = carrierPrediction(EI, reader, "EI105", { nowMs: NOW * 1000 });
    expect(a.kind === "statement" && a.answer.outcome).toBe("needs_route");
    expect(describeCarrierPrediction(EI, a)).toContain("origin and destination");
  });
});

// The served surfaces run on the real clock: what they print is whatever the
// rule says today, which the tests above pin for every side of its dates.
describe("what the hub serves", () => {
  const today = new Date().toISOString().slice(0, 10);
  const want = (origin?: string, destination?: string) =>
    statementAnswer(cfg, { origin, destination, date: today, today });
  const checkAny = (extra = "") =>
    jsonOf(app, `/api/check-any-flight?flight_number=EI105&date=${today}${extra}`, HUB);

  test("with no route: the statement, an ask for the route, and no leg key", async () => {
    const body = await checkAny();
    expect(Object.keys(body)).toEqual([
      "hasStarlink",
      "airline",
      "confidence",
      "airline_statement",
      "reason",
      "flights",
    ]);
    expect(body.hasStarlink).toBeNull();
    expect(body.airline).toBe("Aer Lingus");
    expect(body.confidence).toBe("statement");
    expect(body.reason).toBe(want().sentence);
    expect(body.flights).toEqual([]);
    expect(body.airline_statement).toEqual({
      answer: want().outcome,
      quote: rule.quote,
      as_of: rule.asOf,
      source: rule.source,
      valid_through: rule.validThrough,
    });
  });

  test("with a route: the answer for it, with the leg echoed", async () => {
    const body = await checkAny("&origin=DUB&destination=JFK");
    expect(body.hasStarlink).toBeNull();
    expect(body).not.toHaveProperty("probability");
    expect(body.reason).toBe(want("DUB", "JFK").sentence);
    expect(body.airline_statement.answer).toBe(want("DUB", "JFK").outcome);
    expect(body.leg).toEqual({
      origin: "DUB",
      destination: "JFK",
      match: "no_data",
      otherLegs: [],
    });
    const europe = await checkAny("&origin=DUB&destination=LHR");
    expect(europe.airline_statement.answer).toBe(want("DUB", "LHR").outcome);
    expect(europe.reason).not.toMatch(/likely/i);
  });

  test("K-prefixed codes and the EIN callsign resolve like the plain ones", async () => {
    const plain = await checkAny("&origin=DUB&destination=JFK");
    expect(await checkAny("&origin=dub&destination=KJFK")).toEqual(plain);
    expect(
      await jsonOf(
        app,
        `/api/check-any-flight?flight_number=EIN105&date=${today}&origin=DUB&destination=JFK`,
        HUB
      )
    ).toEqual(plain);
  });

  test("the surfaces beside the fleet model still refuse it, with its dated fact", async () => {
    for (const path of ["/api/check-flight", "/api/predict-flight"]) {
      const { status, text } = await bodyOf(
        app,
        `${path}?flight_number=EI105&date=${today}&origin=DUB&destination=JFK`,
        HUB
      );
      expect(status).toBe(404);
      expect(Object.keys(JSON.parse(text))).toEqual(["error", "airline_info"]);
    }
  });

  test("a single-airline site refuses it and names no Aer Lingus programme", async () => {
    const { status, text } = await bodyOf(
      app,
      `/api/check-flight?flight_number=EI105&date=${today}&origin=DUB&destination=JFK`,
      UA
    );
    expect(status).toBe(404);
    expect(Object.keys(JSON.parse(text))).toEqual(["error"]);
    expect(text).not.toContain("Aer Lingus");
  });

  test("MCP check_flight says the same sentence, with no made-up assignment note", async () => {
    const bare = await mcpTool(app, HUB, "check_flight", { flight_number: "EI105", date: today });
    expect(bare.isError).toBe(false);
    expect(bare.text).toBe(`EI105 on ${today}: ${want().sentence}`);
    const routed = await mcpTool(app, HUB, "check_flight", {
      flight_number: "EI105",
      date: today,
      origin: "DUB",
      destination: "JFK",
    });
    expect(routed.text).toBe(`EI105 on ${today}: ${want("DUB", "JFK").sentence}`);
    expect(routed.text).not.toContain("no assignment data");
  });

  test("the hub's MCP instructions say to pass the route; a ?scope=EI override is ignored", async () => {
    const init = await postMcp(app, HUB, "initialize", {});
    expect(init.result.instructions).toContain(
      "Aer Lingus (EI…): use check_flight with origin and destination"
    );
    expect(init.result.instructions).not.toMatch(/scope=[A-Z|]*EI/);
    const ua = await postMcp(app, UA, "initialize", {});
    expect(ua.result.instructions).not.toContain("Aer Lingus");
  });

  test("an unknown airline's refusal lists Aer Lingus among the lookup carriers", async () => {
    const body = await jsonOf(app, `/api/check-any-flight?flight_number=ZZ100&date=${today}`, HUB);
    expect(body.error).toMatch(/Tracked: .*\bEI\b/);
  });
});

describe("the hub page", () => {
  test("the route fields sit under the form, hidden and disabled until asked for", async () => {
    const { text } = await bodyOf(app, "/", HUB);
    expect(elementAttrs(text, "hub-check-flight-route").class).toContain("hidden");
    for (const name of ["origin", "destination"]) {
      const input = elementAttrs(text, `hub-check-flight-${name}`);
      expect(input.name).toBe(name);
      expect(input.form).toBe("hub-check-flight");
      expect(input).toHaveProperty("disabled");
      expect(text).toContain(`for="hub-check-flight-${name}"`);
    }
  });

  test("a single-airline site's form has no route fields", async () => {
    const { text } = await bodyOf(app, "/", UA);
    expect(text).not.toMatch(/id="[^"]*-route"/);
    expect(text).not.toContain('name="origin"');
  });

  const body = (a: ReturnType<typeof ask>) => ({
    hasStarlink: null,
    airline: "Aer Lingus",
    confidence: "statement",
    airline_statement: { answer: a.outcome, source: rule.source },
    reason: a.sentence,
  });

  test("a covered route prints one 'Likely yes', the airline, its words and the source", () => {
    const html = checkAnyHtml(body(ask("DUB", "JFK")), false);
    expect(html.match(/Likely yes/g)?.length).toBe(1);
    expect(html).toContain("Aer Lingus said on Nov 18, 2026");
    expect(html).toContain(`href="${rule.source.url}"`);
    expect(html).not.toMatch(/%|Unknown|Depends on aircraft/);
  });

  test("the other answers are labelled as no answer, never as a verdict", () => {
    expect(checkAnyHtml(body(ask()), false)).toStartWith(
      '<span class="text-muted">Route needed</span>'
    );
    expect(checkAnyHtml(body(ask("DUB", "LHR")), false)).toContain("No answer for this route");
    expect(checkAnyHtml(body(ask("DUB", "JFK", "2027-04-01")), false)).toContain(
      "No answer for this date"
    );
  });

  test("it escapes what it prints", () => {
    const html = checkAnyHtml(
      {
        airline: "<b>",
        airline_statement: { answer: "likely", source: { label: "<i>", url: '"><script>' } },
        reason: "<img>",
      },
      false
    );
    expect(html).not.toMatch(/<b>|<i>|<img>|<script>/);
  });

  test("the route fields are kept for the airline that asked for them", () => {
    expect(carrierCode("ei 105")).toBe("EI");
    expect(carrierCode("EIN105")).toBe("EI");
    expect(carrierCode("UA1736")).toBe("UA");
    expect(carrierCode("1736")).toBe("");
  });
});

describe("what the second look found", () => {
  test("the hub's MCP page offers exactly the scopes the server takes", async () => {
    const { text } = await bodyOf(app, "/mcp", HUB);
    const offered =
      /To pin one, add[\s\S]*?to the URL/.exec(text)?.[0].replace(/<[^>]+>/g, "") ?? "";
    const codes = offered.match(/\b[A-Z]{2}\b/g) ?? [];
    expect(codes.sort()).toEqual(VALID_SCOPES.filter((s) => s !== "ALL").sort());
    expect(codes).not.toContain("EI");
  });

  test("nothing said of today carries 'in every cabin': that is the refit's promise", async () => {
    expect(rule.claim).not.toMatch(/cabin/i);
    expect(rule.claim).toContain("free");
    for (const a of [
      ask(),
      ask("DUB", "JFK"),
      ask("DUB", "LHR"),
      ask("DUB", "JFK", "2027-04-02"),
    ]) {
      expect(a.sentence).not.toMatch(/cabin/i);
    }
    expect(EI.rollout.phaseNote ?? "").not.toMatch(/cabin/i);
    expect(factsBySlug("aer-lingus")?.summary ?? "").not.toMatch(/every cabin/i);
  });

  test("the narrowing is said as our choice, with no word on who flies which flight", () => {
    const s = ask("DUB", "LHR").sentence;
    expect(rule.coversLabel).not.toMatch(/flies|flown|operat/i);
    expect(s).not.toMatch(/flies itself/i);
    expect(s).toContain("our choice");
    expect(s).toContain(rule.coversLabel);
  });

  test("MCP predict_flight_starlink sends an EI number to check_flight, asking for nothing it can't take", async () => {
    const r = await mcpTool(app, HUB, "predict_flight_starlink", { flight_number: "EI105" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("check_flight");
    expect(r.text).not.toContain("give the origin and destination");
    expect(r.text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
