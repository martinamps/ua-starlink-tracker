import fs from "node:fs";
import path from "node:path";
import type { Browser, Page } from "playwright";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { LOG_DIR, info, warn } from "../utils/logger";

// Add stealth plugin to avoid detection
chromium.use(StealthPlugin());

// Raw HTML debug output directory
const RAW_LOG_DIR = path.join(LOG_DIR, "raw");

export interface StarlinkCheckResult {
  hasStarlink: boolean;
  tailNumber: string | null;
  aircraftType: string | null;
  wifiProvider: string | null;
  flightNumber: string;
  date: string;
  origin: string;
  destination: string;
  error?: string;
  debugFile?: string;
}

/**
 * Save HTML debug output for later analysis
 */
function saveDebugHtml(
  tailNumber: string,
  flightNumber: string,
  html: string,
  bodyText: string
): string {
  try {
    if (!fs.existsSync(RAW_LOG_DIR)) {
      fs.mkdirSync(RAW_LOG_DIR, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${tailNumber}-${flightNumber}-${timestamp}.html`;
    const filepath = path.join(RAW_LOG_DIR, filename);

    // Add debug info header to the HTML
    const debugHtml = `<!--
DEBUG INFO
==========
Tail: ${tailNumber}
Flight: ${flightNumber}
Timestamp: ${new Date().toISOString()}

BODY TEXT EXTRACT:
${bodyText.slice(0, 2000)}
-->
${html}`;

    fs.writeFileSync(filepath, debugHtml);
    return filepath;
  } catch (err) {
    warn("Failed to save debug HTML", err);
    return "";
  }
}

export async function checkStarlinkStatus(
  flightNumber: string,
  date: string, // YYYY-MM-DD
  origin: string,
  destination: string
): Promise<StarlinkCheckResult> {
  const result: StarlinkCheckResult = {
    hasStarlink: false,
    tailNumber: null,
    aircraftType: null,
    wifiProvider: null,
    flightNumber,
    date,
    origin,
    destination,
  };

  let browser: Browser | null = null;
  let page: Page | null = null;

  try {
    browser = await chromium.launch({
      headless: true,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
      ],
    });

    // Create context with realistic settings
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1920, height: 1080 },
      locale: "en-US",
      timezoneId: "America/Chicago",
    });

    page = await context.newPage();

    // Set extra headers
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      Connection: "keep-alive",
      "Upgrade-Insecure-Requests": "1",
    });

    const url = `https://www.united.com/en/us/flightstatus/details/${flightNumber}/${date}/${origin}/${destination}/UA`;
    info(`Fetching: ${url}`);

    // Navigate with a longer timeout
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // Wait for the page to load - look for aircraft details or error message
    try {
      await page.waitForSelector('[class*="Aircraft"], [class*="error"], .atm-c-alert', {
        timeout: 15000,
      });
    } catch {
      // Continue anyway, page might have loaded differently
    }

    // Scroll to load amenities section and wait for dynamic content
    await page.evaluate(() => window.scrollTo(0, 1000));
    await page.waitForTimeout(2000);

    // Try to expand inflight amenities if collapsed
    try {
      const amenitiesBtn = await page.locator("text=Inflight amenities").first();
      if (await amenitiesBtn.isVisible()) {
        await amenitiesBtn.click({ timeout: 3000 });
        await page.waitForTimeout(1000);
      }
    } catch {
      // Amenities might already be expanded or not present
    }

    // Check if flight was found
    const pageContent = await page.content();
    if (pageContent.includes("We couldn't find") || pageContent.includes("No flights found")) {
      result.error = "No upcoming flights available";
      // Save debug HTML for analysis
      const bodyText = await page.evaluate(() => document.body.innerText);
      result.debugFile = saveDebugHtml("unknown", flightNumber, pageContent, bodyText);
      return result;
    }

    // Extract data from the page
    const data = await page.evaluate(() => {
      // Check for Starlink component
      const starlinkComponent = document.querySelector('[class*="Starlink"]');
      const hasStarlinkComponent = starlinkComponent !== null;

      // Check for WiFi provider text in page
      const bodyText = document.body.innerText;
      const hasStarlinkText =
        bodyText.includes("Internet by Starlink") || bodyText.includes("Starlink");
      const hasPanasonicText =
        bodyText.includes("Internet by Panasonic") || bodyText.includes("by Panasonic");
      const hasViasatText =
        bodyText.includes("Internet by Viasat") || bodyText.includes("by Viasat");
      const hasGogoText = bodyText.includes("by Gogo") || bodyText.includes("Gogo Wi-Fi");

      // Check for no WiFi
      const hasNoWifi =
        bodyText.includes("Wi-Fi\n\nNot offered") || bodyText.includes("Wi-Fi: Not offered");

      // Determine WiFi provider
      let wifiProvider: string | null = null;
      if (hasStarlinkText || hasStarlinkComponent) {
        wifiProvider = "Starlink";
      } else if (hasPanasonicText) {
        wifiProvider = "Panasonic";
      } else if (hasViasatText) {
        wifiProvider = "Viasat";
      } else if (hasGogoText) {
        wifiProvider = "Gogo";
      } else if (hasNoWifi) {
        wifiProvider = "None";
      }

      // Extract tail number - look for pattern like "#N164SY" or "#3991"
      let tailNumber: string | null = null;
      const tailMatch = bodyText.match(/\|\s*#([A-Z0-9]+)/);
      if (tailMatch) {
        const extracted = tailMatch[1];
        // If it's just digits, it might be a ship number, prefix with N
        tailNumber = extracted.match(/^\d+$/) ? `N${extracted}` : extracted;
        // Ensure it starts with N for US registration
        if (!tailNumber.startsWith("N")) {
          tailNumber = `N${tailNumber}`;
        }
      }

      // Extract aircraft type from the "Aircraft details" section
      let aircraftType: string | null = null;
      // Look for patterns like "Boeing 787-9", "Embraer E-175", "Airbus A320"
      const typePatterns = [
        /Boeing \d{3}-\d+/i,
        /Embraer E-?\d+/i,
        /Airbus A\d+/i,
        /Boeing \d{3}/i,
      ];
      for (const pattern of typePatterns) {
        const match = bodyText.match(pattern);
        if (match) {
          aircraftType = match[0];
          break;
        }
      }

      return {
        hasStarlink: hasStarlinkComponent || hasStarlinkText,
        tailNumber,
        aircraftType,
        wifiProvider,
        bodyText,
      };
    });

    result.hasStarlink = data.hasStarlink;
    result.tailNumber = data.tailNumber;
    result.aircraftType = data.aircraftType;
    result.wifiProvider = data.wifiProvider;

    if (!data.wifiProvider || (!data.hasStarlink && !data.wifiProvider)) {
      result.debugFile = saveDebugHtml(
        data.tailNumber || "unknown",
        flightNumber,
        pageContent,
        data.bodyText
      );
    }

    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  } finally {
    try {
      if (page) {
        await page.close();
        await new Promise((r) => setTimeout(r, 100));
      }
    } catch {}
    try {
      if (browser) {
        await browser.close();
        await new Promise((r) => setTimeout(r, 100));
      }
    } catch {}
  }
}

// CLI usage: bun run src/api/united-starlink-checker.ts <flightNumber> <date> <origin> <destination>
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length < 4) {
    console.log(
      "Usage: bun run src/api/united-starlink-checker.ts <flightNumber> <date> <origin> <destination>"
    );
    console.log("Example: bun run src/api/united-starlink-checker.ts 4680 2026-01-01 AUS DEN");
    process.exit(1);
  }

  const [flightNumber, date, origin, destination] = args;
  checkStarlinkStatus(flightNumber, date, origin, destination)
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.error ? 1 : 0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
