/**
 * FR24 browser-routed transport.
 */

import type { Browser, Page } from "playwright";
import { COUNTERS, metrics } from "../observability";
import { BROWSER_USER_AGENT } from "../utils/constants";
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
// Bumped to disown an in-flight launch; a disowned launch must not publish to
// module state or tear it down — it closes whatever it created and bails.
let launchGen = 0;
// Browser an in-flight launch() has spawned but not yet published. Lets the
// launch deadline kill a Chromium whose setup calls never settle, instead of
// leaking one orphaned process per abandoned launch.
let pendingBrowser: Browser | null = null;

// A launch that neither resolves nor rejects would leave `launching` set forever
// and wedge every FR24 caller (19h flight-data outage on 2026-05-20).
const LAUNCH_TIMEOUT_MS = 60_000;

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

// Builds the browser in locals and publishes to module state only once fully
// ready, so a concurrent teardown() can never strand a half-initialized launch.
async function launch(): Promise<Page> {
  const gen = ++launchGen;
  await teardown();
  info("Launching FR24 browser transport...");
  const t0 = Date.now();

  let b: Browser | null = null;
  try {
    const chromium = await getChromium();
    b = await chromium.launch({
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
    if (gen === launchGen) pendingBrowser = b;

    const ctx = await b.newContext({
      userAgent: BROWSER_USER_AGENT,
      locale: "en-US",
      viewport: { width: 1280, height: 720 },
    });
    const pg = await ctx.newPage();
    await pg.goto(BOOTSTRAP_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

    if (gen !== launchGen) throw new Error("launch superseded");

    b.on("disconnected", () => {
      warn("FR24 browser disconnected");
      browser = null;
      page = null;
    });
    browser = b;
    page = pg;
    pendingBrowser = null;

    info(`FR24 browser transport ready in ${Date.now() - t0}ms`);
    metrics.increment(COUNTERS.VENDOR_REQUEST, {
      vendor: "fr24",
      type: "browser_launch",
      status: "success",
    });
    return pg;
  } catch (err) {
    metrics.increment(COUNTERS.VENDOR_REQUEST, {
      vendor: "fr24",
      type: "browser_launch",
      status: "error",
    });
    if (pendingBrowser === b) pendingBrowser = null;
    if (b) await b.close().catch(() => {});
    throw err;
  }
}

async function ensurePage(): Promise<Page> {
  if (isAlive()) return page as Page;
  if (!launching) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        error(`FR24 browser launch exceeded ${LAUNCH_TIMEOUT_MS}ms, abandoning it`);
        launchGen++;
        // Closing the half-built browser also rejects its hung setup calls,
        // letting the abandoned launch promise settle.
        void pendingBrowser?.close().catch(() => {});
        pendingBrowser = null;
        reject(new Error("fr24 browser launch timeout"));
      }, LAUNCH_TIMEOUT_MS);
    });
    launching = Promise.race([launch(), deadline]).finally(() => {
      clearTimeout(timer);
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
    // Likely a dead/navigated/hung page. Tear down so the next call relaunches —
    // unless a relaunch is already underway (teardown would be a no-op anyway).
    if ((consecutiveFailures >= 3 || !isAlive()) && !launching) {
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
