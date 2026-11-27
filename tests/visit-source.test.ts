/**
 * `visit_source` on the request counter: one of ten fixed words for where a
 * request came from. What this pins: the set stays closed whatever a caller
 * sends, the boundary cases land where docs/OBSERVABILITY.md says, nothing of
 * the referrer but the word is emitted, and no response changes with it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { VISIT_SOURCES, classifyVisitSource, metrics } from "../src/observability/metrics";
import { createApp } from "../src/server/app";
import { openSnapshot, req } from "./helpers";

const UA_HOST = "unitedstarlinktracker.com";
const HUB_HOST = "airlinestarlinktracker.com";
const CHROME_UA = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/128 Safari/537.36";

const app = createApp(openSnapshot());

function source(path: string, headers: Record<string, string> = {}, clientClass = "browser") {
  const url = new URL(`https://${UA_HOST}${path}`);
  return classifyVisitSource(new Request(url, { headers }), url, clientClass);
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

describe("classifyVisitSource", () => {
  test("names the outside classes from the referrer's host alone", () => {
    const cases: Array<[string, string]> = [
      ["https://www.google.com/", "search"],
      ["https://www.google.co.uk/", "search"],
      ["https://www.bing.com/search?q=united+starlink", "search"],
      ["https://duckduckgo.com/", "search"],
      ["android-app://com.google.android.googlequicksearchbox/", "search"],
      ["https://google.com.au/", "search"],
      ["https://uk.search.yahoo.com/", "search"],
      ["https://yandex.com.tr/", "search"],
      ["https://search.aol.com/", "search"],
      ["https://chatgpt.com/", "assistant"],
      ["https://www.perplexity.ai/search/abc", "assistant"],
      ["https://claude.ai/chat/123", "assistant"],
      ["https://gemini.google.com/app", "assistant"],
      ["https://www.reddit.com/r/unitedairlines/comments/x", "social"],
      ["https://t.co/abc", "social"],
      ["https://www.flyertalk.com/forum/united", "social"],
      ["https://mail.google.com/mail/u/0/", "other"],
      ["https://example.org/blog/post", "other"],
      ["android-app://com.example.reader/", "other"],
    ];
    for (const [referer, want] of cases) {
      expect(source("/", { Referer: referer }), referer).toBe(want);
    }
  });

  test("a lookalike host is not the site it imitates", () => {
    for (const referer of [
      "https://notgoogle.com/",
      "https://google.com.evil.example/",
      "https://chatgpt.com.evil.example/",
      "https://fakereddit.com/",
    ]) {
      expect(source("/", { Referer: referer }), referer).toBe("other");
    }
  });

  test("search means a results host, not the rest of a portal", () => {
    for (const referer of [
      "https://mail.yahoo.com/",
      "https://finance.yahoo.com/",
      "https://www.yahoo.com/",
      "https://blog.naver.com/",
      "https://cafe.naver.com/",
      "https://mail.yandex.ru/",
      "https://tieba.baidu.com/",
      "https://news.google.com/",
      "https://www.google.dev/",
      "https://google.zip/",
      "https://www.msn.com/",
      "https://x.bing.com/",
    ]) {
      expect(source("/", { Referer: referer }), referer).toBe("other");
    }
  });

  test("a search referrer is a search visit on any page, and proves nothing on the API", () => {
    const google = { Referer: "https://www.google.com/" };
    expect(source("/check-flight/UA1", google)).toBe("search");
    expect(source("/mcp", google)).toBe("search");
    // Some script on a search page: not a visit, and not our extension, which
    // sends no referrer and is known only by its own marks.
    expect(source("/api/check-flight?flight_number=UA1&date=2026-06-01", google)).toBe("other");
    expect(
      source("/api/check-any-flight?flight_number=HA50&date=2026-06-01", {
        Origin: "https://www.google.com",
      })
    ).toBe("other");
  });

  test("extension traffic is its own class whatever else it carries", () => {
    for (const cls of ["extension", "other-extension"]) {
      expect(source("/api/check-flight", { Referer: "https://chatgpt.com/" }, cls)).toBe(
        "extension"
      );
    }
  });

  test("our own hosts refer to each other as own, by referrer, origin or fetch metadata", () => {
    expect(source("/fleet", { Referer: `https://${HUB_HOST}/airlines` })).toBe("own");
    expect(source("/fleet", { Referer: "https://www.alaskastarlinktracker.com/" })).toBe("own");
    expect(source("/api/passenger-probe", { Origin: `https://${UA_HOST}` })).toBe("own");
    expect(source("/api/check-flight", { "Sec-Fetch-Site": "same-origin" })).toBe("own");
    expect(source("/", { "Sec-Fetch-Site": "same-site" })).toBe("own");
  });

  test("utm_source counts only for what it names, and never as search", () => {
    expect(source("/?utm_source=chatgpt.com")).toBe("assistant");
    expect(source("/?utm_source=Perplexity")).toBe("assistant");
    expect(source("/?utm_source=reddit")).toBe("social");
    expect(source("/check-flight/UA1/2026-06-01?utm_source=cal")).toBe("calendar");
    expect(source("/?utm_source=google")).toBe("other");
    expect(source("/?utm_source=newsletter")).toBe("other");
    expect(source("/?utm_source=")).toBe("none");
    // The landing after an assistant's link is a top-level navigation the
    // browser itself calls cross-site or user-started; the utm still names it.
    expect(source("/?utm_source=chatgpt.com", { "Sec-Fetch-Site": "none" })).toBe("assistant");
    // A named referrer outranks a utm copied along with a shared link.
    expect(source("/?utm_source=chatgpt.com", { Referer: "https://www.reddit.com/" })).toBe(
      "social"
    );
  });

  test("our own MCP link reads apart from an assistant's citation", () => {
    const flight = "/check-flight/UA1/2026-06-01?utm_source=mcp";
    const planner = "/route-planner?origin=SFO&destination=EWR&date=2026-06-01&utm_source=mcp";
    // Most MCP clients open links with no referrer, from a desktop app or a new tab.
    expect(source(flight)).toBe("mcp-link");
    expect(source(flight, { "Sec-Fetch-Site": "none" })).toBe("mcp-link");
    expect(source(flight, { "Sec-Fetch-Site": "cross-site" })).toBe("mcp-link");
    expect(source(planner, { "Sec-Fetch-Site": "none" })).toBe("mcp-link");
    expect(source("/route-planner/SFO/EWR?utm_source=mcp")).toBe("mcp-link");
    // Shown inside an assistant's web app it is still our link, not its citation.
    expect(source(flight, { Referer: "https://claude.ai/chat/123" })).toBe("mcp-link");
    expect(source(flight, { Referer: "https://chatgpt.com/" })).toBe("mcp-link");
    // The assistant's own citation of the same page.
    expect(source("/check-flight/UA1/2026-06-01", { Referer: "https://chatgpt.com/" })).toBe(
      "assistant"
    );
    expect(source("/check-flight/UA1/2026-06-01?utm_source=chatgpt.com")).toBe("assistant");
    expect(source("/check-flight/UA1/2026-06-01?utm_source=claude")).toBe("assistant");
    // Copied on: a named search, social or own referrer outranks the mark.
    expect(source(flight, { Referer: "https://www.reddit.com/" })).toBe("social");
    expect(source(flight, { Referer: "https://www.google.com/" })).toBe("search");
    expect(source(flight, { Referer: `https://${HUB_HOST}/` })).toBe("own");
    // An unnamed referrer says nothing against it.
    expect(source(flight, { Referer: "https://example.org/" })).toBe("mcp-link");
    expect(source(flight, {}, "extension")).toBe("extension");
  });

  test("only the mark exactly as the link writes it is mcp-link", () => {
    const notTheMark = [
      "utm_source=MCP",
      "utm_source=Mcp",
      "utm_source=mcp%20",
      "utm_source=%20mcp",
      "utm_source=+mcp",
      "utm_source=mcp+",
      "utm_source=%6dcp",
      "utm_source=%6D%63%70",
      "utm_source=mcp%00",
      "utm_source=mcp&utm_source=mcp",
      "utm_source=mcp&utm_source=chatgpt.com",
      "utm_source=mcp&utm_source=",
      "utm%5Fsource=mcp",
      "utm_source=mcp&utm%5Fsource=mcp",
      "UTM_SOURCE=mcp",
      "utm_source=mcp-link",
      "utm_source=mcp.example",
      "utm_source=mcpx",
      "utm_source=xmcp",
      "utm_source=mcp,mcp",
      "utm_source=mcp;utm_source=mcp",
      "utm_source[]=mcp",
      "utm_source==mcp",
      "utm_source",
      "utm_source=",
      "utm_medium=mcp",
      "xutm_source=mcp",
      `utm_source=${"mcp".repeat(2000)}`,
      `utm_source=mcp${"a".repeat(8000)}`,
      `utm_source=${"mcp%20".repeat(500)}`,
      "utm_source=%E0%A4%A",
      "utm_source=m%C2%ADcp",
      "utm_source=ｍｃｐ",
      "utm_source=mcp%0d%0a",
    ];
    for (const query of notTheMark) {
      for (const path of ["/check-flight/UA1", "/route-planner", "/", "/api/check-flight"]) {
        const got = source(`${path}?${query}`, { "Sec-Fetch-Site": "none" });
        expect(got, query).not.toBe("mcp-link");
        // A spelling of "mcp" names no assistant either.
        expect(got, query).not.toBe("assistant");
        expect(VISIT_SOURCES).toContain(got);
      }
    }
    // A repeat that leads with an assistant's name reads as that assistant's, as before.
    expect(source("/check-flight/UA1?utm_source=chatgpt.com&utm_source=mcp")).toBe("assistant");
    // A fragment never reaches the server, and other parameters don't unmake the mark.
    for (const query of [
      "utm_source=mcp",
      "origin=SFO&destination=EWR&utm_source=mcp",
      "utm_source=mcp&utm_medium=anything&x=utm_source%3Dmcp",
      "&&utm_source=mcp&",
    ]) {
      expect(source(`/route-planner?${query}`), query).toBe("mcp-link");
    }
    // The mark in a path or a value is not the parameter.
    expect(source("/check-flight/utm_source=mcp")).toBe("none");
    expect(source("/?q=utm_source=mcp")).toBe("none");
    expect(source("/?next=%3Futm_source%3Dmcp")).toBe("none");
  });

  test("fetch metadata splits a user-started visit from an unnamed outside one and from no signal", () => {
    expect(source("/", { "Sec-Fetch-Site": "none" })).toBe("direct");
    expect(source("/", { "Sec-Fetch-Site": "cross-site" })).toBe("other");
    expect(source("/")).toBe("none");
  });

  test("a user agent alone is never an assistant visit", () => {
    for (const ua of ["ChatGPT-User/1.0", "Claude-User", "Perplexity-User/1.0", CHROME_UA]) {
      expect(source("/", { "User-Agent": ua }), ua).toBe("none");
    }
  });

  test("junk input stays inside the set", () => {
    const junk = [
      "",
      "null",
      "not a url",
      "https://",
      "javascript:alert(1)",
      "//google.com",
      `https://${"a".repeat(5000)}.example/`,
      "https://[::1]/",
      "data:text/html,<script>",
      "android-app://constructor/",
      "android-app://__proto__/",
      "android-app://toString/",
      "android-app://hasOwnProperty",
    ];
    for (const value of junk) {
      for (const headers of [{ Referer: value }, { Origin: value }, { "Sec-Fetch-Site": value }]) {
        expect(VISIT_SOURCES).toContain(source("/", headers));
      }
      expect(VISIT_SOURCES).toContain(source(`/?utm_source=${encodeURIComponent(value)}`));
    }
  });

  test("a name every object inherits is an unknown source, not a tenth value", () => {
    const inherited = [
      "constructor",
      "__proto__",
      "prototype",
      "toString",
      "valueOf",
      "hasOwnProperty",
      "isPrototypeOf",
      "toLocaleString",
      "propertyIsEnumerable",
      "__defineGetter__",
      "__lookupGetter__",
    ];
    for (const name of inherited) {
      for (const utm of [name, name.toUpperCase(), ` ${name} `]) {
        expect(source(`/?utm_source=${encodeURIComponent(utm)}`), `utm ${utm}`).toBe("other");
      }
      for (const header of ["Referer", "Origin"]) {
        for (const path of ["/", "/api/check-flight", "/mcp"]) {
          expect(source(path, { [header]: `android-app://${name}/` }), `${header} ${name}`).toBe(
            "other"
          );
          expect(source(path, { [header]: `https://${name}/` }), `${header} ${name}`).toBe("other");
        }
      }
    }
  });
});

describe("the request counter", () => {
  const SECRET_REFERER = "https://www.google.com/search?q=private+words&sxsrf=TOKEN123";

  test("carries exactly one visit_source from the set, on every kind of answer", async () => {
    const calls = captureIncrements();
    const headers = { "User-Agent": CHROME_UA, Referer: SECRET_REFERER };
    for (const path of ["/", "/api/check-flight?flight_number=UA1&date=2024-01-15", "/no-such"]) {
      await app.dispatch(req(path, UA_HOST, { headers }));
    }
    const http = calls.filter((c) => c.name === "http.request");
    expect(http.length).toBe(3);
    for (const call of http) {
      expect(VISIT_SOURCES).toContain(call.tags.visit_source as (typeof VISIT_SOURCES)[number]);
      expect(typeof call.tags.client_class).toBe("string");
    }
    expect(http.map((c) => c.tags.visit_source)).toEqual(["search", "other", "search"]);
  });

  test("emits nothing of the referrer but the word", async () => {
    const calls = captureIncrements();
    await app.dispatch(
      req("/?utm_source=some-private-campaign", UA_HOST, {
        headers: { "User-Agent": CHROME_UA, Referer: SECRET_REFERER },
      })
    );
    const emitted = JSON.stringify(calls);
    for (const leak of ["google", "private", "TOKEN123", "sxsrf", "campaign"]) {
      expect(emitted.includes(leak), leak).toBe(false);
    }
  });

  test("the tag stays off every other metric", async () => {
    const calls = captureIncrements();
    await app.dispatch(
      req("/api/check-flight?flight_number=UA1&date=2024-01-15", UA_HOST, {
        headers: { "User-Agent": CHROME_UA, Referer: "https://chatgpt.com/" },
      })
    );
    for (const call of calls.filter((c) => c.name !== "http.request")) {
      expect("visit_source" in call.tags, call.name).toBe(false);
    }
  });

  test("an MCP link click and a citation click read apart on the counter, and only as words", async () => {
    const calls = captureIncrements();
    const browser = { "User-Agent": CHROME_UA, "Sec-Fetch-Site": "none" };
    await app.dispatch(req("/check-flight/UA1?utm_source=mcp", UA_HOST, { headers: browser }));
    await app.dispatch(
      req("/check-flight/UA1?utm_source=chatgpt.com", UA_HOST, { headers: browser })
    );
    await app.dispatch(
      req("/check-flight/UA1", UA_HOST, {
        headers: { ...browser, "Sec-Fetch-Site": "cross-site", Referer: "https://chatgpt.com/" },
      })
    );
    await app.dispatch(req("/check-flight/UA1?utm_source=MCP", UA_HOST, { headers: browser }));
    const http = calls.filter((c) => c.name === "http.request");
    expect(http.map((c) => c.tags.visit_source)).toEqual([
      "mcp-link",
      "assistant",
      "assistant",
      "other",
    ]);
    // Same tag keys with and without the mark: the split adds a value, not a key.
    const keys = http.map((c) => Object.keys(c.tags).sort().join());
    expect(new Set(keys).size).toBe(1);
    const emitted = JSON.stringify(calls);
    for (const leak of ["utm_source", "chatgpt", "=mcp"]) {
      expect(emitted.includes(leak), leak).toBe(false);
    }
  });

  test("a page reached by the MCP link is the page itself, with no mark in what it prints", async () => {
    const pages: Array<[string, string]> = [
      ["/check-flight/UA1", ""],
      ["/route-planner", "origin=SFO&destination=EWR"],
      ["/", ""],
    ];
    for (const [path, query] of pages) {
      const plain = await app.dispatch(req(query ? `${path}?${query}` : path, UA_HOST));
      const marked = await app.dispatch(
        req(`${path}?${query ? `${query}&` : ""}utm_source=mcp`, UA_HOST)
      );
      expect(marked.status, path).toBe(plain.status);
      const [plainBody, markedBody] = [await plain.text(), await marked.text()];
      expect(markedBody.includes("utm_source"), path).toBe(false);
      const canonical = (html: string) => html.match(/<link rel="canonical"[^>]*>/)?.[0];
      expect(canonical(markedBody), path).toBe(canonical(plainBody));
      expect(canonical(markedBody), path).toBeDefined();
      const robots = (html: string) => html.match(/<meta name="robots"[^>]*>/)?.[0];
      expect(robots(markedBody), path).toBe(robots(plainBody));
    }
  });

  test("no response changes with where the request came from", async () => {
    const paths: Array<[string, string]> = [
      ["/api/check-flight?flight_number=UA1&date=2024-01-15", UA_HOST],
      ["/api/check-any-flight?flight_number=HA50&date=2024-01-15", HUB_HOST],
    ];
    for (const [path, host] of paths) {
      const plain = await app.dispatch(req(path, host));
      const referred = await app.dispatch(
        req(path, host, {
          headers: { Referer: "https://www.google.com/", "Sec-Fetch-Site": "cross-site" },
        })
      );
      expect(referred.status).toBe(plain.status);
      expect(await referred.text()).toBe(await plain.text());
      expect([...referred.headers].sort()).toEqual([...plain.headers].sort());
    }
  });
});
