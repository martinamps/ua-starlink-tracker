/**
 * Registry-generated tenant matrix + lint-style guardrail for the
 * "optional tenant, United/hub default" bug class (the og:image leak shape):
 * a missing tenant binding must be a compile error or a fail-closed 404,
 * never another tenant's content.
 *
 * Coverage is derived from SITES × routes, so a newly registered airline is
 * covered by construction — no hand-enumerated host lists.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { getContent } from "../src/airlines/content";
import { AIRLINES, SITES, type SiteConfig, siteForAirline } from "../src/airlines/registry";
import { createApp } from "../src/server/app";
import { jsonOf, openSnapshot, postMcp, req } from "./helpers";

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  app = createApp(openSnapshot());
});

function get(site: SiteConfig, route: string, accept?: string) {
  return app.dispatch(
    req(route, site.canonicalHost, accept ? { headers: { Accept: accept } } : {})
  );
}

// 200-expected JSON endpoints; `get` stays for status/Accept/HTML assertions.
function getJSON(site: SiteConfig, route: string) {
  return jsonOf(app, route, site.canonicalHost);
}

// ─────────────────────────────────────────────────────────────────────────────
// Guardrail: ban the bug-class patterns in src/
// ─────────────────────────────────────────────────────────────────────────────

// UA-default shapes: member access, bracket access, ??-default, ternary
// default (`cond ? "UA" : x`). Deliberately does NOT match comparisons
// (`=== "UA"`, `case "UA":`) or explicit fields (`airline: "UA"`) — asserted
// by the regex self-test below.
const UA_DEFAULT_RE =
  /\bAIRLINES\.UA\b|\bAIRLINES\[["']UA["']\]|\?\?\s*["']UA["']|\?\s*["']UA["']\s*:/;

// Allowlists pin the CURRENT number of matching lines per file: a new
// UA-default in an allowlisted file fails ("count grew"), and removing one
// forces the pin down (ratchet). Every entry needs a reason.
const BANNED_PATTERNS: Array<{
  name: string;
  re: RegExp;
  allowlist: Map<string, number>;
  why: string;
}> = [
  {
    name: 'AIRLINES.UA / "UA"-default',
    re: UA_DEFAULT_RE,
    allowlist: new Map([
      ["src/airlines/registry.ts", 3], // SITES.united derives from AIRLINES.UA (2) + resolveTenant doc comment (1)
      ["src/utils/constants.ts", 1], // extractFlightNumber builds united.com URLs — UA-bound by definition
      ["src/api/mcp-server.ts", 1], // scopeCfg: hub-scope MCP stays UA-bound (phase-2 per-airline threading)
      ["src/scripts/starlink-predictor.ts", 1], // prediction model trained on UA observations only
      ["src/scripts/fleet-sync.ts", 1], // CLI default argument for the UA sync job
      ["src/scripts/flightradar24-scraper.ts", 1], // CLI default slug for the UA scraper
      ["src/scripts/verify-tails.ts", 1], // united.com ground-truth CLI — UA-bound by definition
      ["src/scripts/starlink-verifier.ts", 1], // united.com verifier — UA-bound by definition
      ["src/scripts/sync-ship-numbers.ts", 1], // United mainline ship-number sheet — UA-bound by definition
      ["src/scripts/fleet-discovery.ts", 1], // united.com discovery checker — UA-bound by definition
    ]),
    why:
      "A UA default on a missing tenant/airline is the og:image bug class: the row or response " +
      "silently becomes United's on another tenant's surface. Resolve or pass the airline " +
      "explicitly (fail closed when absent), or add a justified allowlist entry.",
  },
  {
    name: "?? hub content fallback",
    re: /\?\?\s+hub\b/,
    allowlist: new Map<string, number>(),
    why:
      "`?? hub` is the fallback that served hub copy (United/Hawaiian/Alaska FAQ JSON-LD) on " +
      "qatarstarlinktracker.com. Per-airline maps must be exhaustive over the registry " +
      "(Record<KnownAirlineCode, T>) and throw on a miss.",
  },
  {
    name: "UA-bound flight-number shims",
    re: /\b(ensureUAPrefix|normalizeFlightNumber|buildFlightNumberVariants|inferFleet)\b/,
    // The shims were deleted in the class-5 sweep — any reappearance is a regression.
    allowlist: new Map<string, number>(),
    why:
      "These shims hard-bind AIRLINES.UA and launder it past the AIRLINES.UA grep. Use the " +
      "cfg-taking versions in src/airlines/flight-number.ts instead.",
  },
];

function srcFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => path.join(dir, f));
}

describe("guardrail: no optional-tenant United/hub defaults in src/", () => {
  const root = path.join(import.meta.dir, "..");

  test("UA-default regex matches defaults, not comparisons", () => {
    const bad = [
      'cfg ?? "UA"',
      "cfg ?? 'UA'",
      "const cfg = AIRLINES.UA;",
      'AIRLINES["UA"]',
      "AIRLINES['UA']",
      'const code = missing ? "UA" : found;',
    ];
    const good = [
      'scope === "UA"',
      'case "UA":',
      'airline: "UA",',
      'if (code !== "UA") {',
      '"UA" === scope ? a : b',
    ];
    for (const s of bad) expect(UA_DEFAULT_RE.test(s), `should match: ${s}`).toBe(true);
    for (const s of good) expect(UA_DEFAULT_RE.test(s), `should NOT match: ${s}`).toBe(false);
  });

  test("banned patterns appear only in allowlisted files, at pinned counts", () => {
    const violations: string[] = [];
    for (const { name, re, allowlist, why } of BANNED_PATTERNS) {
      const actual = new Map<string, number>();
      for (const file of srcFiles(path.join(root, "src"))) {
        const rel = path.relative(root, file);
        const lines = readFileSync(file, "utf8").split("\n");
        let n = 0;
        lines.forEach((line, i) => {
          if (!re.test(line)) return;
          n++;
          if (!allowlist.has(rel)) {
            violations.push(`[${name}] ${rel}:${i + 1}: ${line.trim()}\n  ${why}`);
          }
        });
        if (n > 0) actual.set(rel, n);
      }
      for (const [rel, expected] of allowlist) {
        const n = actual.get(rel) ?? 0;
        if (n !== expected) {
          violations.push(
            `[${name}] ${rel}: pinned ${expected} matching line(s), found ${n}. ` +
              (n > expected
                ? `A new occurrence crept in — fix it instead of bumping the pin.\n  ${why}`
                : "Occurrences were removed — lower the pin to ratchet.")
          );
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  test("every registered airline has homepage content (no hub fallback)", () => {
    const hub = getContent("ALL");
    for (const cfg of Object.values(AIRLINES)) {
      const content = getContent(cfg);
      expect(content, `getContent(${cfg.code}) returned hub content`).not.toBe(hub);
      expect(content.faq.length).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SITES × routes matrix
// ─────────────────────────────────────────────────────────────────────────────

// feature === null → always on. HTML-ness is derived from the route shape.
const ROUTES: Array<[route: string, feature: keyof SiteConfig["features"] | null]> = [
  ["/", null],
  ["/llms.txt", null],
  ["/api/data", null],
  ["/check-flight", "checkFlightPage"],
  ["/route-planner", "routePlannerPage"],
  ["/fleet", "fleetPage"],
  ["/mcp", "mcpPage"],
];
const isHtmlRoute = (route: string) => !route.startsWith("/api/") && !route.endsWith(".txt");

// Editorially deliberate cross-airline mentions (2024 AS/HA merger FAQ copy).
// Covers the airline's name AND canonical host. Anything else is a leak.
const ALLOWED_CROSS_MENTIONS: Record<string, string[]> = {
  alaska: ["HA"],
  hawaiian: ["AS"],
};

function foreignAirlines(site: SiteConfig) {
  const allowed = ALLOWED_CROSS_MENTIONS[site.key] ?? [];
  return Object.values(AIRLINES).filter((a) => a.code !== site.scope && !allowed.includes(a.code));
}

// Canary strings are full airline names + canonical hosts: every brand/content
// leak so far (og:image, hub FAQ JSON-LD) carried them. Bare short names are
// deliberately NOT canaries — shared aircraft-spec fun facts legitimately say
// "on Alaska in 2024" on any tenant's fleet page.
function assertNoForeignTenant(site: SiteConfig, route: string, body: string) {
  for (const other of foreignAirlines(site)) {
    expect(body, `${site.key} ${route} leaks "${other.name}"`).not.toContain(other.name);
    const otherHost = siteForAirline(other.code)?.canonicalHost;
    expect(otherHost, `no site registered for airline ${other.code}`).toBeDefined();
    expect(body, `${site.key} ${route} links ${otherHost}`).not.toContain(otherHost as string);
  }
}

function assertOwnBranding(site: SiteConfig, route: string, body: string) {
  const host = site.canonicalHost;
  expect(body, `${site.key} ${route}: og:image host`).toContain(
    `property="og:image" content="https://${host}/`
  );
  expect(body, `${site.key} ${route}: canonical host`).toContain(
    `<link rel="canonical" href="https://${host}`
  );
  // WebSite JSON-LD url (and og:url) resolve from the same {{host}} var.
  expect(body, `${site.key} ${route}: JSON-LD url`).toContain(`"url":"https://${host}/"`);
}

for (const site of Object.values(SITES)) {
  describe(`tenant matrix: ${site.key} (${site.canonicalHost})`, () => {
    for (const [route, feature] of ROUTES) {
      const enabled = feature === null || site.features[feature];
      const label = feature ? ` (${feature} ${enabled ? "on" : "off"})` : "";
      test(`GET ${route} → ${enabled ? 200 : 404}${label}`, async () => {
        const res = await get(site, route, "text/html");
        expect(res.status).toBe(enabled ? 200 : 404);
        if (!enabled) return;
        const body = await res.text();
        if (isHtmlRoute(route)) assertOwnBranding(site, route, body);
        // Canary sweep: airline-scoped sites must never carry another
        // tenant's branding. The hub legitimately names all public airlines.
        if (site.scope !== "ALL" && (isHtmlRoute(route) || route === "/llms.txt")) {
          assertNoForeignTenant(site, route, body);
        }
      });
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Hub APIs: detection over United-default
// ─────────────────────────────────────────────────────────────────────────────

describe("hub /api/check-flight + /api/predict-flight detect the airline", () => {
  const hub = SITES.airline;

  test("HA flight on hub resolves to Hawaiian, not United", async () => {
    const d = await getJSON(hub, "/api/check-flight?flight_number=HA9999&date=2026-03-22");
    expect(d.airline).toBe("Hawaiian Airlines");
    expect(JSON.stringify(d)).not.toContain("United");
  });

  test("UA flight on hub keeps the contract shape plus airline", async () => {
    const d = await getJSON(hub, "/api/check-flight?flight_number=UA4421&date=2026-03-22");
    expect(typeof d.hasStarlink === "boolean" || d.hasStarlink === null).toBe(true);
    expect(Array.isArray(d.flights)).toBe(true);
    expect(d.airline).toBe("United Airlines");
  });

  test("undetectable carrier fails closed (404), never United", async () => {
    for (const route of [
      "/api/check-flight?flight_number=DL123&date=2026-03-22",
      "/api/predict-flight?flight_number=DL123",
    ]) {
      const res = await get(hub, route);
      expect(res.status, route).toBe(404);
      expect(await res.text()).not.toContain("United");
    }
  });

  test("hub /api/predict-flight scopes the prediction to the detected airline", async () => {
    const d = await getJSON(hub, "/api/predict-flight?flight_number=UA4680");
    expect(d.flight_number).toBe("UA4680");
    expect(typeof d.probability).toBe("number");
  });

  test("airline host /api/check-flight shape is unchanged (no airline field)", async () => {
    const d = await getJSON(SITES.united, "/api/check-flight?flight_number=UA4421&date=2026-03-22");
    expect(d.airline).toBeUndefined();
    expect(Array.isArray(d.flights)).toBe(true);
  });

  test("hub MCP get_fleet_stats is a per-airline breakdown, not United's", async () => {
    const j = await postMcp(app, SITES.airline.canonicalHost, "tools/call", {
      name: "get_fleet_stats",
      arguments: {},
    });
    const text = j.result.content[0].text as string;
    expect(text).not.toContain("United Airlines Starlink Installation Progress");
    for (const a of Object.values(AIRLINES).filter((x) => x.enabled && x.publicInHub)) {
      expect(text, `hub fleet stats missing ${a.name}`).toContain(a.name);
    }
  });

  test("hub detection uses marketing codes only — shared regional prefixes fail closed", async () => {
    // OO/SKW fly for several marketing carriers; OO3400 could be Alaska
    // SkyWest, so the hub must not answer it as United.
    for (const fn of ["OO3400", "SKW3400"]) {
      const res = await get(hub, `/api/check-flight?flight_number=${fn}&date=2026-03-22`);
      expect(res.status, fn).toBe(404);
      expect(await res.text()).not.toContain("United");
    }
    // Marketing IATA/ICAO codes still detect.
    for (const [fn, airline] of [
      ["UA123", "United Airlines"],
      ["UAL123", "United Airlines"],
      ["HA50", "Hawaiian Airlines"],
    ] as const) {
      const d = await getJSON(hub, `/api/check-flight?flight_number=${fn}&date=2026-03-22`);
      expect(d.airline, fn).toBe(airline);
    }
  });

  test("hub /api/predict-flight on a split-phase airline returns the type split, never a number", async () => {
    const d = await getJSON(hub, "/api/predict-flight?flight_number=HA9999");
    // Never model output (no method/n_observations) and never a blended
    // probability — HA's program spans confirmed (A330/A321) and negative (717).
    expect(d.method).toBeUndefined();
    expect(d.n_observations).toBeUndefined();
    expect(d.probability).toBeUndefined();
    expect(d.confidence).toBe("type");
    expect(d.message).toContain("A330");
    expect(d.message).toContain("717");
  });

  test("hub /api/check-flight on an AS flight with no schedule answers from the registry (deliberate wire change)", async () => {
    // The UA-host /api/check-flight shape is the Chrome-extension contract,
    // tenant-pinned elsewhere — this change only affects model-less carriers.
    const d = await getJSON(hub, "/api/check-flight?flight_number=AS9999&date=2026-03-22");
    expect(d.hasStarlink).toBeNull();
    expect(d.flights).toEqual([]);
    expect(d.confidence).toBe("type");
    expect(d.airline).toBe("Alaska Airlines");
    expect(typeof d.message).toBe("string");
    expect(d.message).not.toContain("United");
  });

  test("hub /api/data pins fleetStats: null (deliberate wire change)", async () => {
    // Pre-Set-C the hub served UA's subfleet stats masquerading as the hub's.
    // null is the honest shape — no cross-airline subfleet aggregate exists.
    // We accept the break for hub /api/data consumers.
    const d = await getJSON(hub, "/api/data");
    expect(d.fleetStats).toBeNull();
    expect(Array.isArray(d.starlinkPlanes)).toBe(true);
    expect(d.starlinkPlanes.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-scope MCP: every tool answers under the tenant's own carrier — bare
// flight numbers normalize to the tenant's IATA code, prose comes from the
// config, and the UA-trained prediction model never leaks onto other scopes.
// ─────────────────────────────────────────────────────────────────────────────

function expectNoUaLeak(text: string, label: string) {
  expect(text, `${label}: United literal`).not.toContain("United");
  expect(text, `${label}: united.com link`).not.toContain("united.com");
  expect(text, `${label}: UA flight number`).not.toMatch(/\bUA\d/);
}

describe("MCP tools are scope-correct on non-UA tenants", () => {
  const nonUaSites = [SITES.alaska, SITES.hawaiian, SITES.qatar];
  // Route the tenant plausibly serves — HA's pair exercises its routeTypeRule.
  const ROUTE_FOR: Record<string, { origin: string; destination: string }> = {
    alaska: { origin: "SEA", destination: "JFK" },
    hawaiian: { origin: "HNL", destination: "LAX" },
    qatar: { origin: "DOH", destination: "LHR" },
  };

  // Exact predict branch per scope. Split-phase carriers (HA, QR) must NEVER
  // show a blended number; AS850 quotes the registry penetrationOverride, so
  // the pinned value is registry-driven, not snapshot-data-driven.
  const PREDICT_PIN: Record<
    string,
    | { flight: string; branch: "split"; groups: string[] }
    | { flight: string; branch: "number"; probability: number; mentions: string }
  > = {
    alaska: { flight: "850", branch: "number", probability: 1, mentions: "Hawaiian-operated" },
    hawaiian: { flight: "1", branch: "split", groups: ["A330", "717"] },
    qatar: { flight: "1", branch: "split", groups: ["777", "787"] },
  };

  test("tools/list: same tool names as UA, zero United literals", async () => {
    const ua = await postMcp(app, SITES.united.canonicalHost, "tools/list", {});
    const uaNames = ua.result.tools.map((t: { name: string }) => t.name).sort();
    for (const site of nonUaSites) {
      const j = await postMcp(app, site.canonicalHost, "tools/list", {});
      expect(
        j.result.tools.map((t: { name: string }) => t.name).sort(),
        `${site.key} tool names drifted from UA's`
      ).toEqual(uaNames);
      expect(JSON.stringify(j.result), `${site.key} tools/list mentions United`).not.toContain(
        "United"
      );
    }
  });

  for (const site of nonUaSites) {
    const cfg = AIRLINES[site.scope as string];
    const call = async (name: string, args: Record<string, unknown>) => {
      const j = await postMcp(app, site.canonicalHost, "tools/call", { name, arguments: args });
      return j.result.content[0].text as string;
    };

    describe(`${site.key} (${cfg.iata})`, () => {
      test("check_flight('1') answers about the tenant's flight, not UA1", async () => {
        const t = await call("check_flight", { flight_number: "1", date: "2026-03-22" });
        expect(t).toContain(`${cfg.iata}1`);
        expectNoUaLeak(t, `${site.key} check_flight`);
      });

      test("predict_flight_starlink('1'): registry-driven answer, no UA priors", async () => {
        const t = await call("predict_flight_starlink", { flight_number: "1" });
        expectNoUaLeak(t, `${site.key} predict_flight`);
        // UA-model fingerprints must not appear on other scopes.
        expect(t).not.toContain("fleet prior");
        expect(t).not.toContain("obs ·");
      });

      test("REST /api/predict-flight agrees with MCP predict (same registry answer)", async () => {
        const d = await getJSON(site, "/api/predict-flight?flight_number=1");
        const t = await call("predict_flight_starlink", { flight_number: "1" });
        // Never model output on either surface; MCP renders the same prose.
        expect(d.method).toBeUndefined();
        expect(d.n_observations).toBeUndefined();
        expect(typeof d.message).toBe("string");
        expect(t, `${site.key}: MCP text drifted from REST message`).toContain(d.message);
      });

      const pin = PREDICT_PIN[site.key];
      test(`predict pins the ${pin.branch} branch exactly`, async () => {
        const d = await getJSON(site, `/api/predict-flight?flight_number=${pin.flight}`);
        const t = await call("predict_flight_starlink", { flight_number: pin.flight });
        if (pin.branch === "split") {
          expect(d.probability, `${site.key}: split must not carry a number`).toBeUndefined();
          expect(t).not.toMatch(/~\d+% Starlink probability/);
          for (const g of pin.groups) {
            expect(d.message, `${site.key} REST names ${g}`).toContain(g);
            expect(t, `${site.key} MCP names ${g}`).toContain(g);
          }
        } else {
          expect(d.probability).toBe(pin.probability);
          expect(d.message).toContain(pin.mentions);
          expect(t).toContain(`~${(pin.probability * 100).toFixed(0)}% Starlink probability`);
          expect(t).toContain(pin.mentions);
        }
      });

      for (const tool of ["plan_starlink_itinerary", "predict_route_starlink"] as const) {
        test(`${tool}: registry route answer, never the UA planner`, async () => {
          const t = await call(tool, ROUTE_FOR[site.key]);
          expect(t).toContain(cfg.name);
          expectNoUaLeak(t, `${site.key} ${tool}`);
        });
      }

      test("search_starlink_flights: scoped data, no United branding", async () => {
        const t = await call("search_starlink_flights", { origin: ROUTE_FOR[site.key].origin });
        expectNoUaLeak(t, `${site.key} search`);
      });

      test("list_starlink_aircraft: tenant-labeled header", async () => {
        const t = await call("list_starlink_aircraft", {});
        expect(t).toContain(cfg.name);
        expectNoUaLeak(t, `${site.key} list_aircraft`);
      });

      test("get_fleet_stats: tenant-branded", async () => {
        const t = await call("get_fleet_stats", {});
        expect(t).toContain(cfg.name);
        expectNoUaLeak(t, `${site.key} fleet_stats`);
      });
    });
  }

  test("HA routeTypeRule drives the HNL→LAX answer (not the UA planner)", async () => {
    const j = await postMcp(app, SITES.hawaiian.canonicalHost, "tools/call", {
      name: "plan_starlink_itinerary",
      arguments: { origin: "HNL", destination: "LAX" },
    });
    const t = j.result.content[0].text as string;
    expect(t).toContain("A330");
    expect(t).toContain("~100% Starlink");
  });
});
