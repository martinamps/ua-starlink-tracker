/**
 * Request-level instrumentation: metric coverage, crawler classification, and
 * the 404/HEAD contracts.
 *
 * Three defects this pins:
 *  - HTTP_REQUEST was gated on a matched route, so any path matching no route
 *    emitted no metric at all. Measured in production: 163 counted 404s against
 *    880 real ones, ~82% invisible to every metric-backed dashboard.
 *  - classifyUserAgent collapsed every crawler into one `bot` bucket, so a
 *    Bingbot surge that was ~40% of all traffic could not be seen in metrics.
 *  - 404s carried no Cache-Control, so retiring a large URL space sent every
 *    repeat crawler 404 to origin.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { classifyUserAgent, metrics } from "../src/observability/metrics";
import { createApp } from "../src/server/app";
import { openSnapshot, req } from "./helpers";

const UA = "unitedstarlinktracker.com";
const app = createApp(openSnapshot());

/** metrics is a plain object literal, so it can be spied without a prod seam. */
function captureIncrements(): { calls: Array<{ name: string; tags: Record<string, unknown> }> } {
  const calls: Array<{ name: string; tags: Record<string, unknown> }> = [];
  const original = metrics.increment;
  metrics.increment = (name, tags) => {
    calls.push({ name, tags: (tags ?? {}) as Record<string, unknown> });
    original(name, tags);
  };
  restore = () => {
    metrics.increment = original;
  };
  return { calls };
}
let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("classifyUserAgent", () => {
  test("splits the named crawlers instead of collapsing them to `bot`", () => {
    const cases: Array<[string, string]> = [
      ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "googlebot"],
      ["Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)", "bingbot"],
      ["Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)", "gptbot"],
      ["Mozilla/5.0 (compatible; PerplexityBot/1.0)", "perplexity"],
      ["Mozilla/5.0 (compatible; AhrefsBot/7.0)", "seo-crawler"],
      ["facebookexternalhit/1.1", "social"],
      ["Mozilla/5.0 (compatible; ClaudeBot/1.0)", "claude"],
    ];
    for (const [ua, want] of cases) {
      expect(classifyUserAgent(ua), ua).toBe(want);
    }
  });

  test("GoogleOther is not misread as Googlebot", () => {
    expect(classifyUserAgent("Mozilla/5.0 (compatible; GoogleOther)")).toBe("googleother");
    expect(classifyUserAgent("Mozilla/5.0 (compatible; Google-Extended)")).toBe("googleother");
  });

  test("existing buckets still resolve", () => {
    expect(classifyUserAgent("UA-Starlink-Extension/1.4.0")).toBe("extension");
    expect(classifyUserAgent("curl/8.4.0")).toBe("bot");
    expect(classifyUserAgent("Mozilla/5.0 (Macintosh) AppleWebKit/537 Chrome/120")).toBe("browser");
    expect(classifyUserAgent(null)).toBe("unknown");
    expect(classifyUserAgent("")).toBe("unknown");
  });

  test("stays a bounded enum — no raw UA ever becomes a tag", () => {
    const allowed = new Set([
      "claude",
      "googleother",
      "googlebot",
      "bingbot",
      "gptbot",
      "perplexity",
      "seo-crawler",
      "social",
      "extension",
      "bot",
      "browser",
      "unknown",
    ]);
    for (const ua of [
      "totally made up agent",
      "<script>alert(1)</script>",
      "Mozilla/5.0 (compatible; SomeNewBot/9.9)",
      "x".repeat(500),
    ]) {
      expect(allowed.has(classifyUserAgent(ua)), ua).toBe(true);
    }
  });

  test("the metrics.ts cardinality budget lists every bucket the classifier emits", async () => {
    // The budget header is the stated billing control, so it has to be true:
    // it claimed 5 client classes while the named-crawler split shipped 12,
    // understating the http.request series count by ~2.4x.
    const src = await Bun.file(
      join(import.meta.dir, "..", "src", "observability", "metrics.ts")
    ).text();
    const lines = src.split(" */")[0].split("\n");
    const start = lines.findIndex((l) => l.startsWith(" *   client_class:"));
    expect(start).toBeGreaterThan(-1);
    const end = lines.findIndex((l, i) => i > start && /^ \* {3}\w+:/.test(l));
    const documented = lines.slice(start, end === -1 ? undefined : end).join("\n");
    for (const bucket of [
      "extension",
      "claude",
      "googleother",
      "googlebot",
      "bingbot",
      "gptbot",
      "perplexity",
      "seo-crawler",
      "social",
      "bot",
      "browser",
      "unknown",
    ]) {
      expect(documented, bucket).toContain(bucket);
    }
  });
});

describe("http.request metric coverage", () => {
  const httpCalls = (calls: Array<{ name: string; tags: Record<string, unknown> }>) =>
    calls.filter((c) => c.name === "http.request");

  test("an unmatched path emits the metric, tagged route:unmatched", async () => {
    const { calls } = captureIncrements();
    await app.dispatch(req("/definitely-not-a-route-xyz", UA));
    const http = httpCalls(calls);
    expect(http.length).toBe(1);
    expect(http[0].tags.route).toBe("unmatched");
    expect(http[0].tags.status_code).toBe(404);
  });

  test("a matched path still reports its own route, not the unmatched bucket", async () => {
    const { calls } = captureIncrements();
    await app.dispatch(req("/api/data", UA));
    const http = httpCalls(calls);
    expect(http.length).toBe(1);
    expect(http[0].tags.route).toBe("/api/data");
    expect(http[0].tags.status_code).toBe(200);
  });

  test("no route tag value contains '*' — Datadog strips it and merges series", async () => {
    const { calls } = captureIncrements();
    for (const p of ["/", "/api/data", "/definitely-not-a-route-xyz", "/static/og.webp"]) {
      await app.dispatch(req(p, UA));
    }
    const routes = httpCalls(calls).map((c) => String(c.tags.route));
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) expect(r, r).not.toContain("*");
  });

  test("the crawler bucket reaches the metric tags", async () => {
    const { calls } = captureIncrements();
    await app.dispatch(
      req("/definitely-not-a-route-xyz", UA, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; bingbot/2.0)" },
      })
    );
    expect(httpCalls(calls)[0].tags.client_class).toBe("bingbot");
  });
});

describe("404 responses", () => {
  const get = (path: string) => app.dispatch(req(path, UA, { headers: { Accept: "text/html" } }));

  test("an unmatched path 404s and is edge-cacheable but not browser-cacheable", async () => {
    const res = await get("/definitely-not-a-route-xyz");
    expect(res.status).toBe(404);
    const cc = res.headers.get("cache-control") ?? "";
    // Shared caches absorb the repeat crawl...
    expect(cc).toContain("s-maxage=");
    expect(cc).toContain("public");
    // ...but a browser revalidates, so a path that starts existing is not stuck.
    expect(cc).toContain("max-age=0");
  });

  test("200 HTML is still never edge-cached (renders vary by client IP)", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});

describe("HEAD is allowed wherever GET is", () => {
  const head = (path: string) => app.dispatch(req(path, UA, { method: "HEAD" }));

  test("/api/* accepts HEAD instead of 405ing", async () => {
    for (const path of ["/api/data", "/api/fleet-summary"]) {
      const res = await head(path);
      expect(res.status, path).not.toBe(405);
    }
  });

  test("a genuinely unsupported method still 405s", async () => {
    const res = await app.dispatch(req("/api/data", UA, { method: "DELETE" }));
    expect(res.status).toBe(405);
  });
});
