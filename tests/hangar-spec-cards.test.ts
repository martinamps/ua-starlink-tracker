/**
 * The hangar's spec cards as a crawler, a link preview or a screen reader
 * gets them: each block's name once, then each row as its label and value,
 * apart ("CRJ700 Seats 70 Wingspan 76.3 ft"). The card draws its own heading
 * from data-name, so the name the block already shows isn't said twice, and
 * the trigger's description starts at the rows.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import { createApp } from "../src/server/app";
import { bodyOf, openSnapshot } from "./helpers";

const plain = (html: string) =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

interface Trigger {
  name: string;
  dataName: string;
  describedBy: string[];
  text: string;
}

/** Each spec trigger on the page: its markup up to the block's count line. */
function triggers(html: string): Trigger[] {
  return [...html.matchAll(/<span class="spec-trigger[\s\S]*?(?=<span class="text-xs text-muted)/g)]
    .map((m) => m[0])
    .filter((chunk) => chunk.includes("spec-card"))
    .map((chunk) => ({
      name: plain(chunk.match(/<span class="block truncate">([\s\S]*?)<\/span>/)?.[1] ?? ""),
      dataName: (chunk.match(/data-name="([^"]*)"/)?.[1] ?? "").replace(/&amp;/g, "&"),
      describedBy: (chunk.match(/aria-describedby="([^"]*)"/)?.[1] ?? "").split(" "),
      text: plain(chunk.replace(/^<span[^>]*>/, "")),
    }));
}

let app: ReturnType<typeof createApp>;
beforeAll(() => {
  app = createApp(openSnapshot());
});

describe("hangar spec cards read as separate words", () => {
  const hosts = Object.values(SITES).map((s) => s.canonicalHost);
  let seen = 0;

  for (const host of hosts) {
    test(`${host}/fleet`, async () => {
      const { status, text: html } = await bodyOf(app, "/fleet", host);
      if (status !== 200) return;
      for (const t of triggers(html)) {
        seen++;
        expect(t.name.length, host).toBeGreaterThan(0);
        expect(t.dataName).toBe(t.name);
        // The name once, then the rows, each label apart from its value.
        expect(t.text.startsWith(`${t.name} Seats `), t.text).toBe(true);
        expect(t.text).toMatch(/ Seats [\d,–]+ Wingspan [\d.–]+ ft Length [\d.–]+ ft Range /);
        expect(t.text).toMatch(/ First flight \d{4} Engines \S/);
        // The description points at the rows and the fact, both on the page.
        expect(t.describedBy).toHaveLength(2);
        for (const id of t.describedBy) expect(html).toContain(`id="${id}"`);
        expect(t.describedBy[0]).toEndWith("-rows");
        expect(t.describedBy[1]).toEndWith("-fact");
      }
    });
  }

  test("the hosts above rendered spec cards", () => {
    expect(seen).toBeGreaterThan(0);
  });
});
