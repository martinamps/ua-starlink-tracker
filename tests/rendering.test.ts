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
  // markup raw: validation rejects it (generic-page fallback) and
  // escapeHtmlAttr guards the template-var boundary behind that.
  test("attribute-breakout path falls back and never appears in markup", async () => {
    const res = await app.dispatch(req("/check-flight/UA123%22%3E%3Cscript%3Ex", HOST));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('"><script>x');
    expect(html.match(/<link rel="canonical" href="([^"]+)"/)?.[1]).toBe(
      `https://${HOST}/check-flight`
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Flight permalinks: existence gate (no data → hard 404, never a soft-404 200)
// and URL normalization (one canonical spelling per flight, everything else 301).
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

  test("flight number with no data → 404, noindex, helpful body", async () => {
    const res = await app.dispatch(req(`/check-flight/${ghostFlight}`, HOST));
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("noindex");
    expect(html).toContain(ghostFlight);
    expect(html).toContain("/check-flight");
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
