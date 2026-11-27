/**
 * A heading with a name too long for a phone. "Carbondale/Murphysboro (MDH)"
 * at the display size is wider than a 390px phone's column, and a browser
 * offers no break after a slash between two names: the live route page's
 * heading ran 15px past its column, and 99px before the web font arrived.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PageHeader, Section } from "../src/components/layout";
import { AIRPORT_NAMES } from "../src/utils/airport-names";
import { readableText } from "./helpers";

const header = (title: React.ReactNode) =>
  renderToStaticMarkup(React.createElement(PageHeader, { title }));
const h1 = (title: React.ReactNode) => header(title).match(/<h1[^>]*>(.*?)<\/h1>/)?.[1] ?? "";
const NAME = (first: string, second: string) =>
  `<span class="inline-block max-w-full">${first}<wbr/>${second}</span>`;

describe("a heading", () => {
  test("offers a break after the slash of an airport's name", () => {
    const html = h1("Which Greenville/Spartanburg (GSP) to Carbondale/Murphysboro (MDH) flights?");
    expect(html.split("<wbr/>")).toHaveLength(3);
    expect(html).toContain(NAME("Carbondale/", "Murphysboro"));
    expect(html).toContain(NAME("Greenville/", "Spartanburg"));
  });

  test("keeps the name in a box of its own, so it breaks only when wider than the column", () => {
    // The box moves to the next line whole, as the unbroken word did; only
    // the word with the slash is in it, so "Worth" still wraps by itself.
    expect(h1("Starlink flights from Dallas/Fort Worth (DFW)")).toBe(
      `Starlink flights from ${NAME("Dallas/", "Fort")} Worth (DFW)`
    );
    expect(h1("Minneapolis/St. Paul (MSP) to Pasco/Tri-Cities (PSC)")).toBe(
      `${NAME("Minneapolis/", "St.")} Paul (MSP) to ${NAME("Pasco/", "Tri-")}Cities (PSC)`
    );
    // A code tied to its city by a no-break space stays tied: the box holds both.
    expect(h1("Which Arcata/Eureka\u00a0(ACV) to Chicago\u00a0(ORD) flights?")).toBe(
      `Which ${NAME("Arcata/", "Eureka\u00a0(ACV)")} to Chicago\u00a0(ORD) flights?`
    );
    expect(h1("Wilkes-Barre/Scranton, Seattle/Tacoma")).toBe(
      `Wilkes-${NAME("Barre/", "Scranton,")} ${NAME("Seattle/", "Tacoma")}`
    );
    const css = readFileSync(join(import.meta.dir, "../static/tailwind.css"), "utf8");
    expect(css).toMatch(/\.inline-block\{display:inline-block\}/);
    expect(css).toMatch(/\.max-w-full\{max-width:100%\}/);
  });

  test("reads the same with the breaks taken out", () => {
    const title = "Which Wilkes-Barre/Scranton (AVP) flights have Starlink?";
    // The box starts after the hyphen, where a browser breaks by itself.
    expect(h1(title)).toContain(`Wilkes-${NAME("Barre/", "Scranton")}`);
    expect(readableText(h1(title))).toBe(title);
    expect(readableText(header(title))).toContain(title);
  });

  test("names itself as written, since a browser reads the two halves apart", () => {
    const title = "Carbondale/Murphysboro (MDH) to Chicago (ORD)";
    expect(header(title)).toMatch(
      /<h1 class="[^"]*" aria-label="Carbondale\/Murphysboro \(MDH\) to Chicago \(ORD\)">/
    );
    expect(header("Chicago (ORD) to Denver (DEN)")).not.toContain("aria-label");
  });

  test("leaves every slash that is not an airport's name as it is", () => {
    for (const title of [
      "Open 24/7",
      "Boeing 737-900/900ER",
      "Does UA100 have Starlink Wi-Fi?",
      "N/A",
      "Wi-Fi and/or Starlink",
      "Wi-Fi/Starlink by airline",
      "See /routes/Seattle/Tacoma/flights",
      "NewSeattle/Tacoma",
      "Seattle/Tacoma-bound",
    ]) {
      expect(h1(title)).toBe(title);
      expect(header(title)).not.toContain("aria-label");
    }
  });

  test("every slashed name in the airport table gets its break", () => {
    const slashed = Object.values(AIRPORT_NAMES)
      .map(([city]) => city)
      .filter((city) => city.includes("/"));
    expect(slashed.length).toBeGreaterThan(0);
    for (const city of slashed) {
      const title = `Starlink flights from ${city} (XXX)`;
      const html = h1(title);
      expect(html.split("<wbr/>"), city).toHaveLength(2);
      expect(readableText(html), city).toBe(title);
    }
  });

  test("a section's title gets the same break, and both may wrap inside a word", () => {
    const section = renderToStaticMarkup(
      React.createElement(Section, { title: "Starlink flights from Arcata/Eureka (ACV)" }, "x")
    );
    expect(section).toContain(NAME("Arcata/", "Eureka"));
    expect(section).toMatch(
      /<h2 class="[^"]*\bwrap-break-word\b[^"]*" aria-label="Starlink flights from Arcata\/Eureka \(ACV\)">/
    );
    expect(header("x")).toMatch(/<h1 class="[^"]*\bwrap-break-word\b/);
  });
});
