/**
 * FlyerTalk fetch hardening: slug renames on the same thread are followed,
 * everything else is refused, and the residential-sync retry loop gives up
 * immediately on failures that can't change between attempts. Stubbed
 * fetcher only — no network.
 */

import { describe, expect, test } from "bun:test";
import { fetchAlaskaFlyertalkTails } from "../src/scripts/flyertalk-alaska";
import {
  type FlyertalkFetcher,
  FlyertalkRedirectRejected,
  fetchFlyertalk,
} from "../src/scripts/flyertalk-common";
import { fetchQatarFlyertalkTails } from "../src/scripts/flyertalk-qatar";
import { isDeterministicFetchError, withRetry } from "../src/scripts/residential-sync";

const THREAD = 2201647;
const START = `https://www.flyertalk.com/forum/alaska-airlines-atmos-rewards/${THREAD}-old-slug-a.html`;
const HEADERS = { Accept: "text/html" };

const moved = (location: string, status = 301) =>
  new Response(null, { status, headers: { location } });
const page = (body: string) => new Response(body, { status: 200 });

function stub(routes: Record<string, () => Response>): {
  fetcher: FlyertalkFetcher;
  calls: string[];
} {
  const calls: string[] = [];
  const fetcher: FlyertalkFetcher = async (url, init) => {
    calls.push(url);
    expect(init.redirect).toBe("manual");
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return route();
  };
  return { fetcher, calls };
}

describe("fetchFlyertalk redirects", () => {
  test("same-host same-thread 301 with an absolute Location is followed", async () => {
    const next = `https://www.flyertalk.com/forum/alaska-airlines-atmos-rewards/${THREAD}-new-slug-a.html`;
    const { fetcher, calls } = stub({
      [START]: () => moved(next),
      [next]: () => page("<html>ok</html>"),
    });
    const res = await fetchFlyertalk(START, THREAD, HEADERS, fetcher);
    expect(typeof res.html).toBe("string");
    expect(res.finalUrl).toBe(next);
    expect(calls).toEqual([START, next]);
  });

  test("a relative Location resolves against the current URL and is followed", async () => {
    const next = `https://www.flyertalk.com/forum/alaska-airlines-atmos-rewards/${THREAD}-new-slug-a.html`;
    const { fetcher } = stub({
      [START]: () => moved(`/forum/alaska-airlines-atmos-rewards/${THREAD}-new-slug-a.html`),
      [next]: () => page("ok"),
    });
    const res = await fetchFlyertalk(START, THREAD, HEADERS, fetcher);
    expect(res.finalUrl).toBe(next);
  });

  const rejected: Array<[string, string]> = [
    ["another host", `https://evil.example.com/forum/x/${THREAD}-a.html`],
    ["another thread id", "https://www.flyertalk.com/forum/x/9999999-a.html"],
    ["plain http", `http://www.flyertalk.com/forum/x/${THREAD}-a.html`],
    ["a non-thread path", "https://www.flyertalk.com/login.php"],
  ];
  for (const [label, location] of rejected) {
    test(`a redirect to ${label} is rejected`, async () => {
      const { fetcher } = stub({ [START]: () => moved(location) });
      await expect(fetchFlyertalk(START, THREAD, HEADERS, fetcher)).rejects.toBeInstanceOf(
        FlyertalkRedirectRejected
      );
    });
  }

  test("three chained 301s are rejected as too many hops", async () => {
    const hop = (n: number) => `https://www.flyertalk.com/forum/x/${THREAD}-hop${n}.html`;
    const { fetcher } = stub({
      [START]: () => moved(hop(1)),
      [hop(1)]: () => moved(hop(2)),
      [hop(2)]: () => moved(hop(3)),
      [hop(3)]: () => page("never reached"),
    });
    await expect(fetchFlyertalk(START, THREAD, HEADERS, fetcher)).rejects.toBeInstanceOf(
      FlyertalkRedirectRejected
    );
  });

  test("a 3xx without Location throws", async () => {
    const { fetcher } = stub({ [START]: () => new Response(null, { status: 302 }) });
    await expect(fetchFlyertalk(START, THREAD, HEADERS, fetcher)).rejects.toThrow(/Location/);
  });

  test("a non-2xx final response throws", async () => {
    const { fetcher } = stub({ [START]: () => new Response("no", { status: 403 }) });
    await expect(fetchFlyertalk(START, THREAD, HEADERS, fetcher)).rejects.toThrow(/HTTP 403/);
  });
});

describe("Alaska thread URL", () => {
  // A stale slug would spend a redirect hop (and log a rename warning) on every run.
  test("targets the current slug directly, with no redirect hop", async () => {
    const current = `https://www.flyertalk.com/forum/alaska-airlines-atmos-rewards/${THREAD}-starlink-wi-fi-737s-began-4-2026-e75s-completed-began-12-2025-a.html`;
    const wikipost = `<div id="wikipost-${THREAD}">Starlink Installed N101AS Installations in Progress</div> END WIKIPOST`;
    const { fetcher, calls } = stub({ [current]: () => page(wikipost) });
    const tails = await fetchAlaskaFlyertalkTails(fetcher);
    expect(calls).toEqual([current]);
    expect(Array.isArray(tails)).toBe(true);
  });
});

describe("Qatar pagination after a slug rename", () => {
  test("rel=next resolves against the post-redirect URL", async () => {
    const base = "https://www.flyertalk.com/forum/qatar-airways-privilege-club/";
    const original = `${base}2162391-qr-starlink-now-live.html`;
    const renamed = "https://www.flyertalk.com/forum/qatar-renamed/2162391-qr-starlink-live.html";
    const page2 = "https://www.flyertalk.com/forum/qatar-renamed/2162391-qr-starlink-live-2.html";
    const { fetcher, calls } = stub({
      [original]: () => moved(renamed),
      [renamed]: () =>
        page('<link rel="next" href="2162391-qr-starlink-live-2.html"> A7-BEA A7-ANA'),
      [page2]: () => page("A7-BEB"),
    });
    const tails = await fetchQatarFlyertalkTails(fetcher);
    expect(calls).toEqual([original, renamed, page2]);
    expect(Array.isArray(tails)).toBe(true);
    expect(tails.length).toBeGreaterThan(0);
  });
});

describe("residential-sync retry", () => {
  test("deterministic failures are classified as such", () => {
    expect(isDeterministicFetchError(new FlyertalkRedirectRejected("x"))).toBe(true);
    expect(
      isDeterministicFetchError(new Error("wikipost block not found — page layout changed"))
    ).toBe(true);
    expect(isDeterministicFetchError(new Error("HTTP 503 for x"))).toBe(false);
  });

  test("a rejected redirect is not retried", async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      throw new FlyertalkRedirectRejected("refusing");
    };
    await expect(withRetry(fn, "t", 0)).rejects.toBeInstanceOf(FlyertalkRedirectRejected);
    expect(attempts).toBe(1);
  });

  test("a transient failure is retried", async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      if (attempts < 2) throw new Error("HTTP 503");
      return "ok";
    };
    expect(await withRetry(fn, "t", 0)).toBe("ok");
    expect(attempts).toBe(2);
  });
});
