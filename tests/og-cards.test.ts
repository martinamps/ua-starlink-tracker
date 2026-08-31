/**
 * OG-card derivation pins: every tenant card maps to its own registry file
 * (never another tenant's — the og:image leak class), zero-installed tenants
 * skip the hero card but still appear on the hub grid, and the rollout
 * sparkline is deterministic under a fixed clock.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ApiData,
  type Summary,
  buildCardSpecs,
  buildShareCardSpecs,
  cardDate,
  oldestCardDate,
  rolloutSeries,
} from "../scripts/generate-og-images";
import { AIRLINES, SITES, siteForAirline } from "../src/airlines/registry";
import { badgeValue } from "../src/server/app";
import { shareCardFile } from "../src/utils/share-cards";

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

describe("buildShareCardSpecs", () => {
  test("one PNG per renderable tenant plus the hub card, no shared files", () => {
    const summary: Summary = {
      airlines: [airlineRow("UA", 50, 14), airlineRow("HA", 0, 0), airlineRow("ZZ", 5)],
    };
    const specs = buildShareCardSpecs(summary);
    // Zero-installed (HA) and unregistered (ZZ) tenants get no card; hub last.
    expect(specs.map((s) => s.file)).toEqual([shareCardFile("UA"), shareCardFile("ALL")]);
    expect(new Set(specs.map((s) => s.file)).size).toBe(specs.length);
    for (const s of specs) expect(s.file).toEndWith(".png");
  });

  test("tenant card carries its own host, count, and denominator", () => {
    const [ua] = buildShareCardSpecs({ airlines: [airlineRow("UA", 50)] });
    expect(ua.params.get("layout")).toBe("count");
    expect(ua.params.get("domain")).toBe("unitedstarlinktracker.com");
    expect(ua.params.get("count")).toBe("50");
    expect(ua.params.get("sub")).toContain("OF 100 AIRCRAFT");
  });

  test("the share card and /badge.svg answer the denominator question the same way", () => {
    // Two surfaces in one branch made opposite calls on one number: the badge
    // deliberately withholds the denominator where the tracked roster is wider
    // than the programme, while the share card published it anyway.
    for (const code of Object.keys(AIRLINES)) {
      const cfg = AIRLINES[code];
      if (!siteForAirline(code)) continue;
      const [spec] = buildShareCardSpecs({ airlines: [airlineRow(code, 42)] });
      const sub = spec.params.get("sub") as string;
      const badge = badgeValue(42, 100, cfg.rollout.rosterIsProgramScope);
      expect(sub.includes("OF 100"), `${code} share card`).toBe(badge.includes("of 100"));
    }
  });

  test("an impossible roster drops the denominator on the share card too", () => {
    const [spec] = buildShareCardSpecs({ airlines: [{ ...airlineRow("UA", 102), total: 6 }] });
    expect(spec.params.get("sub")).toBe("AIRCRAFT WITH STARLINK");
    expect(spec.params.get("sub")).not.toContain("OF 6");
  });

  test("every card carries the date of the data behind it", async () => {
    // A shared PNG outlives its numbers; an undated one is quoted forever.
    const summary: Summary = { airlines: [airlineRow("UA", 50), airlineRow("HA", 9)] };
    const data: Record<string, ApiData> = {
      UA: { starlinkPlanes: [], lastUpdated: "2026-08-29T00:00:00.000Z" },
      HA: { starlinkPlanes: [], lastUpdated: "2026-04-11T00:00:00.000Z" },
    };
    const og = await buildCardSpecs(summary, async (code) => data[code] ?? null, NOW);
    const share = buildShareCardSpecs(summary, (code) => data[code]?.lastUpdated);
    for (const spec of [...og, ...share]) {
      expect(spec.params.get("date"), `${spec.file} has no date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    // The hub grid asserts every airline at once, so it takes the oldest stamp
    // — the only date for which the whole card is true.
    expect((og.at(-1) as { params: URLSearchParams }).params.get("date")).toBe("2026-04-11");
    expect((share.at(-1) as { params: URLSearchParams }).params.get("date")).toBe("2026-04-11");
  });

  test("a missing or unparseable stamp renders no date, never a wrong one", () => {
    expect(cardDate(undefined)).toBe("");
    expect(cardDate("not a date")).toBe("");
    expect(oldestCardDate([undefined, "garbage"])).toBe("");
    const [ua] = buildShareCardSpecs({ airlines: [airlineRow("UA", 50)] });
    expect(ua.params.get("date")).toBe("");
  });

  test("share files never collide with the og social images", () => {
    const ogFiles = new Set(
      [SITES.airline.brand, ...Object.values(AIRLINES).map((a) => a.brand)].map((b) =>
        b.socialImagePath.split("/").pop()
      )
    );
    const specs = buildShareCardSpecs({
      airlines: Object.keys(AIRLINES).map((code) => airlineRow(code, 5)),
    });
    for (const s of specs) expect(ogFiles.has(s.file)).toBe(false);
  });
});

describe("nightly workflow delivers every generated card", () => {
  // The commit step's globs ARE the delivery path: the server reads STATIC_DIR
  // from the image's own tree (Dockerfile COPY . ., generate-og never runs at
  // build or boot), so a file the workflow doesn't stage does not exist in
  // production. That is exactly how the share cards shipped dead —
  // resolveShareCard() returning null forever because the step gated on and
  // added only `static/social-image*.webp`.
  const workflow = readFileSync(
    join(import.meta.dir, "..", ".github", "workflows", "og-images.yml"),
    "utf8"
  );

  /** The quoted pathspecs from the step's `GLOBS=( … )` line. */
  function stagedGlobs(): string[] {
    const line = workflow.match(/GLOBS=\(([^)]*)\)/);
    expect(line, "og-images.yml no longer declares a GLOBS=( … ) list").not.toBeNull();
    return [...(line as RegExpMatchArray)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  }

  const matches = (glob: string, file: string) => {
    const rx = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
    return rx.test(`static/${file}`);
  };

  test("every spec filename is covered by a staged glob", async () => {
    const globs = stagedGlobs();
    expect(globs.length).toBeGreaterThan(0);
    const summary: Summary = {
      airlines: Object.keys(AIRLINES).map((code) => airlineRow(code, 5)),
    };
    const files = [
      ...(await buildCardSpecs(summary, noData, NOW)).map((s) => s.file),
      ...buildShareCardSpecs(summary).map((s) => s.file),
    ];
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(
        globs.some((g) => matches(g, f)),
        `${f} is generated but never committed`
      ).toBe(true);
    }
  });

  test("the change gate sees untracked files, not just tracked diffs", () => {
    // git diff is blind to a brand-new artifact, so gating on it would report
    // "no changes" on the very run that first produced the share cards.
    expect(workflow).toContain("git status --porcelain");
    expect(workflow).not.toMatch(/git diff --quiet/);
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

  test("bulk-gid rows (seeds, type-settles, flyertalk) never shape the curve", () => {
    // Bulk writers stamp one run date across many tails — charting them
    // renders a fabricated install cliff (the live AS card bug).
    const organic = planes("2026-05-01", "2026-05-20");
    const bulk: ApiData["starlinkPlanes"] = [
      { DateFound: "2026-04-21", sheet_gid: "as_seed" },
      { DateFound: "2026-04-21", sheet_gid: "ha_seed" },
      { DateFound: "2026-05-18", sheet_gid: "flyertalk_as" },
      { DateFound: "2026-05-19", sheet_gid: "type_deterministic" },
    ];
    const series = rolloutSeries([...bulk, ...organic], NOW);
    expect(series).toEqual(rolloutSeries(organic, NOW));
    expect(series.at(-1)).toBe(2);
    // An all-bulk roster (AS today: 90 as_seed + 7 flyertalk) draws nothing.
    expect(rolloutSeries(bulk, NOW)).toEqual([]);
  });
});
