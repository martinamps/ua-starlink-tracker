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
  trackingMethod,
} from "../src/airlines/published-count";
import { AIRLINES, type AirlineConfig, siteForAirline } from "../src/airlines/registry";
import { reconcileTypeDeterministicFleets } from "../src/database/database";
import { badgeSvgMarkup, badgeValue, createApp } from "../src/server/app";
import { bodyOf, makeFreshDb, openSnapshot } from "./helpers";

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
