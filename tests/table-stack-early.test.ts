import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { DataTable } from "../src/components/layout";
import { TABLE_FRAME, TABLE_FRAME_EARLY } from "../src/components/ui/box-classes";

const css = readFileSync(`${import.meta.dir}/../src/styles/tailwind.css`, "utf8");
const src = (f: string) => readFileSync(`${import.meta.dir}/../src/${f}`, "utf8");

describe("tables that stack early", () => {
  test("the early frame's padding and the table's extra width are the same length", () => {
    const pad = css.match(/\.table-stack-early \{\s*padding-inline-end: ([\d.]+rem);/)?.[1];
    const back = css.match(
      /\.table-stack-early > \.table-stack \{\s*width: calc\(100% \+ ([\d.]+rem)\);/
    )?.[1];
    expect(pad).toBeDefined();
    expect(back).toBe(pad);
  });

  test("DataTable draws the early frame only when asked", () => {
    const plain = renderToStaticMarkup(DataTable({ children: null }));
    const early = renderToStaticMarkup(DataTable({ stackEarly: true, children: null }));
    expect(plain).toContain(`class="${TABLE_FRAME}"`);
    expect(early).toContain(`class="${TABLE_FRAME_EARLY}"`);
    expect(early).not.toContain("stackEarly");
  });

  // Each of these, at the default font, ran past its panel's border on a
  // phone under about 350px wide; the airport page's departures table fits.
  test("the wide tables ask for it, and the airport page's doesn't", () => {
    for (const f of [
      "components/routes-page.tsx",
      "components/route-flights.tsx",
      "components/airport-ranking.tsx",
    ]) {
      expect(src(f)).toContain("<DataTable stackEarly");
    }
    expect(src("client/route-flights.ts")).toContain("${TABLE_FRAME_EARLY}");
    expect(src("components/airport-page.tsx")).not.toContain("stackEarly");
  });
});
