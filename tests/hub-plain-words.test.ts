/**
 * The hub's flight check: first on its home page, in its menu, and answering
 * in a traveller's words. The words are the page's: /api/check-any-flight
 * keeps its own sentences, pinned by the goldens, so each test here reads the
 * API's real body and holds the page's rewrite to the server's current text.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import { type CheckAnyBody, checkAnyHtml, plainWords } from "../src/client/flight-search";
import { HUB_CHECK_ANCHOR, primaryNavLinks } from "../src/components/layout";
import { createApp } from "../src/server/app";
import { bodyOf, elementAttrs, jsonOf, openSnapshot } from "./helpers";

const HUB = SITES.airline.canonicalHost;
let app: ReturnType<typeof createApp>;
let home: string;
let tracked: string[];

// Far enough out that no aircraft is on file: the type answers' own case.
const LATER = new Date(Date.now() + 9 * 86400e3).toISOString().slice(0, 10);
const ask = (fn: string): Promise<CheckAnyBody> =>
  jsonOf(app, `/api/check-any-flight?flight_number=${fn}&date=${LATER}`, HUB);
const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'");

beforeAll(async () => {
  app = createApp(openSnapshot());
  home = (await bodyOf(app, "/", HUB)).text;
  tracked = JSON.parse(elementAttrs(home, "hub-check-flight")["data-tracked-airlines"]);
});

describe("the hub's flight check is the first thing on its home page", () => {
  test("the form comes before the rollout standings and every other section", () => {
    const form = home.indexOf('id="hub-check-flight"');
    expect(form).toBeGreaterThan(0);
    expect(form).toBeLessThan(home.indexOf("Where each tracked rollout stands"));
    expect(form).toBeLessThan(home.indexOf('id="hub-compare-route"'));
    expect(home).toContain(`id="${HUB_CHECK_ANCHOR}"`);
  });

  test("the menu leads to it", () => {
    const nav = primaryNavLinks(SITES.airline);
    expect(nav[0]).toEqual({ href: `/#${HUB_CHECK_ANCHOR}`, label: "Check a flight" });
    expect(home).toContain(`href="/#${HUB_CHECK_ANCHOR}"`);
  });

  test("an airline site's menu is unchanged at its head and names its tools plainly", () => {
    const nav = primaryNavLinks(SITES.united);
    expect(nav[0]).toEqual({ href: "/check-flight", label: "Check a flight" });
    expect(nav.some((l) => l.href.startsWith("/#"))).toBe(false);
    expect(nav).toContainEqual({ href: "/chrome", label: "Extension" });
    expect(nav).toContainEqual({ href: "/mcp", label: "AI assistants" });
    expect(nav.some((l) => l.label === "MCP")).toBe(false);
  });
});

describe("hub answers read in plain words; the API keeps its own", () => {
  test("the form lists the tracked airlines by name", () => {
    expect(tracked.length).toBeGreaterThan(1);
    for (const name of tracked) expect(name).not.toMatch(/^[A-Z0-9]{2}$/);
  });

  test("an untracked airline the API names", async () => {
    const d = await ask("DL123");
    expect(d.error).toStartWith("Airline not tracked. Tracked: ");
    expect(d.airline_info).toBeDefined();
    const page = words(checkAnyHtml(d, false, tracked));
    expect(page).not.toContain("Tracked:");
    expect(page).toContain(`We don't check ${d.airline_info?.airline} flights.`);
    expect(page).toContain(`We check flights on ${tracked[0]}`);
  });

  test("an airline code nobody has", async () => {
    const d = await ask("ZZ12");
    expect(d.error).toStartWith("Airline not tracked. Tracked: ");
    const page = words(checkAnyHtml(d, false, tracked));
    expect(page).not.toContain("Tracked:");
    expect(page).toContain(`We check flights on ${tracked[0]}`);
  });

  test("without the names, the API's own error prints", async () => {
    const d = await ask("ZZ12");
    expect(words(checkAnyHtml(d, false))).toContain(d.error as string);
  });

  for (const fn of ["AS118", "HA50"]) {
    test(`${fn}: an airline answered by aircraft type`, async () => {
      const d = await ask(fn);
      // The API's sentence still carries what the page rewrites.
      expect(d.reason ?? "").toMatch(/determined by aircraft type/);
      const page = words(checkAnyHtml(d, false, tracked));
      expect(page).not.toMatch(/determined by|per-flight prediction model|mid-installation/);
      expect(page).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(page).toContain(d.airline as string);
    });
  }

  test("HA: the date is written out, and the aircraft wait is said plainly", async () => {
    const d = await ask("HA50");
    expect(d.reason).toContain(`on ${LATER} yet`);
    const page = words(checkAnyHtml(d, false, tracked));
    expect(page).toContain("We don't know yet which plane flies it on ");
    expect(page).not.toContain(LATER);
  });

  test("a sentence with nothing to rewrite is left as the API wrote it", () => {
    const s = "N130SY (ERJ-175) — ASE → DEN";
    expect(plainWords(s)).toBe(s);
  });
});
