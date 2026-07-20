/**
 * Citable-stat surfaces: the homepage stat sentence (what AI answer engines
 * quote) and the /methodology page (what earns the citation). Shape-only —
 * counts and dates come from the snapshot and must survive data drift.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
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

describe("homepage stat sentence", () => {
  const airlineSites = Object.values(SITES).filter((s) => s.scope !== "ALL");

  test.each(airlineSites.map((s) => [s.key, s] as const))(
    "%s: one dated, self-contained sentence with live numbers",
    async (_key, site) => {
      const { status, text } = await getText("/", site.canonicalHost);
      expect(status).toBe(200);
      // Fails closed on a zero denominator (no fleet-total meta yet) — a
      // "0 of 0" sentence would be worse than none.
      if (getReader(site.scope).getTotalCount() === 0) {
        expect(text).not.toContain('id="starlink-stat"');
        return;
      }
      expect(text).toContain('id="starlink-stat"');
      const body = visibleText(text);
      // "As of July 19, 2026, 981 of 1,516 United Airlines aircraft (36%) have
      // Starlink WiFi installed" — numbers/date from data, never pinned.
      const sentence =
        /As of [A-Z][a-z]+ \d{1,2}, \d{4}, [\d,]+ of [\d,]+ [^(]+ aircraft \(\d{1,3}%\) have\s+Starlink WiFi installed/;
      expect(body).toMatch(sentence);
    }
  );

  test("hub renders no stat sentence (no single-fleet number)", async () => {
    const { status, text } = await getText("/", SITES.airline.canonicalHost);
    expect(status).toBe(200);
    expect(text).not.toContain('id="starlink-stat"');
  });

  test("united: sentence links to /methodology", async () => {
    const { text } = await getText("/", SITES.united.canonicalHost);
    const stat = text.slice(text.indexOf('id="starlink-stat"'));
    expect(stat.slice(0, stat.indexOf("</p>"))).toContain('href="/methodology"');
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

  test("llms.txt points agents at the stat sentence", async () => {
    const { text } = await getText("/llms.txt", SITES.united.canonicalHost);
    expect(text).toContain("starlink-stat");
    expect(text).toContain("/methodology");
  });
});
