/**
 * A lookup for an airline the hub doesn't answer by flight carries the dated
 * fact it holds, by added keys and added sentences only, and never a verdict.
 * An old Hawaiian HA number is told to use the AS number.
 */
import { describe, expect, test } from "bun:test";
import { hubLookupAirlines } from "../src/airlines/registry";
import { AIRLINE_FACTS, contentOnlyFacts } from "../src/airlines/rollout-facts";
import {
  RETIRED_CODE_NOTES,
  retiredCodeNote,
  untrackedAirlineInfo,
} from "../src/airlines/untracked-airline";
import { airlineInfoHtml, numberNoteHtml } from "../src/client/flight-search";
import { normalizeCarrierPrefix } from "../src/observability";
import { createApp } from "../src/server/app";
import { bodyOf, elementAttrs, mcpTool, openSnapshot } from "./helpers";

const HUB = "airlinestarlinktracker.com";
const UA = "unitedstarlinktracker.com";
const DATE = "2026-09-20";
const app = createApp(openSnapshot());

// An airline the hub's lookup answers itself (Aer Lingus, by route) still has
// its fact for the surfaces that don't, but is no example of a refusal.
const lookupCodes = new Set(hubLookupAirlines().map((a) => a.iata));
const answered = contentOnlyFacts();
const negatives = answered.filter((e) => e.status === "not_starlink");
const announced = answered.filter((e) => e.status === "announced");
const flying = answered.filter(
  (e) => e.status !== "announced" && e.status !== "not_starlink" && !lookupCodes.has(e.iata)
);

const api = async (host: string, path: string, fn: string) => {
  const { status, text } = await bodyOf(app, `${path}?flight_number=${fn}&date=${DATE}`, host);
  return { status, body: JSON.parse(text) as Record<string, unknown> };
};

describe("untrackedAirlineInfo", () => {
  test("the roster holds each kind of airline this covers", () => {
    expect(flying.length).toBeGreaterThan(0);
    expect(announced.length).toBeGreaterThan(0);
    expect(negatives.length).toBeGreaterThan(0);
  });

  test.each(answered.map((e) => [e.iata, e] as const))(
    "%s: the newest current fact, dated and sourced, linked to its hub page",
    (iata, entry) => {
      const info = untrackedAirlineInfo(`${iata}12`);
      if (!info) throw new Error(`no info for ${iata}`);
      const current = entry.facts.filter((f) => !f.superseded);
      const fact = current.find((f) => f.fact === info.fact);
      if (!fact) throw new Error(`${iata}: the fact printed is not a current fact of the entry`);
      const stamp = fact.asOf ?? fact.accessed;
      expect(current.every((f) => (f.asOf ?? f.accessed ?? "") <= (stamp ?? ""))).toBe(true);
      expect([info.as_of, info.checked].filter(Boolean)).toEqual([stamp as string]);
      expect(Boolean(info.as_of)).toBe(Boolean(fact.asOf));
      expect(info.source.url).toBe(fact.source.url);
      expect(info.source.label).toBe(fact.source.label);
      expect(info.page).toBe(`https://${HUB}/airlines/${entry.slug}`);
      expect(info.flying).toBe(entry.status !== "announced" && entry.status !== "not_starlink");
      for (const part of [info.lead, info.dated, info.fact, info.caveat, info.page]) {
        expect(info.summary).toContain(part);
      }
      expect(info.summary).toContain(info.source.url);
    }
  );

  test("an airline with nothing flying reads as a dated not yet", () => {
    for (const e of announced) {
      const info = untrackedAirlineInfo(`${e.iata}12`);
      expect(info?.lead.startsWith("Not yet")).toBe(true);
      expect(info?.dated).toMatch(/^(As of|Checked) /);
    }
    for (const e of flying) {
      expect(untrackedAirlineInfo(`${e.iata}12`)?.lead.startsWith("Not yet")).toBe(false);
    }
  });

  test("it never states a verdict", () => {
    for (const e of answered) {
      const info = untrackedAirlineInfo(`${e.iata}12`) as unknown as Record<string, unknown>;
      for (const key of ["hasStarlink", "probability", "confidence", "flights"]) {
        expect(info).not.toHaveProperty(key);
      }
    }
  });

  test("an airline with no Starlink programme is worded as its choice or as silence, never a no for the flight", () => {
    expect(new Set(negatives.map((e) => e.negative))).toEqual(new Set(["chose", "unannounced"]));
    for (const e of negatives) {
      const info = untrackedAirlineInfo(`${e.iata}12`);
      if (!info) throw new Error(`no info for ${e.iata}`);
      expect(info.status).toBe("not_starlink");
      expect(info.flying).toBe(false);
      expect(info.caveat).toContain("not a check of this flight");
      if (e.negative === "chose") {
        expect(info.lead).toContain("chose another system");
      } else {
        // Silence is an absence of evidence: it is never worded as a no.
        expect(info.lead).toStartWith("We have found no Starlink announcement");
        expect(info.lead).not.toMatch(/has no Starlink/);
        expect(info.caveat).toContain("not proof");
      }
    }
  });

  test("airlines answered by flight and non-numbers get nothing", () => {
    for (const e of AIRLINE_FACTS.filter((x) => x.trackedCode)) {
      expect(untrackedAirlineInfo(`${e.iata}12`)).toBeNull();
    }
    for (const junk of ["", "hello", "1736", "ZZ12", "UAE123", "EK", "EK12345", "EK12A"]) {
      expect(untrackedAirlineInfo(junk)).toBeNull();
    }
  });

  test("typed spellings resolve like the lookup does", () => {
    const [e] = flying;
    const want = untrackedAirlineInfo(`${e.iata}12`);
    expect(untrackedAirlineInfo(` ${e.iata.toLowerCase()} 12 `)).toEqual(want);
    expect(untrackedAirlineInfo(`${e.iata}-12`)).toEqual(want);
  });

  test("an airline's own way to check names its page and the day it was read", () => {
    const withOwn = answered
      .map((e) => untrackedAirlineInfo(`${e.iata}12`))
      .filter((i) => i?.how_to_check);
    expect(withOwn.length).toBeGreaterThan(0);
    for (const info of withOwn) {
      const how = info?.how_to_check;
      expect(how?.source.url).toMatch(/^https:\/\//);
      expect(how?.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(info?.summary).toContain(how?.text as string);
      expect(info?.summary).toContain(how?.source.url as string);
    }
  });
});

// No airline uses this code: the refusal with nothing to add.
const NO_ENTRY = "ZZ";

describe("hub REST answers", () => {
  const [known] = flying;

  test.each([
    ["/api/check-any-flight", 200],
    ["/api/check-flight", 404],
  ] as const)("%s keeps its error and status, and adds airline_info", async (path, status) => {
    const plain = await api(HUB, path, `${NO_ENTRY}100`);
    const withFact = await api(HUB, path, `${known.iata}100`);
    expect(plain.status).toBe(status);
    expect(withFact.status).toBe(status);
    expect(Object.keys(plain.body)).toEqual(["error"]);
    expect(Object.keys(withFact.body)).toEqual(["error", "airline_info"]);
    expect(withFact.body.error).toBe(plain.body.error as string);
    expect(withFact.body.airline_info).toEqual(untrackedAirlineInfo(`${known.iata}100`));
  });

  test("an airline with no entry stays a bare error", async () => {
    expect(Object.keys((await api(HUB, "/api/check-any-flight", "ZZ100")).body)).toEqual(["error"]);
  });

  test("a single-airline host names no other airline's programme", async () => {
    const r = await api(UA, "/api/check-flight", `${known.iata}100`);
    expect(r.status).toBe(404);
    expect(Object.keys(r.body)).toEqual(["error"]);
  });
});

describe("MCP check_flight", () => {
  const [known] = flying;

  test("the hub refusal stays word for word, and the fact follows it", async () => {
    const plain = await mcpTool(app, HUB, "check_flight", {
      flight_number: `${NO_ENTRY}100`,
      date: DATE,
    });
    const withFact = await mcpTool(app, HUB, "check_flight", {
      flight_number: `${known.iata}100`,
      date: DATE,
    });
    expect(withFact.isError).toBe(true);
    expect(withFact.text).toBe(
      `${plain.text}\n\n${untrackedAirlineInfo(`${known.iata}100`)?.summary}`
    );
  });

  test("a single-airline server adds no other airline's fact", async () => {
    const a = await mcpTool(app, UA, "check_flight", {
      flight_number: `${known.iata}100`,
      date: DATE,
    });
    const b = await mcpTool(app, UA, "check_flight", {
      flight_number: `${NO_ENTRY}100`,
      date: DATE,
    });
    expect(a.text).toBe(b.text);
  });
});

describe("the hub page's answer", () => {
  const info = untrackedAirlineInfo(`${flying[0].iata}12`);
  if (!info) throw new Error("no info to render");

  test("prints the fact, its date, both links and the caveat", () => {
    const html = airlineInfoHtml(info);
    for (const part of [info.lead, info.dated, info.caveat, info.source.label]) {
      expect(html).toContain(part.replace(/&/g, "&amp;").replace(/'/g, "&#39;"));
    }
    expect(html).toContain(`href="${info.source.url.replace(/&/g, "&amp;")}"`);
    expect(html).toContain(`href="${info.page}"`);
  });

  test("a source link sits in a paragraph, where a link in a sentence is underlined at rest", () => {
    const html = airlineInfoHtml(info);
    const inParagraphs = (html.match(/<p\b[^>]*>.*?<\/p>/g) ?? []).join("");
    expect(inParagraphs).toContain(`href="${info.source.url.replace(/&/g, "&amp;")}"`);
    expect(html.replace(/<p\b[^>]*>.*?<\/p>/g, "")).not.toMatch(/\(<a /);
  });

  test("escapes every field", () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const html = airlineInfoHtml({
      ...info,
      lead: hostile,
      dated: hostile,
      fact: hostile,
      caveat: hostile,
      airline: hostile,
      page: `"><script>`,
      source: { label: hostile, url: `"><script>` },
      how_to_check: { text: hostile, source: { label: hostile, url: `"><script>` } },
    });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
  });

  test("the hub form carries the retired-code notes and offers no HA example", async () => {
    const { text } = await bodyOf(app, "/", HUB);
    const form = elementAttrs(text, "hub-check-flight");
    expect(
      JSON.parse(form["data-number-notes"].replace(/&quot;/g, '"').replace(/&#x27;/g, "'"))
    ).toEqual(RETIRED_CODE_NOTES);
    const input = elementAttrs(text, "hub-check-flight-number");
    expect(input.placeholder).not.toMatch(/\bHA\d/);
  });
});

describe("an old Hawaiian number", () => {
  test("the note names the AS code and exists for HA alone among answered codes", () => {
    expect(retiredCodeNote("HA50")).toContain("AS");
    expect(retiredCodeNote("ha 50")).toBe(retiredCodeNote("HA50"));
    for (const fn of ["AS850", "UA100", "QR1", "EK12", "HA", "hello"]) {
      expect(retiredCodeNote(fn)).toBeNull();
    }
  });

  test("the page prints it under an answered HA number, escaped", () => {
    expect(numberNoteHtml(RETIRED_CODE_NOTES, "ha 50")).toContain("AS code");
    expect(numberNoteHtml(RETIRED_CODE_NOTES, "AS850")).toBe("");
    expect(numberNoteHtml({ HA: "<b>" }, "HA50")).not.toContain("<b>");
  });

  test("another airline's host adds it beside the unchanged error", async () => {
    const ha = await api(UA, "/api/check-flight", "HA50");
    expect(ha.status).toBe(404);
    expect(Object.keys(ha.body)).toEqual(["error", "flight_number_note"]);
    expect(ha.body.flight_number_note).toBe(retiredCodeNote("HA50") as string);
    const mcp = await mcpTool(app, UA, "check_flight", { flight_number: "HA50", date: DATE });
    expect(mcp.text.endsWith(`\n\n${retiredCodeNote("HA50")}`)).toBe(true);
  });
});

describe("an old Hawaiian number on the hub", () => {
  const note = retiredCodeNote("HA50") as string;

  test.each(["/api/check-any-flight", "/api/check-flight"])(
    "%s answers it as before and adds the note as the last key",
    async (path) => {
      const ha = await api(HUB, path, "HA50");
      const as = await api(HUB, path, "AS850");
      expect(ha.status).toBe(200);
      expect(Object.keys(ha.body).at(-1)).toBe("flight_number_note");
      expect(ha.body.flight_number_note).toBe(note);
      expect(ha.body).toHaveProperty("hasStarlink");
      expect(as.body).not.toHaveProperty("flight_number_note");
    }
  );

  test("an error for an HA number carries no note", async () => {
    const { status, text } = await bodyOf(
      app,
      "/api/check-any-flight?flight_number=HA50&date=not-a-date",
      HUB
    );
    expect(status).toBe(400);
    expect(Object.keys(JSON.parse(text))).toEqual(["error"]);
  });

  test("MCP check_flight and predict_flight_starlink end with the note", async () => {
    for (const tool of ["check_flight", "predict_flight_starlink"]) {
      const ha = await mcpTool(app, HUB, tool, { flight_number: "HA50", date: DATE });
      expect(ha.isError).toBeFalsy();
      expect(ha.text.endsWith(`\n\n${note}`)).toBe(true);
      const as = await mcpTool(app, HUB, tool, { flight_number: "AS850", date: DATE });
      expect(as.text).not.toContain(note);
    }
  });

  test("Hawaiian's own site answers its number with no note", async () => {
    const ha = await api("hawaiianstarlinktracker.com", "/api/check-flight", "HA50");
    expect(ha.body).not.toHaveProperty("flight_number_note");
  });
});

describe("untracked demand tag", () => {
  test.each(["ZG", "XE", "EI", "IB", "BT", "KE", "CM"])("%s is counted by name", (code) => {
    expect(normalizeCarrierPrefix(`${code}123`)).toBe(code);
    expect(normalizeCarrierPrefix(`${code.toLowerCase()} 123`)).toBe(code);
  });

  test("anything else is still other", () => {
    for (const fn of ["ZZ1", "", "<b>1", "EIN105", "É1"]) {
      expect(normalizeCarrierPrefix(fn)).toBe("other");
    }
  });
});
