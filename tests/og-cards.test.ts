/**
 * OG-card derivation pins: every tenant card maps to its own registry file
 * (never another tenant's — the og:image leak class), zero-installed tenants
 * skip the hero card but still appear on the hub grid, and the rollout
 * sparkline is deterministic under a fixed clock.
 */

import { describe, expect, test } from "bun:test";
import {
  type ApiData,
  type Summary,
  buildCardSpecs,
  rolloutSeries,
} from "../scripts/generate-og-images";
import { AIRLINES, SITES } from "../src/airlines/registry";

const NOW = Date.parse("2026-06-04T00:00:00Z");

const airlineRow = (code: string, installed: number, percentage = 10) => ({
  code,
  name: AIRLINES[code]?.name ?? code,
  installed,
  total: 100,
  percentage,
});

const HUB_FILE = SITES.airline.brand.socialImagePath.split("/").pop() as string;
const noData = async () => null;

describe("buildCardSpecs", () => {
  test("every registered airline maps to its own registry file, hub card last", async () => {
    const summary: Summary = {
      airlines: Object.keys(AIRLINES).map((code) => airlineRow(code, 5)),
    };
    const specs = await buildCardSpecs(summary, noData, NOW);

    const expected = Object.values(AIRLINES)
      .filter((cfg) => cfg.brand.socialImagePath)
      .map((cfg) => cfg.brand.socialImagePath.split("/").pop());
    const files = specs.map((s) => s.file);

    expect(files.slice(0, -1).sort()).toEqual(expected.sort());
    expect(files.at(-1)).toBe(HUB_FILE);
    // No two tenants may share a card file — that's the og leak class.
    expect(new Set(files).size).toBe(files.length);
  });

  test("zero-installed tenants get no hero card but stay on the hub grid", async () => {
    const summary: Summary = {
      airlines: [airlineRow("UA", 50, 14), airlineRow("HA", 0, 0)],
    };
    // The fetch list derives from the same skip logic as the cards: the
    // zero-installed tenant must not be fetched at all.
    const fetched: string[] = [];
    const specs = await buildCardSpecs(
      summary,
      async (code) => {
        fetched.push(code);
        return null;
      },
      NOW
    );
    expect(fetched).toEqual(["UA"]);

    expect(specs.map((s) => s.file)).toEqual([
      AIRLINES.UA.brand.socialImagePath.split("/").pop(),
      HUB_FILE,
    ]);
    const hub = specs.at(-1)!;
    expect(hub.params.get("layout")).toBe("grid");
    const cards = JSON.parse(hub.params.get("cards") as string) as Array<{
      name: string;
      pct: number;
    }>;
    expect(cards.map((c) => c.name)).toEqual(["UNITED", "HAWAIIAN"]);
    expect(cards[1].pct).toBe(0);
  });

  test("unknown airline codes are skipped, never defaulted to another tenant", async () => {
    const summary: Summary = { airlines: [airlineRow("ZZ", 5)] };
    const fetched: string[] = [];
    const specs = await buildCardSpecs(
      summary,
      async (code) => {
        fetched.push(code);
        return null;
      },
      NOW
    );
    expect(specs.map((s) => s.file)).toEqual([HUB_FILE]);
    expect(fetched).toEqual([]); // skipped tenants are never fetched either
  });

  test("tenant card params carry that tenant's host, accent, and count", async () => {
    const data: ApiData = {
      starlinkPlanes: [
        { DateFound: "2026-05-01" },
        { DateFound: "2026-05-15" },
        { DateFound: "2026-06-01" },
      ],
    };
    const summary: Summary = { airlines: [airlineRow("UA", 50)] };
    const [ua] = await buildCardSpecs(summary, async (code) => (code === "UA" ? data : null), NOW);

    expect(ua.params.get("layout")).toBe("count");
    expect(ua.params.get("domain")).toBe("unitedstarlinktracker.com");
    expect(ua.params.get("count")).toBe("50");
    expect(ua.params.get("accent")).toBe(AIRLINES.UA.brand.accentColor.replace("#", ""));
    const series = (ua.params.get("series") as string).split(",").map(Number);
    expect(series.at(-1)).toBe(3); // cumulative count ends at the roster size
  });

  test("no rollout data: empty sparkline, card still built", async () => {
    const summary: Summary = { airlines: [airlineRow("UA", 50)] };
    const [ua] = await buildCardSpecs(summary, noData, NOW);
    expect(ua.params.get("series")).toBe("");
    expect(ua.params.get("count")).toBe("50");
  });
});

describe("rolloutSeries", () => {
  const planes = (...dates: string[]): ApiData["starlinkPlanes"] =>
    dates.map((DateFound) => ({ DateFound }));

  test("fixed clock makes the series deterministic and cumulative", () => {
    const a = rolloutSeries(planes("2026-05-01", "2026-05-15", "2026-06-01"), NOW);
    const b = rolloutSeries(planes("2026-05-01", "2026-05-15", "2026-06-01"), NOW);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThanOrEqual(2);
    expect(a.length).toBeLessThanOrEqual(120);
    expect(a.at(-1)).toBe(3);
    for (let i = 1; i < a.length; i++) expect(a[i]).toBeGreaterThanOrEqual(a[i - 1]);
  });

  test("fewer than two dated installs yields no sparkline", () => {
    expect(rolloutSeries(planes("2026-05-01"), NOW)).toEqual([]);
    expect(rolloutSeries(planes("garbage", "also-bad"), NOW)).toEqual([]);
  });
});
