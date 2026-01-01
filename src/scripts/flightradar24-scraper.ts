/**
 * FlightRadar24 Fleet Scraper
 * Exports United Airlines fleet data as a backup/verification source
 */

import type { Browser, Page } from "playwright";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromium.use(StealthPlugin());

// Set browser path to local directory (fallback if not set via env)
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = new URL(
    "../../.playwright-browsers",
    import.meta.url
  ).pathname;
}

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

/**
 * Scrape United Airlines fleet from FlightRadar24
 */
export async function scrapeFlightRadar24Fleet(): Promise<FR24ScrapeResult> {
  const result: FR24ScrapeResult = {
    success: false,
    aircraft: [],
    scrapedAt: new Date().toISOString(),
  };

  let browser: Browser | null = null;
  let page: Page | null = null;

  try {
    console.log("Starting FlightRadar24 fleet scrape...");

    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
      ],
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1920, height: 1080 },
      locale: "en-US",
    });

    page = await context.newPage();

    // Navigate to fleet page
    console.log("Navigating to FlightRadar24...");
    await page.goto("https://www.flightradar24.com/data/airlines/ua-ual/fleet", {
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

    // Wait for fleet table to load
    console.log("Waiting for fleet data...");
    await page.waitForFunction(
      () => document.querySelectorAll('a[href*="/data/aircraft/"]').length > 0,
      { timeout: 15000 }
    );

    // Scroll to load all content
    await page.evaluate(() => window.scrollTo(0, 500));
    await page.waitForTimeout(1000);

    // Check if all aircraft are visible or if we need to expand sections
    let totalExpected = 0;
    try {
      const countText = await page
        .locator("text=/Number of aircraft in fleet:\\s*\\d+/")
        .textContent({ timeout: 3000 });
      const match = countText?.match(/(\d+)/);
      if (match) {
        totalExpected = Number.parseInt(match[1], 10);
        console.log(`Expected fleet size: ${totalExpected}`);
      }
    } catch {
      console.log("Could not determine expected fleet size");
    }

    // Get all visible aircraft - they might already be expanded
    let aircraftCount = await page.locator('a[href*="/data/aircraft/"]').count();
    console.log(`Initially visible aircraft: ${aircraftCount}`);

    // If not all visible, click expand buttons
    if (totalExpected > 0 && aircraftCount < totalExpected) {
      console.log("Expanding aircraft type sections...");

      // Find and click all expand buttons/rows
      const expandableRows = await page.$$("table tbody tr");
      for (const row of expandableRows) {
        const tds = await row.$$("td");
        if (tds.length >= 2) {
          const secondCell = await tds[1].textContent();
          // If second cell is a number, this is a type header row
          if (secondCell && /^\d+$/.test(secondCell.trim())) {
            await row.click();
            await page.waitForTimeout(500);
          }
        }
      }

      await page.waitForTimeout(2000);
      aircraftCount = await page.locator('a[href*="/data/aircraft/"]').count();
      console.log(`After expanding: ${aircraftCount} aircraft`);
    }

    // Extract all aircraft data
    console.log("Extracting aircraft data...");
    const aircraft = await page.evaluate(() => {
      const links = document.querySelectorAll('a[href*="/data/aircraft/"]');
      const results: { registration: string; aircraftType: string }[] = [];
      const seen = new Set<string>();

      for (const link of links) {
        const registration = link.textContent?.trim();
        if (!registration || seen.has(registration)) continue;
        seen.add(registration);

        const row = link.closest("tr");
        const tds = row?.querySelectorAll("td") || [];
        const aircraftType = tds[1]?.textContent?.trim() || "";

        results.push({ registration, aircraftType });
      }

      return results;
    });

    result.aircraft = aircraft;
    result.success = aircraft.length > 0;

    console.log(`Successfully scraped ${aircraft.length} aircraft`);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    console.error("Scrape error:", result.error);
  } finally {
    if (page) await page.close();
    if (browser) await browser.close();
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
