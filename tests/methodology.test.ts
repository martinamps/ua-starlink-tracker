/**
 * Citable-stat surfaces: the homepage count (what AI answer engines
 * quote) and the /methodology page (what earns the citation). Shape-only —
 * counts and dates come from the snapshot and must survive data drift.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { AIRLINES, SITES } from "../src/airlines/registry";
import { createReaderFactory } from "../src/database/reader";
import { createApp } from "../src/server/app";
import { openSnapshot, req } from "./helpers";

let app: ReturnType<typeof createApp>;
let getReader: ReturnType<typeof createReaderFactory>;

beforeAll(() => {
  const db = openSnapshot();
  app = createApp(db);
  getReader = createReaderFactory(db);
});

const getText = async (path: string, host: string) => {
  const res = await app.dispatch(req(path, host));
  return { status: res.status, text: await res.text() };
};

// React SSR interleaves `<!-- -->` between adjacent text expressions; strip
// them so assertions see the sentence as extracted text, the way crawlers do.
const visibleText = (html: string) => html.replace(/<!--.*?-->/g, "");

describe("homepage citable count", () => {
  const airlineSites = Object.values(SITES).filter((s) => s.scope !== "ALL");
  const plain = (html: string) =>
    visibleText(html)
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");

  test.each(airlineSites.map((s) => [s.key, s] as const))(
    "%s: one starlink-stat element with live numbers, dated on the page",
    async (_key, site) => {
      const { status, text } = await getText("/", site.canonicalHost);
      expect(status).toBe(200);
      // No fleet-total meta yet: nothing citable to check.
      if (getReader(site.scope).getTotalCount() === 0) return;
      expect(text.split('id="starlink-stat"').length - 1).toBe(1);
      // The rollout panel ("981 of 1,516 United aircraft 36% have Starlink")
      // or, on heroes without one, the sentence ("As of July 19, 2026, 160
      // Qatar Airways aircraft have Starlink."). Numbers from data, never pinned.
      const stat = plain(text.slice(text.indexOf('id="starlink-stat"')).slice(0, 2000));
      const cfg = AIRLINES[site.scope as string];
      expect(stat).toMatch(
        cfg.rollout.rosterIsProgramScope
          ? /[\d,]+ of [\d,]+ [^.]+?\d{1,3}%\)? have\s+Starlink/
          : /[\d,]+ [^.]+? aircraft have Starlink/
      );
      expect(plain(text)).toMatch(/Data last updated [A-Z][a-z]+ \d{1,2}, \d{4}/);
    }
  );

  test("hub renders no starlink-stat element (no single-fleet number)", async () => {
    const { status, text } = await getText("/", SITES.airline.canonicalHost);
    expect(status).toBe(200);
    expect(text).not.toContain('id="starlink-stat"');
  });

  test("united: the date line links to /methodology", async () => {
    const { text } = await getText("/", SITES.united.canonicalHost);
    const dated = visibleText(text).slice(visibleText(text).indexOf("Data last updated"));
    expect(dated.slice(0, dated.indexOf("</p>"))).toContain('href="/methodology"');
  });
});

describe("/methodology gating", () => {
  test.each(Object.values(SITES).map((s) => [s.key, s] as const))(
    "%s: serves iff the feature is on",
    async (_key, site) => {
      const { status } = await getText("/methodology", site.canonicalHost);
      expect(status).toBe(site.features.methodologyPage ? 200 : 404);
    }
  );

  test("page names its own airline and verification cadence", async () => {
    const { text } = await getText("/methodology", SITES.united.canonicalHost);
    expect(text).toContain("United");
    expect(text).toContain("Citing this data");
    expect(text).toContain("starlink-stat");
  });

  test("sitemap lists /methodology only where it serves", async () => {
    for (const site of Object.values(SITES)) {
      const { text } = await getText("/sitemap.xml", site.canonicalHost);
      expect(
        text.includes(`https://${site.canonicalHost}/methodology`),
        `${site.key} sitemap`
      ).toBe(site.features.methodologyPage);
    }
  });

  test("llms.txt points agents at the starlink-stat count", async () => {
    const { text } = await getText("/llms.txt", SITES.united.canonicalHost);
    expect(text).toContain("starlink-stat");
    expect(text).toContain("/methodology");
  });
});
