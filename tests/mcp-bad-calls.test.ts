/**
 * A route tool called badly must say how to call it well. Registry crawlers
 * call every tool with no arguments, daily, on every host: that is most of
 * the three route tools' errors, and an assistant that makes the same mistake
 * has only the error text to recover with. Garbage codes must not come back
 * as a plain "nothing found", which reads as a real answer.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Scope } from "../src/database/reader";
import { createReaderFactory } from "../src/database/reader";
import { COUNTERS, metrics } from "../src/observability/metrics";
import { mcpDirect, openSnapshot, toolText } from "./helpers";

const ROUTE_TOOLS = [
  "search_starlink_flights",
  "predict_route_starlink",
  "plan_starlink_itinerary",
] as const;
const SCOPES: Scope[] = ["UA", "AS", "ALL"];

let factory: ReturnType<typeof createReaderFactory>;
const reasons: string[] = [];
const originalIncrement = metrics.increment;

beforeAll(() => {
  factory = createReaderFactory(openSnapshot());
  metrics.increment = (name, tags) => {
    if (name === COUNTERS.MCP_TOOL_CALL) reasons.push(`${tags?.outcome}:${tags?.reason}`);
    originalIncrement(name, tags);
  };
});

afterAll(() => {
  metrics.increment = originalIncrement;
});

const raw = (scope: Scope, name: string, args?: Record<string, unknown>) =>
  mcpDirect(
    scope,
    factory,
    "tools/call",
    args === undefined ? { name } : { name, arguments: args }
  );

const call = async (scope: Scope, name: string, args?: Record<string, unknown>) =>
  toolText(await raw(scope, name, args));

/** The reason tag of the one tool call `fn` makes. */
async function reasonOf(fn: () => Promise<unknown>): Promise<string> {
  reasons.length = 0;
  await fn();
  expect(reasons).toHaveLength(1);
  return reasons[0];
}

describe("a route tool called without its airports", () => {
  test("names itself, and the example it shows is a call that works", async () => {
    for (const scope of SCOPES) {
      for (const name of ROUTE_TOOLS) {
        for (const args of [undefined, {}, { origin: "", destination: "  " }, { origin: null }]) {
          const bad = await call(scope, name, args);
          expect(bad.isError, `${scope} ${name}`).toBe(true);
          expect(bad.text).toContain(name);
          expect(bad.text).toContain("3-letter IATA");
          const example = bad.text.match(/Example arguments: (\{[^}]*\})/)?.[1];
          expect(example, bad.text).toBeDefined();
          // The hub compares carriers on a pair, so its one-sided example
          // gets the hub's own both-are-required answer instead.
          if (scope === "ALL" && name === "predict_route_starlink") continue;
          const retry = await call(scope, name, JSON.parse(example as string));
          expect(retry.isError, `${scope} ${name} example: ${retry.text}`).toBe(false);
        }
      }
    }
  });

  test("names the keys it was sent that are not parameters", async () => {
    for (const name of ROUTE_TOOLS) {
      const bad = await call("UA", name, { from: "SFO", to: "EWR" });
      expect(bad.isError).toBe(true);
      expect(bad.text).toContain("Not parameters of this tool: from, to.");
      expect(bad.text).toContain("origin");
    }
  });

  test("says which airport is missing when the planner gets one", async () => {
    const bad = await call("UA", "plan_starlink_itinerary", { origin: "SFO" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("Only origin was given.");
  });

  test("echoes caller text bounded and without markup", async () => {
    const bad = await call("UA", "search_starlink_flights", {
      origin: `<script>alert(1)</script>${"x".repeat(200)}`,
      [`<b>${"k".repeat(200)}`]: 1,
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).not.toContain("<");
    expect(bad.text.length).toBeLessThan(300);
  });
});

describe("codes that are not airports", () => {
  test("are errors on every route tool, never a plain nothing-found", async () => {
    for (const scope of SCOPES) {
      for (const name of ROUTE_TOOLS) {
        for (const origin of ["San Francisco", "string", "SF0", "SFOO"]) {
          const bad = await call(scope, name, { origin, destination: "EWR" });
          expect(bad.isError, `${scope} ${name} ${origin}: ${bad.text}`).toBe(true);
          expect(bad.text).toContain("Unknown airport code");
          expect(bad.text).toContain("origin");
        }
        const typed = await call(scope, name, { origin: ["SFO"], destination: "EWR" });
        expect(typed.isError, `${scope} ${name}`).toBe(true);
        expect(typed.text).toContain("origin must be a string");
      }
    }
  });

  test("search rejects the same airport twice", async () => {
    const same = await call("UA", "search_starlink_flights", { origin: "SFO", destination: "sfo" });
    expect(same.isError).toBe(true);
    expect(same.text).toContain("are the same");
  });

  test("real codes still answer: lower case, padded, K-prefixed ICAO", async () => {
    for (const scope of SCOPES) {
      for (const name of ROUTE_TOOLS) {
        for (const args of [
          { origin: " sfo ", destination: "ewr" },
          { origin: "KSFO", destination: "KEWR" },
        ]) {
          const good = await call(scope, name, args);
          expect(good.isError, `${scope} ${name}: ${good.text}`).toBe(false);
          expect(good.text).not.toContain("Unknown airport code");
        }
      }
    }
  });
});

// The tracker's coordinates table and stored flights are not a list of the
// world's airports. A well-formed code outside both was once refused as
// "Unknown airport code": Glasgow, Christchurch and Nuuk on United's site,
// Kigali on Qatar's, Nadi on Alaska's. Without a complete list a code cannot
// be called unknown, so these say what the data shows instead.
describe("a well-formed code the tracker has no flights for", () => {
  const UNSEEN: [Scope, string, string, string][] = [
    ["UA", "EWR", "GLA", "United Airlines"],
    ["UA", "SFO", "CHC", "United Airlines"],
    ["UA", "EWR", "GOH", "United Airlines"],
    ["QR", "DOH", "KGL", "Qatar Airways"],
    ["AS", "SEA", "NAN", "Alaska Airlines"],
    // No airport has this code. The tracker cannot know that, and does not say so.
    ["UA", "EWR", "XQZ", "United Airlines"],
  ];

  test("is answered on every route tool, never called an unknown code", async () => {
    for (const [scope, origin, destination, airline] of UNSEEN) {
      for (const name of ROUTE_TOOLS) {
        for (const args of [
          { origin, destination },
          { origin: destination, destination: origin },
        ]) {
          const label = `${scope} ${name} ${args.origin}-${args.destination}`;
          const answer = await call(scope, name, args);
          expect(answer.isError, `${label}: ${answer.text}`).toBe(false);
          expect(answer.text, label).not.toContain("Unknown airport code");
          expect(answer.text, label).toContain(
            `no ${airline} flights on record to or from ${destination}`
          );
        }
      }
    }
  });

  test("one-sided calls answer too, and the planner is not sent a dead end", async () => {
    for (const name of ["search_starlink_flights", "predict_route_starlink"]) {
      for (const args of [{ origin: "GLA" }, { destination: "XQZ" }]) {
        const answer = await call("UA", name, args);
        expect(answer.isError, `${name}: ${answer.text}`).toBe(false);
        expect(answer.text).toContain("flights on record");
      }
    }
    const search = await call("UA", "search_starlink_flights", {
      origin: "EWR",
      destination: "GLA",
    });
    expect(search.text).toContain("No scheduled Starlink flights found for EWR→GLA");
    expect(search.text).not.toContain("plan_starlink_itinerary");
  });

  test("counts as a success on the call counter", async () => {
    for (const name of ROUTE_TOOLS) {
      expect(
        await reasonOf(() => raw("UA", name, { origin: "EWR", destination: "GLA" })),
        name
      ).toBe("success:none");
    }
  });

  test("the hub and airports the tracker knows are answered as before", async () => {
    const hub = await call("ALL", "search_starlink_flights", { origin: "EWR", destination: "GLA" });
    expect(hub.isError).toBe(false);
    expect(hub.text).not.toContain("flights on record");
    for (const name of ROUTE_TOOLS) {
      const known = await call("UA", name, { origin: "SFO", destination: "EWR" });
      expect(known.isError, name).toBe(false);
      expect(known.text, name).not.toContain("flights on record");
    }
  });
});

describe("what a client receives", () => {
  test("an error result keeps the wire shape: content and isError only", async () => {
    for (const name of ROUTE_TOOLS) {
      const { result } = await raw("UA", name, {});
      expect(Object.keys(result).sort()).toEqual(["content", "isError"]);
      expect(result.content).toHaveLength(1);
      expect(Object.keys(result.content[0]).sort()).toEqual(["text", "type"]);
    }
  });

  test("the call counter says why a call failed", async () => {
    const tool = "plan_starlink_itinerary";
    expect(await reasonOf(() => raw("UA", tool, {}))).toBe("error:missing_argument");
    expect(await reasonOf(() => raw("UA", tool, { origin: "SFO", destination: "SFO" }))).toBe(
      "error:same_airport"
    );
    expect(await reasonOf(() => raw("UA", tool, { origin: "Paris", destination: "SFO" }))).toBe(
      "error:unknown_airport"
    );
    expect(
      await reasonOf(() => raw("UA", tool, { origin: "SFO", destination: "EWR", date: "soon" }))
    ).toBe("error:invalid_argument");
    expect(await reasonOf(() => raw("UA", "check_flight", {}))).toBe("error:missing_argument");
    expect(await reasonOf(() => raw("UA", tool, { origin: "SFO", destination: "EWR" }))).toBe(
      "success:none"
    );
  });
});
