/**
 * Meta-surface coherence: everything a site advertises about itself
 * (sitemap.xml, llms.txt, robots.txt) must be true of that site, and the
 * dispatch wrapper's header/redirect invariants must hold for every route.
 *
 * Coverage derives from SITES × app.routes — a new tenant or route is pinned
 * by construction, no hand-enumerated host lists.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { HOST_REDIRECTS, SITES, type SiteConfig, resolveSite } from "../src/airlines/registry";
import { API_RATE_LIMIT, createApp } from "../src/server/app";
import { mcpReq, openSnapshot, req } from "./helpers";

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  app = createApp(openSnapshot());
});

// Sweeps fetch every advertised URL — with flight permalinks enumerated in
// the sitemap that exceeds the per-IP page budget, so identify as localhost
// (limiter-exempt). Rate-limit tests below use their own non-local IPs.
const get = (path: string, host: string, accept = "text/html") =>
  app.dispatch(req(path, host, { headers: { Accept: accept, "x-forwarded-for": "127.0.0.1" } }));

function extractUrls(text: string): URL[] {
  const matches = text.match(/https?:\/\/[^\s)\]`"'<>]+/g) ?? [];
  return matches.map((m) => new URL(m.replace(/[.,;:!?*]+$/, "")));
}

// Each site's sitemap is asserted by two tests — fetch and parse it once.
const sitemapMemo = new Map<string, Promise<string[]>>();
function sitemapPaths(site: SiteConfig): Promise<string[]> {
  let paths = sitemapMemo.get(site.key);
  if (!paths) {
    paths = (async () => {
      const res = await get("/sitemap.xml", site.canonicalHost);
      expect(res.status).toBe(200);
      const xml = await res.text();
      const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]));
      for (const u of locs) {
        expect(u.host, `${site.key} sitemap lists foreign host ${u.host}`).toBe(site.canonicalHost);
      }
      return locs.map((u) => u.pathname);
    })();
    sitemapMemo.set(site.key, paths);
  }
  return paths;
}

async function robotsDisallows(site: SiteConfig): Promise<string[]> {
  const res = await get("/robots.txt", site.canonicalHost);
  expect(res.status).toBe(200);
  const txt = await res.text();
  return [...txt.matchAll(/^Disallow:\s*(\S+)/gm)].map((m) => m[1]);
}

async function statusOf(urls: Array<{ href: string; path: string; host: string }>) {
  return Promise.all(urls.map(async (u) => ({ ...u, status: (await get(u.path, u.host)).status })));
}

for (const site of Object.values(SITES)) {
  describe(`meta surfaces: ${site.key} (${site.canonicalHost})`, () => {
    test("every sitemap URL serves < 400", async () => {
      const paths = await sitemapPaths(site);
      const results = await statusOf(
        paths.map((path) => ({ href: path, path, host: site.canonicalHost }))
      );
      for (const r of results) {
        expect(r.status, `${site.key} sitemap advertises ${r.href} → ${r.status}`).toBeLessThan(
          400
        );
      }
    });

    test("no sitemap URL is robots-disallowed", async () => {
      const disallows = await robotsDisallows(site);
      for (const path of await sitemapPaths(site)) {
        for (const prefix of disallows) {
          expect(
            path.startsWith(prefix),
            `${site.key} sitemap lists ${path} but robots.txt disallows ${prefix}`
          ).toBe(false);
        }
      }
    });

    test("every sitemap URL answers HEAD < 400 (crawlers pre-fetch with HEAD)", async () => {
      // /mcp regression: the page branch only matched GET+Accept:text/html, so
      // HEAD fell through to the MCP protocol handler's 405 on a
      // sitemap-advertised URL.
      for (const path of await sitemapPaths(site)) {
        const res = await app.dispatch(
          req(path, site.canonicalHost, {
            method: "HEAD",
            headers: { "x-forwarded-for": "127.0.0.1" },
          })
        );
        expect(res.status, `${site.key} HEAD ${path} → ${res.status}`).toBeLessThan(400);
      }
    });

    test("every llms.txt URL on a tracked host serves < 400", async () => {
      const res = await get("/llms.txt", site.canonicalHost);
      expect(res.status).toBe(200);
      // External links (Chrome Web Store, …) aren't ours to pin; anything on
      // a host we serve — including cross-site links from the hub — must work.
      const ours = extractUrls(await res.text()).filter((u) => resolveSite(u.host) !== null);
      expect(ours.length).toBeGreaterThan(0);
      const results = await statusOf(
        ours.map((u) => ({ href: u.href, path: u.pathname + u.search, host: u.host }))
      );
      for (const r of results) {
        expect(r.status, `${site.key} llms.txt advertises ${r.href} → ${r.status}`).toBeLessThan(
          400
        );
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Sitemap shape: flight permalinks are enumerated from real data with honest
// lastmod values, never request-time stamps.
// ─────────────────────────────────────────────────────────────────────────────

describe("sitemap flight permalinks", () => {
  const permalinkSites = Object.values(SITES).filter(
    (s) => s.features.checkFlightPage && s.scope !== "ALL"
  );

  test.each(permalinkSites.map((s) => [s.key, s] as const))(
    "%s: enumerates flight pages beyond the static list",
    async (_key, site) => {
      const paths = await sitemapPaths(site);
      const flights = paths.filter((p) => p.startsWith("/check-flight/"));
      expect(flights.length).toBeGreaterThan(0);
      expect(paths.length).toBeGreaterThan(flights.length); // static pages still present
      for (const p of flights) {
        expect(p).toMatch(new RegExp(`^/check-flight/${site.scope}\\d{1,4}$`));
      }
    }
  );

  test("lastmod derives from data, not the request clock", async () => {
    const site = SITES.united;
    const first = await (await get("/sitemap.xml", site.canonicalHost)).text();
    await new Promise((r) => setTimeout(r, 5));
    const second = await (await get("/sitemap.xml", site.canonicalHost)).text();
    // Date.now() stamping would differ at ms precision between the two fetches.
    expect(second).toBe(first);

    const urls = first.split("<url>").slice(1);
    const now = Date.now();
    for (const block of urls) {
      const stamps = [...block.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1]);
      expect(stamps.length).toBeLessThanOrEqual(1);
      for (const stamp of stamps) {
        const t = Date.parse(stamp);
        expect(Number.isNaN(t)).toBe(false);
        expect(t).toBeLessThanOrEqual(now);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch wrapper: base headers on every response
// ─────────────────────────────────────────────────────────────────────────────

const BASE_HEADERS = [
  "X-Content-Type-Options",
  "X-Frame-Options",
  "Strict-Transport-Security",
  "Referrer-Policy",
  "Content-Security-Policy",
] as const;

function assertBaseHeaders(res: Response, label: string) {
  for (const h of BASE_HEADERS) {
    expect(res.headers.get(h), `${label}: missing ${h}`).toBeTruthy();
  }
}

describe("base security headers on every response", () => {
  for (const site of Object.values(SITES)) {
    test(`${site.key}: all routes carry base headers + Vary: Host`, async () => {
      for (const route of Object.keys(app.routes)) {
        const res = await get(route, site.canonicalHost);
        assertBaseHeaders(res, `${site.key} ${route} (${res.status})`);
        expect(res.headers.get("Vary"), `${site.key} ${route}: Vary`).toContain("Host");
      }
    });
  }

  test("404, 421, favicon, manifest, and static assets carry base headers", async () => {
    const cases: Array<[string, string]> = [
      ["/no-such-page", "unitedstarlinktracker.com"],
      ["/", "evil.example.com"], // 421
      ["/favicon.ico", "unitedstarlinktracker.com"],
      ["/site.webmanifest", "unitedstarlinktracker.com"],
      ["/static/social-image.webp", "unitedstarlinktracker.com"],
    ];
    for (const [path, host] of cases) {
      assertBaseHeaders(await get(path, host), `${path} on ${host}`);
    }
  });

  test("tenant-agnostic social images do not Vary on Host", async () => {
    const res = await get("/static/social-image.webp", "unitedstarlinktracker.com");
    expect(res.status).toBe(200);
    expect(res.headers.get("Vary")).toBeNull();
  });

  test("HTML keeps its page CSP — wrapper never overwrites", async () => {
    const res = await get("/", "unitedstarlinktracker.com");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toContain("script-src");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CORS preflight + MCP CORS
// ─────────────────────────────────────────────────────────────────────────────

describe("CORS preflight", () => {
  const UA = "unitedstarlinktracker.com";
  const options = (path: string, ip?: string) =>
    app.dispatch(
      req(path, UA, { method: "OPTIONS", headers: ip ? { "x-forwarded-for": ip } : {} })
    );

  test("OPTIONS /api/check-flight → 204 with the API CORS contract", async () => {
    const res = await options("/api/check-flight");
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Content-Type");
  });

  test("OPTIONS /mcp → 204 allowing POST + MCP headers", async () => {
    const res = await options("/mcp");
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Mcp-Session-Id");
  });

  test("POST /mcp responses carry Access-Control-Allow-Origin", async () => {
    const res = await app.dispatch(mcpReq(UA, "tools/list", undefined));
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  test("OPTIONS on /api/* counts against the rate-limit budget", async () => {
    const ip = "10.99.0.1"; // unique bucket — doesn't pollute other tests
    let last = 0;
    for (let i = 0; i <= API_RATE_LIMIT; i++) {
      last = (await options("/api/data", ip)).status;
      if (i === 0) expect(last).toBe(204);
    }
    expect(last).toBe(429);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rate limiter coverage: /mcp protocol traffic and check-flight permalinks are
// metered like /api/* (POST /mcp drives live FR24 lookups; permalink SSR runs
// predictions per request). GET /mcp (the HTML setup page) stays unmetered.
// ─────────────────────────────────────────────────────────────────────────────

describe("rate limiter covers /mcp and permalinks", () => {
  const UA = "unitedstarlinktracker.com";

  // Distinct IPs so each flood gets its own limiter bucket.
  const FLOODS: Array<[string, () => Request]> = [
    [
      "POST /mcp",
      () =>
        req("/mcp", UA, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": "10.99.1.1" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
        }),
    ],
    [
      "OPTIONS /mcp",
      () => req("/mcp", UA, { method: "OPTIONS", headers: { "x-forwarded-for": "10.99.1.2" } }),
    ],
    [
      "GET /check-flight/UA1 permalink",
      () => req("/check-flight/UA1", UA, { headers: { "x-forwarded-for": "10.99.1.3" } }),
    ],
  ];

  test.each(FLOODS)("%s: request past the budget from one IP → 429", async (_name, mk) => {
    let last = 0;
    for (let i = 0; i <= API_RATE_LIMIT; i++) {
      last = (await app.dispatch(mk())).status;
      if (i === 0) expect(last).not.toBe(429);
    }
    expect(last).toBe(429);
  });

  test("GET /mcp setup page is NOT metered", async () => {
    for (let i = 0; i <= API_RATE_LIMIT; i++) {
      const res = await get("/mcp", UA);
      expect(res.status).toBe(200);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch last-resort error handling: a deliberately rethrowing handler must
// leave as a finalized 500 (security headers + CORS), never a bare Bun 500.
// ─────────────────────────────────────────────────────────────────────────────

describe("dispatch wraps handler throws", () => {
  test("throwing /api handler → 500 JSON with nosniff + ACAO", async () => {
    const isolated = createApp(openSnapshot());
    isolated.routes["/api/data"] = () => {
      throw new Error("deliberate rethrow");
    };
    const res = await isolated.dispatch(req("/api/data", "unitedstarlinktracker.com"));
    expect(res.status).toBe(500);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await res.json()).toEqual({ error: "internal" });
  });

  test("throwing page handler → 500 without leaking the error", async () => {
    const isolated = createApp(openSnapshot());
    isolated.routes["/fleet"] = () => {
      throw new Error("secret detail");
    };
    const res = await isolated.dispatch(req("/fleet", "unitedstarlinktracker.com"));
    expect(res.status).toBe(500);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const text = await res.text();
    expect(text).not.toContain("secret detail");
    expect(JSON.parse(text)).toEqual({ error: "internal" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Canonical-host redirects
// ─────────────────────────────────────────────────────────────────────────────

describe("host redirects", () => {
  test("www → apex 301 for every site, path + query preserved", async () => {
    for (const site of Object.values(SITES)) {
      const res = await get("/fleet?x=1", `www.${site.canonicalHost}`);
      expect(res.status, `www.${site.canonicalHost}`).toBe(301);
      expect(res.headers.get("Location")).toBe(`https://${site.canonicalHost}/fleet?x=1`);
    }
  });

  test("non-GET on www falls through and serves (301 would downgrade POST → GET)", async () => {
    const www = "www.unitedstarlinktracker.com";
    const post = await app.dispatch(mcpReq(www, "tools/list", undefined));
    expect(post.status).toBe(200);
    expect(((await post.json()) as { result?: unknown }).result).toBeDefined();

    const preflight = await app.dispatch(req("/api/data", www, { method: "OPTIONS" }));
    expect(preflight.status).toBe(204);
  });

  test("www.localhost never redirects to production (dev fallback excluded)", async () => {
    const res = await get("/", "www.localhost");
    expect(res.status).not.toBe(301);
    expect(res.headers.get("Location")).toBeNull();
  });

  test("parked domains 301 even for static asset paths (redirect beats static)", async () => {
    for (const [apex, target] of Object.entries(HOST_REDIRECTS)) {
      for (const host of [apex, `www.${apex}`]) {
        const res = await get("/static/social-image.webp", host);
        expect(res.status, host).toBe(301);
        expect(res.headers.get("Location")).toBe(`${target}/static/social-image.webp`);
      }
    }
  });

  test("static assets still serve on unknown hosts (no 421 for crawler fetches)", async () => {
    const res = await get("/static/social-image.webp", "evil.example.com");
    expect(res.status).toBe(200);
  });
});
