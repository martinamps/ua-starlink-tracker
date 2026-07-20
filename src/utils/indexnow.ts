/**
 * IndexNow pings (Bing-family engines) so changed pages get recrawled fast.
 * Fire-and-forget by design: callers are background jobs whose real work must
 * never fail on an SEO side channel, so this logs errors and returns. Reads
 * INDEXNOW_KEY at call time (like SLACK_WEBHOOK_URL) — unset means disabled;
 * non-production is always disabled so dev/test churn never reaches engines.
 */

import { type AirlineCode, siteForAirline } from "../airlines/registry";
import { COUNTERS, metrics, normalizeAirlineTag } from "../observability/metrics";
import { error as logError } from "./logger";

const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
const DEDUPE_WINDOW_MS = 60 * 60 * 1000;

// Per-URL hourly dedupe: jobs re-run far more often than pages meaningfully
// change, and IndexNow penalizes noisy hosts. Swept lazily on each call.
const lastPingedAt = new Map<string, number>();

export function pingIndexNow(airline: AirlineCode, paths: string[]): void {
  const key = process.env.INDEXNOW_KEY;
  if (!key || process.env.NODE_ENV !== "production") return;
  // Live sites only — a not-yet-launched tenant has no host worth crawling.
  const site = siteForAirline(airline, true);
  if (!site) return;

  const now = Date.now();
  for (const [url, at] of lastPingedAt) {
    if (now - at >= DEDUPE_WINDOW_MS) lastPingedAt.delete(url);
  }
  const urlList = paths
    .map((p) => `https://${site.canonicalHost}${p}`)
    .filter((url) => {
      if (lastPingedAt.has(url)) return false;
      lastPingedAt.set(url, now);
      return true;
    });
  if (urlList.length === 0) return;

  void (async () => {
    const tags = { vendor: "indexnow", type: "ping", airline: normalizeAirlineTag(airline) };
    try {
      const res = await fetch(INDEXNOW_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ host: site.canonicalHost, key, urlList }),
        signal: AbortSignal.timeout(10_000),
      });
      // 200/202 both mean accepted per spec.
      const ok = res.status === 200 || res.status === 202;
      metrics.increment(COUNTERS.VENDOR_REQUEST, {
        ...tags,
        status: ok ? "success" : "error",
        ...(ok ? {} : { http_status: res.status }),
      });
      if (!ok) logError(`indexnow ping rejected: ${res.status} for ${site.canonicalHost}`);
    } catch (err) {
      metrics.increment(COUNTERS.VENDOR_REQUEST, { ...tags, status: "error" });
      logError("indexnow ping failed", err);
    }
  })();
}
