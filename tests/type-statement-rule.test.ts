/**
 * Airlines answered from their own statement about one aircraft type (Virgin
 * Atlantic's A350, SAS's A320neo). Nothing held says which aircraft flies a
 * flight, so the type the caller states is the whole of what the answer rests
 * on. The hard part is a wrong yes: a type string must match strictly, the
 * yes is never a yes of ours, and every yes says it holds only for the
 * airline's own aircraft of that type.
 */
import { describe, expect, test } from "bun:test";
import { AIRLINES, hubContentAirlines, publicAirlines } from "../src/airlines/registry";
import { statedTypeEcho, statedTypeKey } from "../src/airlines/stated-type";
import { statementAnswer, statementWireField } from "../src/airlines/statement-rule";
import { type FlightVerdict, resolveFlightVerdict } from "../src/api/check-flight-core";
import { VALID_SCOPES } from "../src/api/mcp-server";
import { checkAnyHtml } from "../src/client/flight-search";
import { createReaderFactory } from "../src/database/reader";
import { normalizeCarrierPrefix } from "../src/observability/metrics";
import { createApp } from "../src/server/app";
import { bodyOf, elementAttrs, jsonOf, makeFreshDb, mcpTool, postMcp } from "./helpers";

const extLib = require("../chrome-extension/lib.js");

const HUB = "airlinestarlinktracker.com";
const UA = "unitedstarlinktracker.com";
const VS = AIRLINES.VS;
const SK = AIRLINES.SK;
const typeRule = (code: "VS" | "SK") => {
  const rule = AIRLINES[code].statementRule;
  if (!rule || rule.by !== "type") throw new Error(`${code} has no type rule`);
  return rule;
};
const RULES = { VS: typeRule("VS"), SK: typeRule("SK") };

// Inside both rules' dates whatever day the suite runs.
const TODAY = "2026-11-26";
const FLIGHT_DAY = "2026-12-01";
const NOW = Date.parse(`${TODAY}T12:00:00Z`) / 1000;

const db = makeFreshDb();
const app = createApp(db);

const ask = (code: "VS" | "SK", aircraftType?: string | null, date: string | null = FLIGHT_DAY) =>
  statementAnswer(
    { name: AIRLINES[code].name, iata: code, statementRule: RULES[code] },
    { aircraftType, date, today: TODAY }
  );

// Each a yes only for the airline's own type, spelled so it can mean nothing else.
const VS_YES = [
  "A350",
  "Airbus A350",
  "A350-1000",
  "Airbus A350-1000",
  "airbus a350-1000",
  "A350-1041",
  "A35K",
  "351",
];
const VS_NOT = [
  "Airbus A350-900",
  "A359",
  "A350-900",
  "A3500",
  "A350F",
  "A350 or 787",
  "Boeing 787-9",
  "787",
  "Airbus A330-900neo",
  "A330",
  "A340",
  "Boeing 350",
  "Airbus",
  "A35",
  "A350 A350",
];
const SK_YES = ["A320neo", "Airbus A320neo", "A320 neo", "A320-neo", "A20N", "32N", "A320-251N"];
const SK_UNCLEAR = ["A320", "Airbus A320", "320", "airbus a320"];
const SK_NOT = [
  "A320-200",
  "Airbus A320-200",
  "A320-232",
  "A320ceo",
  "A321neo",
  "Airbus A321neo",
  "A321LR",
  "A21N",
  "A319",
  "A320neo2",
  "A320neo or A320",
  "A3200",
  "CRJ900",
  "Bombardier CRJ900",
  "ATR 72-600",
  "Embraer E195",
  "A330-300",
  "A350-900",
  "neo",
];

describe("the registry entries", () => {
  test.each([VS, SK])("$code answers hub lookups and joins no fleet or content surface", (cfg) => {
    expect(cfg.hubFlightLookup).toBe(true);
    expect(publicAirlines()).not.toContain(cfg);
    expect(hubContentAirlines()).not.toContain(cfg);
    expect(cfg.fr24Slug).toBeUndefined();
    expect(cfg.verifierBackend ?? null).toBeNull();
    expect(cfg.communitySource).toBeUndefined();
    expect(cfg.flightHistoryModel).toBe(false);
    expect(VALID_SCOPES).not.toContain(cfg.code);
  });

  test("each quote is the airline's sentence from its own host, and the claim says no more", () => {
    expect(RULES.VS.source.url).toMatch(/^https:\/\/www\.virginatlantic\.com\//);
    expect(RULES.VS.quote).toContain("across our A350 fleet");
    expect(RULES.VS.claim).toContain("across its A350 fleet");
    expect(RULES.SK.source.url).toMatch(/^https:\/\/www\.sasgroup\.net\//);
    expect(RULES.SK.quote).toContain("all 81 A320neo aircraft now equipped");
    expect(RULES.SK.claim).toContain("all 81 of its A320neo aircraft");
    for (const rule of Object.values(RULES)) {
      for (const words of [rule.claim, rule.beyond, rule.unclearNote ?? ""]) {
        expect(words).not.toMatch(/every flight|all flights|whole fleet|entire fleet|free/i);
      }
      expect(rule.validThrough > rule.asOf).toBe(true);
    }
  });

  test("Virgin Atlantic's page is undated, so it is 'checked', never 'said on'", () => {
    expect(RULES.VS.asOfKind).toBe("checked");
    expect(RULES.SK.asOfKind).toBeUndefined();
    for (const type of [undefined, "A350", "Boeing 787-9"]) {
      const { sentence } = ask("VS", type);
      expect(sentence).toContain("Virgin Atlantic's own page, checked Nov 26, 2026, says that");
      expect(sentence).not.toContain("said on");
    }
    expect(ask("VS", "A350", "2027-04-01").sentence).not.toContain("said on");
    expect(ask("SK", "A320neo").sentence).toContain("SAS said on Sep 1, 2026 that");
  });
});

describe("a stated type is read strictly", () => {
  test("the key drops the maker's name and separators, nothing else", () => {
    expect(statedTypeKey("Airbus A350-1000")).toBe("A3501000");
    expect(statedTypeKey(" a320 neo ")).toBe("A320NEO");
    expect(statedTypeKey("Boeing 787-9")).toBe("BOEING7879");
  });

  test.each(VS_YES)("Virgin Atlantic: %s is its A350", (type) => {
    expect(RULES.VS.matchType(type)).toBe("covered");
    expect(ask("VS", type).outcome).toBe("likely");
  });

  test.each(VS_NOT)("Virgin Atlantic: %s is not, and gets no yes and no no", (type) => {
    expect(RULES.VS.matchType(type)).toBe("other");
    const a = ask("VS", type);
    expect(a.outcome).toBe("other_type");
    expect(a.sentence).toStartWith("No yes or no for the aircraft type given");
    expect(a.sentence).toContain("that is not a no");
    expect(a.sentence).not.toMatch(/likely|^Yes|^No\b(?! yes or no)/i);
  });

  test.each(SK_YES)("SAS: %s is the A320neo", (type) => {
    expect(RULES.SK.matchType(type)).toBe("covered");
    expect(ask("SK", type).outcome).toBe("likely");
  });

  test.each(SK_UNCLEAR)("SAS: a bare %s may be an older aircraft, so no yes", (type) => {
    expect(RULES.SK.matchType(type)).toBe("unclear");
    const a = ask("SK", type);
    expect(a.outcome).toBe("unclear_type");
    expect(a.sentence).toContain("can mean an A320neo or an older A320");
    expect(a.sentence).not.toMatch(/likely/i);
  });

  test.each(SK_NOT)("SAS: %s is not an A320neo, and gets no yes and no no", (type) => {
    expect(RULES.SK.matchType(type)).toBe("other");
    const a = ask("SK", type);
    expect(a.outcome).toBe("other_type");
    expect(a.sentence).not.toMatch(/likely/i);
  });

  test("one airline's type is never the other's yes", () => {
    for (const type of SK_YES) expect(RULES.VS.matchType(type)).toBe("other");
    for (const type of VS_YES) expect(RULES.SK.matchType(type)).toBe("other");
  });

  test("only letters, digits, spaces and hyphens of a stated type are printed back", () => {
    expect(statedTypeEcho("Airbus A350-1000 (Upper)")).toBe("Airbus A350-1000 Upper");
    expect(statedTypeEcho("<b>A350</b>")).toBe("bA350b");
    expect(ask("VS", "<script>").sentence).not.toContain("<");
    // Nothing printable left: the same as no type stated.
    expect(ask("VS", "()").outcome).toBe("needs_type");
  });
});

describe("statementAnswer for a type rule", () => {
  test("no type: it depends on the aircraft, with the statement and an ask for the type", () => {
    for (const code of ["VS", "SK"] as const) {
      for (const type of [undefined, null, ""]) {
        const a = ask(code, type);
        expect(a.outcome).toBe("needs_type");
        expect(a.statedType).toBeNull();
        expect(a.sentence).toStartWith("It depends on the aircraft. ");
        expect(a.sentence).toContain(RULES[code].claim);
        expect(a.sentence).toContain("give the aircraft type your booking shows");
        expect(a.sentence).not.toMatch(/likely|No Starlink/i);
      }
    }
  });

  test("a yes says what it rests on, the partner caution and the aircraft-change caution", () => {
    const vs = ask("VS", "Airbus A350-1000").sentence;
    expect(vs).toStartWith(
      "Likely yes. That holds only if an A350 that Virgin Atlantic itself flies is on the flight."
    );
    expect(vs).toContain("We go by the aircraft type you gave and nothing else");
    expect(vs).toContain("we hold no Virgin Atlantic schedule");
    expect(vs).toContain(
      "An aircraft a partner airline flies under a VS number is not covered, whatever its type"
    );
    expect(vs).toContain("an aircraft change can alter the answer");
    const sk = ask("SK", "A320neo").sentence;
    expect(sk).toContain("only if an A320neo that SAS itself flies is on the flight");
    expect(sk).toContain("under an SK number is not covered, whatever its type");
  });

  test("the route never turns a type answer into a yes or changes it", () => {
    const cfg = { name: VS.name, iata: "VS", statementRule: RULES.VS };
    const routed = (aircraftType?: string) =>
      statementAnswer(cfg, {
        origin: "LHR",
        destination: "JFK",
        aircraftType,
        date: FLIGHT_DAY,
        today: TODAY,
      });
    expect(routed().outcome).toBe("needs_type");
    expect(routed("Boeing 787-9").outcome).toBe("other_type");
    expect(routed("A350").sentence).toBe(ask("VS", "A350").sentence);
  });

  test("the first and last days it answers, and the days either side", () => {
    expect(ask("VS", "A350", "2026-11-26").outcome).toBe("likely");
    expect(ask("VS", "A350", "2026-11-25").outcome).toBe("outside_dates");
    expect(ask("VS", "A350", RULES.VS.validThrough).outcome).toBe("likely");
    expect(ask("VS", "A350", "2027-03-28").outcome).toBe("outside_dates");
    expect(ask("SK", "A320neo", "2026-09-01").outcome).toBe("likely");
    expect(ask("SK", "A320neo", "2026-08-31").outcome).toBe("outside_dates");
    expect(ask("SK", "A320neo", "2027-03-28").outcome).toBe("outside_dates");
  });

  test("past its end date it answers nothing, whatever type is stated", () => {
    for (const code of ["VS", "SK"] as const) {
      const a = statementAnswer(
        { name: AIRLINES[code].name, iata: code, statementRule: RULES[code] },
        { aircraftType: code === "VS" ? "A350" : "A320neo", date: null, today: "2027-03-28" }
      );
      expect(a.outcome).toBe("outside_dates");
      expect(a.sentence).toContain("have not read it again since");
    }
  });

  test("no sentence carries a number of ours", () => {
    const all = [
      ...[undefined, ...VS_YES, ...VS_NOT].map((t) => ask("VS", t).sentence),
      ...[undefined, ...SK_YES, ...SK_UNCLEAR, ...SK_NOT].map((t) => ask("SK", t).sentence),
    ];
    for (const s of all) expect(s).not.toMatch(/\d+ ?%|percent|probab|odds/i);
  });

  test("the wire key: a route rule keeps its five keys, a type rule adds its own", () => {
    const ei = AIRLINES.EI.statementRule;
    if (!ei) throw new Error("no EI rule");
    const eiField = statementWireField(
      statementAnswer(
        { name: "Aer Lingus", iata: "EI", statementRule: ei },
        { origin: "DUB", destination: "JFK", aircraftType: "A350", date: FLIGHT_DAY, today: TODAY }
      )
    ).airline_statement as Record<string, unknown>;
    expect(Object.keys(eiField)).toEqual(["answer", "quote", "as_of", "source", "valid_through"]);
    const vsField = statementWireField(ask("VS", "A350")).airline_statement;
    expect(Object.keys(vsField as object)).toEqual([
      "answer",
      "quote",
      "as_of",
      "source",
      "valid_through",
      "as_of_kind",
      "by",
      "aircraft_type",
    ]);
    const skField = statementWireField(ask("SK")).airline_statement as Record<string, unknown>;
    expect(skField).not.toHaveProperty("as_of_kind");
    expect(skField.by).toBe("aircraft_type");
    expect(skField.aircraft_type).toBeNull();
  });
});

describe("the flight verdict", () => {
  const explode = () => {
    throw new Error("a statement airline must never reach the live lookup");
  };
  const verdict = (code: "VS" | "SK", fn: string, aircraftType?: string) =>
    resolveFlightVerdict(AIRLINES[code], createReaderFactory(db)(code), fn, FLIGHT_DAY, {
      now: NOW,
      lookupTail: explode as never,
      predict: explode as never,
      ...(aircraftType ? { aircraftType } : {}),
    });
  const outcome = (v: FlightVerdict) => {
    if (v.kind !== "no_model" || v.answer.kind !== "statement") throw new Error(v.kind);
    return v.answer.answer.outcome;
  };

  test("it reads no live lookup and no predictor, with or without a type", async () => {
    expect(outcome(await verdict("VS", "VS3"))).toBe("needs_type");
    expect(outcome(await verdict("VS", "VS3", "Airbus A350-1000"))).toBe("likely");
    expect(outcome(await verdict("SK", "SK903"))).toBe("needs_type");
    expect(outcome(await verdict("SK", "SK903", "A320neo"))).toBe("likely");
    expect(outcome(await verdict("SK", "SK903", "A320"))).toBe("unclear_type");
  });

  test("an impossible flight number is refused before the statement is read", async () => {
    expect((await verdict("VS", "VS12345", "A350")).kind).toBe("invalid_flight_number");
  });
});

describe("what the hub serves", () => {
  const today = new Date().toISOString().slice(0, 10);
  const want = (code: "VS" | "SK", aircraftType?: string) =>
    statementAnswer(
      { name: AIRLINES[code].name, iata: code, statementRule: RULES[code] },
      { aircraftType, date: today, today }
    );
  const checkAny = (fn: string, type?: string, host = HUB) =>
    jsonOf(
      app,
      `/api/check-any-flight?flight_number=${fn}&date=${today}${
        type === undefined ? "" : `&aircraft_type=${encodeURIComponent(type)}`
      }`,
      host
    );

  test("with no type: the statement, an ask for the type, never a yes or a no", async () => {
    for (const [fn, code] of [
      ["VS3", "VS"],
      ["SK903", "SK"],
    ] as const) {
      const body = await checkAny(fn);
      expect(Object.keys(body)).toEqual([
        "hasStarlink",
        "airline",
        "confidence",
        "airline_statement",
        "reason",
        "flights",
      ]);
      expect(body.hasStarlink).toBeNull();
      expect(body.confidence).toBe("statement");
      expect(body).not.toHaveProperty("probability");
      expect(body.flights).toEqual([]);
      expect(body.reason).toBe(want(code).sentence);
      expect(body.airline_statement.answer).toBe(want(code).outcome);
      expect(body.airline_statement.by).toBe("aircraft_type");
      expect(body.airline_statement.aircraft_type).toBeNull();
    }
  });

  test("with the type: the answer for it, still no yes of ours and no number", async () => {
    const vs = await checkAny("VS3", "Airbus A350-1000");
    expect(vs.hasStarlink).toBeNull();
    expect(vs).not.toHaveProperty("probability");
    expect(vs.reason).toBe(want("VS", "Airbus A350-1000").sentence);
    expect(vs.airline_statement.answer).toBe(want("VS", "Airbus A350-1000").outcome);
    expect(vs.airline_statement.aircraft_type).toBe("Airbus A350-1000");
    const sk = await checkAny("SK903", "Airbus A320neo");
    expect(sk.hasStarlink).toBeNull();
    expect(sk.airline_statement.answer).toBe(want("SK", "Airbus A320neo").outcome);
  });

  test.each([
    ["VS3", "Boeing 787-9"],
    ["VS3", "Airbus A350-900"],
    ["VS3", "A350/787"],
    ["VS3", "A350;DROP"],
    ["SK903", "Airbus A320"],
    ["SK903", "A320-200"],
    ["SK903", "Airbus A321neo"],
    ["SK903", "CRJ900"],
    ["SK903", `A320neo${"x".repeat(40)}`],
  ])("%s as %s is never likely, a yes or a no", async (fn, type) => {
    const body = await checkAny(fn, type);
    expect(body.airline_statement.answer).not.toBe("likely");
    expect(body.hasStarlink).toBeNull();
    expect(body.reason).not.toMatch(/likely/i);
  });

  test("the aircraft type changes nothing for an airline answered another way", async () => {
    for (const fn of ["UA1736", "AS118", "HA50", "QR701", "EI105"]) {
      expect(await checkAny(fn, "Airbus A350-1000")).toEqual(await checkAny(fn));
    }
    const routed = "&origin=DUB&destination=JFK";
    const ei = (extra: string) =>
      jsonOf(app, `/api/check-any-flight?flight_number=EI105&date=${today}${routed}${extra}`, HUB);
    expect(await ei("&aircraft_type=A350")).toEqual(await ei(""));
  });

  test("ICAO callsigns resolve like the IATA numbers", async () => {
    expect((await checkAny("VIR3", "A350")).reason).toBe((await checkAny("VS3", "A350")).reason);
    expect((await checkAny("SAS903")).airline).toBe("SAS");
  });

  test("a single-airline site refuses them", async () => {
    const res = await app.dispatch(
      new Request(`https://${UA}/api/check-flight?flight_number=VS3&date=${today}`, {
        headers: { host: UA },
      })
    );
    expect(JSON.stringify(await res.json())).not.toContain("airline_statement");
  });

  test("an unknown airline's refusal lists both among the lookup carriers", async () => {
    const body = await checkAny("ZZ100");
    expect(body.error).toMatch(/Tracked: .*\bVS\b.*\bSK\b/);
  });

  test("MCP check_flight takes aircraft_type on the hub and says the same sentence", async () => {
    const bare = await mcpTool(app, HUB, "check_flight", { flight_number: "VS3", date: today });
    expect(bare.isError).toBe(false);
    expect(bare.text).toBe(`VS3 on ${today}: ${want("VS").sentence}`);
    const typed = await mcpTool(app, HUB, "check_flight", {
      flight_number: "VS3",
      date: today,
      aircraft_type: "Airbus A350-1000",
    });
    expect(typed.text).toBe(`VS3 on ${today}: ${want("VS", "Airbus A350-1000").sentence}`);
    expect(typed.text).not.toContain("no assignment data");
    const bad = await mcpTool(app, HUB, "check_flight", {
      flight_number: "SK903",
      date: today,
      aircraft_type: { toString: "A320neo" },
    });
    expect(bad.text).toBe(`SK903 on ${today}: ${want("SK").sentence}`);
  });

  test("the hub's tool list gains the one optional parameter; an airline's own list does not", async () => {
    const tools = async (host: string) =>
      (await postMcp(app, host, "tools/list", {})).result.tools as Array<{
        name: string;
        inputSchema: { properties: Record<string, unknown>; required: string[] };
      }>;
    const hub = (await tools(HUB)).find((t) => t.name === "check_flight");
    expect(Object.keys(hub?.inputSchema.properties ?? {})).toEqual([
      "flight_number",
      "date",
      "origin",
      "destination",
      "aircraft_type",
    ]);
    expect(hub?.inputSchema.required).toEqual(["flight_number", "date"]);
    for (const tool of await tools(UA)) {
      expect(Object.keys(tool.inputSchema.properties)).not.toContain("aircraft_type");
    }
    expect((await tools(HUB)).map((t) => t.name)).toEqual((await tools(UA)).map((t) => t.name));
  });

  test("the hub's MCP instructions say to pass the stated type and never to guess it", async () => {
    const init = await postMcp(app, HUB, "initialize", {});
    for (const name of ["Virgin Atlantic (VS…)", "SAS (SK…)"]) {
      expect(init.result.instructions).toContain(`${name}: use check_flight with aircraft_type`);
    }
    expect(init.result.instructions).toContain("Never guess the type");
    const ua = await postMcp(app, UA, "initialize", {});
    expect(ua.result.instructions).not.toMatch(/Virgin Atlantic|SAS \(SK/);
  });

  test("MCP predict_flight_starlink sends the number to check_flight with aircraft_type", async () => {
    const res = await mcpTool(app, HUB, "predict_flight_starlink", { flight_number: "SK903" });
    expect(res.text).toContain("call check_flight");
    expect(res.text).toContain("aircraft_type");
    expect(res.text).not.toMatch(/origin|%/);
  });
});

describe("the hub page", () => {
  test("the type field sits under the form, hidden and disabled until asked for", async () => {
    const { text } = await bodyOf(app, "/", HUB);
    expect(elementAttrs(text, "hub-check-flight-type").class).toContain("hidden");
    const input = elementAttrs(text, "hub-check-flight-aircraft-type");
    expect(input.name).toBe("aircraft_type");
    expect(input.form).toBe("hub-check-flight");
    expect(input).toHaveProperty("disabled");
    expect(text).toContain('for="hub-check-flight-aircraft-type"');
  });

  test("the hub's MCP page names every lookup airline, and its description is not cut short", async () => {
    const { text } = await bodyOf(app, "/mcp", HUB, { headers: { Accept: "text/html" } });
    expect(text).toContain("Aer Lingus, Virgin Atlantic or SAS flight has Starlink");
    const description = text.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "";
    expect(description).toMatch(/on \d+ airlines/);
    expect(description).not.toContain("…");
  });

  test("a single-airline site's form has no type field", async () => {
    const { text } = await bodyOf(app, "/", UA);
    expect(text).not.toMatch(/id="[^"]*-type"/);
    expect(text).not.toContain('name="aircraft_type"');
  });

  const body = (code: "VS" | "SK", a: ReturnType<typeof ask>) => ({
    hasStarlink: null,
    airline: AIRLINES[code].name,
    confidence: "statement",
    airline_statement: { answer: a.outcome, source: RULES[code].source, by: "aircraft_type" },
    reason: a.sentence,
  });

  test("a covered type prints one 'Likely yes', the airline's words and the source", () => {
    const html = checkAnyHtml(body("VS", ask("VS", "A350")), false);
    expect(html.match(/Likely yes/g)?.length).toBe(1);
    expect(html).toContain("That holds only if an A350 that Virgin Atlantic itself flies");
    expect(html).toContain(`href="${RULES.VS.source.url}"`);
    expect(html).not.toMatch(/%|Unknown/);
  });

  test("the other answers are labelled as no answer, never as a verdict", () => {
    expect(checkAnyHtml(body("VS", ask("VS")), false)).toStartWith(
      '<span class="text-muted">Depends on the aircraft</span>'
    );
    // The label says it once; the sentence after it doesn't say it again.
    expect(
      checkAnyHtml(body("VS", ask("VS")), false).match(/depends on the aircraft/gi)?.length
    ).toBe(1);
    for (const a of [ask("SK", "A320"), ask("SK", "CRJ900"), ask("VS", "Boeing 787-9")]) {
      expect(checkAnyHtml(body("SK", a), false)).toStartWith(
        '<span class="text-muted">No answer for this aircraft type</span>'
      );
    }
    expect(checkAnyHtml(body("VS", ask("VS", "A350", "2027-04-01")), false)).toContain(
      "No answer for this date"
    );
  });
});

describe("the extension, 2.5.0", () => {
  test("VS and SK numbers go to the hub; the type rides only when one is given", () => {
    const bare = extLib.endpointFor("VS3", "2026-12-01", "2.5.0", {
      origin: "LHR",
      destination: "JFK",
    });
    expect(bare).toBe(
      "https://airlinestarlinktracker.com/api/check-any-flight?flight_number=VS3&date=2026-12-01&origin=LHR&destination=JFK&client=ext-2.5.0"
    );
    const typed = new URL(
      extLib.endpointFor("SK903", "2026-12-01", "2.5.0", undefined, "Airbus A320neo")
    );
    expect(typed.searchParams.get("aircraft_type")).toBe("Airbus A320neo");
  });

  test("no other airline's request ever carries a type, and a bad one is dropped", () => {
    for (const fn of ["UA123", "AS118", "HA50", "QR7", "EI105"]) {
      const leg = { origin: "DUB", destination: "JFK" };
      expect(extLib.endpointFor(fn, "2026-12-01", "2.5.0", leg, "Airbus A350")).toBe(
        extLib.endpointFor(fn, "2026-12-01", "2.5.0", leg)
      );
    }
    for (const bad of ["A350&x=1", "<b>", "", 7, null, "x".repeat(41)]) {
      expect(extLib.endpointFor("VS3", "2026-12-01", "2.5.0", undefined, bad)).not.toContain(
        "aircraft_type"
      );
    }
  });

  // One Virgin Atlantic or SAS flight on an English page, its itinerary data
  // decoded: the only card a type is ever read from.
  const vsCard = { flightNumber: "VS3", segmentCount: 1, decoded: true, lang: "en-GB" };
  const skCard = { flightNumber: "SK903", segmentCount: 1, decoded: true, lang: "en" };
  // Every made-up card carries a duration as an English page prints it,
  // which the reader takes as its sign that the card is in English.
  const english = (text: string) => `7 hr 55 min\n${text}`;
  const readVs = (text: string, over: Record<string, unknown> = {}) =>
    extLib.statedAircraftType(english(text), { ...vsCard, ...over });
  const readSk = (text: string, over: Record<string, unknown> = {}) =>
    extLib.statedAircraftType(english(text), { ...skCard, ...over });

  test("a type is read off a card only when the card can mean one aircraft", () => {
    expect(readVs("Virgin Atlantic · Economy · Airbus A350-1000 · VS 3")).toBe("Airbus A350-1000");
    expect(readSk("SAS\nEconomy\nAirbus A320neo\nSK 903")).toBe("Airbus A320neo");
    expect(readSk("SAS · Airbus A320 · SK 903")).toBe("Airbus A320");
    // The same type printed twice is still one type.
    expect(readVs("Airbus A350 · VS 3\nAirbus A350")).toBe("Airbus A350");
    // Two flights on the card: nothing says which leg the type belongs to.
    expect(readVs("Airbus A350 · VS 3", { segmentCount: 2 })).toBeNull();
    expect(readVs("Airbus A350 · VS 3", { segmentCount: 0 })).toBeNull();
    // Two different types, or none.
    expect(readVs("Airbus A350 · Boeing 787")).toBeNull();
    expect(readVs("Virgin Atlantic · VS 3 · 7 hr 55 min")).toBeNull();
    expect(readSk("Airbus A321neo")).toBe("Airbus A321neo");
    // Only for an airline answered by stated type.
    expect(readVs("Airbus A350 · UA 3", { flightNumber: "UA3" })).toBeNull();
    expect(readVs("Airbus A350", { flightNumber: "DL30" })).toBeNull();
    expect(extLib.statedAircraftType(null, vsCard)).toBeNull();
    expect(extLib.statedAircraftType(english("Airbus A350"), null)).toBeNull();
    expect(extLib.statedAircraftType(english("Airbus A350"), 1)).toBeNull();
    expect(readVs(`${"x ".repeat(100000)}\nAirbus A350`)).toBeNull();
  });

  // Finding 1b of the second look: the guard knew "Operated by" in English
  // only, so a partner's A350 under a VS number got the badge on a German,
  // French or Swedish page, and under "Plane and crew by" in English.
  test("a card on a page that is not in English states no type", () => {
    expect(readVs("Virgin Atlantic\nAirbus A350\nVS 3")).toBe("Airbus A350");
    for (const lang of ["de", "de-DE", "fr", "sv-SE", "nb", "da", "es-419", "ja", "", "english"]) {
      expect(readVs("Virgin Atlantic\nAirbus A350\nVS 3", { lang })).toBeNull();
      expect(readSk("SAS\nAirbus A320neo\nSK 903", { lang })).toBeNull();
    }
    for (const lang of [undefined, null, 7, ["en"]]) {
      expect(readVs("Virgin Atlantic\nAirbus A350\nVS 3", { lang })).toBeNull();
    }
    // The second look's own cards, on the page language they would be seen in.
    expect(readVs("Airbus A350\nDurchgeführt von Delta", { lang: "de" })).toBeNull();
    expect(readVs("Airbus A350\nExploité par Delta", { lang: "fr" })).toBeNull();
    expect(readSk("Airbus A320neo\nFlygs av Air France", { lang: "sv" })).toBeNull();
    for (const lang of ["en", "en-US", "en-GB", "EN-au", "en_CA"]) {
      expect(readVs("Virgin Atlantic\nAirbus A350\nVS 3", { lang })).toBe("Airbus A350");
    }
    // A page that says it is English while its cards are not: the card's own
    // words must be English too, or the operator's line could be in any
    // language.
    const raw = (text: string) => extLib.statedAircraftType(text, vsCard);
    expect(raw("Virgin Atlantic\n7 hr 55 min\nAirbus A350\nVS 3")).toBe("Airbus A350");
    expect(raw("Virgin Atlantic\nAirbus A350\nVS 3")).toBeNull();
    expect(raw("7 Std. 55 Min.\nAirbus A350\nDurchgeführt von Delta")).toBeNull();
    expect(raw("7 h 55 min\nAirbus A350\nExploité par Delta")).toBeNull();
    expect(raw("7 tim 55 min\nAirbus A350\nflygs av cityjet")).toBeNull();
  });

  test("an English card that names another operator states no type", () => {
    expect(readSk("SAS\nAirbus A320neo\nSK 903")).toBe("Airbus A320neo");
    for (const line of [
      "Operated by Delta",
      "operated by Cityjet",
      "OPERATED BY DELTA",
      "Plane and crew by Heston Airlines",
      "Aircraft and crew provided by Xfly",
      "Flown by Air France",
      "Wet lease: Titan",
      "Delta flying for Virgin Atlantic",
      "CityJet DBA SAS",
      "Operating as SAS Link",
      "Operated by SAS Connect",
      "Operated by Virgin Atlantic International",
      "Codeshare with KLM",
      "On behalf of SAS",
      "British Airways",
      "Delta Air Lines",
      "Heston Airlines",
    ]) {
      expect(readVs(`Virgin Atlantic\nAirbus A350\nVS 3\n${line}`)).toBeNull();
      expect(readVs(`Virgin Atlantic · ${line} · Airbus A350 · VS 3`)).toBeNull();
      expect(readSk(`SAS\nAirbus A320neo\nSK 903\n${line}`)).toBeNull();
      // Said only in an aria-label, it counts the same.
      expect(readVs("Virgin Atlantic\nAirbus A350\nVS 3", { labels: line })).toBeNull();
    }
    // Operator wording in another language on a page that claims English
    // still reads as a name after "by", "for" or "as" only by luck: the
    // language gate above is what holds there, not this list.
    expect(readVs("Airbus A350\nVS 3", { labels: 7 })).toBeNull();
    // The airline's own name, and its own name as the operator, are no doubt.
    expect(readVs("Virgin Atlantic Airways\nAirbus A350\nOperated by Virgin Atlantic")).toBe(
      "Airbus A350"
    );
    expect(readSk("Scandinavian Airlines\nAirbus A320neo\nOperated by SAS")).toBe("Airbus A320neo");
    expect(
      readVs("Virgin Atlantic\nAirbus A350", {
        labels: "Nonstop flight with Virgin Atlantic.\nSelect flight",
      })
    ).toBe("Airbus A350");
  });

  // Finding 1c: "Airbus A350 900" joined by a no-break space, a thin space,
  // an en dash or a slash read as "Airbus A350", which the server calls a yes.
  test("a type is read whole or not at all, whatever joins its parts", () => {
    expect(readVs("Airbus A350\nVS 3")).toBe("Airbus A350");
    // A space of any kind inside the name is a space.
    expect(readVs("Airbus\u00a0A350\nVS 3")).toBe("Airbus A350");
    expect(readVs("Airbus\u2009A350-1000")).toBe("Airbus A350-1000");
    // A dash of any kind is a hyphen: the type is then the A350-900, whole.
    for (const dash of [
      "-",
      "\u2010",
      "\u2011",
      "\u2012",
      "\u2013",
      "\u2014",
      "\u2212",
      "\uff0d",
    ]) {
      expect(readVs(`Airbus A350${dash}900`)).toBe("Airbus A350-900");
      expect(readVs(`Airbus A350${dash}1000`)).toBe("Airbus A350-1000");
    }
    // Anything else after the type refuses it; it is never cut short.
    for (const sep of [
      " ",
      "\u00a0",
      "\u2009",
      "\u202f",
      "\u2007",
      "\u3000",
      "\t",
      "/",
      " / ",
      ".",
      ",",
      "_",
      "\u200b",
      "\u00ad",
      "\u2060",
      "\ufeff",
      " \u2013 ",
      "\n",
      " · ",
      "\n-",
      " (",
    ]) {
      expect(readVs(`Airbus A350${sep}900\nVS 3`)).toBeNull();
      expect(readSk(`Airbus A320${sep}200N`)).toBeNull();
    }
    for (const text of [
      "Airbus A350 900 · VS 3",
      "Airbus A320 neo",
      "Airbus A320\nneo",
      "Airbus A320neo (Sharklets)",
      "Airbus A350 XWB",
      "Airbus A350F",
      "Boeing 787-9 Dreamliner\nAirbus A350",
      "De Havilland Dash 8\nAirbus A350",
      "Fly our new Airbus A350 to New York\nAirbus A350",
      "Airbus A350\nPreviously Airbus A350",
      "Airbus A350\nA350-900",
      "airbus a350",
      "AIRBUS A350",
      "Ａｉｒｂｕｓ Ａ３５０ ９００",
    ]) {
      expect(readVs(text)).toBeNull();
    }
    // Whatever is read is something the request will carry unchanged.
    expect(readVs("Ａｉｒｂｕｓ Ａ３５０")).toBe("Airbus A350");
  });

  // Finding 1d: with the card's itinerary data undecoded, the fallback counts
  // any card as one flight, so another flight's type could be sent.
  test("a card whose itinerary data did not decode states no type", async () => {
    expect(readVs("Virgin Atlantic\nAirbus A350\nVS 3")).toBe("Airbus A350");
    for (const decoded of [false, undefined, null, 1, "true"]) {
      expect(readVs("Virgin Atlantic\nAirbus A350\nVS 3", { decoded })).toBeNull();
      expect(readVs("Airbus A350\nVS 3\nAirbus A350\nDL 30", { decoded })).toBeNull();
      expect(readSk("SAS\nAirbus A320neo\nSK 903", { decoded })).toBeNull();
    }
    // The content script says how it got its segments on every path, and only
    // the decoded one says yes.
    const content = await Bun.file(`${import.meta.dir}/../chrome-extension/content.js`).text();
    expect(content.match(/decoded: true/g)).toHaveLength(1);
    expect(content.match(/decoded: false/g)).toHaveLength(3);
    expect(content.match(/complete: /g)).toHaveLength(4);
    expect(content).toContain(
      "statedTypeOn(card, segments[0].flightNumber, segments.length, decoded)"
    );
    expect(content).toContain("lang: document.documentElement.lang");
  });

  test("only airlines answered by stated type have a card's type read", () => {
    expect(extLib.wantsAircraftType("VS3")).toBe(true);
    expect(extLib.wantsAircraftType("SK903")).toBe(true);
    for (const fn of ["UA123", "AS118", "QR7", "EI105", "DL100", ""]) {
      expect(extLib.wantsAircraftType(fn)).toBe(false);
    }
  });

  test("a stated type has its own cache entry, and the message carries it", async () => {
    expect(extLib.claimKey("VS3", "2026-12-01", undefined, "Airbus A350")).not.toBe(
      extLib.claimKey("VS3", "2026-12-01")
    );
    expect(extLib.claimKey("UA1217", "2026-10-06")).toBe("UA1217-2026-10-06");
    const sent: unknown[] = [];
    const lookup = extLib.createClaimLookup(async (message: unknown) => {
      sent.push(message);
      return { success: true, data: {} };
    });
    await lookup.get("VS3", "2026-12-01", undefined, "Airbus A350");
    await lookup.get("VS3", "2026-12-01");
    expect(sent).toEqual([
      {
        action: "checkFlight",
        flightNumber: "VS3",
        date: "2026-12-01",
        aircraftType: "Airbus A350",
      },
      { action: "checkFlight", flightNumber: "VS3", date: "2026-12-01" },
    ]);
  });

  test("only the server's 'likely' is badged, and the tooltip says what it rests on", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const answer = (fn: string, type?: string) =>
      jsonOf(
        app,
        `/api/check-any-flight?flight_number=${fn}&date=${today}${type ? `&aircraft_type=${encodeURIComponent(type)}` : ""}`,
        HUB
      );
    const yes = extLib.normalizeClaim(await answer("VS3", "Airbus A350-1000"));
    expect(yes.status).toBe("stated");
    expect(extLib.shouldBadge(yes)).toBe(true);
    expect(extLib.badgeLabel(yes)).toBe("Starlink (likely)");
    const title = extLib.badgeTitle(yes);
    expect(title).toStartWith(
      "Likely Starlink, only if this flight stays on the Airbus A350-1000 this card shows: Virgin Atlantic's own page, checked 2026-11-26, says"
    );
    expect(title).toContain(RULES.VS.quote);
    expect(title).toContain("not a partner airline's");
    expect(title).not.toContain("said on");
    const sk = extLib.badgeTitle(extLib.normalizeClaim(await answer("SK903", "Airbus A320neo")));
    expect(sk).toContain("SAS said on 2026-09-01,");
    for (const [fn, type] of [
      ["VS3", undefined],
      ["VS3", "Boeing 787-9"],
      ["SK903", undefined],
      ["SK903", "Airbus A320"],
      ["SK903", "Airbus A321neo"],
    ] as const) {
      const claim = extLib.normalizeClaim(await answer(fn, type));
      expect(claim.status).toBe("unknown");
      expect(extLib.shouldBadge(claim)).toBe(false);
      // Unknown, never a no: "Starlink only" must not dim the card.
      expect(extLib.filterTier(claim)).toBe(extLib.filterTier(extLib.unknownClaim()));
    }
  });

  test("Aer Lingus's tooltip is word for word what 2.4.0 showed", () => {
    const claim = extLib.normalizeClaim({
      airline: "Aer Lingus",
      airline_statement: { answer: "likely", quote: "Q.", as_of: "2026-11-18" },
    });
    expect(extLib.badgeTitle(claim)).toBe(
      'Likely Starlink: Aer Lingus said on 2026-11-18, "Q." That holds for flights Aer Lingus itself operates, not a partner airline\'s, and a last-minute aircraft change can alter it.'
    );
  });
});

describe("the untracked-lookup metric", () => {
  test("its carrier tag keeps the codes of every airline answered by statement", () => {
    for (const code of ["VS", "SK", "EI", "ZG", "XE"]) {
      expect(normalizeCarrierPrefix(`${code}123`)).toBe(code);
    }
    expect(normalizeCarrierPrefix("ZZ123")).toBe("other");
  });
});
