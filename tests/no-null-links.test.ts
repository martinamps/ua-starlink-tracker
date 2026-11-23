/**
 * No surface may build an address from a missing value. Crawlers asked for
 * /check-flight/null, /fleet/null, /null and the like; those requests turned
 * out to come from two crawlers' own page rendering, not from a link we serve
 * (see the pull request that added this file). This pins that: every page a
 * site links from its homepage and sitemap, its feeds and text files, and the
 * MCP tools' answers are read for an address with a null, undefined, NaN or
 * stringified-object segment.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import { setAssignmentFetcher } from "../src/api/flight-verdict";
import type { Scope } from "../src/database/reader";
import { createReaderFactory } from "../src/database/reader";
import { createApp } from "../src/server/app";
import { bodyOf, mcpDirect, openSnapshot, toolText } from "./helpers";

const HOSTS = Object.values(SITES).map((s) => s.canonicalHost);
const PAGES_PER_HOST = 80;

// A whole path segment or query value, so /fleet/null and ?date=undefined
// match while "nullable" or "/routes/nan-to-x" never would.
const MISSING = /(?:^|[/=&?#])(?:null|undefined|NaN|\[object Object\])(?=$|[/&?#"])/;

/** Every address-bearing value in a document: markup attributes, absolute
 * URLs in text (feeds, llms.txt, JSON-LD, tool answers) and CSV/JSON paths. */
function addresses(body: string): string[] {
  const attrs = [...body.matchAll(/\s(?:href|src|action|content|data-href|poster)="([^"]*)"/g)]
    .map((m) => m[1])
    // content="" also carries prose (descriptions); keep what looks like an address.
    .filter((v) => /^(?:https?:|webcal:|\/|\.|#|\?)/.test(v) || !/\s/.test(v));
  const absolute = [...body.matchAll(/(?:https?|webcal):\/\/[^\s"'<>)\\]+/g)].map((m) => m[0]);
  return [...attrs, ...absolute];
}

const missingIn = (body: string) => addresses(body).filter((a) => MISSING.test(a));

let app: ReturnType<typeof createApp>;
let factory: ReturnType<typeof createReaderFactory>;

beforeAll(() => {
  const db = openSnapshot();
  app = createApp(db);
  factory = createReaderFactory(db);
  // check_flight near departure would otherwise go to the live schedule source.
  setAssignmentFetcher(async () => []);
});

afterAll(() => {
  setAssignmentFetcher(null);
});

describe("the detector", () => {
  test("flags a missing segment and nothing else", () => {
    const bad = [
      '<a href="/check-flight/null">',
      '<a href="/route-planner/PIT/null">',
      '<a href="null">',
      '<img src="/fleet/undefined">',
      "see https://x.test/airlines/null for more",
      '<a href="/check-flight/UA1?date=undefined">',
      '<a href="/fleet/[object Object]">',
    ];
    for (const html of bad) expect(missingIn(html), html).toHaveLength(1);
    const good = [
      '<a href="/check-flight/UA544">',
      '<meta name="description" content="null island is not an airport">',
      '<a href="/airlines/nullable-air">',
      '<meta property="og:url" content="https://x.test/fleet/e175">',
    ];
    for (const html of good) expect(missingIn(html), html).toEqual([]);
  });
});

describe("no address is built from a missing value", () => {
  for (const host of HOSTS) {
    test(`${host}: pages linked from the homepage and sitemap`, async () => {
      const home = await bodyOf(app, "/", host);
      const sitemap = await bodyOf(app, "/sitemap.xml", host);
      const local = (body: string) =>
        addresses(body)
          .map((a) => a.replace(new RegExp(`^https?://${host.replace(/\./g, "\\.")}`), ""))
          .filter((a) => a.startsWith("/") && !a.startsWith("//") && !a.startsWith("/static/"));
      // Spread across page families instead of taking the first N of one.
      const byFamily = new Map<string, string[]>();
      for (const path of new Set(["/", ...local(home.text), ...local(sitemap.text)])) {
        const family = path.split(/[/?#]/)[1] ?? "";
        byFamily.set(family, [...(byFamily.get(family) ?? []), path.split("#")[0]]);
      }
      const perFamily = Math.max(2, Math.floor(PAGES_PER_HOST / Math.max(1, byFamily.size)));
      const paths = [...byFamily.values()].flatMap((list) => list.slice(0, perFamily));
      expect(paths.length).toBeGreaterThan(3);

      const found: string[] = [];
      for (const path of paths) {
        const { status, text } = await bodyOf(app, path, host);
        if (status >= 500) found.push(`${path} → ${status}`);
        for (const a of missingIn(text)) found.push(`${path}: ${a}`);
      }
      expect(found).toEqual([]);
    });

    test(`${host}: the not-found page, feeds and text files`, async () => {
      const found: string[] = [];
      for (const path of [
        "/no-such-page",
        "/feed.xml",
        "/sitemap.xml",
        "/llms.txt",
        "/robots.txt",
        "/data/starlink-tails.csv",
        "/api/data",
      ]) {
        const { text } = await bodyOf(app, path, host);
        for (const a of missingIn(text)) found.push(`${path}: ${a}`);
      }
      expect(found).toEqual([]);
    });
  }

  test("MCP tool answers", async () => {
    // Far enough out that neither flight tool goes to a live schedule source.
    const date = new Date(Date.now() + 60 * 86400_000).toISOString().slice(0, 10);
    const calls: [string, Record<string, unknown>][] = [
      ["get_fleet_stats", {}],
      ["list_starlink_aircraft", { limit: 500 }],
      ["check_flight", { flight_number: "UA544", date }],
      ["predict_flight_starlink", { flight_number: "UA544", date }],
      ["predict_route_starlink", { origin: "SFO", destination: "EWR" }],
      ["plan_starlink_itinerary", { origin: "SFO", destination: "EWR" }],
      ["search_starlink_flights", { origin: "SFO" }],
    ];
    const found: string[] = [];
    for (const scope of ["UA", "AS", "ALL"] as Scope[]) {
      for (const [name, args] of calls) {
        const { text } = toolText(
          await mcpDirect(scope, factory, "tools/call", { name, arguments: args })
        );
        for (const a of missingIn(text)) found.push(`${scope} ${name}: ${a}`);
      }
    }
    expect(found).toEqual([]);
  });
});
