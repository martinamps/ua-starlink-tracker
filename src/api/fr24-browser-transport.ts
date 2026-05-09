/**
 * FR24 browser-routed transport.
 */

import type { Browser, Page } from "playwright";
import { COUNTERS, metrics } from "../observability";
import { error, info, warn } from "../utils/logger";

type ChromiumLauncher = typeof import("playwright-extra")["chromium"];
let chromiumLauncher: ChromiumLauncher | null = null;

async function getChromium(): Promise<ChromiumLauncher> {
  if (!chromiumLauncher) {
    const { chromium } = await import("playwright-extra");
    const { default: StealthPlugin } = await import("puppeteer-extra-plugin-stealth");
    chromium.use(StealthPlugin());
    chromiumLauncher = chromium;
  }
  return chromiumLauncher;
}

const FR24_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Bootstrap to a same-origin URL so subsequent fetch() calls are same-origin —
// no CORS dependency, plausible Referer. Cheap (~1KB) since the tail is fake.
const BOOTSTRAP_URL =
  "https://api.flightradar24.com/common/v1/flight/list.json?query=ZZZZZ&fetchBy=reg&page=1&limit=1";

// Module-scope singleton — multiple FlightRadar24API instances share one browser,
// matching the existing module-scope rate-limit clock.
let browser: Browser | null = null;
let page: Page | null = null;
let launching: Promise<Page> | null = null;
let consecutiveFailures = 0;

export interface FR24FetchResult {
  status: number;
  ok: boolean;
  body: string;
}

function isAlive(): boolean {
  return !!browser?.isConnected() && !!page && !page.isClosed();
}

async function teardown(): Promise<void> {
  const b = browser;
  browser = null;
  page = null;
  if (b) {
    b.removeAllListeners("disconnected");
    await b.close().catch(() => {});
  }
}

async function launch(): Promise<Page> {
  await teardown();
  info("Launching FR24 browser transport...");
  const t0 = Date.now();

  try {
    const chromium = await getChromium();
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
        // Trim resource use — we only ever fetch JSON.
        "--disable-gpu",
        "--disable-extensions",
        "--mute-audio",
        "--no-first-run",
        "--js-flags=--max-old-space-size=128",
      ],
    });

    browser.on("disconnected", () => {
      warn("FR24 browser disconnected");
      browser = null;
      page = null;
    });

    const ctx = await browser.newContext({
      userAgent: FR24_USER_AGENT,
      locale: "en-US",
      viewport: { width: 1280, height: 720 },
    });
    page = await ctx.newPage();

    await page.goto(BOOTSTRAP_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

    info(`FR24 browser transport ready in ${Date.now() - t0}ms`);
    metrics.increment(COUNTERS.VENDOR_REQUEST, {
      vendor: "fr24",
      type: "browser_launch",
      status: "success",
    });
    return page;
  } catch (err) {
    metrics.increment(COUNTERS.VENDOR_REQUEST, {
      vendor: "fr24",
      type: "browser_launch",
      status: "error",
    });
    await teardown();
    throw err;
  }
}

async function ensurePage(): Promise<Page> {
  if (isAlive()) return page as Page;
  if (!launching) {
    launching = launch().finally(() => {
      launching = null;
    });
  }
  return launching;
}

/**
 * Fetch a URL via the headless browser's network stack. Returns the response
 * status and body text. Throws on browser/protocol failures (caller's existing
 * retry-with-backoff handles those).
 */
export async function fr24Fetch(url: string, timeoutMs = 15000): Promise<FR24FetchResult> {
  const p = await ensurePage();

  // page.evaluate has no built-in timeout — race it so a hung renderer
  // can't wedge the flight-updater loop indefinitely.
  const evalPromise = p.evaluate(
    async ([u, tmo]) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), tmo as number);
      try {
        const r = await fetch(u as string, {
          headers: { Accept: "application/json" },
          signal: ctrl.signal,
        });
        return { status: r.status, ok: r.ok, body: await r.text() };
      } finally {
        clearTimeout(timer);
      }
    },
    [url, timeoutMs] as const
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("fr24 browser evaluate timeout")), timeoutMs + 5000);
  });

  try {
    const result = await Promise.race([evalPromise, guard]);
    consecutiveFailures = 0;
    return result;
  } catch (err) {
    consecutiveFailures++;
    // Likely a dead/navigated/hung page. Tear down so the next call relaunches.
    if (consecutiveFailures >= 3 || !isAlive()) {
      error("FR24 browser transport unhealthy, tearing down", err);
      metrics.increment(COUNTERS.VENDOR_REQUEST, {
        vendor: "fr24",
        type: "browser_launch",
        status: "relaunch",
      });
      await teardown();
      consecutiveFailures = 0;
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Graceful shutdown — call on process exit. */
export async function closeFR24Transport(): Promise<void> {
  await teardown();
}
