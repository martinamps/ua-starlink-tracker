/**
 * An airline known by aircraft type (Qatar, Hawaiian) has no count of aircraft
 * with Starlink on this site: it has a sum of fleet-list rows picked by a type
 * rule. No page, badge or share picture of such an airline's site may print
 * that sum as a count of aircraft with Starlink; each says what the number is.
 * United's and Alaska's sites, counted by tail, keep their wording.
 * Hermetic for the by-type sites: fresh DBs seeded here.
 */

import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCardSpecs, buildShareCardSpecs } from "../scripts/generate-og-images";
import {
  BY_TYPE_CARD_CAPTION,
  BY_TYPE_METHOD,
  BY_TYPE_SUM_LABEL,
  byTypeBadgeValue,
  byTypeSumBasis,
  byTypeSumSentence,
  leftOutByType,
  ownCountAsOf,
  publishedCount,
  splitByMethod,
  trackingMethod,
} from "../src/airlines/published-count";
import {
  AIRLINES,
  type AirlineConfig,
  SITES,
  publicAirlines,
  siteForAirline,
} from "../src/airlines/registry";
import { getDailyInstalls, reconcileTypeDeterministicFleets } from "../src/database/database";
import { badgeSvgMarkup, badgeValue, createApp } from "../src/server/app";
import { addFleet, addPlane, bodyOf, makeFreshDb, mcpTool, openSnapshot } from "./helpers";

type App = ReturnType<typeof createApp>;

const BY_TYPE = Object.values(AIRLINES).filter(
  (a) => trackingMethod(a) === "type" && siteForAirline(a.code)
);
const hostOf = (cfg: AirlineConfig) => siteForAirline(cfg.code)?.canonicalHost as string;

function seedFleet(code: string, operator: string, rows: Array<[string, string]>): Database {
  const db = makeFreshDb();
  const fleet = db.query(
    `INSERT INTO united_fleet (tail_number, aircraft_type, fleet, first_seen_source, first_seen_at, last_seen_at, starlink_status, airline)
     VALUES (?, ?, 'mainline', 'test', 1, 1, 'unknown', ?)`
  );
  const listing = db.query(
    `INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, TailNumber, OperatedBy, fleet, airline)
     VALUES (?, 'StrLnk', 'type_deterministic', 'type_deterministic', ?, ?, 'mainline', ?)`
  );
  for (const [tail, type] of rows) {
    fleet.run(tail, type, code);
    if (AIRLINES[code].typeDeterministicWifi?.(type, tail) === "confirmed") {
      listing.run(type, tail, operator, code);
    }
  }
  reconcileTypeDeterministicFleets(db);
  db.run("INSERT INTO meta (key, value) VALUES (?, '2026-11-25T06:00:00.000Z')", [
    `${code}:lastUpdated`,
  ]);
  db.run("INSERT INTO meta (key, value) VALUES (?, ?)", [
    `${code}:totalAircraftCount`,
    String(rows.length),
  ]);
  return db;
}

const QATAR_ROWS = readFileSync(
  join(import.meta.dir, "fixtures", "qatar-listed-tails-2026-11-23.csv"),
  "utf8"
)
  .trim()
  .split("\n")
  .slice(1)
  .map((l) => l.split(",") as [string, string]);

/** Hawaiian as its own page describes it: 24 A330-200s, 18 A321neos, 19 717s. */
const HAWAIIAN_ROWS: Array<[string, string]> = (
  [
    ["Airbus A330-243", 24],
    ["Airbus A321-271N", 18],
    ["Boeing 717-22A", 19],
  ] as const
).flatMap(([type, n], t) =>
  Array.from({ length: n }, (_, i): [string, string] => [`N${t + 3}${10 + i}HA`, type])
);

const SEEDS: Record<string, () => Database> = {
  QR: () => seedFleet("QR", "Qatar Airways", QATAR_ROWS),
  HA: () => seedFleet("HA", "Hawaiian Airlines", HAWAIIAN_ROWS),
};

const decode = (s: string) =>
  s
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Everything a reader, a screen reader or a crawler is told, one piece per
 * element: the text of each block, each described attribute, and each string
 * of the page's structured data, cut into sentences.
 */
function saidOn(body: string): string[] {
  const html = body.replace(/<!--[\s\S]*?-->/g, "").replace(/<style[\s\S]*?<\/style>/g, " ");
  const pieces: string[] = [];
  for (const m of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
    pieces.push(...m[1].split(/(?<!\\)"/));
  }
  const visible = html.replace(/<script[\s\S]*?<\/script>/g, " ");
  for (const m of visible.matchAll(/\b(?:content|aria-label|alt|title)="([^"]*)"/g)) {
    pieces.push(m[1]);
  }
  pieces.push(
    ...visible
      .split(
        /<\/?(?:p|li|ul|ol|div|section|header|footer|main|nav|h[1-6]|table|tr|td|th|dl|dt|dd|figure|figcaption|summary|details|title|text|svg|g|button|label|pre)\b[^>]*>|\n/
      )
      .map((t) => t.replace(/<[^>]+>/g, " "))
  );
  return pieces
    .map(decode)
    .flatMap((p) => p.split(/(?<=[.!?])\s+/))
    .filter(Boolean);
}

const hasNumber = (text: string, n: number) =>
  new RegExp(`(?<![\\d,.])${n}(?![\\d]|[,.]\\d)`).test(text);

/** Words that say the number is aircraft that have Starlink. */
const CLAIM =
  /\b(?:have|has|with) Starlink\b|\baircraft equipped\b|\bStarlink-equipped\b|\d\s+Starlink\b|\bequipped aircraft\b/i;
/** Words that say what was added up. */
const BASIS = /\bfleet list\b|\bby aircraft type\b|\bour sum\b|\bsum of\b/i;

/** The piece, when it prints `sum` as aircraft with Starlink and says nothing of how it was reached. */
const flatCount = (piece: string, sum: number) =>
  hasNumber(piece, sum) && CLAIM.test(piece) && !BASIS.test(piece);

/** A heading or line that describes a figure as a count of aircraft with Starlink. */
const COUNT_LABEL =
  /^aircraft with starlink$|\bcount of [^.]*\baircraft (?:that have|with) Starlink\b|\blive equipped count\b/i;

/** The fleet page's heading and the lines under it, as read. */
const headerOf = (page: string) =>
  decode(
    (page.match(/<h1[\s\S]*?<\/header>/)?.[0] ?? "")
      .replace(/<!-- -->/g, "")
      .replace(/<[^>]+>/g, " ")
  ).replace(/ ([.,)])/g, "$1");

async function sweep(app: App, host: string): Promise<Array<{ path: string; body: string }>> {
  const paths = new Set(["/", "/fleet", "/embed", "/badge.svg", "/llms.txt", "/check-flight"]);
  const sitemap = await bodyOf(app, "/sitemap.xml", host);
  for (const m of sitemap.text.matchAll(/<loc>https?:\/\/[^/]+([^<]*)<\/loc>/g)) {
    paths.add(m[1] || "/");
  }
  const out: Array<{ path: string; body: string }> = [];
  for (const path of paths) {
    const r = await app.dispatch(new Request(`http://x${path}`, { headers: { Host: host } }));
    const type = r.headers.get("content-type") ?? "";
    if (r.status === 200 && /html|svg|text\/|xml/.test(type)) {
      out.push({ path, body: await r.text() });
    }
  }
  return out;
}

describe("the checker catches the wordings this replaced", () => {
  test("each old place reads as a flat count", () => {
    for (const [old, n] of [
      ["149 of 160 aircraft (93%) have Starlink.", 149],
      ["Qatar Starlink: 149 aircraft equipped", 149],
      ["42 Airbus aircraft equipped", 42],
      [
        "All 42 of Hawaiian's Airbus aircraft, every A330-200 and every A321neo, have Starlink.",
        42,
      ],
      ["149 Starlink (listed, not yet verified)", 149],
      ["149 Qatar Airways aircraft have Starlink.", 149],
    ] as const) {
      expect(
        saidOn(`<p>${old}</p>`).some((p) => flatCount(p, n)),
        old
      ).toBe(true);
    }
    for (const label of [
      "Aircraft with Starlink",
      "A small SVG badge with the live count of Qatar Airways aircraft that have Starlink, updated hourly.",
      "auto-updating SVG badge with the live equipped count",
    ]) {
      expect(COUNT_LABEL.test(label), label).toBe(true);
    }
  });

  test("the sum's own sentences pass, and a different number is not the sum", () => {
    for (const cfg of BY_TYPE) {
      expect(flatCount(`${byTypeSumSentence(cfg, 149)}.`, 149), cfg.code).toBe(false);
      expect(flatCount(byTypeBadgeValue(149), 149), cfg.code).toBe(false);
    }
    expect(flatCount("1,149 aircraft have Starlink.", 149)).toBe(false);
    expect(flatCount("149.5 aircraft have Starlink.", 149)).toBe(false);
  });
});

describe("no by-type airline's site prints its fleet-list sum as a count of aircraft with Starlink", () => {
  test("there are by-type airlines with a site, and each has a seed", () => {
    expect(BY_TYPE.map((a) => a.code).sort()).toEqual(Object.keys(SEEDS).sort());
  });

  for (const cfg of BY_TYPE) {
    describe(cfg.name, () => {
      let app: App;
      let sum: number;
      let pages: Array<{ path: string; body: string }>;
      const host = hostOf(cfg);

      beforeAll(async () => {
        const db = SEEDS[cfg.code]();
        sum = (
          db
            .query(
              "SELECT COUNT(*) AS n FROM united_fleet WHERE airline = ? AND starlink_status = 'confirmed'"
            )
            .get(cfg.code) as { n: number }
        ).n;
        app = createApp(db);
        pages = await sweep(app, host);
      });

      test("the seed gives a sum that is short of the fleet list", () => {
        expect(sum).toBeGreaterThan(0);
        expect(pages.map((p) => p.path)).toEqual(
          expect.arrayContaining(["/", "/fleet", "/embed", "/badge.svg", "/llms.txt"])
        );
      });

      test("no page, feed or picture says the sum is aircraft with Starlink", () => {
        for (const { path, body } of pages) {
          const said = saidOn(body);
          expect(
            said.filter((p) => flatCount(p, sum)),
            `${host}${path}`
          ).toEqual([]);
          expect(
            said.filter((p) => COUNT_LABEL.test(p)),
            `${host}${path}`
          ).toEqual([]);
        }
      });

      test("the home page prints the sum under a heading that says what it is", () => {
        const home = pages.find((p) => p.path === "/")?.body ?? "";
        const said = saidOn(home);
        expect(said).toContain(BY_TYPE_SUM_LABEL);
        expect(said.some((p) => hasNumber(p, sum))).toBe(true);
      });

      test("the fleet page's heading says what was added up, and gives no share", () => {
        const fleet = pages.find((p) => p.path === "/fleet")?.body ?? "";
        const header = headerOf(fleet);
        expect(header).toContain(" of the ");
        expect(header).toContain(`aircraft on our fleet list are of ${byTypeSumBasis(cfg.code)}.`);
        expect(header).toContain(`They are ${BY_TYPE_METHOD}.`);
        expect(header).not.toContain("%");
        expect(header).not.toMatch(/have Starlink\./);
      });

      test("the badge says the sum is by aircraft type, at the size it had", () => {
        const svg = pages.find((p) => p.path === "/badge.svg")?.body ?? "";
        const value = byTypeBadgeValue(sum);
        expect(svg).toContain(`>${value}</text>`);
        expect(svg).not.toContain("aircraft equipped");
        expect(svg).toContain(
          `aria-label="${byTypeSumSentence(cfg, sum).replace(/'/g, "&apos;")}."`
        );
        // An embedder's page keeps its layout: same width and height as the
        // "N aircraft equipped" badge this replaces.
        const was = badgeSvgMarkup(`${cfg.shortName} Starlink`, `${sum} aircraft equipped`, "#000");
        const size = (s: string) => s.match(/<svg[^>]* width="(\d+)" height="(\d+)"/)?.slice(1);
        expect(size(svg)).toEqual(size(was) as string[]);
        expect(size(svg)?.[1]).toBe("20");
      });

      test("the share pictures caption the number as a sum by type", async () => {
        const summary = {
          airlines: [{ code: cfg.code, name: cfg.name, installed: sum, total: 999, percentage: 1 }],
        };
        const [og] = await buildCardSpecs(summary, async () => null);
        const [share] = buildShareCardSpecs(summary);
        for (const spec of [og, share]) {
          expect(spec.params.get("count")).toBe(String(sum));
          expect(spec.params.get("sub")).toBe(BY_TYPE_CARD_CAPTION);
        }
      });
    });
  }

  test("the picture caption is no longer than the longest the card already carried", () => {
    expect(BY_TYPE_CARD_CAPTION.length).toBeLessThanOrEqual("OF 61 AIRCRAFT HAVE STARLINK".length);
    expect(BY_TYPE_CARD_CAPTION).not.toMatch(/WITH STARLINK|HAVE STARLINK/);
  });
});

describe("airlines counted by tail read as before", () => {
  const BY_TAIL = Object.values(AIRLINES).filter(
    (a) => trackingMethod(a) === "tail" && siteForAirline(a.code)
  );
  let app: App;

  beforeAll(() => {
    app = createApp(openSnapshot());
  });

  test("United and Alaska are the airlines this covers", () => {
    expect(BY_TAIL.map((a) => a.code)).toEqual(expect.arrayContaining(["UA", "AS"]));
  });

  test("the badge markup is byte for byte what it was when no spoken name is given", () => {
    expect(badgeSvgMarkup("United Starlink", "99 of 350 aircraft", "#0ea5e9")).toBe(
      `<svg xmlns="http://www.w3.org/2000/svg" width="248" height="20" role="img" aria-label="United Starlink: 99 of 350 aircraft">
  <title>United Starlink: 99 of 350 aircraft</title>
  <rect width="115" height="20" rx="3" fill="#1a2332"/>
  <rect x="115" width="133" height="20" rx="3" fill="#0ea5e9"/>
  <rect x="115" width="3" height="20" fill="#0ea5e9"/>
  <g fill="#ffffff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="57.5" y="14">United Starlink</text>
    <text x="181.5" y="14">99 of 350 aircraft</text>
  </g>
</svg>`
    );
    expect(badgeValue(99, 350, true)).toBe("99 of 350 aircraft");
    expect(badgeValue(42, 61, false)).toBe("42 aircraft equipped");
  });

  for (const code of ["UA", "AS"]) {
    test(`${code}: badge, fleet heading, embed page, llms.txt and list heading keep their words`, async () => {
      const cfg = AIRLINES[code];
      const host = hostOf(cfg);

      const svg = (await bodyOf(app, "/badge.svg", host)).text;
      const value = svg.match(/<text[^>]*>([^<]*)<\/text>\s*<\/g>/)?.[1] ?? "";
      expect(value).toMatch(/^\d+ of \d+ aircraft$|^\d+ aircraft equipped$/);
      expect(svg).toContain(`aria-label="${cfg.shortName} Starlink: ${value}"`);
      expect(svg).toContain(`<title>${cfg.shortName} Starlink: ${value}</title>`);

      const fleet = (await bodyOf(app, "/fleet", host)).text;
      const header = headerOf(fleet);
      expect(header).toMatch(
        /[\d,]+ of [\d,]+ aircraft \( ?\d+% ?\) have Starlink\.|We can name [\d,]+ of [\d,]+ aircraft \( ?\d+% ?\) with Starlink\./
      );
      expect(header).not.toContain("on our fleet list");
      expect(fleet).not.toContain("Starlink by aircraft type, not checked plane by plane");

      const embed = (await bodyOf(app, "/embed", host)).text;
      expect(decode(embed.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " "))).toContain(
        `A small SVG badge with the live count of ${cfg.name} aircraft that have Starlink, updated hourly.`
      );
      expect(embed).toContain(
        `content="An auto-updating SVG badge with the live count of ${cfg.name} aircraft that have Starlink Wi-Fi. One image tag, no script."`
      );

      const llms = (await bodyOf(app, "/llms.txt", host)).text;
      expect(llms).toContain(
        `- [Embed badge](https://${host}/embed) — auto-updating SVG badge with the live equipped count (https://${host}/badge.svg)`
      );

      const home = (await bodyOf(app, "/", host)).text;
      expect(saidOn(home)).not.toContain(BY_TYPE_SUM_LABEL);
      expect(home).toMatch(/aircraft with Starlink<\/h2>|Aircraft with Starlink<\/h2>/);
    });

    test(`${code}: the share pictures keep their captions`, async () => {
      const cfg = AIRLINES[code];
      const row = { code, name: cfg.name, installed: 50, total: 100, percentage: 50 };
      const [og] = await buildCardSpecs({ airlines: [row] }, async () => null);
      const [share] = buildShareCardSpecs({ airlines: [row] });
      expect(og.params.get("sub")).toBe("AIRCRAFT WITH STARLINK");
      expect(share.params.get("sub")).toBe("OF 100 AIRCRAFT HAVE STARLINK");
    });
  }
});

/**
 * The hub prints figures over every airline at once. Such a figure may add up
 * only airlines counted on this site: one known by aircraft type is left out
 * and named beside it, with its fleet-list sum worded as one. The split comes
 * from trackingMethod, so a by-type airline added to the hub is left out too;
 * the seeds below must then grow, or the first test here fails.
 */
describe("no hub total adds a by-type sum to aircraft counted on this site", () => {
  const HUB = SITES.airline.canonicalHost;
  const hubAirlines = publicAirlines();
  const hubByType = hubAirlines.filter((a) => trackingMethod(a) === "type");
  const hubCounted = hubAirlines.filter((a) => trackingMethod(a) !== "type");

  /** Fleets sized so no figure of one kind equals a figure of another. */
  const COUNTED_SEEDS: Record<string, { equipped: number; bare: number; type: string }> = {
    UA: { equipped: 18, bare: 9, type: "Boeing 737-900" },
    AS: { equipped: 6, bare: 5, type: "Boeing 737-800" },
  };

  let app: App;
  let pages: Array<{ path: string; body: string }>;
  let stats: string;
  let list: string;
  let mainlineList: string;
  const counted = { starlink: 0, total: 0 };
  let sum = 0;
  let listedTotal = 0;
  const sums: Record<string, number> = {};
  let db: Database;

  beforeAll(async () => {
    db = makeFreshDb();
    for (const cfg of hubCounted) {
      const seed = COUNTED_SEEDS[cfg.code];
      for (let i = 0; i < seed.equipped + seed.bare; i++) {
        const tail = `N${100 + i}${cfg.code}`;
        const equipped = i < seed.equipped;
        addFleet(db, tail, equipped ? "confirmed" : "negative", {
          airline: cfg.code,
          aircraftType: seed.type,
          verifiedWifi: equipped ? "Starlink" : "None",
        });
        if (equipped) addPlane(db, tail, "Starlink", { airline: cfg.code, aircraft: seed.type });
      }
      db.run("UPDATE united_fleet SET fleet = 'mainline' WHERE airline = ?", [cfg.code]);
      db.run("INSERT INTO meta (key, value) VALUES (?, '2026-11-25T06:00:00.000Z')", [
        `${cfg.code}:lastUpdated`,
      ]);
      db.run("INSERT INTO meta (key, value) VALUES (?, ?)", [
        `${cfg.code}:totalAircraftCount`,
        String(seed.equipped + seed.bare),
      ]);
      counted.starlink += seed.equipped;
      counted.total += seed.equipped + seed.bare;
    }
    // The by-type fleets, copied row for row from their own seeds.
    for (const cfg of hubByType) {
      const src = SEEDS[cfg.code]();
      for (const table of ["united_fleet", "starlink_planes", "meta"]) {
        const rows = src
          .query(
            table === "meta"
              ? "SELECT * FROM meta WHERE key LIKE ?"
              : `SELECT * FROM ${table} WHERE airline = ?`
          )
          .all(table === "meta" ? `${cfg.code}:%` : cfg.code) as Array<Record<string, unknown>>;
        for (const row of rows) {
          const cols = Object.keys(row).filter((c) => c !== "id");
          db.query(
            `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`
          ).run(...(cols.map((c) => row[c]) as Array<string | number | null>));
        }
      }
      sums[cfg.code] = (
        db
          .query(
            "SELECT COUNT(*) AS n FROM united_fleet WHERE airline = ? AND starlink_status = 'confirmed'"
          )
          .get(cfg.code) as { n: number }
      ).n;
      sum += sums[cfg.code];
      listedTotal += (
        db.query("SELECT COUNT(*) AS n FROM united_fleet WHERE airline = ?").get(cfg.code) as {
          n: number;
        }
      ).n;
    }
    app = createApp(db);
    pages = await sweep(app, HUB);
    stats = (await mcpTool(app, HUB, "get_fleet_stats")).text;
    list = (await mcpTool(app, HUB, "list_starlink_aircraft", { limit: 500 })).text;
    mainlineList = (await mcpTool(app, HUB, "list_starlink_aircraft", { fleet: "mainline" })).text;
  });

  test("every airline on the hub is seeded, and one of them is known by type", () => {
    expect(hubCounted.map((a) => a.code).sort()).toEqual(Object.keys(COUNTED_SEEDS).sort());
    expect(hubByType.length).toBeGreaterThan(0);
    for (const cfg of hubByType) expect(SEEDS[cfg.code], cfg.code).toBeDefined();
    expect(sum).toBeGreaterThan(0);
    expect(new Set([counted.starlink, sum, counted.starlink + sum]).size).toBe(3);
    expect(pages.map((p) => p.path)).toEqual(
      expect.arrayContaining(["/", "/fleet", "/embed", "/badge.svg", "/llms.txt"])
    );
  });

  test("the split leaves out every by-type airline in the registry, whatever the hub lists", () => {
    const all = Object.values(AIRLINES);
    const split = splitByMethod(all.map((a) => ({ code: a.code, starlink: 7, total: 9 })));
    const byType = all.filter((a) => trackingMethod(a) === "type");
    expect(split.byType.map((b) => b.cfg.code).sort()).toEqual(byType.map((a) => a.code).sort());
    expect(split.counted.starlink).toBe(7 * (all.length - byType.length));
    expect(split.counted.total).toBe(9 * (all.length - byType.length));
    for (const a of byType) expect(split.counted.names).not.toContain(a.shortName);
    expect(leftOutByType(split)).toContain(BY_TYPE_METHOD);
    expect(leftOutByType(splitByMethod([{ code: "UA", starlink: 7, total: 9 }]))).toBeNull();
  });

  test("no page, feed, picture or tool answer prints the mixed total", () => {
    const mixed = counted.starlink + sum;
    const said = [
      ...pages.flatMap(({ path, body }) => saidOn(body).map((piece) => ({ path, piece }))),
      // "(showing N)" is the number of rows printed under the header, which
      // has by then said how many are of each kind.
      ...[stats, list, mainlineList].flatMap((t) =>
        saidOn(t.replace(/\*\*/g, "").replace(/ \(showing \d+\):/, ":")).map((piece) => ({
          path: "mcp",
          piece,
        }))
      ),
    ];
    // The mixed total as aircraft with Starlink, under any wording. A share
    // ("66%") is not a count.
    const counts = (piece: string) => piece.replace(/\d+(?:\.\d+)?%/g, "");
    expect(
      said.filter(({ piece }) => hasNumber(counts(piece), mixed) && CLAIM.test(piece))
    ).toEqual([]);
    // "N of M": the mixed total over any fleet, or any count over the mixed fleet.
    const of = new RegExp(
      `(?<![\\d,.])(?:${mixed} of (?:the )?[\\d,]+|[\\d,]+ of (?:the )?${counted.total + listedTotal})(?![\\d])`
    );
    expect(said.filter(({ piece }) => of.test(piece))).toEqual([]);
    // A row count beside a filter that holds both kinds.
    expect(said.filter(({ piece }) => new RegExp(`^ALL \\(?${mixed}\\)?$`).test(piece))).toEqual(
      []
    );
  });

  test("no page prints a by-type airline's own sum as aircraft with Starlink", () => {
    expect(pages.map((p) => p.path)).toContain("/install-rate");
    for (const cfg of hubByType) {
      // The airline's source's own counts, printed with their date, are not
      // our fleet-list sum, though this seed makes the two equal.
      const own = publishedCount(cfg, sums[cfg.code]);
      const dated = own.basis === "tracked" || own.basis === "type" ? null : ownCountAsOf(own);
      expect(
        pages.flatMap(({ path, body }) =>
          saidOn(body)
            .filter((piece) => flatCount(piece, sums[cfg.code]))
            .filter((piece) => !(dated && piece.includes(dated)))
            .map((piece) => ({ path, piece }))
        ),
        cfg.code
      ).toEqual([]);
    }
  });

  describe("the install pace page, were a by-type airline's rows ever dated", () => {
    let dated: App;
    let page: string;

    beforeAll(async () => {
      // The worst case: dated rows are what a pace chart is drawn from, and a
      // by-type airline's bulk-settled rows carry none today.
      for (const cfg of hubByType) {
        const tails = db
          .query("SELECT TailNumber AS t FROM starlink_planes WHERE airline = ?")
          .all(cfg.code) as Array<{ t: string }>;
        tails.forEach(({ t }, i) => {
          const day = new Date(Date.UTC(2026, 5 + (i % 5), 2 + (i % 20)));
          db.run(
            "UPDATE starlink_planes SET DateFound = ?, sheet_gid = 'discovery', sheet_type = 'discovery' WHERE TailNumber = ? AND airline = ?",
            [day.toISOString().slice(0, 10), t, cfg.code]
          );
        });
      }
      dated = createApp(db);
      page = (await bodyOf(dated, "/install-rate", HUB)).text;
    });

    test("the seed would chart them: their rows count as dated installs", () => {
      for (const cfg of hubByType) {
        expect(getDailyInstalls(db, cfg.code).length, cfg.code).toBeGreaterThan(0);
      }
    });

    test("the hub gives a pace section to counted airlines only", () => {
      const said = saidOn(page);
      for (const cfg of hubCounted) {
        expect(page).toContain(`id="install-rate-stat-${cfg.code.toLowerCase()}"`);
      }
      for (const cfg of hubByType) {
        expect(page).not.toContain(`id="install-rate-stat-${cfg.code.toLowerCase()}"`);
        expect(said.filter((p) => flatCount(p, sums[cfg.code]))).toEqual([]);
        expect(said.filter((p) => p.includes(`${cfg.name} aircraft with Starlink`))).toEqual([]);
      }
      expect(
        said.some((p) =>
          p.includes(`Installs per month for ${hubCounted.map((a) => a.shortName).join(" and ")},`)
        )
      ).toBe(true);
    });

    test("one line says who is left out and why", () => {
      const lines = saidOn(page).filter((p) => p.endsWith("so no install pace is shown."));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`on our fleet list are ${BY_TYPE_METHOD},`);
      for (const cfg of hubByType) {
        expect(lines[0]).toContain(`${cfg.shortName}'s ${sums[cfg.code]} `);
      }
    });

    test("a by-type airline's own site serves no install pace page and lists none", async () => {
      for (const cfg of hubByType) {
        const host = hostOf(cfg);
        expect((await bodyOf(dated, "/install-rate", host)).status, host).toBe(404);
        expect((await bodyOf(dated, "/sitemap.xml", host)).text).not.toContain("/install-rate");
        const fleet = (await bodyOf(dated, "/fleet", host)).text;
        expect(fleet).not.toContain('href="/install-rate"');
      }
    });
  });

  test("the fleet page's heading counts only the counted airlines and names the rest", async () => {
    const header = headerOf(pages.find((p) => p.path === "/fleet")?.body ?? "");
    const names = hubCounted.map((a) => a.shortName);
    expect(header).toContain(`${counted.starlink} of ${counted.total} ${names.join(" and ")}`);
    expect(header).toContain("have Starlink.");
    for (const cfg of hubByType) expect(header).toContain(`${cfg.shortName}'s `);
    expect(header).toContain(`on our fleet list are ${BY_TYPE_METHOD}.`);
  });

  test("the fleet page's squares keep a by-type airline out of the checked ones", () => {
    const said = saidOn(pages.find((p) => p.path === "/fleet")?.body ?? "");
    expect(said).toContain(`${counted.starlink} Starlink`);
    expect(said).toContain(
      `${sum} Starlink, listed or by aircraft type, not checked plane by plane`
    );
  });

  test("the badge shows the counted airlines, at the size it had, and says who is left out", () => {
    const svg = pages.find((p) => p.path === "/badge.svg")?.body ?? "";
    const value = `${counted.starlink} of ${counted.total} aircraft`;
    expect(svg).toContain(`>${value}</text>`);
    expect(svg).toContain(">Airline Starlink</text>");
    const name = svg.match(/aria-label="([^"]*)"/)?.[1].replace(/&apos;/g, "'") ?? "";
    expect(name).toStartWith(`Airline Starlink: ${value}, `);
    expect(name).toContain(BY_TYPE_METHOD);
    for (const cfg of hubByType) expect(name).toContain(`${cfg.shortName}'s `);
    const was = badgeSvgMarkup(
      "Airline Starlink",
      `${counted.starlink + sum} of ${counted.total + listedTotal} aircraft`,
      "#000"
    );
    const size = (s: string) => s.match(/<svg[^>]* width="(\d+)" height="(\d+)"/)?.slice(1);
    expect(size(svg)).toEqual(size(was) as string[]);
  });

  test("the home list gives no row count over both kinds, and marks the by-type tab", () => {
    const said = saidOn(pages.find((p) => p.path === "/")?.body ?? "");
    expect(said).toContain("ALL");
    for (const cfg of hubByType) {
      expect(
        said.some((p) => p.startsWith(`${cfg.name.toUpperCase()} (`) && p.endsWith(" by type)"))
      ).toBe(true);
    }
    for (const cfg of hubCounted) {
      expect(said.some((p) => new RegExp(`^${cfg.name.toUpperCase()} \\(\\d+\\)$`).test(p))).toBe(
        true
      );
    }
  });

  test("get_fleet_stats totals the counted airlines and says who is not in the total", () => {
    const total = stats.split("\n").find((l) => l.includes("have Starlink WiFi")) ?? "";
    expect(total).toContain(`${counted.starlink} of ${counted.total} aircraft`);
    for (const cfg of hubCounted) expect(total.split("**")[1]).toContain(cfg.name);
    for (const cfg of hubByType) {
      expect(total.split("**")[1]).not.toContain(cfg.name);
      expect(total.split("Not in this total:")[1]).toContain(cfg.name);
    }
    expect(total).toContain(BY_TYPE_METHOD);
    expect(stats).not.toContain("All tracked airlines");
  });

  test("list_starlink_aircraft heads the list with the counted aircraft, then the by-type ones", () => {
    for (const text of [list, mainlineList]) {
      const header = text.split("\n")[0];
      expect(header).toStartWith(`${counted.starlink} Starlink-equipped aircraft `);
      expect(header).toContain(`${BY_TYPE_METHOD} (showing `);
      for (const cfg of hubByType)
        expect(header).toContain(` ${cfg.shortName} aircraft on the fleet list`);
    }
    // Every aircraft is still listed: the header changed, the rows did not.
    expect(list.split("\n\n")[1].split("\n")).toHaveLength(counted.starlink + sum);
  });
});
