/**
 * Citation integrity — everything checkable about the roster's sources WITHOUT
 * a network. Runs in the normal suite on every push.
 *
 * The companion `bun run verify-citations` is the half that fetches; it is
 * deliberately opt-in, because a check that fails on bad hotel wifi is a check
 * people learn to skip. What lives here is the half that can never flake: URL
 * shape, date sanity, allowlist hygiene, and the rule that a summary may not
 * assert anything the entry's own facts do not.
 *
 * Shapes, not values — the roster grows and every assertion here has to survive
 * that.
 */

import { describe, expect, test } from "bun:test";
import {
  BLOCKED_HOSTS,
  MAX_CONFIRMATION_AGE_DAYS,
  RETIRED_BLOCKS,
} from "../scripts/citations/allowlist";
import { assertableTokens, checkTokens, htmlToText, normalize } from "../scripts/citations/tokens";
import {
  AIRLINE_FACTS,
  type RolloutFact,
  factStamp,
  formatFactDate,
} from "../src/airlines/rollout-facts";

const allFacts: Array<{ slug: string; index: number; fact: RolloutFact }> = AIRLINE_FACTS.flatMap(
  (e) => e.facts.map((fact, index) => ({ slug: e.slug, index, fact }))
);

const citedHosts = new Set(allFacts.map(({ fact }) => new URL(fact.source.url).hostname));

// A URL that resolves to nothing is worse than no citation: it looks checked.
const PLACEHOLDER = /example\.(com|org)|localhost|127\.0\.0\.1|\bTODO\b|\bTK\b|^https:\/\/#/i;

describe("citation URLs", () => {
  test("every source URL is a well-formed https URL with a real host and path", () => {
    for (const { slug, index, fact } of allFacts) {
      const where = `${slug}#${index}`;
      let url: URL;
      expect(() => {
        url = new URL(fact.source.url);
      }, `${where}: unparseable URL ${fact.source.url}`).not.toThrow();
      url = new URL(fact.source.url);
      expect(url.protocol, `${where}: not https`).toBe("https:");
      expect(url.hostname.includes("."), `${where}: hostname without a dot`).toBe(true);
      expect(PLACEHOLDER.test(fact.source.url), `${where}: placeholder URL`).toBe(false);
      // A bare host is a link to a homepage, which cannot date or support a
      // specific claim — every citation must point at a document.
      expect(url.pathname.length, `${where}: cites a bare host`).toBeGreaterThan(1);
    }
  });

  test("mirrors are archive snapshots of the URL they stand in for", () => {
    for (const { slug, index, fact } of allFacts) {
      const mirror = fact.source.mirror;
      if (!mirror) continue;
      const where = `${slug}#${index}`;
      expect(mirror, `${where}: mirror not https`).toStartWith("https://");
      expect(mirror, `${where}: mirror is not an archive snapshot`).toMatch(
        /web\.archive\.org|archive\.(ph|is|today)|perma\.cc/
      );
      expect(mirror, `${where}: mirror is the same URL`).not.toBe(fact.source.url);
    }
  });

  // The same release legitimately backs several claims — but two DIFFERENT
  // airlines resting a claim on one URL is usually a copy-paste, and it is how
  // a fact ends up attributed to a page about someone else.
  test("a URL shared across airlines is shared deliberately, not by accident", () => {
    const owners = new Map<string, Set<string>>();
    for (const entry of AIRLINE_FACTS) {
      for (const fact of entry.facts) {
        const set = owners.get(fact.source.url) ?? new Set<string>();
        set.add(entry.slug);
        owners.set(fact.source.url, set);
      }
    }
    for (const [url, slugs] of owners) {
      if (slugs.size < 2) continue;
      // Group announcements (IAG, Indigo Partners) really do cover several
      // carriers; what must not happen is the same URL under many unrelated
      // airlines, so the bound is deliberately tight.
      expect([...slugs].length, `${url} is cited by ${[...slugs].join(", ")}`).toBeLessThanOrEqual(
        3
      );
    }
  });

  test("no entry cites the same URL twice for the same claim shape", () => {
    for (const entry of AIRLINE_FACTS) {
      const seen = new Set<string>();
      for (const fact of entry.facts) {
        const key = `${fact.source.url}|${fact.fact}`;
        expect(seen.has(key), `${entry.slug}: duplicate fact+source pair`).toBe(false);
        seen.add(key);
      }
    }
  });
});

describe("citation dates", () => {
  test("every asOf/accessed is a real calendar date, never in the future", () => {
    const today = new Date().toISOString().slice(0, 10);
    for (const { slug, index, fact } of allFacts) {
      const { date } = factStamp(fact);
      const where = `${slug}#${index}`;
      expect(date, `${where}: not YYYY-MM[-DD]`).toMatch(/^\d{4}-\d{2}(-\d{2})?$/);
      // Date.parse accepts "2026-02-31"; round-tripping catches the rollover.
      if (date.length === 10) {
        expect(
          new Date(date).toISOString().slice(0, 10),
          `${where}: ${date} is not a real day`
        ).toBe(date);
      }
      expect(date <= today, `${where}: future-dated ${date}`).toBe(true);
      const year = Number(date.slice(0, 4));
      expect(year, `${where}: implausible year`).toBeGreaterThan(2014);
    }
  });

  test("a fact declares either asOf or accessed, never both and never neither", () => {
    for (const { slug, index, fact } of allFacts) {
      const has = [fact.asOf, fact.accessed].filter(Boolean).length;
      expect(has, `${slug}#${index}: needs exactly one of asOf/accessed`).toBe(1);
    }
  });
});

// The counterpart to the network check: `summary` and `insteadOf` render in the
// H1 sub-heading, both meta descriptions, the /airlines row and the llms.txt
// roster line, and carry no source link of their own. So they may assert only
// what the entry's dated facts assert. The existing rollout-facts test pins the
// numbers; this one runs the SAME extractor the network check uses, so aircraft
// types, registrations, money and proper nouns are held to it too.
/**
 * Names a summary asserts that no fact in its entry carries. Each is a real
 * defect of the same shape as the review's Southwest finding ("gated on antenna
 * deliveries" — a claim in the highest-traffic string on the page, sourced
 * nowhere), and each is fixed by either deleting the phrase from the summary or
 * adding a dated fact that carries it.
 *
 * This is a RATCHET, in the style of the pinned-occurrence guard in
 * tenant-matrix.test.ts: the test fails when a new drift appears AND when a
 * pinned one is fixed without being removed from here. Fix the summary; do not
 * add to this list.
 *
 * Empty, and meant to stay that way. The two entries it held — flydubai's
 * "Dubai Airshow" and Turkish's "Anuvu's Dedicated Space" — were both true and
 * both in the cited releases ("The announcement was made at the Dubai Airshow
 * 2025"; "deploy Anuvu Dedicated Space technology"), just missing from the
 * facts the summaries are checked against. Fixing them meant putting the phrase
 * in the fact that carries the source, not deleting it from the summary.
 */
const KNOWN_SUMMARY_DRIFT: Record<string, string[]> = {};

describe("summary containment", () => {
  const misses = () => {
    const out: Array<{ slug: string; raw: string; severity: string }> = [];
    for (const entry of AIRLINE_FACTS) {
      const backing = normalize(
        [
          ...entry.facts.map((f) => f.fact),
          // A summary may state the date its claims are as of, in either the
          // stored form or the one the page renders ("Sep 24, 2024").
          ...entry.facts.map((f) => factStamp(f).date),
          ...entry.facts.map((f) => formatFactDate(factStamp(f).date)),
          entry.statusLabel,
        ].join(" \n ")
      );
      const subject = `${entry.name} ${entry.shortName}`;
      for (const claim of [entry.summary, entry.insteadOf ?? ""]) {
        if (!claim) continue;
        for (const r of checkTokens(assertableTokens(claim, subject), backing)) {
          if (!r.found)
            out.push({ slug: entry.slug, raw: r.token.raw, severity: r.token.severity });
        }
      }
    }
    return out;
  };

  // Numbers, money amounts, aircraft types and registrations are unambiguous:
  // a summary publishing one the facts do not carry is publishing an unsourced
  // figure in the meta description. Never pinnable.
  test("no summary publishes a figure or aircraft type its facts do not", () => {
    const hard = misses().filter((m) => m.severity === "fail");
    expect(hard.map((m) => `${m.slug}: "${m.raw}"`)).toEqual([]);
  });

  test("no summary names something its facts do not — pinned drift only", () => {
    const found = misses()
      .filter((m) => m.severity === "warn")
      .map((m) => `${m.slug}: ${m.raw}`)
      .sort();
    const pinned = Object.entries(KNOWN_SUMMARY_DRIFT)
      .flatMap(([slug, names]) => names.map((n) => `${slug}: ${n}`))
      .sort();
    expect(
      found,
      "A summary names something no fact carries. Fix the summary or add a dated fact — do not add to KNOWN_SUMMARY_DRIFT. If you fixed one, delete its pin."
    ).toEqual(pinned);
  });
});

describe("token extraction", () => {
  // A miss the extractor invents is worse than no check: it sends a reviewer to
  // re-source a claim the page already makes. PaxEx.Aero serves
  // "Viasat</a>&#8216;s GX satellites"; the named forms of those quotes were
  // decoded and the numeric forms were not, so "Viasat's GX" read as absent
  // from a page that says it.
  test("numeric character references for curly quotes decode like their named forms", () => {
    const text = htmlToText("<p><a>Viasat</a>&#8216;s GX satellites and &#8220;Amara&#8221;</p>");
    expect(text).toContain("viasat gx");
    expect(text).toContain('"amara"');
    expect(normalize("&#8217;s")).toBe(normalize("&rsquo;s"));
  });
});

describe("bot-blocked host allowlist", () => {
  test("every allowlisted host is still cited by a real fact", () => {
    for (const host of Object.keys(BLOCKED_HOSTS)) {
      expect(citedHosts.has(host), `${host} is allowlisted but nothing cites it — remove it`).toBe(
        true
      );
    }
  });

  test("retired blocks are retired — a returning host must be re-justified", () => {
    for (const host of Object.keys(RETIRED_BLOCKS)) {
      expect(
        citedHosts.has(host),
        `${host} is cited again but only listed as retired — move it back with fresh evidence`
      ).toBe(false);
      expect(RETIRED_BLOCKS[host].length, `${host}: retired without a reason`).toBeGreaterThan(30);
    }
  });

  test("every entry carries a reason, observed evidence, and dates that parse", () => {
    for (const [host, meta] of Object.entries(BLOCKED_HOSTS)) {
      expect(meta.reason.trim().length, `${host}: empty reason`).toBeGreaterThan(20);
      expect(
        meta.evidence.trim().length,
        `${host}: evidence must say what was seen`
      ).toBeGreaterThan(40);
      expect(
        meta.claimsConfirmedBy.trim().length,
        `${host}: no confirmation route`
      ).toBeGreaterThan(30);
      for (const [label, date] of [
        ["addedOn", meta.addedOn],
        ["claimsConfirmedOn", meta.claimsConfirmedOn],
      ] as const) {
        expect(date, `${host}: ${label} not YYYY-MM-DD`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(Date.parse(date), `${host}: ${label} unparseable`).toBeFinite();
        expect(Date.parse(date), `${host}: ${label} in the future`).toBeLessThanOrEqual(Date.now());
      }
    }
  });

  // An unverifiable citation is a standing obligation, not a permanent hole:
  // the confirmation expires and someone has to re-open the page or replace it.
  test("no human confirmation has gone stale", () => {
    for (const [host, meta] of Object.entries(BLOCKED_HOSTS)) {
      const ageDays = (Date.now() - Date.parse(meta.claimsConfirmedOn)) / 86_400_000;
      expect(
        ageDays,
        `${host}: last confirmed ${Math.round(ageDays)} days ago — re-open the page in a browser, re-date the entry, or replace the citation`
      ).toBeLessThanOrEqual(MAX_CONFIRMATION_AGE_DAYS);
    }
  });

  test("a host is allowlisted once, and not also retired", () => {
    for (const host of Object.keys(BLOCKED_HOSTS)) {
      expect(RETIRED_BLOCKS[host], `${host} is both blocked and retired`).toBeUndefined();
    }
  });
});
