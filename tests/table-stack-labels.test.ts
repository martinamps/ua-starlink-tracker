/**
 * A DataTable stacks its rows into cards once its column is under 15rem (a
 * larger browser font on a phone), and its headings are then hidden. A bare
 * count in such a card can't say what it counts, so the cells that hold one
 * carry a label that only the stacked layout draws. These tests pin both
 * halves: the label reaches the markup, and the CSS that draws it lives only
 * inside the stacking rule, so the default-size table is untouched. That
 * /routes labels its cells is pinned in airport-ranking.test.ts, on rows it seeds.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Td } from "../src/components/layout";

const cell = (props: React.ComponentProps<typeof Td>) =>
  renderToStaticMarkup(React.createElement("tr", null, React.createElement(Td, props)));

describe("Td's label", () => {
  test("is written as data-label, and is absent when not given", () => {
    expect(cell({ label: "Today", children: "2" })).toContain('data-label="Today"');
    expect(cell({ children: "2" })).not.toContain("data-label");
  });

  test("asks for the inline form only beside a label", () => {
    expect(cell({ label: "#", labelInline: true, children: "1" })).toContain("data-label-inline");
    expect(cell({ labelInline: true, children: "1" })).not.toContain("data-label-inline");
  });
});

describe("the stylesheet", () => {
  const css = readFileSync(join(import.meta.dir, "../src/styles/tailwind.css"), "utf8");

  /** The body of the first block that opens with `head`, braces balanced. */
  const block = (head: string) => {
    const start = css.indexOf(head);
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = css.indexOf("{", start); i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
    }
    throw new Error(`unclosed ${head}`);
  };

  test("draws labels only inside the stacking rule", () => {
    const stack = block("@container (width < 15rem)");
    const outside = css.replace(stack, "");
    expect(stack).toContain("td[data-label]::before");
    expect(stack).toContain("td[data-label-inline]::before");
    expect(outside).not.toContain("data-label");
  });

  test("keeps the drawn label out of what screen readers announce", () => {
    // The column heading still names the cell; the empty alternative text
    // stops the label being read a second time.
    expect(block("@container (width < 15rem)")).toContain('content: attr(data-label) / "";');
  });
});
