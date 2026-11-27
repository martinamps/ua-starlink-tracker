/**
 * The `market` word on the request counter: home | abroad | unknown, against
 * the site's home market. The country comes from Cloudflare's cf-ipcountry,
 * which only counts on a request that came through Cloudflare. A forged,
 * odd or missing value is `unknown`; a caller who skips Cloudflare can't pose
 * as home; and neither the country nor any address leaves in a tag.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { AIRLINES, SITES, enabledAirlines, homeMarketCountries } from "../src/airlines/registry";
import { classifyMarket, metrics } from "../src/observability/metrics";
import { createApp } from "../src/server/app";
import { type SocketPeer, cameThroughCloudflare } from "../src/server/client-ip";
import { openSnapshot, req } from "./helpers";

const UA_HOST = "unitedstarlinktracker.com";
const AS_HOST = "alaskastarlinktracker.com";
const HUB_HOST = "airlinestarlinktracker.com";
const CHROME_UA = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/128 Safari/537.36";
// Cloudflare edge addresses (inside its published ranges), and documentation
// ranges (RFC 5737 / RFC 3849) for everyone else.
const CF_EDGE_V4 = "172.68.10.20";
const CF_EDGE_V6 = "2606:4700:10::ac43:1";
const VISITOR_V4 = "203.0.113.77";
const VISITOR_V6 = "2001:db8:5a1e::77";
const PROXY_PEER = "172.18.0.5";

const US = new Set(["US"]);
const app = createApp(openSnapshot());

function peer(address: string | null): SocketPeer {
  return { requestIP: () => (address === null ? null : { address }) };
}

function plain(headers: Record<string, string>): Request {
  return new Request("http://x/", { headers });
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

describe("home market per site, from the airline registry", () => {
  test("every airline's register names at least one two-letter country", () => {
    for (const airline of Object.values(AIRLINES)) {
      expect(airline.registerCountries.length, airline.code).toBeGreaterThan(0);
      for (const c of airline.registerCountries) expect(c, airline.code).toMatch(/^[A-Z]{2}$/);
    }
  });

  test("the US sites are US, Qatar is QA, the hub is every enabled airline's", () => {
    expect([...homeMarketCountries(SITES.united.scope)]).toEqual(["US"]);
    expect([...homeMarketCountries(SITES.alaska.scope)]).toEqual(["US"]);
    expect([...homeMarketCountries(SITES.hawaiian.scope)]).toEqual(["US"]);
    expect([...homeMarketCountries(SITES.qatar.scope)]).toEqual(["QA"]);
    const hub = homeMarketCountries("ALL");
    for (const a of enabledAirlines()) {
      for (const c of a.registerCountries) expect(hub.has(c), `${a.code} ${c}`).toBe(true);
    }
    expect(hub.has("BR")).toBe(false);
  });

  test("an unknown scope has no home", () => {
    expect(homeMarketCountries("ZZ").size).toBe(0);
  });
});

describe("classifyMarket", () => {
  test("home, abroad, and unknown without Cloudflare", () => {
    expect(classifyMarket("US", US, true)).toBe("home");
    expect(classifyMarket("BR", US, true)).toBe("abroad");
    expect(classifyMarket("US", US, false)).toBe("unknown");
    expect(classifyMarket("BR", US, false)).toBe("unknown");
  });

  test("hostile and odd header values are unknown", () => {
    const hostile = [
      null,
      undefined,
      "",
      " ",
      "XX",
      "T1",
      "us",
      "Us",
      " US",
      "US ",
      "USA",
      "U",
      "U S",
      "US,US",
      "US\u0000",
      "US​",
      "ＵＳ",
      "1A",
      "../",
      "US;home",
      "x".repeat(10_000),
      "<script>",
      "home",
      "abroad",
    ];
    for (const value of hostile) {
      expect(classifyMarket(value, US, true), JSON.stringify(value)).toBe("unknown");
    }
  });

  test("only the three words ever come out", () => {
    const seen = new Set<string>();
    for (const value of ["US", "GB", "XX", "T1", "", "zz", "QA", "A7", null]) {
      for (const via of [true, false]) seen.add(classifyMarket(value, US, via));
    }
    for (const word of seen) expect(["home", "abroad", "unknown"]).toContain(word);
  });
});

describe("cameThroughCloudflare", () => {
  test("a proxy hop from a Cloudflare edge counts, v4 and v6", () => {
    for (const edge of [CF_EDGE_V4, CF_EDGE_V6]) {
      const r = plain({ "x-forwarded-for": `${VISITOR_V4}, ${edge}` });
      expect(cameThroughCloudflare(r, peer(PROXY_PEER)), edge).toBe(true);
      expect(cameThroughCloudflare(r, peer(`::ffff:${PROXY_PEER}`)), edge).toBe(true);
      expect(cameThroughCloudflare(r), edge).toBe(true);
    }
  });

  test("a direct hit through our proxy can't pose as Cloudflare", () => {
    // The proxy appends the real peer, so a forged Cloudflare entry is never last.
    const r = plain({
      "x-forwarded-for": `${CF_EDGE_V4}, ${VISITOR_V4}`,
      "cf-ipcountry": "US",
      "cf-connecting-ip": VISITOR_V4,
      "cf-ray": "8f00000000000000-IAD",
    });
    expect(cameThroughCloudflare(r, peer(PROXY_PEER))).toBe(false);
    expect(cameThroughCloudflare(plain({ "cf-ipcountry": "US" }), peer(PROXY_PEER))).toBe(false);
    expect(cameThroughCloudflare(plain({ "x-forwarded-for": VISITOR_V6 }), peer(PROXY_PEER))).toBe(
      false
    );
  });

  test("a public socket peer that isn't Cloudflare is refused whatever it writes", () => {
    const r = plain({ "x-forwarded-for": CF_EDGE_V4, "cf-ipcountry": "US" });
    expect(cameThroughCloudflare(r, peer(VISITOR_V4))).toBe(false);
    expect(cameThroughCloudflare(r, peer(VISITOR_V6))).toBe(false);
    expect(cameThroughCloudflare(r, peer(null))).toBe(false);
  });

  test("a Cloudflare socket peer with no proxy in front counts", () => {
    expect(cameThroughCloudflare(plain({}), peer(CF_EDGE_V4))).toBe(true);
  });

  test("garbage in the forwarded header is refused", () => {
    for (const xff of ["", ",", "not-an-ip", `${CF_EDGE_V4}/20`, `${CF_EDGE_V4}:443`, "::ffff:"]) {
      expect(cameThroughCloudflare(plain({ "x-forwarded-for": xff }), peer(PROXY_PEER)), xff).toBe(
        false
      );
    }
  });
});

describe("the request counter", () => {
  const viaCloudflare = (country: string) => ({
    "User-Agent": CHROME_UA,
    "cf-ipcountry": country,
    "x-forwarded-for": `${VISITOR_V4}, ${CF_EDGE_V4}`,
  });

  test("carries one market word per site", async () => {
    const calls = captureIncrements();
    const cases: Array<[string, Record<string, string>, string]> = [
      [UA_HOST, viaCloudflare("US"), "home"],
      [UA_HOST, viaCloudflare("BR"), "abroad"],
      [AS_HOST, viaCloudflare("US"), "home"],
      [AS_HOST, viaCloudflare("VN"), "abroad"],
      [HUB_HOST, viaCloudflare("IE"), "home"],
      [HUB_HOST, viaCloudflare("AR"), "abroad"],
      [UA_HOST, viaCloudflare("XX"), "unknown"],
      [UA_HOST, viaCloudflare("T1"), "unknown"],
      [UA_HOST, viaCloudflare("us"), "unknown"],
      [UA_HOST, { "User-Agent": CHROME_UA, "cf-ipcountry": "US" }, "unknown"],
      [UA_HOST, { "User-Agent": CHROME_UA }, "unknown"],
    ];
    for (const [host, headers] of cases) {
      await app.dispatch(req("/", host, { headers }));
    }
    const http = calls.filter((c) => c.name === "http.request");
    expect(http.map((c) => c.tags.market)).toEqual(cases.map((c) => c[2]));
  });

  test("a direct hit to the origin, forging every Cloudflare header, is not home", async () => {
    const calls = captureIncrements();
    await app.dispatch(
      req("/", UA_HOST, {
        headers: {
          "User-Agent": CHROME_UA,
          "cf-ipcountry": "US",
          "cf-connecting-ip": VISITOR_V4,
          "x-forwarded-for": `${CF_EDGE_V4}, ${VISITOR_V4}`,
        },
      }),
      peer(PROXY_PEER)
    );
    await app.dispatch(
      req("/", UA_HOST, {
        headers: {
          "User-Agent": CHROME_UA,
          "cf-ipcountry": "US",
          "x-forwarded-for": CF_EDGE_V4,
        },
      }),
      peer(VISITOR_V4)
    );
    const http = calls.filter((c) => c.name === "http.request");
    expect(http.map((c) => c.tags.market)).toEqual(["unknown", "unknown"]);
  });

  test("counted on 404s and API answers too", async () => {
    const calls = captureIncrements();
    for (const path of ["/no-such-page", "/api/fleet-summary"]) {
      await app.dispatch(req(path, UA_HOST, { headers: viaCloudflare("US") }));
    }
    const http = calls.filter((c) => c.name === "http.request");
    expect(http.map((c) => c.tags.market)).toEqual(["home", "home"]);
  });

  test("no country or address leaves in any metric, and the tag stays on http.request", async () => {
    const calls = captureIncrements();
    for (const country of ["BR", "QA", "US"]) {
      await app.dispatch(
        req("/api/check-flight?flight_number=UA1&date=2024-01-15", UA_HOST, {
          headers: viaCloudflare(country),
        })
      );
    }
    for (const call of calls) {
      const values = Object.values(call.tags).map(String);
      for (const leak of ["BR", "QA", "US", VISITOR_V4, CF_EDGE_V4]) {
        expect(values.includes(leak), `${call.name} ${leak}`).toBe(false);
      }
      if (call.name !== "http.request") expect("market" in call.tags, call.name).toBe(false);
    }
  });

  test("no response changes with the country", async () => {
    const paths: Array<[string, string]> = [
      ["/api/check-flight?flight_number=UA1&date=2024-01-15", UA_HOST],
      ["/api/check-any-flight?flight_number=HA50&date=2024-01-15", HUB_HOST],
    ];
    for (const [path, host] of paths) {
      const a = await app.dispatch(req(path, host));
      const b = await app.dispatch(req(path, host, { headers: viaCloudflare("BR") }));
      expect(b.status).toBe(a.status);
      expect(await b.text()).toBe(await a.text());
      expect([...b.headers].sort()).toEqual([...a.headers].sort());
    }
  });
});
