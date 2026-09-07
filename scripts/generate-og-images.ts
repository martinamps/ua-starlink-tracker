/**
 * Renders static/og.html headlessly and saves 1200x630 .webp social cards.
 *
 * Pulls live counts from /api/fleet-summary (or a per-tenant /api/data) so the
 * hero number and rollout curve stay current. Run via `bun run generate-og` or
 * the daily GitHub Action.
 */
import "../src/playwright-env";
import path from "node:path";
import { type Page, chromium } from "playwright";
import { AIRLINES, SITES, siteForAirline } from "../src/airlines/registry";
import { isBulkGid } from "../src/database/database";
import { denominatorIsPublishable, shareCardFile } from "../src/utils/share-cards";

const OG_HTML = path.resolve(import.meta.dir, "../static/og.html");
const OUT_DIR = path.resolve(import.meta.dir, "../static");
const HUB_HOST = SITES.airline.canonicalHost;
const W = 1200;
const H = 630;

export interface Summary {
  airlines: Array<{
    code: string;
    name: string;
    installed: number;
    total: number;
    percentage: number;
  }>;
}
export interface ApiData {
  starlinkPlanes: Array<{ DateFound: string | null; sheet_gid?: string | null }>;
  /** The tenant's own data stamp. A shared PNG outlives its numbers, so every
   * card is stamped with the date the data behind it was last updated. */
  lastUpdated?: string;
}

export interface CardSpec {
  file: string;
  params: URLSearchParams;
  desc: string;
}

/** YYYY-MM-DD for the card stamp; "" when the stamp is missing or unparseable,
 * which renders no date rather than a wrong one. */
export function cardDate(lastUpdated: string | null | undefined): string {
  const t = Date.parse(lastUpdated ?? "");
  return Number.isNaN(t) ? "" : new Date(t).toISOString().slice(0, 10);
}

/** The hub grid asserts every airline's number at once, so the only date for
 * which the whole card is true is the OLDEST of them. */
export function oldestCardDate(stamps: Array<string | null | undefined>): string {
  const days = stamps.map(cardDate).filter(Boolean).sort();
  return days[0] ?? "";
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { Accept: "application/json" },
    });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

/** Cumulative install count over time, downsampled to ~120 points. Bulk-gid
 * rows (seeds, type-rule settles, FlyerTalk backfills) are excluded — they
 * stamp one run date across many tails and would chart a fabricated cliff. */
export function rolloutSeries(planes: ApiData["starlinkPlanes"], nowMs = Date.now()): number[] {
  const dates = planes
    .filter((p) => !isBulkGid(p.sheet_gid))
    .map((p) => p.DateFound)
    .filter((d): d is string => !!d && /^\d{4}-\d{2}-\d{2}/.test(d))
    .sort();
  if (dates.length < 2) return [];
  const start = new Date(dates[0] as string).getTime();
  const end = nowMs;
  const n = Math.min(120, Math.max(2, Math.ceil((end - start) / 86400000)));
  const series: number[] = [];
  let cursor = 0;
  for (let i = 0; i < n; i++) {
    const t = new Date(start + (i / (n - 1)) * (end - start)).toISOString().slice(0, 10);
    while (cursor < dates.length && (dates[cursor] as string) <= t) cursor++;
    series.push(cursor);
  }
  return series;
}

// Share cards ship as PNG (pastes cleanly everywhere users share them), and
// unlike the webp og cards they are committed to git every night — so they
// render at 1x, not the og cards' deviceScaleFactor 2. Measured on the UA card:
// 112KB at 2x vs 39KB at 1x. At ~5 cards a night that is the difference between
// ~200MB and ~70MB of git objects a year, for output already at 1200x630, the
// size social platforms want.
async function renderPng(page: Page, params: URLSearchParams, out: string) {
  await page.goto(`file://${OG_HTML}?${params}`, { waitUntil: "networkidle", timeout: 15000 });
  await Bun.write(out, await page.screenshot({ type: "png" }));
}

async function renderWebp(page: Page, params: URLSearchParams, out: string) {
  await page.goto(`file://${OG_HTML}?${params}`, { waitUntil: "networkidle", timeout: 15000 });
  // Chromium can't screenshot to webp directly; capture PNG then re-encode in-page
  // with canvas.toDataURL('image/webp') — keeps it dependency-free.
  const png = await page.screenshot({ type: "png" });
  const dataUrl = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
  const webpBase64 = await page.evaluate(
    ([url, w, h]) =>
      new Promise<string>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = w as number;
          canvas.height = h as number;
          const ctx = canvas.getContext("2d");
          if (!ctx) return reject(new Error("no 2d ctx"));
          ctx.drawImage(img, 0, 0, w as number, h as number);
          resolve(canvas.toDataURL("image/webp", 0.92).split(",")[1] as string);
        };
        img.onerror = () => reject(new Error("image load failed"));
        img.src = url as string;
      }),
    [dataUrl, W, H] as const
  );
  await Bun.write(out, Buffer.from(webpBase64, "base64"));
}

/**
 * Card derivation: summary → one spec per renderable tenant card, hub card
 * last. The injected getData fetches a tenant's rollout history — it is only
 * called for tenants that pass the skip rules, so the fetch list and the
 * card list cannot drift. No browser; tests pass a stub fetcher.
 */
export async function buildCardSpecs(
  summary: Summary,
  getData: (code: string, host: string) => Promise<ApiData | null>,
  nowMs = Date.now()
): Promise<CardSpec[]> {
  const specs: CardSpec[] = [];
  const stamps: Array<string | undefined> = [];

  // ── per-airline cards ───────────────────────────────────────────────────────
  for (const a of summary.airlines) {
    if (a.installed === 0) continue; // no point in a "0 aircraft" hero number
    const cfg = AIRLINES[a.code];
    const host = siteForAirline(a.code)?.canonicalHost;
    if (!cfg || !host) {
      console.warn(
        `og-images: no ${cfg ? "site" : "registry"} entry for airline ${a.code} — skipping card`
      );
      continue;
    }

    // Sparkline only when the tenant's rollout history resolved — the count
    // alone is still useful.
    const data = await getData(a.code, host);
    const series = data ? rolloutSeries(data.starlinkPlanes, nowMs) : [];
    stamps.push(data?.lastUpdated);

    specs.push({
      file: path.basename(cfg.brand.socialImagePath),
      params: new URLSearchParams({
        layout: "count",
        label: `${cfg.name.toUpperCase()} STARLINK TRACKER`,
        domain: host,
        accent: cfg.brand.accentColor.replace("#", ""),
        count: String(a.installed),
        sub: "AIRCRAFT WITH STARLINK",
        series: series.join(","),
        date: cardDate(data?.lastUpdated),
      }),
      desc: `${a.code} count=${a.installed} sparkline=${series.length > 1}`,
    });
  }

  // ── hub card ────────────────────────────────────────────────────────────────
  const cards = summary.airlines.map((a) => ({
    name: a.name.replace(/ Airlines?$/, "").toUpperCase(),
    pct: Math.round(a.percentage),
    accent: AIRLINES[a.code]?.brand.accentColor.replace("#", "") ?? "0ea5e9",
  }));
  specs.push({
    file: path.basename(SITES.airline.brand.socialImagePath),
    params: new URLSearchParams({
      layout: "grid",
      label: "AIRLINE STARLINK TRACKER",
      domain: HUB_HOST,
      accent: SITES.airline.brand.accentColor.replace("#", ""),
      cards: JSON.stringify(cards),
      caption: "PER-AIRCRAFT STARLINK WIFI STATUS",
      date: oldestCardDate(stamps),
    }),
    desc: cards.map((c) => `${c.name}=${c.pct}%`).join(" "),
  });

  return specs;
}

/**
 * Downloadable share-stat cards, one per renderable tenant plus the hub grid.
 * Same skip rules as the og cards (zero-installed and unregistered airlines
 * never get a card) but a separate spec list: og cards are the social-preview
 * contract, share cards are the user-facing download, and the two may diverge
 * in copy without touching each other.
 */
export function buildShareCardSpecs(
  summary: Summary,
  lastUpdatedOf: (code: string) => string | null | undefined = () => null
): CardSpec[] {
  const specs: CardSpec[] = [];

  for (const a of summary.airlines) {
    if (a.installed === 0) continue;
    const cfg = AIRLINES[a.code];
    const host = siteForAirline(a.code)?.canonicalHost;
    if (!cfg || !host) continue; // buildCardSpecs already warned for these
    specs.push({
      file: shareCardFile(a.code),
      params: new URLSearchParams({
        layout: "count",
        label: `${cfg.name.toUpperCase()} STARLINK TRACKER`,
        domain: host,
        accent: cfg.brand.accentColor.replace("#", ""),
        count: String(a.installed),
        // Same rule as /badge.svg — both hand this ratio to somebody else's
        // page. Publishing "OF 61 AIRCRAFT" here while the badge deliberately
        // withheld it made two surfaces in one branch disagree on one number.
        sub: denominatorIsPublishable(a.installed, a.total, cfg.rollout.rosterIsProgramScope)
          ? `OF ${a.total} AIRCRAFT HAVE STARLINK`
          : "AIRCRAFT WITH STARLINK",
        date: cardDate(lastUpdatedOf(a.code)),
      }),
      desc: `share ${a.code} ${a.installed}/${a.total}`,
    });
  }

  const cards = summary.airlines.map((a) => ({
    name: a.name.replace(/ Airlines?$/, "").toUpperCase(),
    pct: Math.round(a.percentage),
    accent: AIRLINES[a.code]?.brand.accentColor.replace("#", "") ?? "0ea5e9",
  }));
  specs.push({
    file: shareCardFile("ALL"),
    params: new URLSearchParams({
      layout: "grid",
      label: "AIRLINE STARLINK TRACKER",
      domain: HUB_HOST,
      accent: SITES.airline.brand.accentColor.replace("#", ""),
      cards: JSON.stringify(cards),
      caption: "PER-AIRCRAFT STARLINK WIFI STATUS",
      date: oldestCardDate(summary.airlines.map((a) => lastUpdatedOf(a.code))),
    }),
    desc: `share hub ${cards.map((c) => `${c.name}=${c.pct}%`).join(" ")}`,
  });

  return specs;
}

async function main() {
  const summary = await getJson<Summary>(`https://${HUB_HOST}/api/fleet-summary`);
  if (!summary) {
    console.error(`fatal: could not fetch https://${HUB_HOST}/api/fleet-summary`);
    process.exit(1);
  }

  // One fetch pass feeds both spec builders: the og cards need the rollout
  // history, the share cards need the same payload's lastUpdated stamp, and
  // fetching twice would let the two card families date differently.
  const dataByCode = new Map<string, ApiData | null>();
  const specs = await buildCardSpecs(summary, async (code, host) => {
    if (!dataByCode.has(code)) {
      dataByCode.set(code, await getJson<ApiData>(`https://${host}/api/data`));
    }
    return dataByCode.get(code) ?? null;
  });
  specs.push(...buildShareCardSpecs(summary, (code) => dataByCode.get(code)?.lastUpdated));

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const viewport = { width: W, height: H };
  const ogPage = await browser.newPage({ viewport, deviceScaleFactor: 2 });
  const sharePage = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  const generated: string[] = [];
  for (const spec of specs) {
    const out = path.join(OUT_DIR, spec.file);
    if (spec.file.endsWith(".png")) await renderPng(sharePage, spec.params, out);
    else await renderWebp(ogPage, spec.params, out);
    generated.push(`${spec.file}  ${spec.desc}`);
  }

  await browser.close();
  console.log(`Generated ${generated.length} OG images @ ${W}x${H}:\n  ${generated.join("\n  ")}`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
