/**
 * No visitor address or raw user agent leaves for Datadog. Spans carry the
 * bounded client_class word the request metric already carries; the tracer is
 * told not to collect client IPs or map headers to tags whatever the
 * environment says; and the log lines a request can write (app.log ships)
 * hold neither. A trace or log that carries one again fails here.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { TRACER_OPTIONS, tracer } from "../src/observability/tracer";
import { API_RATE_LIMIT, createApp } from "../src/server/app";
import { LOG_DIR } from "../src/utils/logger";
import { openSnapshot, req } from "./helpers";

const UA_HOST = "unitedstarlinktracker.com";
const HUB_HOST = "airlinestarlinktracker.com";
// Documentation ranges (RFC 5737 / RFC 3849): never a real visitor.
const VISITOR_V4 = "203.0.113.77";
const VISITOR_V6 = "2001:db8:5a1e::77";
const FORWARDED_V4 = "198.51.100.23";
const VISITOR_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36 VisitorMarker/9.9";
const SECRETS = [VISITOR_V4, VISITOR_V6, FORWARDED_V4, VISITOR_UA, "VisitorMarker"];

const app = createApp(openSnapshot());

type Captured = { name: string; tags: Record<string, unknown> };

let restore: Array<() => void> = [];
afterEach(() => {
  for (const r of restore) r();
  restore = [];
});

/** Swap the live tracer's trace() for one that records every tag set on a span. */
function captureSpans(): Captured[] {
  const spans: Captured[] = [];
  const spy = spyOn(tracer, "trace").mockImplementation(((
    name: string,
    fn: (s: unknown) => unknown
  ) => {
    const tags: Record<string, unknown> = {};
    spans.push({ name, tags });
    const span = {
      addTags(t: Record<string, unknown>) {
        Object.assign(tags, t);
      },
      setTag(k: string, v: unknown) {
        tags[k] = v;
      },
      context: () => null,
    };
    return fn(span);
  }) as typeof tracer.trace);
  restore.push(() => spy.mockRestore());
  return spans;
}

/** Everything a request writes to the console or app.log while `fn` runs. */
async function captureLogs(fn: () => Promise<void>): Promise<string> {
  const logPath = path.join(LOG_DIR, "app.log");
  const sizeOf = () => {
    try {
      return statSync(logPath).size;
    } catch {
      return 0;
    }
  };
  const before = sizeOf();
  const lines: string[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const spy = spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
    restore.push(() => spy.mockRestore());
  }
  await fn();
  const written = sizeOf() > before ? readFileSync(logPath).subarray(before).toString("utf8") : "";
  return `${written}\n${lines.join("\n")}`;
}

function leaks(haystack: string): string[] {
  return SECRETS.filter((s) => haystack.includes(s));
}

const visitorHeaders = (ip: string) => ({
  "cf-connecting-ip": ip,
  "x-forwarded-for": `${FORWARDED_V4}, 10.0.0.1`,
  "x-real-ip": FORWARDED_V4,
  "user-agent": VISITOR_UA,
});

const today = new Date().toISOString().slice(0, 10);
const REQUESTS: Array<[string, string, RequestInit?]> = [
  ["/", UA_HOST],
  ["/fleet", UA_HOST],
  [`/api/check-flight?flight_number=UA123&date=${today}`, UA_HOST],
  [`/api/check-any-flight?flight_number=HA50&date=${today}`, HUB_HOST],
  ["/api/data", UA_HOST],
  ["/no-such-page", UA_HOST],
  ["/api/passenger-probe", UA_HOST, { method: "POST", body: "{}" }],
  [
    "/mcp",
    UA_HOST,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    },
  ],
];

describe("tracer settings", () => {
  test("client-IP collection is off and no header becomes a tag", () => {
    expect(TRACER_OPTIONS.clientIpEnabled).toBe(false);
    expect(TRACER_OPTIONS.headerTags).toEqual([]);
  });
});

describe("request spans", () => {
  for (const ip of [VISITOR_V4, VISITOR_V6]) {
    test(`carry the visitor class, never the address or user agent (${ip.includes(":") ? "v6" : "v4"})`, async () => {
      const spans = captureSpans();
      for (const [p, host, init] of REQUESTS) {
        const extra = (init?.headers ?? {}) as Record<string, string>;
        const res = await app.dispatch(
          req(p, host, { ...init, headers: { ...visitorHeaders(ip), ...extra } })
        );
        await res.arrayBuffer();
      }
      const web = spans.filter((s) => s.name === "web.request");
      expect(web.length).toBe(REQUESTS.length);
      for (const s of web) {
        expect(typeof s.tags.client_class).toBe("string");
        expect(s.tags["http.client_ip"]).toBeUndefined();
        expect(s.tags["http.useragent"]).toBeUndefined();
      }
      expect(leaks(JSON.stringify(spans))).toEqual([]);
    });
  }
});

describe("log lines", () => {
  test("a rate-limited burst logs bounded tags, not the caller", async () => {
    const out = await captureLogs(async () => {
      let limited = 0;
      for (let i = 0; i <= API_RATE_LIMIT + 1; i++) {
        const res = await app.dispatch(
          req("/api/no-such-endpoint", UA_HOST, { headers: visitorHeaders("203.0.113.199") })
        );
        await res.arrayBuffer();
        if (res.status === 429) limited++;
      }
      expect(limited).toBeGreaterThan(0);
    });
    expect(out).toContain("rate limited");
    expect([...leaks(out), "203.0.113.199"].filter((s) => out.includes(s))).toEqual([]);
  });

  test("ordinary requests log neither address nor user agent", async () => {
    const out = await captureLogs(async () => {
      for (const [p, host, init] of REQUESTS) {
        const extra = (init?.headers ?? {}) as Record<string, string>;
        const res = await app.dispatch(
          req(p, host, { ...init, headers: { ...visitorHeaders(VISITOR_V4), ...extra } })
        );
        await res.arrayBuffer();
      }
    });
    expect(leaks(out)).toEqual([]);
  });
});
