#!/usr/bin/env bun
/**
 * Generate per-tenant favicons (A4f-3: plane top-left chasing a satellite
 * top-right around a progress arc). The SVG is the source of truth;
 * Playwright rasterizes 16/32/180/192/512px PNGs per tenant.
 *
 *   bun run build-favicons
 *
 * Outputs to static/favicons/{code}.svg + {code}-{size}.png. The hub site
 * uses 'hub' as its code with the cross-airline accent.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { AIRLINES, HUB_BRAND } from "../src/airlines/registry";

const OUT = path.join(import.meta.dir, "..", "static", "favicons");

// A4f-3 geometry: plane at 310°, satellite at 40°, contrail 60°→310° clockwise.
const PLANE_A = 310;
const SAT_A = 40;
const TRAIL_A = 60;
const R = 21;

const PLANE =
  "M12 2 L13.2 8 L21 12.5 L21 14.5 L13.2 12.5 L13.6 18 L16 20 L16 21.5 L12 20.5 L8 21.5 L8 20 L10.4 18 L10.8 12.5 L3 14.5 L3 12.5 L10.8 8 Z";

const rad = (a: number) => ((a - 90) * Math.PI) / 180;
const pt = (a: number, r = R, cx = 32, cy = 32): [number, number] => [
  cx + r * Math.cos(rad(a)),
  cy + r * Math.sin(rad(a)),
];

function arc(a0: number, a1: number, r = R, cx = 32, cy = 32): string {
  const [x0, y0] = pt(a0, r, cx, cy);
  const [x1, y1] = pt(a1, r, cx, cy);
  const da = (((a1 - a0) % 360) + 360) % 360;
  const large = da > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/** Full A4f-3 on a dark tile — for apple-touch-icon and ≥48px contexts. */
export function tileSvg(accent: string): string {
  const [px, py] = pt(PLANE_A);
  const [sx, sy] = pt(SAT_A);
  const heading = PLANE_A + 90;
  return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <rect width="64" height="64" rx="13" fill="#0a0f1a"/>
  <circle cx="32" cy="32" r="${R}" fill="none" stroke="#1d2536" stroke-width="5"/>
  <path d="${arc(TRAIL_A, PLANE_A)}" fill="none" stroke="${accent}" stroke-width="5" stroke-linecap="round" style="filter:drop-shadow(0 0 3px ${accent}b0)"/>
  <g transform="translate(${sx.toFixed(1)} ${sy.toFixed(1)}) rotate(${SAT_A})">
    <circle r="6.5" fill="${accent}" opacity="0.22"/>
    <rect x="-6" y="-1.6" width="3.8" height="3.2" fill="#f3f6fb" opacity="0.92"/>
    <rect x="2.2" y="-1.6" width="3.8" height="3.2" fill="#f3f6fb" opacity="0.92"/>
    <rect x="-2" y="-2" width="4" height="4" fill="#f3f6fb" transform="rotate(45)"/>
  </g>
  <g transform="translate(${px.toFixed(1)} ${py.toFixed(1)}) rotate(${heading}) scale(0.82) translate(-12 -12)">
    <path d="${PLANE}" fill="#f3f6fb"/>
  </g>
</svg>`;
}

/** Tab favicon — transparent, chunky, holds at 16px. Same plane→satellite
 * story but the satellite reduces to a bright dot and the plane has a dark
 * outline so it reads on both light and dark tab bars. */
export function tabSvg(accent: string): string {
  const r = 24;
  const [px, py] = pt(PLANE_A, r);
  const [sx, sy] = pt(SAT_A, r);
  const heading = PLANE_A + 90;
  return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <path d="${arc(SAT_A + 12, TRAIL_A - 8, r)}" fill="none" stroke="${accent}" stroke-width="9" stroke-linecap="round" opacity="0.22"/>
  <path d="${arc(TRAIL_A, PLANE_A, r)}" fill="none" stroke="${accent}" stroke-width="9" stroke-linecap="round"/>
  <circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="5.5" fill="${accent}"/>
  <circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="2.5" fill="#fff"/>
  <g transform="translate(${px.toFixed(1)} ${py.toFixed(1)}) rotate(${heading}) scale(1.15) translate(-12 -12)">
    <path d="${PLANE}" fill="#fff" stroke="${accent}" stroke-width="2.2" stroke-linejoin="round"/>
  </g>
</svg>`;
}

interface Tenant {
  code: string;
  accent: string;
}

function tenants(): Tenant[] {
  const out: Tenant[] = [{ code: "hub", accent: HUB_BRAND.faviconAccent ?? HUB_BRAND.accentColor }];
  for (const cfg of Object.values(AIRLINES)) {
    out.push({
      code: cfg.code.toLowerCase(),
      accent: cfg.brand.faviconAccent ?? cfg.brand.accentColor,
    });
  }
  return out;
}

// 16/32px → tab mode (transparent, chunky); ≥180px → tile mode (dark bg, full detail).
const RASTER_PLAN: { size: number; svg: (a: string) => string; transparent: boolean }[] = [
  { size: 16, svg: tabSvg, transparent: true },
  { size: 32, svg: tabSvg, transparent: true },
  { size: 180, svg: tileSvg, transparent: false },
  { size: 192, svg: tileSvg, transparent: false },
  { size: 512, svg: tileSvg, transparent: false },
];

async function main() {
  await mkdir(OUT, { recursive: true });
  const list = tenants();

  for (const t of list) {
    await writeFile(path.join(OUT, `${t.code}.svg`), tabSvg(t.accent));
    await writeFile(path.join(OUT, `${t.code}-tile.svg`), tileSvg(t.accent));
  }
  console.log(`Wrote ${list.length}×2 SVGs to static/favicons/`);

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    for (const t of list) {
      for (const { size, svg, transparent } of RASTER_PLAN) {
        const markup = svg(t.accent).replace("<svg ", `<svg width="${size}" height="${size}" `);
        await page.setViewportSize({ width: size, height: size });
        await page.setContent(
          `<!doctype html><body style="margin:0;background:transparent">${markup}</body>`,
          { waitUntil: "load" }
        );
        await page.screenshot({
          path: path.join(OUT, `${t.code}-${size}.png`),
          omitBackground: transparent,
          clip: { x: 0, y: 0, width: size, height: size },
        });
      }
      console.log(`  ${t.code}: ${RASTER_PLAN.map((p) => p.size).join("/")}px`);
    }
  } finally {
    await browser.close();
  }
  console.log("Done.");
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
