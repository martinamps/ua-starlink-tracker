/**
 * `visit_source` on the request counter: one of nine fixed words for where a
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

  test("a search engine's page calling the API is the extension, not a search visit", () => {
    const google = { Referer: "https://www.google.com/" };
    expect(source("/api/check-flight?flight_number=UA1&date=2026-06-01", google)).toBe("extension");
    expect(
      source("/api/check-any-flight?flight_number=HA50&date=2026-06-01", {
        Origin: "https://www.google.com",
      })
    ).toBe("extension");
    expect(source("/check-flight/UA1", google)).toBe("search");
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
    ];
    for (const value of junk) {
      for (const headers of [{ Referer: value }, { Origin: value }, { "Sec-Fetch-Site": value }]) {
        expect(VISIT_SOURCES).toContain(source("/", headers));
      }
      expect(VISIT_SOURCES).toContain(source(`/?utm_source=${encodeURIComponent(value)}`));
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
    expect(http.map((c) => c.tags.visit_source)).toEqual(["search", "extension", "search"]);
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
