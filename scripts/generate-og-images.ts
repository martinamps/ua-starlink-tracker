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
}

export interface CardSpec {
  file: string;
  params: URLSearchParams;
  desc: string;
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
    }),
    desc: cards.map((c) => `${c.name}=${c.pct}%`).join(" "),
  });

  return specs;
}

async function main() {
  const summary = await getJson<Summary>(`https://${HUB_HOST}/api/fleet-summary`);
  if (!summary) {
    console.error(`fatal: could not fetch https://${HUB_HOST}/api/fleet-summary`);
    process.exit(1);
  }

  const specs = await buildCardSpecs(summary, (_code, host) =>
    getJson<ApiData>(`https://${host}/api/data`)
  );

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
  const generated: string[] = [];
  for (const spec of specs) {
    await renderWebp(page, spec.params, path.join(OUT_DIR, spec.file));
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
