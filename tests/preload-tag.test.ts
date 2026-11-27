/**
 * The `preload` word on the request counter: none | prefetch | prerender. A
 * browser can load a page before anyone clicks (Chrome's search prefetch and
 * speculation rules, link prefetch) and says so in a request header. What this
 * pins: those loads are marked, a real click is not, `visit_source` is the
 * same either way, the set stays closed whatever a caller sends, nothing of
 * the header but the word is emitted, and no response changes with it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { PRELOADS, classifyPreload, metrics } from "../src/observability/metrics";
import { createApp } from "../src/server/app";
import { openSnapshot, req } from "./helpers";

const UA_HOST = "unitedstarlinktracker.com";
const HUB_HOST = "airlinestarlinktracker.com";
const CHROME_UA = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/128 Safari/537.36";
const GOOGLE = "https://www.google.com/";

const app = createApp(openSnapshot());

function preload(headers: Record<string, string> = {}) {
  return classifyPreload(new Request("https://x/", { headers }));
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

describe("classifyPreload", () => {
  test("a request with no purpose header is a real load", () => {
    expect(preload()).toBe("none");
    expect(preload({ "Sec-Fetch-Site": "cross-site", Referer: GOOGLE })).toBe("none");
  });

  test("reads every header a browser has marked a prefetch with", () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ "Sec-Purpose": "prefetch" }, "prefetch"],
      [{ "Sec-Purpose": "prefetch;anonymous-client-ip" }, "prefetch"],
      [{ "Sec-Purpose": "prefetch; anonymous-client-ip" }, "prefetch"],
      [{ "Sec-Purpose": "PREFETCH" }, "prefetch"],
      [{ Purpose: "prefetch" }, "prefetch"],
      [{ "X-Moz": "prefetch" }, "prefetch"],
      [{ "X-Purpose": "preview" }, "prefetch"],
      [{ "Sec-Purpose": "prefetch;prerender" }, "prerender"],
      [{ "Sec-Purpose": "prefetch;prerender=?1" }, "prerender"],
      [{ "Sec-Purpose": "prefetch;prerender;anonymous-client-ip" }, "prerender"],
      [{ Purpose: "prerender" }, "prerender"],
      [{ Purpose: "prefetch", "Sec-Purpose": "prefetch;prerender" }, "prerender"],
      [{ "Sec-Purpose": "prefetch;prerender", Purpose: "prefetch" }, "prerender"],
    ];
    for (const [headers, want] of cases) {
      expect(preload(headers), JSON.stringify(headers)).toBe(want);
    }
  });

  test("only whole tokens count, and a parameter set to false is a no", () => {
    for (const value of [
      "",
      "navigate",
      "notprefetch",
      "prefetching",
      "pre-fetch",
      "prefetch=?0",
      "x-prefetch-y",
      "anonymous-client-ip",
      "../../prefetch/..",
      "<script>prerender</script>",
    ]) {
      expect(preload({ "Sec-Purpose": value }), value).toBe("none");
    }
    expect(preload({ "Sec-Purpose": "prefetch;prerender=?0" })).toBe("prefetch");
  });

  test("the set stays closed whatever a caller sends", () => {
    const hostile = [
      "prefetch".repeat(10_000),
      `${"a".repeat(5_000)};prerender`,
      "prefetch\tprerender",
      "prerender,prefetch,203.0.113.77",
      "préfetch",
      "prefetch;".repeat(500),
      "%70refetch",
      "=;=;=,,;;",
    ];
    for (const value of hostile) {
      for (const name of ["Sec-Purpose", "Purpose", "X-Purpose", "X-Moz"]) {
        expect(PRELOADS).toContain(preload({ [name]: value }));
      }
    }
    // Past the cap nothing is read.
    expect(preload({ "Sec-Purpose": `${"a".repeat(5_000)};prerender` })).toBe("none");
  });
});

describe("http.request preload tag", () => {
  const searchClick = {
    "User-Agent": CHROME_UA,
    Referer: GOOGLE,
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "document",
  };

  test("a search prefetch, a prerender and a real click are told apart, with the same visit_source", async () => {
    const calls = captureIncrements();
    const cases: Array<[Record<string, string>, string]> = [
      [searchClick, "none"],
      [{ ...searchClick, "Sec-Purpose": "prefetch;anonymous-client-ip" }, "prefetch"],
      [{ ...searchClick, "Sec-Purpose": "prefetch", Purpose: "prefetch" }, "prefetch"],
      [{ ...searchClick, "Sec-Purpose": "prefetch;prerender" }, "prerender"],
    ];
    for (const [headers] of cases) {
      await app.dispatch(req("/", UA_HOST, { headers }));
    }
    const http = calls.filter((c) => c.name === "http.request");
    expect(http.map((c) => c.tags.preload)).toEqual(cases.map((c) => c[1]));
    for (const call of http) {
      expect(call.tags.visit_source).toBe("search");
      expect(call.tags.client_class).toBe("browser");
      expect(call.tags.status_code).toBe(200);
      expect(call.tags.route).toBe("/");
      expect(call.tags.tenant).toBe("UA");
      expect(call.tags.airline).toBeDefined();
    }
  });

  test("an in-site prerender keeps visit_source own, and a typed address direct", async () => {
    const calls = captureIncrements();
    await app.dispatch(
      req("/fleet", UA_HOST, {
        headers: {
          "User-Agent": CHROME_UA,
          "Sec-Fetch-Site": "same-origin",
          "Sec-Purpose": "prefetch;prerender",
        },
      })
    );
    // Chrome prerenders the address bar's top suggestion.
    await app.dispatch(
      req("/", UA_HOST, {
        headers: {
          "User-Agent": CHROME_UA,
          "Sec-Fetch-Site": "none",
          "Sec-Purpose": "prefetch;prerender",
        },
      })
    );
    const http = calls.filter((c) => c.name === "http.request");
    expect(http.map((c) => [c.tags.visit_source, c.tags.preload])).toEqual([
      ["own", "prerender"],
      ["direct", "prerender"],
    ]);
  });

  test("counted on every site, on 404s and API answers too", async () => {
    const calls = captureIncrements();
    const headers = { "User-Agent": CHROME_UA, "Sec-Purpose": "prefetch" };
    await app.dispatch(req("/", HUB_HOST, { headers }));
    await app.dispatch(req("/no-such-page", UA_HOST, { headers }));
    await app.dispatch(req("/api/fleet-summary", UA_HOST, { headers }));
    await app.dispatch(req("/api/fleet-summary", UA_HOST));
    const http = calls.filter((c) => c.name === "http.request");
    expect(http.map((c) => c.tags.preload)).toEqual(["prefetch", "prefetch", "prefetch", "none"]);
  });

  test("nothing of the header but the word is emitted, and the tag stays on http.request", async () => {
    const calls = captureIncrements();
    const marker = "zz-marker-203.0.113.77";
    for (const value of [`prefetch;${marker}`, `prefetch;prerender;${marker}`, marker]) {
      await app.dispatch(
        req("/api/check-flight?flight_number=UA1&date=2024-01-15", UA_HOST, {
          headers: { "User-Agent": CHROME_UA, "Sec-Purpose": value, Purpose: value },
        })
      );
    }
    const http = calls.filter((c) => c.name === "http.request");
    expect(http.map((c) => c.tags.preload)).toEqual(["prefetch", "prerender", "none"]);
    for (const call of calls) {
      for (const value of Object.values(call.tags).map(String)) {
        expect(value.includes("zz-marker"), `${call.name} ${value}`).toBe(false);
        expect(value.includes("anonymous-client-ip"), call.name).toBe(false);
      }
      if (call.name !== "http.request") expect("preload" in call.tags, call.name).toBe(false);
    }
  });

  test("no response changes with the header", async () => {
    const paths: Array<[string, string]> = [
      ["/api/check-flight?flight_number=UA1&date=2024-01-15", UA_HOST],
      ["/api/check-any-flight?flight_number=HA50&date=2024-01-15", HUB_HOST],
      ["/robots.txt", UA_HOST],
    ];
    for (const [path, host] of paths) {
      const a = await app.dispatch(req(path, host));
      for (const value of ["prefetch", "prefetch;prerender"]) {
        const b = await app.dispatch(req(path, host, { headers: { "Sec-Purpose": value } }));
        expect(b.status).toBe(a.status);
        expect(await b.text()).toBe(await a.clone().text());
        expect([...b.headers].sort()).toEqual([...a.headers].sort());
      }
    }
  });
});
