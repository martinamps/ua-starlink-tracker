/**
 * On /fleet a square and a registry row name their tail's Wi-Fi in a title
 * and an accessible name. Those words are the page's own, the ones its
 * legends print, which differ by site: the hub says "No data yet" where the
 * default says "Not checked yet", since nobody checks some of its airlines'
 * aircraft one by one.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import { PROVIDER_LABEL } from "../src/components/fleet/providers";
import { createApp } from "../src/server/app";
import { bodyOf, openSnapshot } from "./helpers";

const HOSTS = Object.values(SITES).map((s) => s.canonicalHost);
const HIDDEN = / (?:title|aria-label)="[^"]*"/g;

describe("the fleet page's squares and registry rows use the page's own Wi-Fi labels", () => {
  let app: ReturnType<typeof createApp>;
  beforeAll(() => {
    app = createApp(openSnapshot());
  });

  test.each(HOSTS)("%s: no title names a Wi-Fi label the legends don't print", async (host) => {
    const page = await bodyOf(app, "/fleet", host);
    if (page.status !== 200) return;
    const main = page.text.slice(page.text.indexOf("<main"), page.text.indexOf("</main>"));
    const printed = main.replace(HIDDEN, "");
    const marks = (re: RegExp) =>
      [...main.matchAll(re)].map((m) => m[0].match(/ title="([^"]*)"/)?.[1] ?? "");
    const rows = marks(/<a id="t-[^>]*>/g);
    const squares = marks(/<a href="#t-[^>]*>/g);
    expect(rows.length).toBe(squares.length);
    for (const label of Object.values(PROVIDER_LABEL)) {
      if (printed.includes(label)) continue;
      for (const title of [...rows, ...squares]) expect(title).not.toContain(label);
    }
  });

  test("the hub relabels at least one provider, so the check above has teeth", async () => {
    const page = await bodyOf(app, "/fleet", "airlinestarlinktracker.com");
    const printed = page.text.replace(HIDDEN, "");
    expect(Object.values(PROVIDER_LABEL).some((label) => !printed.includes(label))).toBe(true);
  });
});
