/**
 * FlightRadar24 Fleet Scraper
 * Exports United Airlines fleet data as a backup/verification source
 */

import type { Browser, Page } from "playwright";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { AIRLINES } from "../airlines/registry";
import { BROWSER_USER_AGENT } from "../utils/constants";

chromium.use(StealthPlugin());

export interface FR24Aircraft {
  registration: string;
  aircraftType: string;
}

export interface FR24ScrapeResult {
  success: boolean;
  aircraft: FR24Aircraft[];
  scrapedAt: string;
  error?: string;
}

export async function launchFR24Browser(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
  });
}

export interface FleetPageRow {
  links: { text: string; href: string }[];
  /** <td> or role="cell" texts; the type sits at index 1 in both layouts. */
  cells: string[];
}

export function parseExpectedFleetSize(pageText: string): number {
  const m = pageText.match(/Number of aircraft(?: in fleet)?:?\s*(\d[\d,]*)/i);
  return m ? Number.parseInt(m[1].replace(/,/g, ""), 10) : -1;
}

const lastSegment = (href: string) =>
  href
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .split("/")
    .pop()
    ?.toLowerCase() ?? "";

/**
 * One aircraft per row. A row links to /data/aircraft/ three ways: the
 * registration (/data/aircraft/n202ha, text "N202HA"), the type
 * (/data/aircraft/a21n, text "Airbus A321-271N") and "History". Only the
 * registration link's text matches its own URL slug, so that identity picks
 * it; reading every link's text as a registration is how the 2026-11-05
 * redesign put "Boeing 757-224" and "History" into united_fleet.
 */
export function parseFleetRows(rows: FleetPageRow[]): FR24Aircraft[] {
  const out: FR24Aircraft[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const reg = row.links.find((l) => l.text && l.text.toLowerCase() === lastSegment(l.href));
    if (!reg || seen.has(reg.text)) continue;
    seen.add(reg.text);
    const typeLink = row.links.find((l) => l.text && lastSegment(l.href) !== lastSegment(reg.href));
    out.push({ registration: reg.text, aircraftType: typeLink?.text ?? row.cells[1] ?? "" });
  }
  return out;
}

/**
 * Scrape an airline's fleet roster from FlightRadar24.
 * Pass `sharedBrowser` when calling sequentially for multiple slugs — repeated
 * chromium.launch() in one process is unreliable under playwright-extra+stealth.
 */
export async function scrapeFlightRadar24Fleet(
  slug = AIRLINES.UA.fr24Slug as string,
  sharedBrowser?: Browser
): Promise<FR24ScrapeResult> {
  const result: FR24ScrapeResult = {
    success: false,
    aircraft: [],
    scrapedAt: new Date().toISOString(),
  };

  let browser: Browser | null = null;
  let page: Page | null = null;
  const ownsBrowser = !sharedBrowser;

  try {
    console.log("Starting FlightRadar24 fleet scrape...");

    browser = sharedBrowser ?? (await launchFR24Browser());

    const context = await browser.newContext({
      userAgent: BROWSER_USER_AGENT,
      viewport: { width: 1920, height: 1080 },
      locale: "en-US",
    });

    page = await context.newPage();

    // Navigate to fleet page
    console.log("Navigating to FlightRadar24...");
    await page.goto(`https://www.flightradar24.com/data/airlines/${slug}/fleet`, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    // Wait for initial load
    await page.waitForTimeout(3000);

    // Handle consent popups - try multiple times
    console.log("Handling consent popups...");
    for (let i = 0; i < 5; i++) {
      try {
        const hasPopup = await page
          .locator('.didomi-popup, [class*="consent"], [class*="cookie"]')
          .isVisible({ timeout: 1000 });
        if (hasPopup) {
          await page.keyboard.press("Escape");
          await page.waitForTimeout(500);
          try {
            await page.click('button:has-text("Save")', { timeout: 1000 });
          } catch {}
          try {
            await page.click('button:has-text("Do not share")', { timeout: 1000 });
          } catch {}
          try {
            await page.click('[aria-label="Close"]', { timeout: 1000 });
          } catch {}
        } else {
          break;
        }
      } catch {
        break;
      }
    }

    await page.waitForTimeout(2000);

    // FR24 can report a 0-aircraft roster (e.g. a regional whose tails are listed
    // under the parent), so accept the fleet-count header as a ready signal too.
    console.log("Waiting for fleet data...");
    await page.waitForFunction(
      () =>
        document.querySelectorAll('a[href*="/data/aircraft/"]').length > 0 ||
        /Number of aircraft/i.test(document.body?.textContent ?? ""),
      undefined,
      { timeout: 15000 }
    );

    // Scroll to load all content
    await page.evaluate(() => window.scrollTo(0, 500));
    await page.waitForTimeout(1000);

    // "Number of aircraft in fleet: 1644" before the 2026-11 redesign,
    // "Number of aircraft1644" after.
    const totalExpected = parseExpectedFleetSize(
      await page.evaluate(() => document.body?.textContent ?? "")
    );
    console.log(`Expected fleet size: ${totalExpected}`);

    // The old table hid each type's tails behind a clickable header row; the
    // redesign renders every row up front, collapsed panels included.
    const visible = await page.locator('a[href*="/data/aircraft/"]').count();
    if (totalExpected > 0 && visible < totalExpected) {
      for (const row of await page.$$("table tbody tr")) {
        const tds = await row.$$("td");
        const secondCell = tds.length >= 2 ? await tds[1].textContent() : null;
        if (secondCell && /^\d+$/.test(secondCell.trim())) {
          await row.click();
          await page.waitForTimeout(500);
        }
      }
      await page.waitForTimeout(2000);
    }

    console.log("Extracting aircraft data...");
    const rows: FleetPageRow[] = await page.evaluate(() =>
      Array.from(document.querySelectorAll('tr, [role="row"]'))
        .map((row) => ({
          links: Array.from(row.querySelectorAll('a[href*="/data/aircraft/"]')).map((a) => ({
            text: a.textContent?.trim() ?? "",
            href: a.getAttribute("href") ?? "",
          })),
          cells: Array.from(row.querySelectorAll('td, [role="cell"]')).map(
            (td) => td.textContent?.trim() ?? ""
          ),
        }))
        .filter((r) => r.links.length > 0)
    );
    const aircraft = parseFleetRows(rows);
    if (totalExpected > 0 && aircraft.length !== totalExpected) {
      console.warn(`FR24 ${slug}: parsed ${aircraft.length} of ${totalExpected} aircraft`);
    }

    result.aircraft = aircraft;
    result.success = aircraft.length > 0 || totalExpected === 0;

    console.log(`Successfully scraped ${aircraft.length} aircraft`);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    console.error("Scrape error:", result.error);
  } finally {
    if (page) await page.close().catch(() => {});
    if (browser && ownsBrowser) await browser.close().catch(() => {});
  }

  return result;
}

/**
 * Get aircraft registrations by type pattern
 */
export function filterByType(aircraft: FR24Aircraft[], typePattern: RegExp): FR24Aircraft[] {
  return aircraft.filter((a) => typePattern.test(a.aircraftType));
}

/**
 * Get E175 aircraft (common Starlink-equipped type)
 */
export function getE175Aircraft(aircraft: FR24Aircraft[]): FR24Aircraft[] {
  return filterByType(aircraft, /E175|ERJ.?175/i);
}

/**
 * Get CRJ-550 aircraft
 */
export function getCRJ550Aircraft(aircraft: FR24Aircraft[]): FR24Aircraft[] {
  return filterByType(aircraft, /CRJ.?550/i);
}

// CLI usage
if (import.meta.main) {
  const args = process.argv.slice(2);
  const outputFile = args[0] || "./tmp/flightradar24-fleet.json";

  scrapeFlightRadar24Fleet()
    .then((result) => {
      if (result.success) {
        const fs = require("node:fs");
        fs.writeFileSync(outputFile, JSON.stringify(result, null, 2));
        console.log(`\nSaved ${result.aircraft.length} aircraft to ${outputFile}`);

        // Summary by type
        const byType: Record<string, number> = {};
        for (const a of result.aircraft) {
          const type = a.aircraftType || "Unknown";
          byType[type] = (byType[type] || 0) + 1;
        }

        console.log("\nFleet by type:");
        const topTypes = Object.entries(byType)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10);
        for (const [type, count] of topTypes) {
          console.log(`  ${type}: ${count}`);
        }

        // E175 summary (likely Starlink candidates)
        const e175 = getE175Aircraft(result.aircraft);
        console.log(`\nE175 variants (potential Starlink): ${e175.length}`);
      } else {
        console.error("Scrape failed:", result.error);
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error("Fatal error:", err);
      process.exit(1);
    });
}
