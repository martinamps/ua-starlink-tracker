/**
 * Template rendering: renderHtml is a single pass over the template — data
 * values containing {{...}} or $-replacement patterns pass through literally —
 * and every HTML page claims its own path in canonical, og:url, and the
 * WebPage JSON-LD (subpages must not canonicalize to the homepage).
 */

import { beforeAll, describe, expect, test } from "bun:test";
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

  beforeAll(() => {
    app = createApp(openSnapshot());
  });

  test.each(["/", "/check-flight", "/check-flight/UA123", "/fleet", "/route-planner"])(
    "%s",
    async (path) => {
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
    }
  );

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
