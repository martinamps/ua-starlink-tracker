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
  factStamp,
  factsAliasTarget,
  factsBySlug,
  factsStamp,
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
        const { date } = factStamp(fact);
        expect(AS_OF_RE.test(date), `${entry.slug}: bad date ${date}`).toBe(true);
        const t = Date.parse(date);
        expect(Number.isFinite(t), `${entry.slug}: unparseable date ${date}`).toBe(true);
        expect(t, `${entry.slug}: future-dated fact ${date}`).toBeLessThanOrEqual(Date.now());
        expect(fact.source.url, `${entry.slug}: non-https source`).toStartWith("https://");
        expect(fact.source.label.length, `${entry.slug}: empty source label`).toBeGreaterThan(0);
        expect(fact.fact.trim().length, `${entry.slug}: empty fact`).toBeGreaterThan(0);
      }
      // The visible stamp always resolves, even for entries built entirely on
      // undated sources (those say "checked" and contribute no lastmod).
      expect(Number.isFinite(Date.parse(factsStamp(entry).date)), entry.slug).toBe(true);
    }
  });

  // The lastmod bug this guards: dating a claim to the day you authored the
  // page makes every page advertise today's freshness for months-old sources,
  // then freezes that lie in place. An undated source gets `accessed` instead,
  // which is rendered as "checked" and never reaches <lastmod>.
  test("no asOf is the build date — asOf is the claim's date, not the access date", () => {
    const today = new Date().toISOString().slice(0, 10);
    for (const entry of AIRLINE_FACTS) {
      for (const fact of entry.facts) {
        expect(fact.asOf, `${entry.slug}: asOf is today's date — use accessed`).not.toBe(today);
      }
    }
  });

  test("accessed-only entries contribute no lastmod and say 'checked'", () => {
    for (const entry of AIRLINE_FACTS) {
      const stamp = factsStamp(entry);
      if (entry.facts.every((f) => !f.asOf)) {
        expect(latestFactDate(entry), `${entry.slug} must not mint a lastmod`).toBe("");
        expect(stamp.label, entry.slug).toBe("checked");
      } else {
        expect(stamp.label, entry.slug).toBe("updated");
        expect(stamp.date, entry.slug).toBe(latestFactDate(entry));
      }
    }
  });

  // summary and insteadOf are the widest-read strings in this file (sub-heading,
  // meta + og description, /airlines row, llms.txt roster line) but render no
  // source link of their own. So every number they publish must be one the
  // dated, sourced facts already carry — the page banner promises exactly that.
  test("every number in summary/insteadOf is backed by the entry's facts", () => {
    const runs = (s: string) => (s.match(/\d{2,}/g) ?? []).map((m) => m);
    for (const entry of AIRLINE_FACTS) {
      const backing = [
        ...entry.facts.map((f) => f.fact),
        // A summary may state the date its claims are as of.
        ...entry.facts.map((f) => factStamp(f).date),
        ...entry.facts.map((f) => formatFactDate(factStamp(f).date)),
      ].join(" ");
      for (const claim of [entry.summary, entry.insteadOf ?? ""]) {
        for (const n of runs(claim)) {
          expect(backing.includes(n), `${entry.slug}: "${n}" in summary is in no fact`).toBe(true);
        }
      }
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

  // "They chose Amazon Leo" is verifiable; "we found no announcement" is not.
  // Forcing the distinction at the data level is what stops factsHeadline from
  // publishing an unverified negative as a verified one.
  test("every negative entry declares whether it chose an alternative or is unannounced", () => {
    for (const entry of AIRLINE_FACTS) {
      if (entry.status === "not_starlink") {
        expect(["chose", "unannounced"], `${entry.slug}: missing negative kind`).toContain(
          entry.negative
        );
      } else {
        expect(entry.negative, `${entry.slug}: negative kind on a positive entry`).toBeUndefined();
      }
    }
  });

  test("formatFactDate keeps the source's precision", () => {
    expect(formatFactDate("2026-08-21")).toBe("Aug 21, 2026");
    expect(formatFactDate("2025-11")).toBe("Nov 2025");
  });
});
