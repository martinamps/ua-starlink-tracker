/**
 * The MCP Plausible event forwards the caller's address the way clientIp reads
 * it for the rest of the server: Cloudflare's cf-connecting-ip first, since
 * any caller can write x-forwarded-for.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { trackMcpEvent } from "../src/api/mcp-server";
import { clientIp } from "../src/server/client-ip";

const ANALYTICS = {
  scriptSrc: "https://analytics.example/js/script.js",
  dataDomain: "unitedstarlinktracker.com",
  eventApiUrl: "https://analytics.example/api/event",
};

const originalFetch = globalThis.fetch;
const originalEnv = process.env.NODE_ENV;
afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.NODE_ENV = originalEnv;
});

function forwardedFor(headers: Record<string, string>): string | null {
  const sent: Headers[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    sent.push(new Headers(init?.headers));
    return new Response(null, { status: 202 });
  }) as unknown as typeof fetch;
  process.env.NODE_ENV = "production";
  trackMcpEvent(new Request("https://unitedstarlinktracker.com/mcp", { headers }), ANALYTICS, {
    method: "tools/call",
    tool: "check_flight",
  });
  expect(sent.length).toBe(1);
  return sent[0].get("x-forwarded-for");
}

describe("clientIp", () => {
  test("reads cf-connecting-ip, then the first x-forwarded-for entry, then x-real-ip", () => {
    const r = (h: Record<string, string>) => new Request("https://x.test/", { headers: h });
    expect(
      clientIp(r({ "cf-connecting-ip": "198.51.100.1", "x-forwarded-for": "192.0.2.20" }))
    ).toBe("198.51.100.1");
    expect(clientIp(r({ "x-forwarded-for": "192.0.2.20, 10.0.0.1" }))).toBe("192.0.2.20");
    expect(clientIp(r({ "x-real-ip": "192.0.2.40" }))).toBe("192.0.2.40");
    expect(clientIp(r({}))).toBe("unknown");
  });
});

describe("MCP analytics event address", () => {
  test("a caller-set x-forwarded-for does not override Cloudflare's address", () => {
    expect(
      forwardedFor({ "cf-connecting-ip": "198.51.100.1", "x-forwarded-for": "192.0.2.20" })
    ).toBe("198.51.100.1");
  });

  test("without Cloudflare it falls back to the first forwarded entry", () => {
    expect(forwardedFor({ "x-forwarded-for": "192.0.2.20, 10.0.0.1" })).toBe("192.0.2.20");
  });

  test("with no address at all it sends no forwarded header", () => {
    expect(forwardedFor({})).toBeNull();
  });
});

describe("MCP analytics event for the team's own live check", () => {
  test("sends nothing, so a check run is never a visitor", () => {
    let sent = 0;
    globalThis.fetch = (async () => {
      sent++;
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    process.env.NODE_ENV = "production";
    const headers = { "User-Agent": "Mozilla/5.0 Chrome/131.0 ua-starlink-live-check/2 (bot)" };
    trackMcpEvent(new Request("https://unitedstarlinktracker.com/mcp", { headers }), ANALYTICS, {
      method: "tools/call",
      tool: "check_flight",
    });
    expect(sent).toBe(0);
  });
});
