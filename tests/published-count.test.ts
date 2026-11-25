/**
 * An airline known only by aircraft type has no count of its own on this site:
 * the hub may print the airline's own dated figure or nothing, never the sum
 * of its finished types as "aircraft with Starlink".
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, rmSync } from "node:fs";
import {
  checkedPlaneByPlane,
  publishedCount,
  statedCount,
  trackingMethod,
} from "../src/airlines/published-count";
import {
  type AirlineConfig,
  enabledAirlines,
  hubContentAirlines,
  hubLookupAirlines,
} from "../src/airlines/registry";
import {
  AIRLINE_FACTS,
  airlineOwnCount,
  airlineOwnTypeSum,
  airlineOwnTypeTotal,
} from "../src/airlines/rollout-facts";
import { createApp } from "../src/server/app";
import {
  TEST_DB,
  addPlane,
  bodyOf as bodyOfApp,
  jsonOf,
  mcpReq,
  openSnapshot,
  toolText,
} from "./helpers";

const HUB = "airlinestarlinktracker.com";

let app: ReturnType<typeof createApp>;
let db: Database;
let byType: Array<{ cfg: AirlineConfig }>;

beforeAll(() => {
  db = openSnapshot();
  app = createApp(db);
  byType = hubContentAirlines()
    .filter((cfg) => trackingMethod(cfg) === "type")
    .map((cfg) => ({ cfg }));
  if (byType.length === 0) throw new Error("no by-type airline on the hub: nothing is tested");
});

const bodyOf = (path: string) => bodyOfApp(app, path, HUB);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("the published-count rule", () => {
  test("a plane-by-plane airline publishes its tracked count", () => {
    const tail = hubContentAirlines().find((cfg) => trackingMethod(cfg) === "tail");
    if (!tail) throw new Error("no plane-by-plane airline on the hub");
    expect(publishedCount(tail, 7)).toEqual({ basis: "tracked", count: 7 });
  });

  test("a by-type airline never publishes the by-type sum", () => {
    for (const { cfg } of byType) {
      const p = publishedCount(cfg, 123456);
      expect(p.basis).not.toBe("tracked");
      if (p.basis === "airline" || p.basis === "type-sum") {
        expect(p.count).not.toBe(123456);
        expect(p.asOf).toMatch(/^\d{4}-\d{2}/);
        expect(p.url).toStartWith("https://");
      }
    }
  });

  test("an airline's own figure is dated, current and stated by its fact", () => {
    for (const entry of AIRLINE_FACTS) {
      for (const f of entry.facts) {
        if (f.officialFleetCount === undefined) continue;
        expect(f.asOf).toBeDefined();
        expect(f.fact).toContain(String(f.officialFleetCount));
      }
      if (!entry.trackedCode) continue;
      const own = airlineOwnCount(entry.trackedCode);
      const current = entry.facts.filter(
        (f) => !f.superseded && f.officialFleetCount !== undefined
      );
      expect(own === null).toBe(current.length === 0);
      if (own) expect(current.map((f) => f.asOf)).toContain(own.asOf);
    }
  });

  test("a sum of whole types is its fact's stated counts, dated, and never outranks the airline's own figure", () => {
    let sums = 0;
    for (const entry of AIRLINE_FACTS) {
      for (const f of entry.facts) {
        if (!f.wholeTypes) continue;
        expect(f.asOf, entry.slug).toBeDefined();
        expect(f.wholeTypes.by.length, entry.slug).toBeGreaterThan(0);
        // The fact states each count and calls the type complete; the sum
        // itself is nobody's claim, so it is never an officialFleetCount.
        for (const t of f.wholeTypes.types) expect(f.fact, entry.slug).toContain(`all ${t.count} `);
        expect(f.officialFleetCount, entry.slug).toBeUndefined();
      }
      if (!entry.trackedCode) continue;
      const sum = airlineOwnTypeSum(entry.trackedCode);
      const current = entry.facts.filter(
        (f) => !f.superseded && f.asOf && f.wholeTypes?.types.some((t) => t.count > 0)
      );
      expect(sum === null).toBe(current.length === 0);
      if (!sum) continue;
      sums++;
      expect(current.map((f) => f.asOf)).toContain(sum.asOf);
      expect(sum.parts.length).toBeGreaterThan(0);
      expect(sum.count).toBe(sum.parts.reduce((a, p) => a + p.count, 0));
      expect(sum.url).toStartWith("https://");
    }
    expect(sums).toBeGreaterThan(0);
    for (const { cfg } of byType) {
      const expected = airlineOwnCount(cfg.code)
        ? "airline"
        : airlineOwnTypeSum(cfg.code)
          ? "type-sum"
          : "type";
      expect(publishedCount(cfg, 7).basis).toBe(expected);
    }
  });
});

describe("the count a search description may state", () => {
  const typeRuled = () =>
    enabledAirlines().filter((cfg) => trackingMethod(cfg) === "tail" && cfg.typeDeterministicWifi);

  test("an airline checked plane by plane states its tracked count", () => {
    const tail = enabledAirlines().find(checkedPlaneByPlane);
    if (!tail) throw new Error("no airline is checked plane by plane: nothing is tested");
    expect(statedCount(tail, 7)).toBe(7);
    expect(statedCount(tail, 0)).toBeNull();
  });

  test("an airline with a type rule is not plane by plane, whatever its phase table says", () => {
    if (typeRuled().length === 0) {
      throw new Error("no airline has a type rule without a phase table: nothing is tested");
    }
    for (const cfg of enabledAirlines()) {
      if (!cfg.typeDeterministicWifi && !cfg.communitySource) continue;
      expect(checkedPlaneByPlane(cfg)).toBe(false);
      expect(statedCount(cfg, 123456)).toBeNull();
    }
  });

  test("a count settled by type is stated only when it equals the airline's own dated figure", () => {
    let checked = 0;
    for (const cfg of enabledAirlines()) {
      if (checkedPlaneByPlane(cfg)) continue;
      const own = airlineOwnCount(cfg.code)?.count ?? airlineOwnTypeTotal(cfg.code)?.total;
      if (own === undefined) continue;
      expect(statedCount(cfg, own)).toBe(own);
      expect(statedCount(cfg, own + 1)).toBeNull();
      expect(statedCount(cfg, own - 1)).toBeNull();
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  test("a community list is never stated, even beside a plane-by-plane method", () => {
    const tail = enabledAirlines().find(checkedPlaneByPlane);
    if (!tail) throw new Error("no airline is checked plane by plane: nothing is tested");
    const community = {
      ...tail,
      communitySource: { label: "a forum list", url: "https://x.test" },
    };
    expect(checkedPlaneByPlane(community)).toBe(false);
    expect(statedCount(community, 7)).toBeNull();
    for (const cfg of enabledAirlines().filter((a) => a.communitySource)) {
      if (!airlineOwnCount(cfg.code)) expect(statedCount(cfg, 7)).toBeNull();
    }
  });

  test("the per-type total is the newest current dated fact's counts, each stated by its text", () => {
    for (const entry of AIRLINE_FACTS) {
      if (!entry.trackedCode) continue;
      const total = airlineOwnTypeTotal(entry.trackedCode);
      const current = entry.facts.filter((f) => !f.superseded && f.asOf && f.officialCounts);
      expect(total === null).toBe(current.length === 0);
      if (!total) continue;
      const fact = current.find((f) => f.asOf === total.asOf);
      const counts = Object.values(fact?.officialCounts ?? {});
      expect(total.total).toBe(counts.reduce((a, b) => a + b, 0));
      for (const n of counts.filter((c) => c > 0)) expect(fact?.fact).toContain(String(n));
    }
  });
});

describe("hub search description on seeded counts", () => {
  // An airline with a type rule and a per-type total on file (Alaska today):
  // seeded so that its tracked count equals that total, then one past it.
  let tmp: string;
  let wdb: Database;
  let cfg: AirlineConfig;
  let own: number;

  beforeAll(() => {
    const found = enabledAirlines().find(
      (a) => a.publicInHub && !checkedPlaneByPlane(a) && airlineOwnTypeTotal(a.code)
    );
    if (!found) throw new Error("no type-ruled airline has a per-type total: nothing is tested");
    cfg = found;
    own = airlineOwnTypeTotal(cfg.code)?.total ?? 0;
    tmp = `/tmp/ua-stated-count-${process.pid}-${Date.now()}.sqlite`;
    copyFileSync(TEST_DB, tmp);
    wdb = new Database(tmp);
    const have = (
      wdb.query("SELECT COUNT(*) n FROM starlink_planes WHERE airline = ?").get(cfg.code) as {
        n: number;
      }
    ).n;
    for (let i = have; i < own; i++) addPlane(wdb, `N${1000 + i}ZZ`, null, { airline: cfg.code });
  });

  afterAll(() => {
    wdb.close();
    rmSync(tmp, { force: true });
  });

  const describeHub = async () => metaDescription((await bodyOfApp(createApp(wdb), "/", HUB)).text);

  test("its count is stated while it equals the airline's own figures, and dropped once it doesn't", async () => {
    const matching = await describeHub();
    const figure = `${cfg.shortName} (?:has it )?on ${own.toLocaleString("en-US")}`;
    expect(matching).toMatch(new RegExp(figure));
    expect(matching).not.toContain("plane by plane");
    expect(matching).toMatch(/ Check a flight by number on \d+ of them\.$/);

    addPlane(wdb, "N9999ZZ", null, { airline: cfg.code });
    const ahead = await describeHub();
    expect(ahead).not.toContain(cfg.shortName);
    expect(ahead).toMatch(/ Check a flight by number on \d+ of them\.$/);
  });
});

/** Every description a search engine or an assistant reads off a hub page:
 * the meta tags, the structured data's own descriptions, llms.txt's summary. */
function descriptionsOf(html: string, llms: string): string[] {
  const plain = (t: string) => t.replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
  return [
    ...[...html.matchAll(/<meta (?:name|property)="[\w:]*description" content="([^"]*)"/g)].map(
      (m) => plain(m[1])
    ),
    ...[...html.matchAll(/"description":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)),
    ...llms.split("\n").flatMap((l) => (l.startsWith("> ") ? [l.slice(2)] : [])),
  ];
}

const metaDescription = (html: string) =>
  html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "";

describe("hub home page", () => {
  test("the search description states a count only for an airline whose count needs no caveat", async () => {
    const { text } = await bodyOf("/");
    const desc = metaDescription(text);
    expect(desc).toMatch(
      /^\d+ airlines fly Starlink Wi-Fi or are installing it\.( [^.]+\.)? Check a flight by number on \d+ of them\.$/
    );
    expect(desc).not.toContain("plane by plane");
    expect(desc).not.toContain("-operated");
    for (const cfg of enabledAirlines()) {
      const stated = desc.match(new RegExp(`${esc(cfg.shortName)} (?:has it )?on ([\\d,]+)`));
      if (!stated) {
        expect(desc).not.toContain(cfg.shortName);
        continue;
      }
      const n = Number(stated[1].replace(/,/g, ""));
      expect(statedCount(cfg, n)).toBe(n);
    }
  });

  test("the search description offers the flight check for the airlines that answer it, not for every rollout", async () => {
    const desc = metaDescription((await bodyOf("/")).text);
    const [, rollouts, checkable] =
      desc.match(/^(\d+) airlines .* Check a flight by number on (\d+) of them\.$/) ?? [];
    expect(desc).not.toContain("any flight");
    expect(Number(checkable)).toBe(hubLookupAirlines().length);
    expect(Number(checkable)).toBeLessThan(Number(rollouts));
    for (const cfg of hubLookupAirlines()) {
      const json = await jsonOf(
        app,
        `/api/check-any-flight?flight_number=${cfg.iata}9999&date=2026-03-22`,
        HUB
      );
      expect(json.error ?? "").not.toContain("not tracked");
    }
  });

  test("no description calls an airline with a type rule or a community list plane by plane", async () => {
    const [{ text: html }, { text: llms }] = await Promise.all([bodyOf("/"), bodyOf("/llms.txt")]);
    const descriptions = descriptionsOf(html, llms);
    expect(descriptions.length).toBeGreaterThan(3);
    const notPlaneByPlane = enabledAirlines().filter((cfg) => !checkedPlaneByPlane(cfg));
    for (const sentence of descriptions.flatMap((d) => d.split(/(?<=\.)\s+/))) {
      if (!/plane[ -]by[ -]plane/i.test(sentence)) continue;
      for (const cfg of notPlaneByPlane) expect(sentence).not.toContain(cfg.shortName);
    }
  });

  test("the most-planes answer ranks a by-type airline by its own dated figure or not at all", async () => {
    const { text } = await bodyOf("/");
    const answer =
      text.match(
        /"name":"Which airline has the most Starlink planes\?","acceptedAnswer":\{"@type":"Answer","text":"([^"]*)"/
      )?.[1] ?? "";
    expect(answer).toContain("counted by aircraft type");
    for (const { cfg } of byType) {
      const own = airlineOwnCount(cfg.code);
      const ranked = new RegExp(`${esc(cfg.name)}(, with| \\()`);
      const sum = airlineOwnTypeSum(cfg.code);
      if (own) {
        expect(answer).toMatch(
          new RegExp(`${esc(cfg.name)}(, with | \\()[\\d,]+, its own figure as of \\w+`)
        );
      } else if (sum) {
        // The sum never stands without its parts, who counted them and when.
        expect(answer).toMatch(
          new RegExp(
            `${esc(cfg.name)}(, with | \\()[\\d,]+, our sum of [\\d,]+ [^.()]* per [^.()]+ as of \\w+ \\d`
          )
        );
        expect(answer).toMatch(
          new RegExp(`${esc(cfg.name)}[^.]* per-type counts a source gives\\.`)
        );
      } else {
        expect(answer).not.toMatch(ranked);
        expect(answer).toMatch(new RegExp(`${esc(cfg.name)}[^.]* no figure to rank\\.`));
      }
    }
  });

  test("a by-type row gives the airline's dated figure with its source, or no figure", async () => {
    const { text } = await bodyOf("/");
    for (const { cfg } of byType) {
      const at = text.indexOf(`>${cfg.name}</a>`);
      expect(at).toBeGreaterThan(-1);
      const row = text.slice(at, text.indexOf("</li>", at)).replace(/<!-- -->/g, "");
      expect(row).toContain("by aircraft type");
      const own = airlineOwnCount(cfg.code);
      if (own) {
        expect(row).toMatch(/aircraft with Starlink, per [^<]+ as of \w+ \d/);
        expect(row).toContain(`href="${own.url}"`);
      } else if (airlineOwnTypeSum(cfg.code)) {
        const sum = airlineOwnTypeSum(cfg.code);
        expect(row).toMatch(/aircraft with Starlink: [\d,]+ [^<]*, per [^<]+ as of \w+ \d/);
        expect(row).toContain(`href="${sum?.url}"`);
        expect(row).toContain("The total is our sum");
      } else {
        expect(row).not.toContain("aircraft with Starlink");
      }
    }
  });
});

describe("Qatar's own figure on the hub home page", () => {
  // Pinned on purpose, against the shapes-not-values habit: this figure comes
  // from a source file, not the data snapshot, and a newer one must be a
  // deliberate edit here too.
  test("the row and the most-planes answer print 170, dated and sourced", async () => {
    const qr = enabledAirlines().find((cfg) => cfg.code === "QR");
    if (!qr) throw new Error("Qatar is not an enabled airline: nothing is tested");
    const own = airlineOwnCount("QR");
    expect(own).toMatchObject({ count: 170, asOf: "2026-11-16", sourceLabel: "The Peninsula" });

    const { text } = await bodyOf("/");
    const at = text.indexOf(`>${qr.name}</a>`);
    expect(at).toBeGreaterThan(-1);
    const row = text.slice(at, text.indexOf("</li>", at)).replace(/<!-- -->/g, "");
    expect(row.replace(/<[^>]+>/g, "")).toContain(
      "170 aircraft with Starlink, per Qatar Airways as of Nov 16, 2026"
    );
    expect(row).toContain(`href="${own?.url}"`);

    const answer =
      text.match(
        /"name":"Which airline has the most Starlink planes\?","acceptedAnswer":\{"@type":"Answer","text":"([^"]*)"/
      )?.[1] ?? "";
    expect(answer).toMatch(/Qatar Airways(, with | \()170, its own figure as of Nov 16, 2026/);
  });
});

describe("hub /airlines", () => {
  test("a by-type row's figure is the airline's own, dated, or absent", async () => {
    const { text } = await bodyOf("/airlines");
    expect(text).toContain("counted by aircraft type");
    for (const { cfg } of byType) {
      const at = text.indexOf(`>${cfg.name}</a>`);
      expect(at).toBeGreaterThan(-1);
      const row = text.slice(at, text.indexOf("</tr>", at)).replace(/<!-- -->/g, "");
      if (airlineOwnCount(cfg.code)) expect(row).toMatch(/[\d,]+<span[^>]*>as of \w+ \d/);
      else if (airlineOwnTypeSum(cfg.code)) {
        expect(row).toMatch(/[\d,]+<span[^>]*>[\d,]+ [^<]*, per [^<]+ as of \w+ \d/);
        expect(text).toContain("our sum of the per-type counts");
      } else expect(row).toContain("By type");
    }
  });
});

describe("MCP fleet answers for a by-type airline", () => {
  const call = async (code: string, name: string) => {
    const r = await app.dispatch(
      mcpReq(HUB, "tools/call", { name, arguments: {} }, { query: `?scope=${code}` })
    );
    return toolText(await r.json()).text;
  };

  test("get_fleet_stats labels the by-type sum and never calls it a count", async () => {
    for (const { cfg } of byType) {
      const text = await call(cfg.code, "get_fleet_stats");
      expect(text).toContain("counted by aircraft type, not plane by plane");
      expect(text).not.toMatch(/\d aircraft have Starlink WiFi/);
      const own = airlineOwnCount(cfg.code);
      if (own) expect(text).toContain(`${own.count} aircraft as of ${own.asOf}`);
      const sum = own ? null : airlineOwnTypeSum(cfg.code);
      if (sum) {
        expect(text).toContain(`as of ${sum.asOf}`);
        expect(text).toContain(`that is ${sum.count} aircraft, a total the source does not state`);
        for (const p of sum.parts) expect(text).toContain(`${p.count} ${p.name}`);
      }
    }
  });

  test("the hub's line for a by-type airline carries the same sourced figure", async () => {
    const r = await app.dispatch(
      mcpReq(HUB, "tools/call", { name: "get_fleet_stats", arguments: {} })
    );
    const text = toolText(await r.json()).text;
    let lines = 0;
    for (const { cfg } of byType) {
      const line = text.split("\n").find((l) => l.startsWith(`**${cfg.name}**`));
      if (!line) continue;
      lines++;
      expect(line).toContain("counted by aircraft type, not plane by plane");
      const sum = airlineOwnCount(cfg.code) ? null : airlineOwnTypeSum(cfg.code);
      if (sum)
        expect(line).toContain(`that is ${sum.count} aircraft, a total the source does not state`);
    }
    expect(lines).toBeGreaterThan(0);
  });

  test("list_starlink_aircraft says its list is by type", async () => {
    for (const { cfg } of byType) {
      const text = await call(cfg.code, "list_starlink_aircraft");
      expect(text.split("\n")[0]).toContain("counted by aircraft type");
      expect(text.split("\n")[0]).not.toContain("Starlink-equipped aircraft");
    }
  });
});
