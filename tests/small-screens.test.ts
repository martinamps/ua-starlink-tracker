/**
 * Two layouts that a phone, or a larger font set in the browser, broke.
 *
 * A row of an airline's name and its stage pill. The name wraps inside
 * itself beside the pill, so every row of a list keeps its pill at the
 * right. A row that may simply wrap dropped the pill under the name on the
 * rows with the longest names and left it at the right on the others: one
 * list, pills on both sides, at 320 to 390px at the default font.
 *
 * The hangar's spec card. It is 16rem wide over px blocks, and the page's
 * side padding steps at rem breakpoints, which move with the browser's own
 * font setting. A rule that counted on one padding left the card up to 20px
 * past the window at a 24px setting.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SITES } from "../src/airlines/registry";
import { createApp } from "../src/server/app";
import { bodyOf, openSnapshot } from "./helpers";

const ROOT = join(import.meta.dir, "..");
const compiled = () => readFileSync(join(ROOT, "static/tailwind.css"), "utf8");
const hub = SITES.airline.canonicalHost;

let app: ReturnType<typeof createApp>;
beforeAll(() => {
  app = createApp(openSnapshot());
});

/** The class list of each element that directly holds a stage pill's row. */
function pillRows(html: string): { row: string; name: string }[] {
  const rows: { row: string; name: string }[] = [];
  const pattern =
    /<div class="(flex [^"]*)">\s*<span class="(flex [^"]*)">(?:(?!<\/div>).)*?<span class="[^"]*rounded-full[^"]*"/gs;
  for (const match of html.matchAll(pattern)) rows.push({ row: match[1], name: match[2] });
  return rows;
}

describe("a row of an airline's name and its stage pill", () => {
  const expectAlike = (rows: { row: string; name: string }[]) => {
    for (const { row, name } of rows) {
      const rowClasses = row.split(" ");
      // The pill stays on the name's line while the name can still wrap, and
      // takes a line of its own, at the right, only when it cannot.
      expect(rowClasses).toContain("flex-wrap");
      expect(rowClasses).toContain("justify-end");
      expect(rowClasses).not.toContain("justify-between");
      expect(name.split(" ")).toContain("flex-1");
    }
  };

  test("the hub home's list: the name takes the room the pill leaves", async () => {
    const rows = pillRows((await bodyOf(app, "/", hub)).text);
    expect(rows.length).toBeGreaterThan(1);
    expectAlike(rows);
  });

  test("a compare page's two panels: the same", async () => {
    const sitemap = (await bodyOf(app, "/sitemap.xml", hub)).text;
    const path = sitemap.match(/<loc>https:\/\/[^/]+(\/compare\/[^<]+)<\/loc>/)?.[1];
    expect(path).toBeTruthy();
    const rows = pillRows((await bodyOf(app, path as string, hub)).text);
    expect(rows).toHaveLength(2);
    expectAlike(rows);
  });

  test("the stylesheet has the rules the rows count on", () => {
    const css = compiled();
    expect(css).toMatch(/\.flex-1\{flex:1\}/);
    expect(css).toMatch(/\.flex-wrap\{flex-wrap:wrap\}/);
    expect(css).toMatch(/\.justify-end\{justify-content:flex-end\}/);
  });
});

describe("the hangar's spec card in the column before the last", () => {
  const source = readFileSync(join(ROOT, "src/styles/tailwind.css"), "utf8");
  const rule = source.match(/--spec-next:\s*([^;]+);/)?.[1] ?? "";
  // min(0px, calc(<px>px - <rem>rem + (100vw - 100cqw) / 2))
  const terms = rule.match(
    /^min\(0px, calc\((\d+(?:\.\d+)?)px - (\d+(?:\.\d+)?)rem \+ \(100vw - 100cqw\) \/ 2\)\)$/
  );

  test("moves by the page's measured margin, not an assumed padding", () => {
    expect(terms, rule).toBeTruthy();
    expect(compiled()).toContain("(100vw - 100cqw)");
  });

  test("stays inside the window at any base font, and does not move at 16px", () => {
    const [px, rem] = [Number(terms?.[1]), Number(terms?.[2])];
    const left = (font: number, margin: number) => Math.min(0, px - rem * font + margin);
    // The card starts a 1px border and the head's 0.5rem inside its block,
    // is 16rem wide, and its block's left edge is two blocks and a gap
    // (118 + 12 + 118) from the grid's right edge at the least.
    const overrun = (font: number, margin: number) =>
      1 + 0.5 * font + left(font, margin) + 16 * font - (248 + margin);
    // The page's padding from 768px at the default font is 2rem.
    expect(left(16, 32)).toBe(0);
    for (let font = 16; font <= 32; font += 0.5) {
      // px-4, sm:px-6, md:px-8, and a grid centred in a wider window.
      for (const margin of [font, 1.5 * font, 2 * font, 200]) {
        expect(overrun(font, margin), `${font}px font, ${margin}px margin`).toBeLessThanOrEqual(0);
      }
    }
  });
});
