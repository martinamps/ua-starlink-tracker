/**
 * Citation verification — fetch every cited source and check that the claim's
 * distinguishing tokens are actually in the bytes it returns.
 *
 * WHY THIS EXISTS
 * A content review of the hub roster found 42 defects that every test on the
 * branch passed: claims attributed to pages that do not contain them, `asOf`
 * dates 44 to 429 days from their source's real dateline, a hard 404 cited as a
 * source, and figures that appear in no cited text at all. Nothing in the suite
 * had ever opened a source URL, so "the tests pass" and "the claims are true"
 * were unrelated facts. The rule this restores: a claim cannot merge unless a
 * machine has seen its numbers and proper nouns in the source's own bytes.
 *
 * HOW TO RUN IT
 *   bun run verify-citations                # everything, ~1 req/s per host
 *   bun run verify-citations --changed      # only facts whose text, asOf or
 *                                           # url differs from the merge base
 *   bun run verify-citations --slug=zipair  # one entry
 *   bun run verify-citations --strict       # warnings fail too (weekly CI job)
 *   bun run verify-citations --audit-allowlist  # re-test the blocked hosts
 *   bun run verify-citations --no-cache     # ignore .citation-cache
 *
 * Exits non-zero on any FAIL (and on any WARN under --strict).
 *
 * WIRING — deliberately NOT in `bun test`
 * This makes real network requests, so it is opt-in. A citation check wired
 * into the pre-push hook would fail on hotel wifi and teach everyone to skip
 * it, which is the same failure mode as a <lastmod> that always says "now".
 * Run it before merging anything that touches rollout-facts.ts, and weekly to
 * catch link rot and silently-edited sources. The parts that need no network —
 * URL shape, date sanity, allowlist hygiene, summary containment — live in
 * tests/citation-integrity.test.ts and run on every push.
 *
 * WHEN YOU ADD AN AIRLINE
 * Write the facts, then run this. A new entry is expected to come back clean;
 * if a token is missing, the fix is the fact or the citation, never the
 * checker. If the host blocks automated clients, add a `source.mirror` archive
 * snapshot first, and only fall back to scripts/citations/allowlist.ts — which
 * makes the claim SKIPPED, a standing obligation, not a pass.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AIRLINES } from "../src/airlines/registry";
import { AIRLINE_FACTS, type RolloutFact } from "../src/airlines/rollout-facts";
import { BLOCKED_HOSTS } from "./citations/allowlist";
import { dateSkewDays, extractPublishedDates } from "./citations/pubdate";
import {
  type Severity,
  assertableTokens,
  checkTokens,
  htmlToText,
  severityOf,
} from "./citations/tokens";

/** A dateline and an `asOf` can legitimately differ by a few weeks — a fact may
 * be dated to an event the article reports rather than to the article. Past a
 * month it is not a rounding difference; the five date blockers were 44, 46,
 * 63, 90 and 429 days out. */
const MAX_DATE_SKEW_DAYS = 31;
const REQUEST_TIMEOUT_MS = 20_000;
const PER_HOST_DELAY_MS = 1_000;
const CACHE_DIR = join(import.meta.dir, "..", ".citation-cache");
// A desktop UA, because the check is "would a reader see this claim on this
// page" — not "does this host like robots".
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

interface Finding {
  slug: string;
  factIndex: number;
  check: string;
  severity: Severity;
  expected: string;
  found: string;
}

const args = new Set(process.argv.slice(2));
const strict = args.has("--strict");
const noCache = args.has("--no-cache");
const slugFilter = [...args].find((a) => a.startsWith("--slug="))?.slice("--slug=".length);

const findings: Finding[] = [];
let skipped = 0;
let unread = 0;
let checkedFacts = 0;
const fetchedHosts = new Map<string, number>();

function report(f: Finding) {
  findings.push(f);
}

async function politeFetch(
  url: string
): Promise<{ status: number; body: string; finalUrl: string }> {
  const host = new URL(url).hostname;
  const last = fetchedHosts.get(host) ?? 0;
  const wait = last + PER_HOST_DELAY_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  fetchedHosts.set(host, Date.now());
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
  });
  return { status: res.status, body: await res.text(), finalUrl: res.url || url };
}

/** Cache keyed by URL + day so a re-run inside 24h re-reads the same bytes:
 * the point is to make re-running cheap, not to hide a source that changed. */
async function fetchPage(url: string): Promise<{ status: number; body: string; finalUrl: string }> {
  const key = `${Bun.hash(url).toString(16)}-${new Date().toISOString().slice(0, 10)}.json`;
  const path = join(CACHE_DIR, key);
  if (!noCache && existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  const result = await politeFetch(url);
  if (!noCache) {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify(result));
  }
  return result;
}

/** Below this, a "page" is a loading shell, a cookie wall, or an app that
 * renders its content in the browser — not something a claim can rest on. A
 * real press release runs to thousands of characters; the shortest cited page
 * that genuinely serves its text is an order of magnitude above this. */
const MIN_READABLE_CHARS = 600;

function unreadableReason(raw: string, text: string): string | null {
  // A PDF press release is a legitimate source and an illegible one: the bytes
  // are compressed streams, so every token "fails" and every finding is noise.
  // Cite an HTML version, or add a mirror — do not let it report as checked.
  if (raw.startsWith("%PDF") || raw.slice(0, 2048).includes("%PDF-")) {
    return "the URL serves a PDF — cite an HTML version or add a readable mirror";
  }
  if (text.length < MIN_READABLE_CHARS) {
    return `only ${text.length} characters of text (client-rendered page or interstitial)`;
  }
  return null;
}

async function verifyFact(slug: string, subject: string, fact: RolloutFact, index: number) {
  const { url, mirror } = fact.source;
  const host = new URL(url).hostname;
  const add = (check: string, severity: Severity, expected: string, found: string) =>
    report({ slug, factIndex: index, check, severity, expected, found });

  if (BLOCKED_HOSTS[host]) {
    // Never a pass. The claim stands unverified until a human re-confirms it,
    // and the offline test expires that confirmation on a timer.
    skipped++;
    console.log(`  SKIP  ${slug}#${index}  ${host} — allowlisted: ${BLOCKED_HOSTS[host].reason}`);
    return;
  }

  let page: { status: number; body: string; finalUrl: string };
  try {
    page = await fetchPage(url);
  } catch (err) {
    // A TLS failure IS the signal — never retry with verification disabled.
    // The Hawaiian citation presented exactly this way before it 301'd to a 404.
    add("reachable", "fail", "200 over valid TLS", `request failed: ${(err as Error).message}`);
    return;
  }

  if (page.status >= 400) {
    add("reachable", "fail", "< 400", `HTTP ${page.status} — dead citation`);
    return;
  }
  if (page.status >= 300) add("reachable", "warn", "2xx", `HTTP ${page.status}`);
  const finalHost = new URL(page.finalUrl).hostname;
  if (finalHost !== host) {
    // Not a failure on its own — newsrooms move — but the Hawaiian dead link
    // presented as a cross-host redirect, so it always gets printed.
    add("redirect", "warn", host, `redirected to ${finalHost}`);
  }
  const text = htmlToText(page.body);
  // "The source does not say this" and "we could not read the source" are
  // different findings, and collapsing them is how a client-rendered page turns
  // into seven bogus token failures that bury the one real one. A 200 that
  // yields no readable prose is as unverified as a 403 — and unlike a 403, it
  // looks checked, which is worse.
  const unreadable = unreadableReason(page.body, text);
  if (unreadable) {
    unread++;
    console.log(`  UNREAD ${slug}#${index}  ${host} — ${unreadable}`);
    add("readable", "fail", "prose a reader could check the claim against", unreadable);
    return;
  }
  checkedFacts++;

  const published = extractPublishedDates(page.body);
  if (fact.asOf) {
    if (!published.length) {
      add(
        "asOf",
        "warn",
        `within ${MAX_DATE_SKEW_DAYS}d of the source's date`,
        "no date in markup"
      );
    } else {
      const skews = published.map((p) => ({ p, skew: dateSkewDays(fact.asOf as string, p.iso) }));
      const best = skews.reduce((a, b) => (b.skew < a.skew ? b : a));
      if (best.skew > MAX_DATE_SKEW_DAYS) {
        add(
          "asOf",
          "fail",
          `asOf ${fact.asOf} within ${MAX_DATE_SKEW_DAYS}d`,
          `nearest date on the page is ${best.p.iso} (${best.p.via}) — ${best.skew} days off`
        );
      }
    }
  } else if (published.length) {
    // An `accessed` fact declares its source undated. When the page turns out
    // to publish a date, the claim should be a DatedFact carrying it — that is
    // the SAS mistake in reverse, and it silently costs the page a lastmod.
    add(
      "accessed",
      "warn",
      "an undated evergreen source",
      `source publishes ${published[0].iso} (${published[0].via})`
    );
  }

  for (const result of checkTokens(assertableTokens(fact.fact, subject), text)) {
    const severity = severityOf(result);
    if (!severity) continue;
    add(
      `token/${result.token.kind}`,
      severity,
      result.token.raw,
      result.viaFallback
        ? `only the family root "${result.token.fallback}" appears`
        : "absent from the source text"
    );
  }

  if (mirror) {
    try {
      const snap = await fetchPage(mirror);
      // A 404 means the snapshot the mirror promises does not exist — that is a
      // broken receipt, and it blocks. A 5xx or a rate-limit says nothing about
      // the snapshot: archive.org is regularly slow or refusing, and failing the
      // gate on its mood is how a checker earns the right to be ignored.
      if (snap.status === 404 || snap.status === 410) {
        add("mirror", "fail", "a snapshot that exists", `HTTP ${snap.status}`);
      } else if (snap.status >= 400) {
        add("mirror", "warn", "a snapshot that opens", `HTTP ${snap.status} — archive unavailable`);
      }
    } catch (err) {
      add("mirror", "warn", "a snapshot that opens", `request failed: ${(err as Error).message}`);
    }
  }
}

/** --changed: only entries carrying a fact whose text, date or URL is not in
 * the merge base's copy of the file, so a one-line edit costs seconds instead
 * of a full sweep. Substring matching against the old source is deliberately
 * crude — it errs toward re-checking, which is the safe direction. Returns null
 * when there is no merge base to diff against, and the caller checks all. */
function changedSlugs(): Set<string> | null {
  const base = Bun.spawnSync(["git", "merge-base", "HEAD", "main"]).stdout.toString().trim();
  if (!base) return null;
  const before = Bun.spawnSync([
    "git",
    "show",
    `${base}:src/airlines/rollout-facts.ts`,
  ]).stdout.toString();
  if (!before) return null;
  const changed = new Set<string>();
  for (const entry of AIRLINE_FACTS) {
    const moved = entry.facts.some(
      (f) =>
        !before.includes(f.fact) ||
        !before.includes(f.source.url) ||
        !before.includes(f.asOf ?? f.accessed)
    );
    if (moved) changed.add(entry.slug);
  }
  return changed;
}

async function auditAllowlist() {
  console.log("Auditing allowlisted hosts — an entry that now answers should be removed.\n");
  for (const [host, meta] of Object.entries(BLOCKED_HOSTS)) {
    const url = AIRLINE_FACTS.flatMap((e) => e.facts)
      .map((f) => f.source.url)
      .find((u) => new URL(u).hostname === host);
    if (!url) {
      console.log(`  STALE   ${host} — no citation uses it; remove the entry`);
      continue;
    }
    try {
      const res = await politeFetch(url);
      console.log(
        res.status < 400
          ? `  LIFTED  ${host} — HTTP ${res.status}; remove the entry and let the check run`
          : `  BLOCKED ${host} — HTTP ${res.status} (${meta.reason})`
      );
    } catch (err) {
      console.log(`  BLOCKED ${host} — ${(err as Error).message} (${meta.reason})`);
    }
  }
}

async function main() {
  if (args.has("--audit-allowlist")) {
    await auditAllowlist();
    return;
  }

  const only = args.has("--changed") ? changedSlugs() : null;
  if (args.has("--changed")) {
    console.log(
      only
        ? `--changed: ${only.size} entr${only.size === 1 ? "y" : "ies"} differ from the merge base\n`
        : "--changed: no merge base to diff against — checking everything\n"
    );
  }

  for (const entry of AIRLINE_FACTS) {
    if (slugFilter && entry.slug !== slugFilter) continue;
    if (only && !only.has(entry.slug)) continue;
    const subject = `${entry.name} ${entry.shortName} ${
      entry.trackedCode ? (AIRLINES[entry.trackedCode]?.name ?? "") : ""
    }`;
    for (const [i, fact] of entry.facts.entries()) {
      await verifyFact(entry.slug, subject, fact, i);
    }
  }

  const fails = findings.filter((f) => f.severity === "fail");
  const warns = findings.filter((f) => f.severity === "warn");
  console.log(
    `\n${"slug".padEnd(22)}${"#".padEnd(3)}${"check".padEnd(20)}${"expected".padEnd(46)}found`
  );
  console.log("-".repeat(140));
  for (const f of [...fails, ...warns]) {
    const tag = f.severity === "fail" ? "FAIL" : "warn";
    console.log(
      `${tag} ${f.slug.padEnd(17)}${String(f.factIndex).padEnd(3)}${f.check.padEnd(20)}${f.expected.slice(0, 44).padEnd(46)}${f.found}`
    );
  }
  console.log(
    `\n${checkedFacts} facts verified · ${skipped} skipped (allowlisted) · ${unread} unreadable · ${fails.length} failures · ${warns.length} warnings`
  );
  if (fails.length || (strict && warns.length)) process.exit(1);
}

await main();
