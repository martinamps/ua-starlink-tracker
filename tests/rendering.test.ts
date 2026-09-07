/**
 * Template rendering: renderHtml is a single pass over the template — data
 * values containing {{...}} or $-replacement patterns pass through literally —
 * and every HTML page claims its own path in canonical, og:url, and the
 * WebPage JSON-LD (subpages must not canonicalize to the homepage).
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { createReaderFactory } from "../src/database/reader";
import { createApp, renderHtml } from "../src/server/app";
import { openSnapshot, req } from "./helpers";

describe("renderHtml", () => {
  test("placeholders inside data values do not re-expand", () => {
    const out = renderHtml("<body>{{html}}</body>", {
      html: "sheet-sourced value with {{analyticsSnippet}} inside",
      analyticsSnippet: '<script src="https://evil.example/x.js"></script>',
    });
    expect(out).toBe("<body>sheet-sourced value with {{analyticsSnippet}} inside</body>");
  });

  test("$-replacement patterns in values are inert", () => {
    const out = renderHtml("<title>{{siteTitle}}</title>", { siteTitle: "a $` b $& c $' d $0" });
    expect(out).toBe("<title>a $` b $& c $' d $0</title>");
  });

  test("known vars resolve; unknown placeholders render empty", () => {
    expect(renderHtml("{{starlinkCount}} of {{unknownVar}}", { starlinkCount: "7" })).toBe("7 of ");
  });
});

describe("canonical / og:url / WebPage JSON-LD claim the page path", () => {
  const HOST = "unitedstarlinktracker.com";
  let app: ReturnType<typeof createApp>;
  // Picked from the snapshot at run time — a hardcoded flight number would
  // drift out of the data and trip the existence gate.
  let realFlight: string;

  beforeAll(() => {
    const db = openSnapshot();
    app = createApp(db);
    realFlight = createReaderFactory(db)("UA").getSitemapFlights()[0]?.flight_number ?? "";
    expect(realFlight).toMatch(/^UA\d{1,4}$/);
  });

  test.each(["/", "/check-flight", "/fleet", "/route-planner"])("%s", async (path) => {
    const res = await app.dispatch(req(path, HOST));
    expect(res.status).toBe(200);
    const html = await res.text();
    const expected = `https://${HOST}${path}`;

    expect(html.match(/<link rel="canonical" href="([^"]+)"/)?.[1]).toBe(expected);
    expect(html.match(/<meta property="og:url" content="([^"]+)"/)?.[1]).toBe(expected);
    // First "url" after the WebPage type is the page's own claim (isPartOf
    // carries the site root separately).
    expect(html.match(/"@type":"WebPage".*?"url":"([^"]+)"/s)?.[1]).toBe(expected);
    // Brand copy embeds count placeholders — all of them must have resolved.
    expect(html).not.toContain("{{");
  });

  test("flight permalink with data → 200, self-canonical, flight-specific H1", async () => {
    const path = `/check-flight/${realFlight}`;
    const res = await app.dispatch(req(path, HOST));
    expect(res.status).toBe(200);
    const html = await res.text();
    const expected = `https://${HOST}${path}`;
    expect(html.match(/<link rel="canonical" href="([^"]+)"/)?.[1]).toBe(expected);
    expect(html.match(/<meta property="og:url" content="([^"]+)"/)?.[1]).toBe(expected);
    expect(html).toContain(`Does ${realFlight} Have Starlink WiFi?`);
    expect(html).not.toContain("0% of the time");
  });

  test("dated flight page canonicalizes to the undated flight page", async () => {
    const res = await app.dispatch(req(`/check-flight/${realFlight}/2027-01-15`, HOST));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.match(/<link rel="canonical" href="([^"]+)"/)?.[1]).toBe(
      `https://${HOST}/check-flight/${realFlight}`
    );
    expect(html).toContain(`Does ${realFlight} Have Starlink WiFi?`);
  });

  test("WebPage JSON-LD carries the page's own title, not homepage copy", async () => {
    const res = await app.dispatch(req("/fleet", HOST));
    expect(res.status).toBe(200);
    const html = await res.text();

    const title = html.match(/<title>([^<]+)<\/title>/)?.[1];
    expect(title).toBeTruthy();
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map(
      (m) => JSON.parse(m[1]) as { "@type": string; name?: string }
    );
    const webPage = blocks.find((b) => b["@type"] === "WebPage");
    expect(webPage?.name).toBe(title as string);
  });

  // Attribute-breakout input in the permalink segment must never reach the
  // markup raw: validation rejects it (hard 404) and escapeHtmlAttr guards
  // the template-var boundary behind that.
  test("attribute-breakout path 404s and never appears in markup", async () => {
    const res = await app.dispatch(req("/check-flight/UA123%22%3E%3Cscript%3Ex", HOST));
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).not.toContain('"><script>x');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Flight permalinks: existence gate (no data → interactive soft page, noindex,
// canonical to /check-flight — the client-side FR24 lookup can still answer;
// malformed/other-carrier segments hard-404) and URL normalization (one
// canonical spelling per flight, everything else 301).
// ─────────────────────────────────────────────────────────────────────────────

describe("flight permalink gate + normalization", () => {
  const HOST = "unitedstarlinktracker.com";
  let app: ReturnType<typeof createApp>;
  let ghostFlight: string;

  beforeAll(() => {
    const db = openSnapshot();
    app = createApp(db);
    // A number whose digits appear in NO schedule/route row (any prefix or
    // zero-padding) — guaranteed to fail the gate regardless of data drift.
    const used = new Set(
      (
        db
          .query(
            `SELECT flight_number FROM upcoming_flights
             UNION SELECT flight_number FROM flight_routes`
          )
          .all() as { flight_number: string | null }[]
      ).map((r) => String(r.flight_number).replace(/^\D*0*/, ""))
    );
    let n = 9999;
    while (used.has(String(n))) n--;
    ghostFlight = `UA${n}`;
  });

  test("valid-format flight with no data → 200 soft page, noindex, canonical to /check-flight", async () => {
    const res = await app.dispatch(req(`/check-flight/${ghostFlight}`, HOST));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.match(/<meta name="robots" content="([^"]+)"/)?.[1]).toContain("noindex");
    expect(html.match(/<link rel="canonical" href="([^"]+)"/)?.[1]).toBe(
      `https://${HOST}/check-flight`
    );
    // The interactive lookup form still serves — the URL is not a dead end.
    expect(html).toContain('id="check-flight-form"');
  });

  test("malformed and other-carrier segments → 404, noindex", async () => {
    for (const seg of ["UA123X", "banana", "AA123"]) {
      const res = await app.dispatch(req(`/check-flight/${seg}`, HOST));
      expect(res.status, seg).toBe(404);
      expect(await res.text(), seg).toContain("noindex");
    }
  });

  test("rendered 404s are edge-cacheable and carry nothing per-visitor", async () => {
    // /check-flight/* is unbounded — any typo, airport code or stale link lands
    // there — so a crawler sweep must be absorbed by shared caches instead of
    // re-rendering React at origin on every hit. That means the response also
    // has to be visitor-independent, which is why the onboard probe (the one
    // IP-varying slot in the template) is blanked on this path.
    for (const seg of ["PHX", "banana", "AA123"]) {
      const res = await app.dispatch(req(`/check-flight/${seg}`, HOST));
      const cc = res.headers.get("Cache-Control") ?? "";
      expect(cc, seg).toContain("s-maxage");
      expect(cc, seg).not.toContain("no-store");
      // The inline lookup script still has to run, so the CSP stays the HTML one.
      expect(res.headers.get("Content-Security-Policy"), seg).toContain("script-src");
      expect(await res.text(), seg).not.toContain("passenger-probe");
    }
  });

  test("200 renders stay private — they vary by client IP", async () => {
    const res = await app.dispatch(req("/check-flight", HOST));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });

  // A 404 must still be usable: the segment users actually mistype (an airport
  // code from the homepage form) explains itself and offers the lookup again.
  test("non-flight-number segment → 404 page with notice, form, and route-planner hint", async () => {
    const res = await app.dispatch(req("/check-flight/PHX", HOST));
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("isn&#x27;t a flight number");
    expect(html).toContain("PHX");
    expect(html).toContain('id="check-flight-form"');
    expect(html).toContain('href="/route-planner"');
    expect(html).not.toContain("The page you&#x27;re looking for doesn&#x27;t exist");
  });

  test("non-airport garbage → 404 page with notice but no route-planner hint", async () => {
    const res = await app.dispatch(req("/check-flight/phoenix%20arizona", HOST));
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("isn&#x27;t a flight number");
    expect(html).not.toContain('href="/route-planner"');
  });

  test("other-carrier segment → 404 page that never names the other carrier", async () => {
    const res = await app.dispatch(req("/check-flight/AA123", HOST));
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("AA123");
    expect(html).not.toContain("American");
  });

  test("zero-padded spelling → 301 to the canonical flight URL", async () => {
    const digits = ghostFlight.slice(2);
    const res = await app.dispatch(req(`/check-flight/UA0${digits.slice(0, 3)}`, HOST));
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(
      `https://${HOST}/check-flight/UA${Number(digits.slice(0, 3))}`
    );
  });

  test("lowercase spelling → 301, date segment preserved", async () => {
    const res = await app.dispatch(
      req(`/check-flight/${ghostFlight.toLowerCase()}/2027-06-01`, HOST)
    );
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(
      `https://${HOST}/check-flight/${ghostFlight}/2027-06-01`
    );
  });
});
