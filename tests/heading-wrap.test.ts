/**
 * A heading with a name too long for a phone. "Carbondale/Murphysboro (MDH)"
 * at the display size is wider than a 390px phone's column, and a browser
 * offers no break after a slash between two names: the live route page's
 * heading ran 15px past its column, and 99px before the web font arrived.
 */

import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PageHeader, Section } from "../src/components/layout";
import { readableText } from "./helpers";

const h1 = (title: React.ReactNode) =>
  renderToStaticMarkup(React.createElement(PageHeader, { title })).match(
    /<h1[^>]*>(.*?)<\/h1>/
  )?.[1] ?? "";

describe("a heading", () => {
  test("offers a break after a slash that joins two names", () => {
    const html = h1("Which Greenville/Spartanburg (GSP) to Carbondale/Murphysboro (MDH) flights?");
    expect(html.split("<wbr/>")).toHaveLength(3);
    expect(html).toContain("Carbondale/<wbr/>Murphysboro");
  });

  test("reads the same with the breaks taken out", () => {
    const title = "Which Wilkes-Barre/Scranton (AVP) flights have Starlink?";
    expect(h1(title).replaceAll("<wbr/>", "")).toBe(title);
    const page = renderToStaticMarkup(React.createElement(PageHeader, { title }));
    expect(readableText(page)).toContain(title);
  });

  test("leaves a slash between figures, and a title with none, as they are", () => {
    for (const title of ["Open 24/7", "Boeing 737-900/900ER", "Does UA100 have Starlink Wi-Fi?"]) {
      expect(h1(title)).toBe(title);
    }
  });

  test("a section's title gets the same break, and both may wrap inside a word", () => {
    const section = renderToStaticMarkup(
      React.createElement(Section, { title: "Starlink flights from Arcata/Eureka (ACV)" }, "x")
    );
    expect(section).toContain("Arcata/<wbr/>Eureka");
    expect(section).toMatch(/<h2 class="[^"]*\bwrap-break-word\b/);
    const header = renderToStaticMarkup(React.createElement(PageHeader, { title: "x" }));
    expect(header).toMatch(/<h1 class="[^"]*\bwrap-break-word\b/);
  });
});
