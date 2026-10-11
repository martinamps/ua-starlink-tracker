/**
 * Extension traffic classification. The extension's service worker fetches
 * with the stock Chrome user agent, so `client_class:extension` was never
 * emitted in production: every extension lookup landed in `browser`. v2.0.1
 * tags its requests with `client=ext-<version>`; the extension's own Origin
 * is the fallback for builds that predate the tag.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  classifyMcpClient,
  classifyRequest,
  metrics,
  normalizeExtVersion,
  requestClientTags,
} from "../src/observability/metrics";
import { API_RATE_LIMIT, EXTENSION_RATE_LIMIT, createApp } from "../src/server/app";
import { createLogThrottle } from "../src/utils/log-throttle";
import { openSnapshot, req } from "./helpers";

const UA_HOST = "unitedstarlinktracker.com";
const OWN_ORIGIN = "chrome-extension://jjfljoifenkfdbldliakmmjhdkbhehoi";
const CHROME_UA = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/128 Safari/537.36";

const app = createApp(openSnapshot());

function request(query: string, headers: Record<string, string> = {}) {
  const url = new URL(`https://${UA_HOST}/api/check-flight?${query}`);
  return { req: new Request(url, { headers: { "User-Agent": CHROME_UA, ...headers } }), url };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

function captureIncrements() {
  const calls: Array<{ name: string; tags: Record<string, unknown> }> = [];
  const original = metrics.increment;
  metrics.increment = (name, tags) => {
    calls.push({ name, tags: (tags ?? {}) as Record<string, unknown> });
    original(name, tags);
  };
  restore = () => {
    metrics.increment = original;
  };
  return calls;
}

describe("classifyRequest", () => {
  test("the client param marks extension traffic despite a browser UA", () => {
    const { req: r, url } = request("flight_number=UA1&date=2026-06-01&client=ext-2.0.1");
    expect(classifyRequest(r, url)).toBe("extension");
  });

  test("the extension's own origin counts, a foreign extension's does not", () => {
    const own = request("flight_number=UA1&date=2026-06-01", { Origin: OWN_ORIGIN });
    expect(classifyRequest(own.req, own.url)).toBe("extension");
    for (const origin of [
      "chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh",
      "moz-extension://1234-5678",
      "safari-web-extension://abcd",
    ]) {
      const foreign = request("flight_number=UA1&date=2026-06-01", { Origin: origin });
      expect(classifyRequest(foreign.req, foreign.url), origin).toBe("other-extension");
    }
  });

  test("a junk client value falls through to the user agent", () => {
    for (const client of ["foo", "ext-", "ext-2.0", "ext-2.0.1.4", "ext-999.0.0"]) {
      const { req: r, url } = request(`flight_number=UA1&date=2026-06-01&client=${client}`);
      expect(classifyRequest(r, url), client).toBe("browser");
    }
  });
});

describe("normalizeExtVersion", () => {
  test("buckets into a fixed enum", () => {
    expect(normalizeExtVersion(null)).toBe("none");
    expect(normalizeExtVersion("ext-1.2.0")).toBe("1.x");
    expect(normalizeExtVersion("ext-2.0.1")).toBe("2.0");
    // 2.1 (first leg-scoped build) gets its own bucket; later 2.x share one.
    expect(normalizeExtVersion("ext-2.1.0")).toBe("2.1");
    expect(normalizeExtVersion("ext-2.3.0")).toBe("2.x");
    expect(normalizeExtVersion("ext-3.0.0")).toBe("other");
    expect(normalizeExtVersion("<script>")).toBe("other");
  });

  test("ext_version rides along only on extension traffic", () => {
    const ext = request("flight_number=UA1&date=2026-06-01&client=ext-2.0.1");
    expect(requestClientTags(ext.req, ext.url)).toEqual({
      client_class: "extension",
      ext_version: "2.0",
    });
    const legacy = request("flight_number=UA1&date=2026-06-01", { Origin: OWN_ORIGIN });
    expect(requestClientTags(legacy.req, legacy.url).ext_version).toBe("none");
    const web = request("flight_number=UA1&date=2026-06-01");
    expect(requestClientTags(web.req, web.url)).toEqual({ client_class: "browser" });
  });
});

describe("/api/check-flight with the client tag", () => {
  const path = "/api/check-flight?flight_number=UA1234&date=2024-01-15";

  test("the response shape and CORS are unchanged by the param", async () => {
    const plain = await app.dispatch(req(path, UA_HOST));
    const tagged = await app.dispatch(req(`${path}&client=ext-2.0.1`, UA_HOST));
    expect(tagged.status).toBe(plain.status);
    expect(tagged.headers.get("access-control-allow-origin")).toBe("*");
    const [a, b] = [await plain.json(), await tagged.json()];
    expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
    expect(typeof b.hasStarlink === "boolean" || b.hasStarlink === null).toBe(true);
    expect(Array.isArray(b.flights)).toBe(true);
  });

  test("the request metric carries the extension class and version", async () => {
    const calls = captureIncrements();
    await app.dispatch(
      req(`${path}&client=ext-2.0.1`, UA_HOST, { headers: { "User-Agent": CHROME_UA } })
    );
    const http = calls.filter((c) => c.name === "http.request");
    expect(http.length).toBe(1);
    expect(http[0].tags.client_class).toBe("extension");
    expect(http[0].tags.ext_version).toBe("2.0");
  });

  test("website traffic gets no ext_version tag", async () => {
    const calls = captureIncrements();
    await app.dispatch(req(path, UA_HOST, { headers: { "User-Agent": CHROME_UA } }));
    const http = calls.filter((c) => c.name === "http.request");
    expect(http[0].tags.client_class).toBe("browser");
    expect("ext_version" in http[0].tags).toBe(false);
  });
});

describe("classifyMcpClient", () => {
  test("names the major MCP clients from their user agents", () => {
    const cases: Array<[string | null, string]> = [
      ["Claude-User", "claude"],
      ["claude-code/2.1.278 (cli)", "claude"],
      ["Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Claude/2.9939.4 Chrome/152.0", "claude"],
      ["openai-mcp/1.0.0 (Codex)", "chatgpt"],
      ["Cursor/3.21.18 (darwin arm64)", "cursor"],
      ["AgentIndexBot/0.1 (+https://agents.traderszone.net)", "bot"],
      ["node", "other"],
      [null, "unknown"],
    ];
    for (const [ua, bucket] of cases) expect(classifyMcpClient(ua), String(ua)).toBe(bucket);
  });

  test("tool-call metrics carry the client class", async () => {
    const calls = captureIncrements();
    await app.dispatch(
      req("/mcp", UA_HOST, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "Claude-User" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "get_fleet_stats", arguments: {} },
        }),
      })
    );
    const tool = calls.filter((c) => c.name === "mcp.tool_call");
    expect(tool.length).toBe(1);
    expect(tool[0].tags.client_class).toBe("claude");
  });
});

describe("createLogThrottle", () => {
  test("one line per key per interval, carrying the suppressed count", () => {
    const allow = createLogThrottle(1000);
    expect(allow("a", 0)).toBe(0);
    expect(allow("a", 10)).toBeNull();
    expect(allow("a", 20)).toBeNull();
    expect(allow("b", 20)).toBe(0);
    expect(allow("a", 1000)).toBe(2);
  });
});

describe("rate-limited responses", () => {
  test("the 429 metric carries bounded client tags, never the IP", async () => {
    const limited = createApp(openSnapshot());
    const calls = captureIncrements();
    const headers = { "User-Agent": CHROME_UA, "cf-connecting-ip": "203.0.113.9" };
    let last: Response | null = null;
    for (let i = 0; i <= EXTENSION_RATE_LIMIT; i++) {
      last = await limited.dispatch(
        req("/api/check-flight?client=ext-2.1.1", UA_HOST, { headers })
      );
    }
    expect(last?.status).toBe(429);
    const rl = calls.filter((c) => c.name === "http.rate_limited");
    expect(rl.length).toBe(1);
    expect(rl[0].tags).toMatchObject({
      route: "/api/check-flight",
      bucket: "ext",
      client_class: "extension",
      ext_version: "2.1",
      airline: "united",
    });
    expect(Object.values(rl[0].tags)).not.toContain("203.0.113.9");
  });

  test("our extension gets its own larger bucket; everyone else keeps the shared one", async () => {
    const limited = createApp(openSnapshot());
    const flood = async (headers: Record<string, string>, n: number) => {
      const statuses: number[] = [];
      for (let i = 0; i < n; i++) {
        const res = await limited.dispatch(req("/api/check-flight", UA_HOST, { headers }));
        statuses.push(res.status);
      }
      return statuses;
    };

    const ext = await flood(
      { Origin: OWN_ORIGIN, "cf-connecting-ip": "203.0.113.20" },
      EXTENSION_RATE_LIMIT + 1
    );
    expect(ext.slice(0, EXTENSION_RATE_LIMIT)).not.toContain(429);
    expect(ext[EXTENSION_RATE_LIMIT]).toBe(429);

    const web = await flood({ "cf-connecting-ip": "203.0.113.21" }, API_RATE_LIMIT + 1);
    expect(web.slice(0, API_RATE_LIMIT)).not.toContain(429);
    expect(web[API_RATE_LIMIT]).toBe(429);

    const copycat = await flood(
      {
        Origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
        "cf-connecting-ip": "203.0.113.22",
      },
      API_RATE_LIMIT + 1
    );
    expect(copycat[API_RATE_LIMIT]).toBe(429);
  });
});
