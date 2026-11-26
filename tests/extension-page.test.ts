/**
 * The extension's real content.js and lib.js, run in Chromium on made-up
 * results pages, answered by the real handlers in this process.
 *
 * The unit tests call lib.js one function at a time, and passed while a
 * caller inside content.js handed the type reader the wrong arguments: an
 * opened Virgin Atlantic card never got its badge. Nothing but a run of
 * content.js itself sees that.
 *
 * No address is opened. The page is built with setContent, every request the
 * page makes is refused and counted, and a lookup goes through the same URL
 * builder as background.js into createApp(db).dispatch. The page's clock is
 * a fake one moved by hand, so the debounces cost no real time.
 *
 * Chromium comes from Playwright's own install (`bun run install-browser`),
 * or from EXTENSION_TEST_CHROMIUM. CI installs it; a machine without one
 * skips, and says so.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type Page, chromium } from "playwright";
import { AIRLINES } from "../src/airlines/registry";
import { setAssignmentFetcher } from "../src/api/flight-verdict";
import { createApp } from "../src/server/app";
import { addFlight, addPlane, makeFreshDb } from "./helpers";

const extLib = require("../chrome-extension/lib.js");

const EXT = join(import.meta.dir, "..", "chrome-extension");
const LIB_JS = readFileSync(join(EXT, "lib.js"), "utf8");
const CONTENT_JS = readFileSync(join(EXT, "content.js"), "utf8");
const VERSION: string = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8")).version;

// Inside both type rules' dates whatever day the suite runs.
const CLOCK = new Date("2026-12-01T12:00:00Z");
const DAY = "20261202";
const DEPARTS = Date.parse("2026-12-02T18:00:00Z") / 1000;

function chromiumPath(): string | null {
  const named = process.env.EXTENSION_TEST_CHROMIUM;
  if (named) return named;
  try {
    const own = chromium.executablePath();
    return existsSync(own) ? own : null;
  } catch {
    return null;
  }
}

const CHROMIUM = chromiumPath();
if (!CHROMIUM) {
  if (process.env.CI) {
    throw new Error("no Chromium for tests/extension-page.test.ts: install Playwright's browser");
  }
  console.warn(
    "SKIPPED tests/extension-page.test.ts: no Chromium. Run `bun run install-browser`, or set EXTENSION_TEST_CHROMIUM."
  );
}

type Ask = { flightNumber: string; aircraftType?: string; origin?: string; destination?: string };

let browser: Browser;
let db: Database;
let app: ReturnType<typeof createApp>;

/** What background.js does with a message, against the handlers in-process. */
async function serverAnswer(message: Record<string, string | undefined>) {
  const url = extLib.endpointFor(
    message.flightNumber,
    message.date,
    VERSION,
    { origin: message.origin, destination: message.destination },
    message.aircraftType
  );
  if (!url) return { success: false, error: "unsupported flight number or date" };
  setSystemTime(CLOCK);
  try {
    const res = await app.dispatch(new Request(url, { headers: { host: new URL(url).host } }));
    const body = await res.json().catch(() => null);
    return body && (res.ok || res.status === 400 || res.status === 404)
      ? { success: true, data: body }
      : { success: false, status: res.status };
  } finally {
    setSystemTime();
  }
}

const tim = (...segments: string[]) =>
  `<span data-travelimpactmodelwebsiteurl="https://www.travelimpactmodel.org/lookup/flight?itinerary=${segments.join(",")}"></span>`;
const closedCard = (id: string, airline: string, inner: string) =>
  `<li id="${id}"><div>10:00 AM – 1:05 PM</div><div>${airline}</div><div>7 hr 55 min</div><div>Nonstop</div>${inner}</li>`;
const details = (airline: string, type: string, flight: string, more = "") =>
  `<div class="details"><div>Travel time: 7 hr 55 min</div><div><span>${airline}</span> · <span>Economy</span> · <span>${type}</span> · <span>${flight}</span></div>${more}</div>`;

const VS3 = `LHR-JFK-VS-3-${DAY}`;
const SK903 = `CPH-ARN-SK-903-${DAY}`;
const UA544 = `ORD-DEN-UA-544-${DAY}`;
const VS_OPEN = details("Virgin Atlantic", "Airbus A350", "VS 3");

interface Run {
  page: Page;
  asks: Ask[];
  /** Moves the page's clock on, then waits until every lookup has answered. */
  advance(ms?: number): Promise<void>;
  /** Appends markup inside the card `id`, as a page opening it in place does. */
  append(id: string, html: string): Promise<void>;
  /** A new, unrelated card joins the list: every pass looks at all cards. */
  addOtherCard(): Promise<void>;
  badge(id: string): Promise<{ text: string; title: string; label: string | null } | null>;
  /** Every time one of our badges went into ("+") or out of ("-") the page. */
  badgeMoves(): Promise<string[]>;
  refused: string[];
  close(): Promise<void>;
}

async function openPage(cards: string, lang = "en"): Promise<Run> {
  const context = await browser.newContext({ viewport: { width: 800, height: 900 } });
  const refused: string[] = [];
  await context.route("**/*", (route) => {
    refused.push(route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const asks: Ask[] = [];
  let inFlight = 0;
  await page.exposeFunction("__serverAnswer", async (message: Record<string, string>) => {
    asks.push(message as unknown as Ask);
    inFlight++;
    try {
      return await serverAnswer(message);
    } finally {
      inFlight--;
    }
  });
  await page.clock.install({ time: CLOCK });
  await page.setContent(
    `<!doctype html><html lang="${lang}"><body><ul>${cards}</ul></body></html>`
  );
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    w.chrome = {
      runtime: {
        sendMessage: (m: unknown) => (w.__serverAnswer as (m: unknown) => Promise<unknown>)(m),
      },
    };
    const moves: string[] = [];
    w.__badgeMoves = moves;
    const ours = (n: Node): n is Element =>
      n.nodeType === 1 && (n as Element).classList.contains("starlink-wifi-badge");
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const n of m.addedNodes) if (ours(n)) moves.push(`+${n.textContent}`);
        for (const n of m.removedNodes) if (ours(n)) moves.push(`-${n.textContent}`);
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  });
  await page.addScriptTag({ content: LIB_JS });
  await page.addScriptTag({ content: CONTENT_JS });

  const idle = async () => {
    for (let quiet = 0; quiet < 3; ) {
      await page.evaluate(() => 0);
      quiet = inFlight === 0 ? quiet + 1 : 0;
      if (inFlight > 0) await new Promise((r) => setTimeout(r, 5));
    }
  };
  const advance = async (ms = 3000) => {
    // In steps: an answer that lands mid-way can set a timer of its own.
    for (let done = 0; done < ms; done += 500) {
      await page.clock.runFor(500);
      await idle();
    }
  };
  await advance();

  return {
    page,
    asks,
    refused,
    advance,
    append: async (id, html) => {
      await page.evaluate(
        ([cardId, markup]) =>
          document.getElementById(cardId)?.insertAdjacentHTML("beforeend", markup),
        [id, html] as const
      );
      await advance();
    },
    addOtherCard: async () => {
      await page.evaluate((day) => {
        const li = document.createElement("li");
        li.innerHTML = `<div>Other</div><span data-travelimpactmodelwebsiteurl="x?itinerary=BOS-LAX-DL-1-${day}"></span>`;
        document.querySelector("ul")?.appendChild(li);
      }, DAY);
      await advance();
    },
    badge: (id) =>
      page.evaluate((cardId) => {
        const el = document.getElementById(cardId)?.querySelector(".starlink-wifi-badge");
        return el
          ? {
              text: el.textContent ?? "",
              title: el.getAttribute("title") ?? "",
              label: el.getAttribute("aria-label"),
            }
          : null;
      }, id),
    badgeMoves: () =>
      page.evaluate(() => (window as unknown as { __badgeMoves: string[] }).__badgeMoves),
    close: () => context.close(),
  };
}

const typesAsked = (run: Run, flightNumber: string) =>
  run.asks.filter((a) => a.flightNumber === flightNumber).map((a) => a.aircraftType ?? null);

describe.skipIf(!CHROMIUM)("content.js in a page", () => {
  beforeAll(async () => {
    setAssignmentFetcher(() => Promise.resolve([]));
    db = makeFreshDb();
    addPlane(db, "N544UA", "Starlink");
    addFlight(db, "N544UA", "UA544", "ORD", DEPARTS, { arrivalAirport: "DEN" });
    addFlight(db, "N544UA", "UA545", "ORD", DEPARTS, { arrivalAirport: "BOS" });
    app = createApp(db);
    browser = await chromium.launch({ executablePath: CHROMIUM ?? undefined, timeout: 30_000 });
  }, 40_000);

  afterAll(async () => {
    setAssignmentFetcher(null);
    await browser?.close();
    db?.close();
  });

  const inPage = (name: string, cards: string, body: (run: Run) => Promise<void>, lang = "en") =>
    test(name, async () => {
      const run = await openPage(cards, lang);
      try {
        await body(run);
        expect(run.refused).toEqual([]);
      } finally {
        await run.close();
      }
    }, 30_000);

  // The owner's guide, steps 1 to 3. On 897f00d the badge never came: the
  // pass that looks again at a settled card read its type with the reader's
  // old arguments, and always got none.
  inPage(
    "a closed Virgin Atlantic card gets its badge once its details open in place",
    closedCard("vs", "Virgin Atlantic", tim(VS3)),
    async (run) => {
      expect(await run.badge("vs")).toBeNull();
      expect(typesAsked(run, "VS3")).toEqual([null]);

      await run.append("vs", VS_OPEN + tim(VS3));
      expect((await run.badge("vs"))?.text).toBe("Starlink (likely)");
      expect(typesAsked(run, "VS3")).toEqual([null, "Airbus A350"]);

      await run.addOtherCard();
      await run.addOtherCard();
      expect((await run.badge("vs"))?.text).toBe("Starlink (likely)");
      expect(await run.badgeMoves()).toEqual(["+Starlink (likely)"]);
      expect(typesAsked(run, "VS3")).toEqual([null, "Airbus A350"]);
    }
  );

  // Nothing says the opened details repeat the itinerary attribute, the one
  // thing that used to wake a pass.
  inPage(
    "the opened details need not carry the itinerary data again",
    closedCard("vs", "Virgin Atlantic", tim(VS3)),
    async (run) => {
      expect(await run.badge("vs")).toBeNull();
      await run.append("vs", VS_OPEN);
      expect((await run.badge("vs"))?.text).toBe("Starlink (likely)");
      expect(await run.badgeMoves()).toEqual(["+Starlink (likely)"]);
    }
  );

  // The badge's own label says "not a partner airline's", which the reader
  // takes for an operator line: read back, it took the badge off and the next
  // pass put it on again, for as long as the page lived.
  inPage(
    "a badge once shown stays, and is never read back as the card's own words",
    closedCard("vs", "Virgin Atlantic", VS_OPEN + tim(VS3)),
    async (run) => {
      const shown = await run.badge("vs");
      expect(shown?.text).toBe("Starlink (likely)");
      expect(shown?.label).toContain("not a partner airline's");
      await run.addOtherCard();
      await run.append("vs", "<div>Average legroom (31 in)</div>");
      await run.addOtherCard();
      expect((await run.badge("vs"))?.text).toBe("Starlink (likely)");
      expect(await run.badgeMoves()).toEqual(["+Starlink (likely)"]);
      expect(typesAsked(run, "VS3")).toEqual(["Airbus A350"]);
    }
  );

  inPage(
    "the tooltip carries Virgin Atlantic's own caution, from the server's real answer",
    closedCard("vs", "Virgin Atlantic", VS_OPEN + tim(VS3)) +
      closedCard("sk", "SAS", details("SAS", "Airbus A320neo", "SK 903") + tim(SK903)),
    async (run) => {
      const rule = AIRLINES.VS.statementRule;
      if (!rule || rule.by !== "type" || !rule.caution) throw new Error("VS rule has no caution");
      const vs = await run.badge("vs");
      expect(vs?.title).toContain(`"${rule.quote}" ${rule.caution}. The tracker goes by`);
      expect(vs?.label).toContain(rule.caution);
      const sk = await run.badge("sk");
      expect(sk?.text).toBe("Starlink (likely)");
      expect(sk?.title).toContain(`${AIRLINES.SK.statementRule?.quote}" The tracker goes by`);
      expect(sk?.title).not.toContain("may vary");
    }
  );

  inPage(
    "an operator line that appears on an open card takes the badge off",
    closedCard("vs", "Virgin Atlantic", VS_OPEN + tim(VS3)),
    async (run) => {
      expect((await run.badge("vs"))?.text).toBe("Starlink (likely)");
      await run.append("vs", "<div>Operated by Delta</div>");
      expect(await run.badge("vs")).toBeNull();
      expect(await run.badgeMoves()).toEqual(["+Starlink (likely)", "-Starlink (likely)"]);
    }
  );

  inPage(
    "a partner's card, an A350-900 and a plain A320 get none",
    closedCard(
      "partner",
      "Virgin Atlantic",
      details("Virgin Atlantic", "Airbus A350", "VS 3", "<div>Operated by Delta</div>") + tim(VS3)
    ) +
      closedCard(
        "a359",
        "Virgin Atlantic",
        `<div>Travel time: 7 hr 55 min</div><div>Airbus A350</div><div>(900)</div><div>VS 5</div>${tim(`LHR-MIA-VS-5-${DAY}`)}`
      ) +
      closedCard(
        "ceo",
        "SAS",
        details("SAS", "Airbus A320", "SK 1460") + tim(`CPH-OSL-SK-1460-${DAY}`)
      ),
    async (run) => {
      for (const id of ["partner", "a359", "ceo"]) expect(await run.badge(id)).toBeNull();
      expect(typesAsked(run, "VS3")).toEqual([null]);
      expect(typesAsked(run, "VS5")).toEqual([null]);
      expect(await run.badgeMoves()).toEqual([]);
    }
  );

  inPage(
    "a page that is not in English gets no type badge",
    `<li id="vs"><div>10:00 – 13:05</div><div>Virgin Atlantic</div><div>7 Std. 55 Min.</div><div>Virgin Atlantic · Economy · Airbus A350 · VS 3</div>${tim(VS3)}</li>`,
    async (run) => {
      expect(await run.badge("vs")).toBeNull();
      expect(typesAsked(run, "VS3")).toEqual([null]);
    },
    "de"
  );

  // The itinerary pattern wanted a letter first in an airline's code, so the
  // IndiGo and Cape Air legs were not seen and each card counted as one flight.
  inPage(
    "a second flight on an airline whose code starts with a digit keeps the card unbadged",
    [
      `<li id="vs6e"><div>Virgin Atlantic, IndiGo</div><div>14 hr 5 min</div><div>1 stop</div>`,
      details("Virgin Atlantic", "Airbus A350", "VS 302"),
      "<div>2 hr layover</div>",
      details("IndiGo", "Airbus A350", "6E 5001"),
      tim(`LHR-DEL-VS-302-${DAY}`, `DEL-BLR-6E-5001-${DAY}`),
      "</li>",
      `<li id="ua9k"><div>United, Cape Air</div><div>5 hr</div><div>1 stop</div>`,
      tim(`ORD-BOS-UA-545-${DAY}`, `BOS-ACK-9K-12-${DAY}`),
      "</li>",
      closedCard("ua", "United", tim(`ORD-BOS-UA-545-${DAY}`)),
    ].join(""),
    async (run) => {
      expect(await run.badge("vs6e")).toBeNull();
      expect(await run.badge("ua9k")).toBeNull();
      // The same United flight alone is badged: the answer was a yes.
      expect((await run.badge("ua"))?.text).toBe("Starlink");
      expect(run.asks.map((a) => a.flightNumber)).toEqual(["UA545"]);
    }
  );

  inPage(
    "United's badge: one lookup, one badge, through an opened card and a changing list",
    closedCard("ua", "United", tim(UA544)),
    async (run) => {
      expect((await run.badge("ua"))?.text).toBe("Starlink");
      await run.append("ua", details("United", "Boeing 737", "UA 544") + tim(UA544));
      await run.addOtherCard();
      expect((await run.badge("ua"))?.text).toBe("Starlink");
      expect(await run.badgeMoves()).toEqual(["+Starlink"]);
      expect(run.asks).toEqual([
        {
          action: "checkFlight",
          flightNumber: "UA544",
          date: "2026-12-02",
          origin: "ORD",
          destination: "DEN",
        } as Ask,
      ]);
    }
  );
});
