/**
 * One percent for one count.
 *
 * The home page printed 44% and /api/fleet-summary answered 45 for the same
 * 736 of 1,636 aircraft: the pages floored, the API rounded to a tenth, the
 * MCP tool printed one decimal and its instructions rounded. A reader who met
 * two of them had no reason to trust either. pctWhole (components/ui/format)
 * is the one rule now, and these tests hold every surface to it three ways:
 * the rule itself, each sentence a surface serves that states a share beside
 * its counts, and the sources, so a new file can't bring its own arithmetic.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { buildCardSpecs, buildShareCardSpecs } from "../scripts/generate-og-images";
import { AIRLINES, SITES, publicAirlines, siteForAirline } from "../src/airlines/registry";
import { pct, pctWhole } from "../src/components/ui/format";
import { createApp } from "../src/server/app";
import { denominatorIsPublishable } from "../src/utils/share-cards";
import { bodyOf, jsonOf, mcpInitialize, mcpTool, openSnapshot, readableText } from "./helpers";

const ROOT = join(import.meta.dir, "..");
const HUB = SITES.airline.canonicalHost;
const HOSTS = Object.values(SITES)
  .filter((s) => s.live)
  .map((s) => s.canonicalHost);

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  app = createApp(openSnapshot());
});

describe("the rule", () => {
  test("is the whole number below the share", () => {
    expect(pctWhole(736, 1636)).toBe(44);
    expect(pct(736, 1636)).toBe("44%");
    expect(pctWhole(1, 3)).toBe(33);
    expect(pctWhole(2, 3)).toBe(66);
  });

  test("reads 100 only for a whole fleet, and 0 for none or no fleet", () => {
    expect(pctWhole(104, 104)).toBe(100);
    expect(pctWhole(103, 104)).toBe(99);
    expect(pct(103, 104)).toBe(">99%");
    expect(pct(99, 100)).toBe("99%");
    expect(pctWhole(1, 500)).toBe(0);
    expect(pct(1, 500)).toBe("<1%");
    expect(pct(1, 100)).toBe("1%");
    expect(pct(0, 500)).toBe("0%");
    expect(pct(3, 0)).toBe("0%");
    expect(pctWhole(3, 0)).toBe(0);
  });

  test("an exact share is not floored a point low by floating point", () => {
    // (n / 100) * 100 falls just short of n for 29, 57, 58 and more.
    for (let n = 0; n <= 100; n++) expect(pctWhole(n, 100)).toBe(n);
    for (let n = 1; n <= 200; n++) expect(pctWhole(n, 200)).toBe(Math.floor(n / 2));
  });

  test("the label never says more than the number", () => {
    for (const total of [1, 3, 7, 61, 104, 348, 1636]) {
      for (let n = 0; n <= total; n++) {
        const whole = pctWhole(n, total);
        const label = pct(n, total);
        expect(whole * total).toBeLessThanOrEqual(n * 100);
        expect(label === `${whole}%` || label === ">99%" || label === "<1%").toBe(true);
      }
    }
  });
});

interface Stated {
  starlink: number;
  total: number;
  label: string;
  text: string;
}

/**
 * Every "N of M … (P%)", "N of M … · P%" and "N / M · P%" in a text: a share stated beside
 * the counts it comes from. Shape, not copy, so a new page's sentence is held
 * to the rule without being listed here.
 */
function statedShares(text: string): Stated[] {
  const plain = readableText(text.replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, " ")).replace(
    /\s+/g,
    " "
  );
  const re =
    /(\d[\d,]*) (?:of|\/) (?:[A-Za-z'’-]+ ){0,4}?(\d[\d,]*)(?: [A-Za-z0-9'’/-]+){0,4}? ?(?:\(|· ?)((?:<|>)?\d+(?:\.\d+)?%)/g;
  return [...plain.matchAll(re)].map((m) => ({
    starlink: Number(m[1].replace(/,/g, "")),
    total: Number(m[2].replace(/,/g, "")),
    label: m[3],
    text: m[0],
  }));
}

const held = (found: Stated[], where: string) => {
  for (const s of found) {
    expect({ where, text: s.text, label: s.label }).toEqual({
      where,
      text: s.text,
      label: pct(s.starlink, s.total),
    });
  }
};

/** One URL per path shape the sitemap lists, and every aircraft-type page. */
async function pagesOf(host: string): Promise<string[]> {
  const { status, text } = await bodyOf(app, "/sitemap.xml", host);
  expect(status).toBe(200);
  const paths = [...text.matchAll(/<loc>https?:\/\/[^/]+([^<]*)<\/loc>/g)].map((m) => m[1] || "/");
  const byShape = new Map<string, string>();
  for (const p of paths) {
    const shape = p.startsWith("/fleet/") ? p : p.split("/").slice(0, 2).join("/") || "/";
    if (!byShape.has(shape)) byShape.set(shape, p);
  }
  return [...byShape.values(), "/llms.txt", "/feed.xml", "/badge.svg", "/embed"];
}

describe("every surface states the rule's percent", () => {
  test("statedShares reads the forms the surfaces use", () => {
    const found = statedShares(
      "<p>736<!-- --> of <!-- -->1,636 aircraft (44%) have it. 252 of 252 · 100%. " +
        "**Mainline Fleet**: 391 of 1210 aircraft (32%). 59 of Alaska's 76 E175s have Starlink (77%). " +
        "CRJ550 103 / 104 · &gt;99%</p>"
    );
    expect(found.map((s) => [s.starlink, s.total, s.label])).toEqual([
      [736, 1636, "44%"],
      [252, 252, "100%"],
      [391, 1210, "32%"],
      [59, 76, "77%"],
      [103, 104, ">99%"],
    ]);
    // A wrong one is caught, so the scan below can fail.
    expect(statedShares("736 of 1,636 aircraft (45.0%)")[0].label).not.toBe(pct(736, 1636));
  });

  test("pages, feeds, llms.txt and the badge, on every site", async () => {
    let seen = 0;
    for (const host of HOSTS) {
      for (const path of await pagesOf(host)) {
        const { status, text } = await bodyOf(app, path, host);
        if (status !== 200) continue;
        const found = statedShares(text);
        seen += found.length;
        held(found, `${host}${path}`);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  test("/api/fleet-summary answers the pages' percent, per airline and per type", async () => {
    const { airlines } = (await jsonOf(app, "/api/fleet-summary", HUB)) as {
      airlines: Array<{
        code: string;
        installed: number;
        total: number;
        percentage: number | null;
        families: Array<{ family: string; installed: number; total: number; percentage: number }>;
      }>;
    };
    expect(airlines.length).toBeGreaterThan(0);
    for (const a of airlines) {
      // Null where the pages, the badge and the share card print no share.
      const shared = denominatorIsPublishable(
        a.installed,
        a.total,
        AIRLINES[a.code].rollout.rosterIsProgramScope
      );
      expect({ code: a.code, percentage: a.percentage }).toEqual({
        code: a.code,
        percentage: shared ? pctWhole(a.installed, a.total) : null,
      });
      for (const f of a.families) {
        expect({ code: a.code, family: f.family, percentage: f.percentage }).toEqual({
          code: a.code,
          family: f.family,
          percentage: pctWhole(f.installed, f.total),
        });
      }
    }
  });

  test("the MCP's fleet stats and instructions, in every scope", async () => {
    let seen = 0;
    const scopes = ["", "?scope=ALL", ...publicAirlines().map((a) => `?scope=${a.code}`)];
    for (const host of HOSTS) {
      const { text, isError } = await mcpTool(app, host, "get_fleet_stats");
      expect(isError).toBe(false);
      const found = statedShares(text);
      seen += found.length;
      held(found, `${host} get_fleet_stats`);
      // One decimal was the tool's own rule; no percent it prints has one now.
      expect(text).not.toMatch(/\d\.\d%/);
    }
    for (const query of scopes) {
      const init = (await mcpInitialize(app, HUB, query)) as {
        result: { instructions: string };
      };
      const reality = init.result.instructions.match(/Fleet reality[\s\S]*?\n\n/)?.[0] ?? "";
      expect(reality).not.toMatch(/\d\.\d%|~/);
    }
    expect(seen).toBeGreaterThan(0);
  });

  test("the instructions give a share only where the pages do, and the same one", async () => {
    let seen = 0;
    for (const cfg of publicAirlines()) {
      const init = (await mcpInitialize(app, HUB, `?scope=${cfg.code}`)) as {
        result: { instructions: string };
      };
      const reality = init.result.instructions.match(/Fleet reality[\s\S]*?\n\n/)?.[0];
      // A roster with aircraft outside the programme is no denominator.
      if (!cfg.rollout.rosterIsProgramScope) {
        expect({ code: cfg.code, reality }).toEqual({ code: cfg.code, reality: undefined });
        continue;
      }
      const host = siteForAirline(cfg.code)?.canonicalHost;
      if (!host || !reality) continue;
      const stats = await jsonOf(app, "/api/data", host);
      const split = stats.fleetStats as Record<string, { starlink: number; total: number }>;
      for (const [fleet, word] of [
        ["mainline", "Mainline"],
        ["express", "Express/regional"],
      ]) {
        const line = reality.split("\n").find((l) => l.includes(word));
        if (split[fleet].total === 0) {
          expect({ code: cfg.code, fleet, line }).toEqual({
            code: cfg.code,
            fleet,
            line: undefined,
          });
          continue;
        }
        seen++;
        expect(line).toContain(` ${pct(split[fleet].starlink, split[fleet].total)} `);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  test("the hub's share pictures draw the rule's percent, whatever the summary carries", async () => {
    const summary = {
      // A stale or hand-made percentage must not reach the picture.
      airlines: [
        { code: "UA", name: "United Airlines", installed: 736, total: 1636, percentage: 45 },
      ],
    };
    const og = await buildCardSpecs(summary, async () => null);
    const share = buildShareCardSpecs(summary);
    for (const specs of [og, share]) {
      const grid = specs.find((s) => s.params.get("layout") === "grid");
      expect(grid).toBeDefined();
      const cards = JSON.parse(grid?.params.get("cards") ?? "[]") as Array<{ pct: number }>;
      expect(cards.map((c) => c.pct)).toEqual([pctWhole(736, 1636)]);
    }
  });
});

/**
 * Files that multiply by 100 for something other than a share of aircraft.
 * A file not listed here that does its own percent arithmetic fails below:
 * a count goes through pct / pctWhole, and odds through probPct / probLabel,
 * all in components/ui/format.
 */
const OWN_ARITHMETIC: Record<string, string> = {
  "src/components/ui/format.ts": "the rule, and the odds formatters beside it",
  "src/api/mcp-server.ts": "flight and route odds, never a fleet count",
  "src/api/qatar-verdict.ts": "a schedule share as a lower bound, floored",
  "src/client/flight-search.ts": "flight odds as a lower bound, floored",
  "src/client/meter.ts": "a bar's CSS width",
  "src/components/charts/cumulative-installs.tsx": "chart positions",
  "src/components/charts/rollout-math.ts": "chart positions",
  "src/database/database.ts": "the exact ratio stored in meta and FleetStats; a log line",
  "src/utils/utils.ts": "the exact ratio in FleetStats, printed nowhere",
  "src/database/outlook.ts": "a forecast's error, not a share",
  "src/outlook/route.ts": "a change in points, not a share",
  "src/scripts/starlink-predictor.ts": "flight odds and backtest reports",
  "src/scripts/sheet-scrape.ts": "a log line",
  "src/scripts/verified-wifi-patch.ts": "an operator's script",
  "src/scripts/precision-backtest.ts": "backtest report",
  "src/scripts/outlook-backtest.ts": "backtest report",
  "src/scripts/route-backtest.ts": "backtest report",
};

const PERCENT_ARITHMETIC =
  /\*\s*100\b(?!\d)|\b100\s*\*|\*\s*1000\)\s*\/\s*10\b|percentage\w*\)?\.toFixed\(/;

describe("no surface brings its own arithmetic", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) files.push(full);
    }
  };
  walk(join(ROOT, "src"));
  files.push(join(ROOT, "scripts", "generate-og-images.ts"));

  test("percent arithmetic lives only where it is listed", () => {
    const strays: string[] = [];
    for (const file of files) {
      const rel = relative(ROOT, file);
      if (rel in OWN_ARITHMETIC) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
          if (PERCENT_ARITHMETIC.test(line)) strays.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(strays).toEqual([]);
  });

  test("the listed files that print fleet counts do it through the rule", () => {
    const app = readFileSync(join(ROOT, "src/server/app.ts"), "utf8");
    const mcp = readFileSync(join(ROOT, "src/api/mcp-server.ts"), "utf8");
    // /api/fleet-summary and the MCP's fleet stats: the two that had drifted.
    // Booleans, so a failure prints the pattern and not the file.
    const has = (source: string, re: RegExp) => re.test(source);
    expect(has(app, /percentage:\s*[^,\n]*Math\./)).toBe(false);
    expect(has(app, /percentage\b[^\n]*\.toFixed\(/)).toBe(false);
    expect(has(mcp, /percentage\b[^\n]*\.toFixed\(/)).toBe(false);
    expect(has(mcp, /\(starlink \/ total\)/)).toBe(false);
  });

  test("every listed file still needs its place on the list", () => {
    for (const rel of Object.keys(OWN_ARITHMETIC)) {
      const file = files.find((f) => relative(ROOT, f) === rel);
      const needs = file ? PERCENT_ARITHMETIC.test(readFileSync(file, "utf8")) : false;
      expect({ rel, needs }).toEqual({ rel, needs: true });
    }
  });
});
