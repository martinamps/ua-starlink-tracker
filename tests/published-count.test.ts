/**
 * An airline known only by aircraft type has no count of its own on this site:
 * the hub may print the airline's own dated figure or nothing, never the sum
 * of its finished types as "aircraft with Starlink".
 */

import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { publishedCount, trackingMethod } from "../src/airlines/published-count";
import { type AirlineConfig, hubContentAirlines } from "../src/airlines/registry";
import { AIRLINE_FACTS, airlineOwnCount } from "../src/airlines/rollout-facts";
import { createApp } from "../src/server/app";
import { bodyOf as bodyOfApp, mcpReq, openSnapshot, toolText } from "./helpers";

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
      if (p.basis === "airline") {
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
});

describe("hub home page", () => {
  test("the search description names only airlines counted plane by plane", async () => {
    const { text } = await bodyOf("/");
    const desc = text.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "";
    expect(desc).toMatch(
      /airlines fly Starlink Wi-Fi or are installing it\. Counted plane by plane: \S+ \([\d,]+/
    );
    expect(desc).toEndWith("Check any flight by number.");
    for (const { cfg } of byType) expect(desc).not.toContain(cfg.shortName);
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
      if (own) {
        expect(answer).toMatch(
          new RegExp(`${esc(cfg.name)}(, with | \\()[\\d,]+, its own figure as of \\w+`)
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
      } else {
        expect(row).not.toContain("aircraft with Starlink");
      }
    }
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
      else expect(row).toContain("By type");
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
    }
  });

  test("list_starlink_aircraft says its list is by type", async () => {
    for (const { cfg } of byType) {
      const text = await call(cfg.code, "list_starlink_aircraft");
      expect(text.split("\n")[0]).toContain("counted by aircraft type");
      expect(text.split("\n")[0]).not.toContain("Starlink-equipped aircraft");
    }
  });
});
