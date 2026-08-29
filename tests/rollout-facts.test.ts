/**
 * Structural invariants for the rollout-facts roster. Accuracy-with-receipts
 * is enforceable shape: every claim must carry a parseable, non-future date
 * and an https source; the URL space (slugs + aliases) must stay collision-
 * free; tracked entries must share the registry's canonical slug so each
 * airline keeps exactly one indexable URL.
 */

import { describe, expect, test } from "bun:test";
import { AIRLINES, airlineSlug } from "../src/airlines/registry";
import {
  AIRLINE_FACTS,
  contentOnlyFacts,
  factsAliasTarget,
  factsBySlug,
  formatFactDate,
  latestFactDate,
} from "../src/airlines/rollout-facts";

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// YYYY-MM-DD, or YYYY-MM when the source only supports month precision.
const AS_OF_RE = /^\d{4}-\d{2}(-\d{2})?$/;

describe("rollout-facts structure", () => {
  test("slugs are kebab-case and unique; aliases collide with nothing", () => {
    const slugs = AIRLINE_FACTS.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    const aliases = AIRLINE_FACTS.flatMap((e) => e.aliases ?? []);
    expect(new Set(aliases).size).toBe(aliases.length);
    for (const s of [...slugs, ...aliases]) {
      expect(SLUG_RE.test(s), `bad slug: ${s}`).toBe(true);
    }
    for (const alias of aliases) {
      expect(factsBySlug(alias), `alias shadows a slug: ${alias}`).toBeNull();
      expect(factsAliasTarget(alias), `alias resolves: ${alias}`).not.toBeNull();
    }
  });

  test("IATA codes are unique across the roster (they mint 301s)", () => {
    const iatas = AIRLINE_FACTS.map((e) => e.iata);
    expect(new Set(iatas).size).toBe(iatas.length);
  });

  test("every fact carries a parseable, non-future date and an https source", () => {
    for (const entry of AIRLINE_FACTS) {
      expect(entry.facts.length, `${entry.slug} has no facts`).toBeGreaterThan(0);
      for (const fact of entry.facts) {
        expect(AS_OF_RE.test(fact.asOf), `${entry.slug}: bad asOf ${fact.asOf}`).toBe(true);
        const t = Date.parse(fact.asOf);
        expect(Number.isFinite(t), `${entry.slug}: unparseable asOf ${fact.asOf}`).toBe(true);
        expect(t, `${entry.slug}: future-dated fact ${fact.asOf}`).toBeLessThanOrEqual(Date.now());
        expect(fact.source.url, `${entry.slug}: non-https source`).toStartWith("https://");
        expect(fact.source.label.length, `${entry.slug}: empty source label`).toBeGreaterThan(0);
        expect(fact.fact.trim().length, `${entry.slug}: empty fact`).toBeGreaterThan(0);
      }
      // The page's lastmod derives from this — it must always exist and parse.
      expect(Number.isFinite(Date.parse(latestFactDate(entry)))).toBe(true);
    }
  });

  test("tracked entries use the registry's canonical slug and a real code", () => {
    for (const entry of AIRLINE_FACTS.filter((e) => e.trackedCode)) {
      const cfg = AIRLINES[entry.trackedCode as string];
      expect(cfg, `${entry.slug}: unknown trackedCode`).toBeDefined();
      expect(entry.slug, `${entry.slug}: slug drifts from registry`).toBe(airlineSlug(cfg));
    }
    // Every tracked entry is excluded from the content-only roster.
    for (const entry of contentOnlyFacts()) {
      expect(entry.trackedCode).toBeUndefined();
    }
  });

  test("negative entries always say what the airline runs instead", () => {
    for (const entry of AIRLINE_FACTS.filter((e) => e.status === "not_starlink")) {
      expect(entry.insteadOf, `${entry.slug} missing insteadOf`).toBeTruthy();
    }
  });

  test("formatFactDate keeps the source's precision", () => {
    expect(formatFactDate("2026-08-21")).toBe("Aug 21, 2026");
    expect(formatFactDate("2025-11")).toBe("Nov 2025");
  });
});
