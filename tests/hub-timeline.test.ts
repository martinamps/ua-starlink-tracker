/**
 * The hub's /timeline: every hub airline's dated facts, grouped by airline,
 * newest first, superseded ones kept and marked. Shape only: the counts and
 * dates come from rollout-facts and move with every new fact.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import { AIRLINE_FACTS, type AirlineFactsEntry } from "../src/airlines/rollout-facts";
import { hubTimelineAirlines } from "../src/components/hub-timeline-page";
import { createApp } from "../src/server/app";
import { bodyOf, openSnapshot } from "./helpers";

const HUB = SITES.airline.canonicalHost;
const UA = SITES.united.canonicalHost;

let app: ReturnType<typeof createApp>;
beforeAll(() => {
  app = createApp(openSnapshot());
});

/** Each airline section's id and the dates and superseded marks of its entries, in page order. */
function sections(html: string) {
  const out = new Map<string, Array<{ date: string; replaced: boolean }>>();
  for (const m of html.matchAll(/<section id="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g)) {
    const entries = [...m[2].matchAll(/<li([^>]*)>\s*<time dateTime="([^"]+)"/g)];
    out.set(
      m[1],
      entries.map((e) => ({ date: e[2], replaced: e[1].includes('data-superseded="true"') }))
    );
  }
  return out;
}

describe("hub /timeline", () => {
  test("serves on the hub, with one section per airline that has a dated fact", async () => {
    const { status, text } = await bodyOf(app, "/timeline", HUB);
    expect(status).toBe(200);
    const page = sections(text);
    const airlines = hubTimelineAirlines(AIRLINE_FACTS);
    expect(page.size).toBeGreaterThan(0);
    for (const slug of page.keys()) {
      expect(
        airlines.some((a) => a.entry.slug === slug),
        slug
      ).toBe(true);
      // The jump list points at it, and its airline page is linked.
      expect(text).toContain(`href="#${slug}"`);
      expect(text).toContain(`href="/airlines/${slug}"`);
    }
  });

  test("facts run newest first within each airline; airlines by their newest fact", async () => {
    const page = sections((await bodyOf(app, "/timeline", HUB)).text);
    const firsts: string[] = [];
    for (const [slug, entries] of page) {
      expect(entries.length, slug).toBeGreaterThan(0);
      const dates = entries.map((e) => e.date);
      expect(dates, slug).toEqual([...dates].sort().reverse());
      firsts.push(dates[0]);
    }
    expect(firsts).toEqual([...firsts].sort().reverse());
  });

  test("every dated fact is on the page, superseded ones marked, each with its source link", async () => {
    const { text } = await bodyOf(app, "/timeline", HUB);
    const page = sections(text);
    for (const { entry, facts } of hubTimelineAirlines(AIRLINE_FACTS)) {
      const shown = page.get(entry.slug) ?? [];
      expect(shown.length, entry.slug).toBe(facts.length);
      expect(shown.filter((e) => e.replaced).length, entry.slug).toBe(
        facts.filter((f) => f.superseded).length
      );
      for (const f of facts) expect(text, f.source.label).toContain(`href="${f.source.url}"`);
    }
  });

  test("a superseded fact sits below a current fact of its airline (the page says 'listed above')", () => {
    for (const { entry, facts } of hubTimelineAirlines(AIRLINE_FACTS)) {
      facts.forEach((f, i) => {
        if (f.superseded && !f.withdrawnBecause) {
          expect(
            facts.slice(0, i).some((g) => !g.superseded),
            `${entry.slug} ${f.asOf}`
          ).toBe(true);
        }
      });
    }
  });

  // A fact withdrawn for its source, with only older facts left to answer,
  // says so in its own words: "listed above" would point at nothing.
  test("a withdrawn fact prints its reason, never 'listed above'", async () => {
    const { text } = await bodyOf(app, "/timeline", HUB);
    for (const { facts } of hubTimelineAirlines(AIRLINE_FACTS)) {
      for (const f of facts.filter((g) => g.withdrawnBecause)) {
        expect(f.superseded, f.fact).toBe(true);
        expect(text).toContain(f.withdrawnBecause?.replace(/'/g, "&#x27;") ?? "");
      }
    }
  });

  test("undated facts stay off; airlines without a dated fact get no section", () => {
    const undatedOnly: AirlineFactsEntry = {
      ...AIRLINE_FACTS[0],
      slug: "undated-only",
      facts: [{ ...AIRLINE_FACTS[0].facts[0], asOf: undefined, accessed: "2026-01-01" }],
    };
    const dated = AIRLINE_FACTS[0];
    const result = hubTimelineAirlines([undatedOnly, dated]);
    expect(result.map((a) => a.entry.slug)).toEqual([dated.slug]);
    expect(result[0].facts.every((f) => Boolean(f.asOf))).toBe(true);
  });

  test("advertised in the hub sitemap with the newest fact's date, and in llms.txt", async () => {
    const { text } = await bodyOf(app, "/sitemap.xml", HUB);
    const newest = hubTimelineAirlines(AIRLINE_FACTS)[0].facts[0].asOf;
    const entry = text.match(/<loc>[^<]*\/timeline<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/);
    expect(entry?.[1].startsWith(newest)).toBe(true);
    const llms = (await bodyOf(app, "/llms.txt", HUB)).text;
    expect(llms).toContain(`https://${HUB}/timeline`);
  });

  test("hub airline pages link to their own section", async () => {
    const page = sections((await bodyOf(app, "/timeline", HUB)).text);
    for (const slug of [...page.keys()].slice(0, 5)) {
      const { status, text } = await bodyOf(app, `/airlines/${slug}`, HUB);
      expect(status, slug).toBe(200);
      expect(text, slug).toContain(`href="/timeline#${slug}"`);
    }
  });

  test("the United site keeps its own timeline and no hub-timeline link", async () => {
    const { status, text } = await bodyOf(app, "/timeline", UA);
    expect(status).toBe(200);
    expect(text).toContain("Milestones");
    expect(text).not.toContain("Starlink timeline by airline");
  });
});
