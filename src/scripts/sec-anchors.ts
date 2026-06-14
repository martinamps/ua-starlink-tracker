/**
 * Daily SEC EDGAR watcher: keeps the officially-reported fleet/Starlink anchors
 * (10-K fleet tables, earnings 8-K Starlink counts) seeded for display, and
 * flags newly filed 10-K/10-Q/8-Ks from UAL, SkyWest, and Republic so the
 * handful of numbers they contain can be reviewed and added each quarter.
 * Anchor extraction is deliberately manual — the figures change at most
 * quarterly and live in prose/tables that don't parse robustly. To add a new
 * figure, append it to SEED_ANCHORS below.
 */

import type { Database } from "bun:sqlite";
import { getFleetAnchors, recordSecFilings, seedFleetAnchors } from "../database/database";
import { COUNTERS, metrics, normalizeAirlineTag, withSpan } from "../observability";
import type { FleetAnchorRow, SecFilingRow } from "../types";
import { type JobHandle, startJob } from "../utils/job-runner";
import { info, error as logError } from "../utils/logger";

// SEC fair-access policy requires "company-name contact-email" — other formats get 403.
const SEC_USER_AGENT = "ua-starlink-tracker admin@unitedstarlinktracker.com";

const SEC_COMPANIES = [
  { cik: "0000100517", company: "United Airlines Holdings", tag: "united_airlines_holdings" },
  { cik: "0000793733", company: "SkyWest", tag: "skywest" },
  { cik: "0000810332", company: "Republic Airways", tag: "republic_airways" },
] as const;

const WATCHED_FORMS = new Set(["10-K", "10-Q", "8-K"]);
// Only earnings 8-Ks (Item 2.02) carry fleet/Starlink figures; the rest are
// financings/governance noise that would train reviewers to ignore the alert.
const EARNINGS_8K_ITEM = "2.02";
const WATCH_WINDOW_DAYS = 450;

// Verified against the filings on 2026-06-13.
export const SEED_ANCHORS: Array<Omit<FleetAnchorRow, "added_at">> = [
  {
    airline: "UA",
    as_of_date: "2025-12-31",
    scope: "Mainline fleet in service",
    metric: "mainline_fleet_total",
    value: "1066",
    source_form: "UAL 10-K FY2025",
    source_url:
      "https://www.sec.gov/Archives/edgar/data/100517/000010051726000023/ual-20251231.htm",
  },
  {
    airline: "UA",
    as_of_date: "2025-12-31",
    scope: "Regional fleet in service",
    metric: "regional_fleet_total",
    value: "424",
    source_form: "UAL 10-K FY2025",
    source_url:
      "https://www.sec.gov/Archives/edgar/data/100517/000010051726000023/ual-20251231.htm",
  },
  {
    airline: "UA",
    as_of_date: "2026-03-31",
    scope: "Starlink installed, dual-class United Express",
    metric: "starlink_installed_dual_class_uax",
    value: "327",
    source_form: "UAL Q1 2026 earnings 8-K",
    source_url:
      "https://www.sec.gov/Archives/edgar/data/100517/000010051726000089/ual_erx03312026xex991.htm",
  },
  {
    airline: "UA",
    as_of_date: "2026-03-31",
    scope: "SkyWest aircraft under United Express agreements",
    metric: "skywest_united_express_total",
    value: "226",
    source_form: "SkyWest Q1 2026 10-Q",
    source_url:
      "https://www.sec.gov/Archives/edgar/data/793733/000110465926048542/skyw-20260331x10q.htm",
  },
  {
    airline: "UA",
    as_of_date: "2025-12-31",
    scope: "Republic aircraft operated for United",
    metric: "republic_united_total",
    value: "126",
    source_form: "Republic 10-K FY2025",
    source_url:
      "https://www.sec.gov/Archives/edgar/data/810332/000162828026019614/rjet-20251231.htm",
  },
];

interface SubmissionsJson {
  filings?: {
    recent?: {
      accessionNumber?: string[];
      form?: string[];
      filingDate?: string[];
      primaryDocument?: string[];
      items?: string[];
    };
  };
}

/** Pull the watched forms out of a data.sec.gov submissions document. */
export function extractRecentFilings(
  cik: string,
  company: string,
  submissions: SubmissionsJson,
  nowMs: number
): Array<Omit<SecFilingRow, "seen_at">> {
  const recent = submissions.filings?.recent;
  if (!recent?.accessionNumber) return [];
  const cutoff = nowMs - WATCH_WINDOW_DAYS * 86400 * 1000;
  const out: Array<Omit<SecFilingRow, "seen_at">> = [];
  for (let i = 0; i < recent.accessionNumber.length; i++) {
    const form = recent.form?.[i] ?? "";
    if (!WATCHED_FORMS.has(form)) continue;
    if (form === "8-K" && !(recent.items?.[i] ?? "").includes(EARNINGS_8K_ITEM)) continue;
    const filedDate = recent.filingDate?.[i] ?? "";
    if (!filedDate || Date.parse(filedDate) < cutoff) continue;
    const accession = recent.accessionNumber[i];
    const doc = recent.primaryDocument?.[i] ?? "";
    out.push({
      accession,
      cik,
      company,
      form,
      filed_date: filedDate,
      primary_doc_url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}/${doc}`,
    });
  }
  return out;
}

export interface SecAnchorsSyncResult {
  outcome: "success" | "partial" | "error";
  newFilings: number;
  anchors: number;
}

export async function runSecAnchorsSync(
  db: Database,
  fetcher: typeof fetch = fetch
): Promise<SecAnchorsSyncResult> {
  return withSpan(
    "scraper.sec_anchors",
    async (span): Promise<SecAnchorsSyncResult> => {
      span.setTag("job.type", "background");
      const airlineTag = normalizeAirlineTag("UA");
      seedFleetAnchors(db, SEED_ANCHORS);

      let newFilings = 0;
      let failed = 0;
      for (const { cik, company, tag } of SEC_COMPANIES) {
        try {
          // A company's first successful run records its whole back-catalog —
          // only per-filing log/alert once that company has a baseline.
          const hasBaseline =
            (
              db.query("SELECT COUNT(*) AS n FROM sec_filings_seen WHERE cik = ?").get(cik) as {
                n: number;
              }
            ).n > 0;
          const res = await fetcher(`https://data.sec.gov/submissions/CIK${cik}.json`, {
            headers: { "User-Agent": SEC_USER_AGENT, Accept: "application/json" },
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const filings = extractRecentFilings(cik, company, await res.json(), Date.now());
          const fresh = recordSecFilings(db, filings);
          newFilings += fresh.length;
          if (!hasBaseline) continue;
          for (const f of fresh) {
            info(
              `sec-anchors: new ${company} ${f.form} filed ${f.filed_date} — review for updated fleet/Starlink anchors (append to SEED_ANCHORS): ${f.primary_doc_url}`
            );
            metrics.increment(COUNTERS.SEC_FILING_SEEN, {
              company: tag,
              form: f.form.toLowerCase(),
              airline: airlineTag,
            });
          }
        } catch (err) {
          failed++;
          logError(`sec-anchors: ${company} submissions fetch failed`, err);
        }
      }

      const outcome: SecAnchorsSyncResult["outcome"] =
        failed === SEC_COMPANIES.length ? "error" : failed > 0 ? "partial" : "success";
      metrics.increment(COUNTERS.SCRAPER_SYNC, {
        source: "sec_anchors",
        airline: airlineTag,
        status: outcome,
      });
      span.setTag("result", outcome);
      span.setTag("new_filings", newFilings);

      const anchors = getFleetAnchors(db, "UA").length;
      if (newFilings > 0 || outcome !== "success") {
        info(`sec-anchors sync ${outcome}: ${newFilings} new filings, ${anchors} anchors stored`);
      }
      return { outcome, newFilings, anchors };
    },
    { "job.type": "background" }
  );
}

export function startSecAnchorsJob(db: Database): JobHandle {
  return startJob({
    name: "sec_anchors",
    intervalMs: 24 * 3600 * 1000,
    initialDelayMs: 30 * 60 * 1000,
    run: async () => {
      await runSecAnchorsSync(db);
    },
  });
}
