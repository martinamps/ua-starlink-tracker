#!/usr/bin/env bun
/**
 * Warn-only: is the Chrome Web Store serving the version in manifest.json?
 *
 * v2.0.0 sat unpublished for weeks while the store kept serving 1.2.0, and
 * nothing in the repo could see it. This is a manual release step, not a CI
 * gate: it scrapes a Google page whose markup can change, so it always exits 0.
 */

import { join, resolve } from "node:path";

const LISTING_URL =
  "https://chromewebstore.google.com/detail/google-flights-starlink-i/jjfljoifenkfdbldliakmmjhdkbhehoi?hl=en";
const VERSION_RE = /Version<\/div><div[^>]*>([\d.]+)/;

export function parseListingVersion(html: string): string | null {
  return html.match(VERSION_RE)?.[1] ?? null;
}

async function main() {
  if (process.env.CI) {
    console.log("skipped: never runs in CI");
    return;
  }
  const manifestPath = join(resolve(import.meta.dir, ".."), "chrome-extension", "manifest.json");
  const { version: local } = (await Bun.file(manifestPath).json()) as { version: string };

  let html: string;
  try {
    const res = await fetch(LISTING_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/128 Safari/537.36",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err) {
    console.warn(`skipped: could not fetch listing (${err instanceof Error ? err.message : err})`);
    return;
  }

  const published = parseListingVersion(html);
  if (!published) {
    console.warn("skipped: listing fetched but no version found (markup changed?)");
    return;
  }
  if (published === local) {
    console.log(`ok: store serves ${published}, matching manifest.json`);
  } else {
    console.warn(`WARN: store serves ${published}, manifest.json is ${local} — not yet published`);
  }
}

if (import.meta.main) await main();
