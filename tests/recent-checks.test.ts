/**
 * "Your flights": the dated flights a browser checked, kept in that browser
 * and listed on the homepage with each one's answer now.
 *
 * Seeded on a fresh database. What is pinned: storage that throws, is absent
 * or holds junk never breaks a page and never yields a row; a flight leaves
 * when its date is over; a change note is printed only for a change that
 * happened, and never on first sight; the row's answer is the flight page's
 * own headline, word for word, a yes for some legs included; the served
 * homepage holds nothing of the list; the two addresses the script calls
 * answer only a browser on our own page, add no route and no tag key, and
 * count one fixed word.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import {
  FRESH_SEC,
  RECENT_KEY,
  RECENT_MAX,
  type RecentCheck,
  type RecentStore,
  type RowAnswer,
  type RowRead,
  type Seen,
  airlineAnswerHtml,
  changeNote,
  checkKey,
  checkedWhen,
  clearChecks,
  currentChecks,
  forgetCheck,
  freshAnswer,
  hubAnswerHtml,
  hubSeen,
  hubWords,
  inShowOrder,
  overEverywhere,
  readRecent,
  recentRowHtml,
  recentSectionHtml,
  rememberCheck,
  rememberHubCheck,
  rememberRead,
  writeRecent,
} from "../src/client/recent-checks";
import { labelPhrase } from "../src/components/ui/format";
import { COUNTERS, metrics, normalizeRecentAction } from "../src/observability/metrics";
import { createApp } from "../src/server/app";
import { RECENT_PREFIX, RECENT_TAP_PATH } from "../src/server/recent-checks";
import { addFleet, addFlight, addPlane, makeFreshDb, req } from "./helpers";

const UA = SITES.united.canonicalHost;
const AS = SITES.alaska.canonicalHost;
const HUB = SITES.airline.canonicalHost;
const HOUR = 3600;
const DAY = 86400;
const now = Math.floor(Date.now() / 1000);
const isoDay = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);
const SOON = isoDay(now + 2 * DAY);
const LATER = isoDay(now + 9 * DAY);
const LONG_AGO = isoDay(now - 30 * DAY);
const BROWSER =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const OUR_PAGE = { "sec-fetch-site": "same-origin", "user-agent": BROWSER };

/** A working store over a plain map. */
function memoryStore(initial?: string): RecentStore & { data: Map<string, string> } {
  const data = new Map<string, string>(initial === undefined ? [] : [[RECENT_KEY, initial]]);
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
    removeItem: (k) => {
      data.delete(k);
    },
  };
}

/** Reads, and refuses every write: a full quota, or legacy Safari private mode. */
function readOnlyStore(initial?: string): RecentStore {
  const inner = memoryStore(initial);
  return {
    getItem: inner.getItem,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => {
      throw new Error("SecurityError");
    },
  };
}

/** Throws on everything: site data blocked. */
const deadStore: RecentStore = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("SecurityError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

const yes = (tail = "N37529"): Seen => ({ tone: "yes", firm: true, tails: [tail] });
const no = (tail = "N4VIA"): Seen => ({ tone: "no", firm: true, tails: [tail] });
const forecast = (tone = "likely"): Seen => ({ tone, firm: false, tails: [] });
const check = (f: string, d = SOON, extra: Partial<RecentCheck> = {}) => ({
  f,
  d,
  seen: yes(),
  ...extra,
});

describe("what is kept", () => {
  test("a check is kept, and read back as it was written", () => {
    const store = memoryStore();
    expect(rememberCheck(store, check("UA1932", SOON, { o: "DEN", a: "ORD" }), now)).toBe(true);
    expect(readRecent(store)).toEqual([
      { f: "UA1932", d: SOON, o: "DEN", a: "ORD", seen: yes(), at: now },
    ]);
  });

  test("checking a flight again replaces its row and what it last said", () => {
    const store = memoryStore();
    rememberCheck(store, check("UA1932"), now - DAY);
    rememberCheck(store, check("UA500", SOON, { seen: no() }), now - HOUR);
    rememberCheck(store, check("UA1932", SOON, { seen: yes("N27539") }), now);
    const list = readRecent(store);
    expect(list.map((c) => c.f).sort()).toEqual(["UA1932", "UA500"]);
    expect(list.find((c) => c.f === "UA1932")).toMatchObject({ seen: yes("N27539"), at: now });
  });

  test("the same number on another date or leg is its own row", () => {
    const store = memoryStore();
    rememberCheck(store, check("UA403"), now);
    rememberCheck(store, check("UA403", LATER), now);
    rememberCheck(store, check("UA403", SOON, { o: "ORD", a: "FLL" }), now);
    expect(readRecent(store)).toHaveLength(3);
    expect(new Set(readRecent(store).map(checkKey)).size).toBe(3);
  });

  test(`at most ${RECENT_MAX}: one more pushes out the row looked at longest ago`, () => {
    const store = memoryStore();
    for (let i = 0; i < RECENT_MAX; i++) {
      rememberCheck(store, check(`UA${100 + i}`), now - (RECENT_MAX - i) * HOUR);
    }
    // Looked at again, so it is no longer the oldest.
    rememberCheck(store, check("UA100"), now - 60);
    rememberCheck(store, check("UA999"), now);
    const kept = readRecent(store).map((c) => c.f);
    expect(kept).toHaveLength(RECENT_MAX);
    expect(kept).toContain("UA999");
    expect(kept).toContain("UA100");
    expect(kept).not.toContain("UA101");
  });

  test("nothing off-shape is kept: a date already over, a bad number, a bad airport", () => {
    const store = memoryStore();
    expect(rememberCheck(store, check("UA1932", LONG_AGO), now)).toBe(false);
    expect(rememberCheck(store, check("ua 1932"), now)).toBe(false);
    expect(rememberCheck(store, check("UA1932", "tomorrow"), now)).toBe(false);
    expect(rememberCheck(store, check("UA1932", SOON, { o: "KDEN" }), now)).toBe(false);
    expect(
      rememberCheck(store, check("UA1932", SOON, { seen: { ...yes(), tone: "x" } }), now)
    ).toBe(false);
    expect(store.data.size).toBe(0);
  });

  test("one row removed, and the whole list cleared", () => {
    const store = memoryStore();
    rememberCheck(store, check("UA1932"), now);
    rememberCheck(store, check("UA500"), now);
    forgetCheck(store, checkKey(check("UA1932")));
    expect(readRecent(store).map((c) => c.f)).toEqual(["UA500"]);
    clearChecks(store);
    expect(store.data.has(RECENT_KEY)).toBe(false);
    // The last row removed leaves no key behind either.
    rememberCheck(store, check("UA500"), now);
    forgetCheck(store, checkKey(check("UA500")));
    expect(store.data.has(RECENT_KEY)).toBe(false);
  });

  test("the next departure is listed first", () => {
    const list = [
      { ...check("UA2", LATER), at: now },
      { ...check("UA1"), at: now - HOUR },
      { ...check("UA3"), at: now },
    ];
    expect(inShowOrder(list).map((c) => c.f)).toEqual(["UA3", "UA1", "UA2"]);
  });
});

describe("storage that fails", () => {
  const kept = JSON.stringify([{ ...check("UA1932"), at: now }]);

  test("no storage at all: nothing kept, nothing read, nothing thrown", () => {
    expect(rememberCheck(null, check("UA1932"), now)).toBe(false);
    expect(readRecent(null)).toEqual([]);
    expect(currentChecks(null, now)).toEqual([]);
    expect(() => forgetCheck(null, "x")).not.toThrow();
    expect(() => clearChecks(null)).not.toThrow();
  });

  test("storage that throws on every call reads as empty", () => {
    expect(readRecent(deadStore)).toEqual([]);
    expect(currentChecks(deadStore, now)).toEqual([]);
    expect(rememberCheck(deadStore, check("UA1932"), now)).toBe(false);
    expect(writeRecent(deadStore, [])).toBe(false);
    expect(() => forgetCheck(deadStore, "x")).not.toThrow();
    expect(() => clearChecks(deadStore)).not.toThrow();
  });

  test("storage that reads and refuses writes still lists what it holds", () => {
    const store = readOnlyStore(kept);
    expect(readRecent(store).map((c) => c.f)).toEqual(["UA1932"]);
    expect(rememberCheck(store, check("UA500"), now)).toBe(false);
    expect(() => forgetCheck(store, checkKey(check("UA1932")))).not.toThrow();
    expect(() => clearChecks(store)).not.toThrow();
  });

  test.each([
    ["not JSON", "{{{"],
    ["not a list", '{"f":"UA1"}'],
    ["a list of junk", '[1,null,"UA1",[],{}]'],
    ["a string", '"UA1932"'],
    ["empty", ""],
  ])("stored text that is %s yields no row", (_, text) => {
    expect(readRecent(memoryStore(text))).toEqual([]);
  });

  test("a stored row with anything off-shape is dropped whole; the rest stand", () => {
    const good = { ...check("UA500"), at: now };
    const bad = [
      { ...good, f: '"><img src=x onerror=alert(1)>' },
      { ...good, f: "UA1", d: "2026-13-40x" },
      { ...good, f: "UA2", o: "<b>" },
      { ...good, f: "UA3", t: "x".repeat(41) },
      { ...good, f: "UA4", seen: { tone: "yes", firm: "true", tails: [] } },
      { ...good, f: "UA5", seen: { tone: "yes", firm: true, tails: ["<script>"] } },
      { ...good, f: "UA6", seen: { tone: "yes", firm: true, tails: Array(7).fill("N1") } },
      { ...good, f: "UA7", at: "now" },
      { ...good, f: "UA9", h: "x".repeat(401) },
      { ...good, f: "UA10", h: 7 },
      { ...good, f: "UA11", k: "x".repeat(41) },
      { ...good, f: "UA8", at: null },
    ];
    const store = memoryStore(JSON.stringify([...bad, good, good]));
    // The duplicate of the one good row is dropped too.
    expect(readRecent(store)).toEqual([good]);
  });

  test("more rows than the limit, written by anything else, are cut to it", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ ...check(`UA${i + 1}`), at: now }));
    expect(readRecent(memoryStore(JSON.stringify(many)))).toHaveLength(RECENT_MAX);
  });
});

describe("when a flight leaves", () => {
  test("a date is over everywhere only once the last place on Earth has left it", () => {
    const noonUtc = Date.UTC(2027, 5, 10, 12) / 1000;
    // Still June 9 at UTC-12 until 12:00 UTC on June 10.
    expect(overEverywhere("2027-06-09", noonUtc - 1)).toBe(false);
    expect(overEverywhere("2027-06-09", noonUtc)).toBe(true);
    expect(overEverywhere("2027-06-10", noonUtc + DAY - 1)).toBe(false);
  });

  test("a flight whose date is over is dropped from the list and from storage", () => {
    const rows = [
      { ...check("UA1", LONG_AGO), at: now - 31 * DAY },
      { ...check("UA2"), at: now },
    ];
    const store = memoryStore(JSON.stringify(rows));
    expect(currentChecks(store, now).map((c) => c.f)).toEqual(["UA2"]);
    expect(JSON.parse(store.data.get(RECENT_KEY) ?? "[]")).toHaveLength(1);
  });

  test("with every flight over, the key itself goes", () => {
    const store = memoryStore(JSON.stringify([{ ...check("UA1", LONG_AGO), at: now - 31 * DAY }]));
    expect(currentChecks(store, now)).toEqual([]);
    expect(store.data.has(RECENT_KEY)).toBe(false);
  });
});

describe("the change note", () => {
  const WHEN = "on Nov 25";

  test("none on first sight: the answer just kept, read again unchanged", () => {
    for (const seen of [yes(), no(), forecast(), forecast("unknown")]) {
      expect(changeNote(seen, { ...seen, tails: [...seen.tails] }, WHEN)).toBeNull();
    }
  });

  const odds = (tone: string, figure: string): Seen => ({ ...forecast(tone), odds: figure });

  test("odds that drift within a tier are no change", () => {
    expect(changeNote(odds("likely", "74%"), odds("likely", "81%"), WHEN)).toBeNull();
    expect(changeNote(odds("unlikely", "12%"), odds("unlikely", "21%"), WHEN)).toBeNull();
    expect(changeNote(odds("maybe", "52%"), odds("maybe", "43%"), WHEN)).toBeNull();
    // "Not sure yet" either side is no answer to compare.
    expect(changeNote(forecast("unknown"), odds("likely", "74%"), WHEN)).toBeNull();
    expect(changeNote(odds("likely", "74%"), forecast("unknown"), WHEN)).toBeNull();
  });

  test("odds that moved ten points, or across a cut, say what they were", () => {
    expect(changeNote(odds("likely", "74%"), odds("unlikely", "31%"), WHEN)).toBe(
      "Changed since you checked on Nov 25: the odds were about 74%."
    );
    expect(changeNote(odds("likely", "84%"), odds("likely", "74%"), WHEN)).toBe(
      "Changed since you checked on Nov 25: the odds were about 84%."
    );
    // 71% to 68% is three points, and across the likely cut.
    expect(changeNote(odds("likely", "71%"), odds("maybe", "68%"), WHEN)).toBe(
      "Changed since you checked on Nov 25: the odds were about 71%."
    );
    expect(changeNote(odds("unlikely", "<1%"), odds("unlikely", "14%"), WHEN)).toBe(
      "Changed since you checked on Nov 25: the odds were under 1%."
    );
    expect(changeNote(odds("likely", ">99%"), odds("likely", "88%"), WHEN)).toBe(
      "Changed since you checked on Nov 25: the odds were over 99%."
    );
  });

  test("a row kept before figures were names the tier it had", () => {
    expect(changeNote(forecast("likely"), odds("maybe", "55%"), WHEN)).toBe(
      "Changed since you checked on Nov 25: the forecast was likely."
    );
    expect(changeNote(forecast("unlikely"), forecast("likely"), WHEN)).toBe(
      "Changed since you checked on Nov 25: the forecast was unlikely."
    );
    expect(changeNote(forecast("likely"), odds("likely", "90%"), WHEN)).toBeNull();
    // A type rule's yes, no longer a yes.
    expect(changeNote(forecast("yes"), odds("maybe", "48%"), WHEN)).toBe(
      "Changed since you checked on Nov 25: the answer was a yes."
    );
  });

  test("a forecast that firmed up says the odds it had", () => {
    expect(changeNote(odds("maybe", "48%"), yes(), WHEN)).toBe(
      "New since you checked on Nov 25: an aircraft is assigned; the odds were about 48%."
    );
    expect(
      changeNote({ tone: "open", firm: false, tails: [], odds: "≥40%" }, no(), WHEN, true)
    ).toBe("New since you checked on Nov 25: a firm answer; the odds were at least 40%.");
  });

  test("a firm answer that is missing today is no change: a failed lookup reads the same", () => {
    expect(changeNote(yes(), forecast("likely"), WHEN)).toBeNull();
    expect(changeNote(no(), forecast("unknown"), WHEN)).toBeNull();
  });

  test("an aircraft newly assigned", () => {
    expect(changeNote(forecast(), yes(), WHEN)).toBe(
      "New since you checked on Nov 25: an aircraft is assigned."
    );
    expect(changeNote(forecast("unlikely"), no(), "earlier today")).toBe(
      "New since you checked earlier today: an aircraft is assigned."
    );
  });

  test("a different aircraft, same answer", () => {
    expect(changeNote(yes("N37529"), yes("N27539"), WHEN)).toBe(
      "Changed since you checked on Nov 25: the plane was N37529, now N27539."
    );
  });

  test("a different aircraft and a different answer", () => {
    expect(changeNote(no("N4VIA"), yes("N37529"), WHEN)).toBe(
      "Changed since you checked on Nov 25: the plane was N4VIA, now N37529; the answer was a no."
    );
    expect(changeNote(yes("N37529"), no("N4VIA"), WHEN)).toBe(
      "Changed since you checked on Nov 25: the plane was N37529, now N4VIA; the answer was a yes."
    );
  });

  test("the same aircraft, a different answer", () => {
    const unchecked: Seen = { tone: "unknown", firm: true, tails: ["N55LST"] };
    expect(changeNote(unchecked, yes("N55LST"), WHEN)).toBe(
      "Changed since you checked on Nov 25: the aircraft hadn't been checked."
    );
    const partial: Seen = { tone: "partial", firm: true, tails: ["N37529"] };
    expect(changeNote(partial, yes("N37529"), WHEN)).toBe(
      "Changed since you checked on Nov 25: the answer was a yes for some of its legs."
    );
  });

  test("an aircraft unnamed on either side is never called a different one", () => {
    expect(changeNote({ ...no(), tails: [] }, no("N4VIA"), WHEN)).toBeNull();
    expect(changeNote(no("N4VIA"), { ...no(), tails: [] }, WHEN)).toBeNull();
    expect(changeNote({ ...no(), tails: [] }, yes(), WHEN)).toBe(
      "Changed since you checked on Nov 25: the answer was a no."
    );
  });

  test("two aircraft on two legs are named together", () => {
    const two: Seen = { tone: "yes", firm: true, tails: ["N1", "N2"] };
    expect(changeNote(two, { ...two, tails: ["N1", "N3"] }, WHEN)).toBe(
      "Changed since you checked on Nov 25: the plane was N1 and N2, now N1 and N3."
    );
  });

  test("more or fewer aircraft named is not called a plane changed", () => {
    // A second leg came on record, or left it: the first leg's plane is the same.
    const one: Seen = { tone: "yes", firm: true, tails: ["N1"] };
    const two: Seen = { tone: "yes", firm: true, tails: ["N1", "N2"] };
    expect(changeNote(one, two, WHEN)).toBe(
      "Changed since you checked on Nov 25: the answer named N1, now N1 and N2."
    );
    expect(changeNote(two, { ...one, tone: "partial" }, WHEN)).toBe(
      "Changed since you checked on Nov 25: the answer named N1 and N2, now N1; the answer was a yes."
    );
    expect(changeNote(one, two, WHEN)).not.toContain("plane was");
  });

  test("the hub claims a firm answer, not an assignment it cannot see", () => {
    const open: Seen = { tone: "open", firm: false, tails: [] };
    expect(changeNote(open, hubSeen({ hasStarlink: true }), WHEN, true)).toBe(
      "New since you checked on Nov 25: a firm answer."
    );
    expect(changeNote(open, hubSeen({ hasStarlink: null }), WHEN, true)).toBeNull();
    expect(
      changeNote(hubSeen({ hasStarlink: false }), hubSeen({ hasStarlink: true }), WHEN, true)
    ).toBe("Changed since you checked on Nov 25: the answer was a no.");
  });

  test("the day last looked is the visitor's own calendar day", () => {
    const day = (sec: number) => isoDay(sec);
    expect(checkedWhen(now - 60, now, day)).toMatch(/^(earlier today|on [A-Z][a-z]{2} \d{1,2})$/);
    expect(checkedWhen(now, now, day)).toBe("earlier today");
    const at = Date.UTC(2027, 10, 25, 15) / 1000;
    expect(checkedWhen(at, at + 3 * DAY, day)).toBe("on Nov 25");
    // Another year is named.
    expect(checkedWhen(at, at + 60 * DAY, day)).toBe("on Nov 25, 2027");
  });
});

describe("the hub's answers", () => {
  const form = (answer?: string) =>
    ({ dataset: answer ? { answer } : {} }) as unknown as HTMLFormElement;
  const asked = (extra: Record<string, string> = {}) =>
    new URLSearchParams({ flight_number: "ua 1932", date: SOON, ...extra });

  test("a dated check that got an answer is kept under its canonical number", () => {
    const store = memoryStore();
    const body = { hasStarlink: true, flights: [{ tail_number: "N37529" }] };
    expect(rememberHubCheck(store, form("tracked"), asked(), body, now)).toBe(true);
    expect(readRecent(store)).toEqual([
      { f: "UA1932", d: SOON, h: "Starlink", c: "text-success", seen: yes(), at: now },
    ]);
  });

  test("an answer's row words are its label and airline; the sentence is the airline page's", () => {
    const body = {
      hasStarlink: false,
      airline: "United Airlines",
      reason: `Tail N4VIA isn't on our "Starlink" list & <b>never</b> was`,
    };
    expect(hubWords(body)).toEqual({
      h: "No Starlink · United Airlines",
      k: "United Airlines",
      c: "text-muted",
    });
    expect(hubWords({ probability: 0.42, basis: {}, airline: "Alaska Airlines" })).toEqual({
      h: "≥42% Starlink · Alaska Airlines",
      k: "Alaska Airlines",
      c: "text-accent",
    });
    expect(
      hubWords({
        hasStarlink: null,
        airline: "Qatar Airways",
        airline_statement: { answer: "likely", source: { label: "x", url: "https://x" } },
      })
    ).toEqual({ h: "Likely yes · Qatar Airways", k: "Qatar Airways", c: "text-accent" });
    // An airline name too long to be one is neither printed nor kept.
    expect(hubWords({ hasStarlink: true, airline: "x".repeat(41) })).toEqual({
      h: "Starlink",
      k: undefined,
      c: "text-success",
    });
    const store = memoryStore();
    rememberHubCheck(store, form(), asked(), body, now);
    expect(readRecent(store)[0]).toMatchObject(hubWords(body));
  });

  test("the route and aircraft type asked with it are kept with it", () => {
    const store = memoryStore();
    const params = asked({ origin: "dub", destination: "jfk", aircraft_type: "Airbus A350-1000" });
    rememberHubCheck(store, form(), params, { hasStarlink: null }, now);
    expect(readRecent(store)[0]).toMatchObject({ o: "DUB", a: "JFK", t: "Airbus A350-1000" });
  });

  test("not kept: an error, a community airline's form, an entry that is no flight number", () => {
    const store = memoryStore();
    expect(rememberHubCheck(store, form(), asked(), { error: "Not tracked" }, now)).toBe(false);
    expect(rememberHubCheck(store, form("community"), asked(), { hasStarlink: true }, now)).toBe(
      false
    );
    const junk = new URLSearchParams({ flight_number: "<script>", date: SOON });
    expect(rememberHubCheck(store, form(), junk, { hasStarlink: true }, now)).toBe(false);
    expect(store.data.size).toBe(0);
  });

  test("what a hub answer said: yes, no or open, and only well-formed aircraft", () => {
    expect(hubSeen({ hasStarlink: null })).toEqual({ tone: "open", firm: false, tails: [] });
    expect(hubSeen({ hasStarlink: false, flights: [] })).toEqual({
      tone: "no",
      firm: true,
      tails: [],
    });
    const flights = [
      { tail_number: "N2" },
      { tail_number: "N1" },
      { tail_number: "N1" },
      { tail_number: null },
      { tail_number: "<b>" },
      null,
    ];
    expect(hubSeen({ hasStarlink: true, flights }).tails).toEqual(["N1", "N2"]);
    expect(hubSeen({ hasStarlink: true, flights: "x" }).tails).toEqual([]);
  });

  test("an open hub answer keeps the figure its label printed; a firm one keeps none", () => {
    expect(hubSeen({ hasStarlink: null, probability: 0.42, basis: {} })).toEqual({
      tone: "open",
      firm: false,
      tails: [],
      odds: "≥42%",
    });
    expect(hubSeen({ hasStarlink: null, probability: 0.315 })).toMatchObject({ odds: "32%" });
    expect(hubSeen({ hasStarlink: true, probability: 0.9 })).not.toHaveProperty("odds");
    expect(hubSeen({ hasStarlink: null, confidence: "type" })).not.toHaveProperty("odds");
  });
});

describe("the list's markup", () => {
  const rows = [
    { ...check("UA1932", SOON, { o: "DEN", a: "ORD" }), at: now },
    { ...check("UA500"), at: now },
  ];

  test("says where it is kept, and has one clear button and a remove button a row", () => {
    const html = recentSectionHtml(rows, now, false);
    expect(html).toContain("Kept in this browser only.");
    expect(html.match(/data-recent-clear/g)).toHaveLength(1);
    expect(html.match(/data-recent-remove/g)).toHaveLength(2);
    expect(html.match(/data-recent-row=/g)).toHaveLength(2);
    expect(html).toContain("UA1932");
    expect(html).toContain("DEN → ORD");
  });

  test("an airline site's row links the flight's own page, with its leg", () => {
    const html = recentRowHtml(rows[0], now, false);
    expect(html).toContain(`href="/check-flight/UA1932/${SOON}?origin=DEN&amp;destination=ORD"`);
    expect(recentRowHtml(rows[1], now, false)).toContain(`href="/check-flight/UA500/${SOON}"`);
  });

  test("a hub row has no page of its own to link", () => {
    expect(recentRowHtml(rows[0], now, true)).not.toContain("<a ");
  });

  test("a waiting row holds the room of the words its answer last had, unseen and unread", () => {
    const said = 'Yes — UA500 on <img src=x onerror="alert(1)"> has Starlink (N37529, verified)';
    const html = recentRowHtml({ ...rows[1], h: said }, now, false);
    const held = html.match(/<span aria-hidden="true" class="invisible ([^"]*)">(.*?)<\/span>/);
    expect(held?.[2]).toContain("&lt;img");
    expect(html).not.toContain("<img");
    // In the answer's own type, so the answer takes the room that was held.
    const answer = airlineAnswerHtml({ ...yes(), headline: said, passed: false }, null);
    for (const cls of (held?.[1] ?? "").split(" ")) expect(answer).toContain(cls);
    expect(answer).toContain(held?.[2] ?? "missing");
    expect(html).toMatch(/<span data-recent-wait class="absolute [^"]*">Checking…<\/span>/);
  });

  test("a row with no words kept waits on plain lines", () => {
    const html = recentRowHtml(rows[1], now, false);
    expect(html).toContain("<span data-recent-wait>Checking…</span>");
    expect(html).not.toContain("invisible");
  });

  test("a hub row holds room for its answer's link to the airline's site too", () => {
    const pages = {
      "United Airlines": { url: "https://ua.example/check-flight", site: "ua.example" },
    };
    const kept = { ...rows[1], h: "No Starlink · United Airlines · <b>", k: "United Airlines" };
    const html = recentRowHtml(kept, now, true, pages);
    expect(html).toContain(
      '<span aria-hidden="true" class="invisible block">No Starlink · United Airlines · &lt;b&gt;<a href='
    );
    expect(html).toContain('aria-label="Full answer for UA500 on ua.example"');
    expect(html).toContain(">Full answer →</a>");
    // An airline the page has no site for holds no link, whatever the list says.
    expect(recentRowHtml({ ...kept, k: "Nobody" }, now, true, pages)).not.toContain("<a ");
  });

  test("the remove button names its flight for a screen reader", () => {
    expect(recentRowHtml(rows[1], now, false)).toMatch(
      /aria-label="Remove UA500 on [A-Z][a-z]{2}( | )\d{1,2}[^"]* from your flights"/
    );
  });

  test("an answer is printed escaped, in the card headline's colour, with its note", () => {
    const answer: RowAnswer = {
      ...yes(),
      headline: 'Yes — UA1 <img src=x onerror="alert(1)"> has Starlink',
      passed: false,
    };
    const html = airlineAnswerHtml(answer, "Changed <since> you checked");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain("text-success");
    expect(html).toContain("Changed &lt;since&gt; you checked");
    expect(airlineAnswerHtml({ ...answer, tone: "no" }, null)).not.toContain("data-recent-note");
    // A tone this build doesn't know prints in the plain colour, not as a class name.
    expect(airlineAnswerHtml({ ...answer, tone: "text-danger" }, null)).toContain("text-primary");
  });
});

describe("rows drawn without asking again", () => {
  const key = (c: RecentCheck) => checkKey(c);
  const shown = (f: string, at: number, extra: Partial<RecentCheck> = {}) =>
    ({ ...check(f), h: `Yes — ${f} has Starlink`, at, ...extra }) as RecentCheck;

  test("a flight its page showed minutes ago is drawn from what the page said", () => {
    const c = shown("UA1932", now - 120);
    expect(freshAnswer(c, now, false)).toEqual({ h: c.h, seen: c.seen, at: c.at });
    // Past the window, or with no words kept, the row asks.
    expect(freshAnswer(shown("UA1932", now - FRESH_SEC), now, false)).toBeNull();
    expect(freshAnswer({ ...check("UA1932"), at: now } as RecentCheck, now, false)).toBeNull();
    // A clock that ran backwards is no fresh answer.
    expect(freshAnswer(shown("UA1932", now + 600), now, false)).toBeNull();
  });

  test("the list's own last read is used while fresh, and never one older than the page's", () => {
    const read: RowRead = { h: "Yes — newer", seen: yes("N27539"), at: now - 60 };
    expect(freshAnswer(shown("UA1932", now - 3 * HOUR, { r: read }), now, false)).toEqual(read);
    const stale = { ...read, at: now - 2 * HOUR };
    expect(freshAnswer(shown("UA1932", now - 3 * HOUR, { r: stale }), now, false)).toBeNull();
    // Checked on its page after the list read it: the page's answer is the newer one.
    const c = shown("UA1932", now - 30, { r: { ...read, at: now - 90 } });
    expect(freshAnswer(c, now, false)?.h).toBe(c.h);
  });

  test("a hub row needs its label's colour, which rows kept before colours lack", () => {
    const hubRow = shown("UA1932", now - 60, { h: "Starlink · United Airlines" });
    expect(freshAnswer(hubRow, now, true)).toBeNull();
    expect(freshAnswer({ ...hubRow, c: "text-success" }, now, true)?.c).toBe("text-success");
  });

  test("a read is kept beside the row and leaves the note's baseline alone", () => {
    const store = memoryStore();
    rememberCheck(store, check("UA1932"), now - DAY);
    const before = readRecent(store)[0];
    const read: RowRead = { h: "No — UA1932", seen: no(), at: now };
    rememberRead(store, key(before), read);
    const after = readRecent(store)[0];
    expect(after.r).toEqual(read);
    expect(after.seen).toEqual(before.seen);
    expect(after.at).toBe(before.at);
    // The note still compares with what the page said.
    expect(changeNote(after.seen, read.seen, "on Nov 25")).toContain("the answer was a yes");
    // Checking the flight again starts over from that check.
    rememberCheck(store, check("UA1932"), now);
    expect(readRecent(store)[0].r).toBeUndefined();
  });

  test("a read for a row that is gone, or off-shape, writes nothing", () => {
    const store = memoryStore();
    rememberCheck(store, check("UA1932"), now);
    const kept = store.data.get(RECENT_KEY);
    rememberRead(store, "UA9|x", { h: "x", seen: yes(), at: now });
    rememberRead(store, key(readRecent(store)[0]), {
      h: "x",
      seen: { tone: "<b>", firm: true, tails: [] },
      at: now,
    });
    expect(store.data.get(RECENT_KEY)).toBe(kept);
    expect(() => rememberRead(deadStore, "UA1932", { h: "x", seen: yes(), at: now })).not.toThrow();
  });
});

describe("saved values from before, and saved values that are hostile", () => {
  test("a list written by the first release reads as it was", () => {
    // The shape #295 wrote: no figure, no colour, no read.
    const old = JSON.stringify([
      { f: "UA1932", d: SOON, h: "Yes — UA1932 has Starlink", seen: yes(), at: now - DAY },
      {
        f: "UA500",
        d: SOON,
        h: "No Starlink · United Airlines · Tail N4VIA is not on our list",
        k: "United Airlines",
        seen: { tone: "open", firm: false, tails: [] },
        at: now - DAY,
      },
      { f: "UA77", d: SOON, seen: forecast("likely"), at: now - DAY },
    ]);
    const rows = readRecent(memoryStore(old));
    expect(rows.map((c) => c.f)).toEqual(["UA1932", "UA500", "UA77"]);
    expect(rows[2].seen).toEqual(forecast("likely"));
    // An old row is not fresh on the hub (no colour), so it asks.
    expect(freshAnswer({ ...rows[1], at: now }, now, true)).toBeNull();
  });

  test("a hostile figure or colour drops its row; a hostile read drops the read only", () => {
    const good = { f: "UA1932", d: SOON, seen: yes(), at: now };
    const stored = JSON.stringify([
      { ...good, f: "UA1", seen: { ...forecast(), odds: "<img src=x>" } },
      { ...good, f: "UA2", seen: { ...forecast(), odds: 74 } },
      { ...good, f: "UA3", c: "text-[red] onload" },
      { ...good, f: "UA4", r: { h: "<b>", seen: yes(), c: "javascript:", at: now } },
      { ...good, f: "UA5", r: "x" },
      { ...good, f: "UA6", r: { h: "x".repeat(401), seen: yes(), at: now } },
      { ...good, f: "UA7", r: { h: "ok", seen: yes(), at: Number.NaN } },
    ]);
    const rows = readRecent(memoryStore(stored));
    expect(rows.map((c) => c.f)).toEqual(["UA4", "UA5", "UA6", "UA7"]);
    for (const c of rows) expect(c.r).toBeUndefined();
  });

  test("a hub answer prints its words escaped, its colour only from the fixed set", () => {
    const html = hubAnswerHtml(
      { h: '<img src=x onerror="alert(1)"> · <b>Air</b>', c: "text-[red]" as never },
      "Changed <x>",
      ""
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("text-[red]");
    expect(html).toContain('<span class="text-muted">&lt;img');
    expect(html).toContain("Changed &lt;x&gt;");
  });
});

describe("a hub row is two lines on a phone", () => {
  const pages = {
    "United Airlines": { url: "https://ua.example/check-flight", site: "ua.example" },
  };
  test("the label in its colour, the airline, then the link to the airline's page", () => {
    const link = '<a data-recent-open href="https://ua.example/x" class="mt-1 block py-2">See</a>';
    const html = hubAnswerHtml(
      { h: "≥42% Starlink · United Airlines", c: "text-accent" },
      null,
      link
    );
    expect(html).toBe(
      `<span class="text-accent">≥42% Starlink</span><span class="text-secondary"> · United Airlines</span>${link}`
    );
    // The waiting row holds the same two lines' room.
    const row = recentRowHtml(
      {
        ...check("UA500"),
        h: "≥42% Starlink · United Airlines",
        k: "United Airlines",
        c: "text-accent",
        at: now,
      } as RecentCheck,
      now,
      true,
      pages
    );
    expect(row).toContain(">≥42% Starlink · United Airlines<a href=");
    expect(row).toContain(">Full answer →</a>");
  });
});

describe("the row's answer carries its figure", () => {
  test("labelPhrase reads a printed figure back in words", () => {
    expect(labelPhrase("74%")).toBe("about 74%");
    expect(labelPhrase("≥40%")).toBe("at least 40%");
    expect(labelPhrase("<1%")).toBe("under 1%");
    expect(labelPhrase(">99%")).toBe("over 99%");
    expect(labelPhrase("100%")).toBe("100%");
  });
});

// --- The server's side --------------------------------------------------------

let db: Database;
let app: ReturnType<typeof createApp>;
// 18:00 UTC on the UTC day two days out, and six hours on: mid-morning at
// SFO, then evening at ORD, one local day whatever the hour or season.
const UA403_SFO = Math.floor((now + 2 * DAY) / DAY) * DAY + 18 * HOUR;
const UA403_ORD = UA403_SFO + 6 * HOUR;

beforeAll(() => {
  db = makeFreshDb();
  addPlane(db, "N37529", "Starlink", { aircraft: "Boeing 737 MAX 9" });
  addFleet(db, "N37529", "confirmed", {
    aircraftType: "Boeing 737 MAX 9",
    verifiedWifi: "Starlink",
    verifiedAt: now - DAY,
  });
  addFlight(db, "N37529", "UA1932", "DEN", now + 2 * DAY, { arrivalAirport: "ORD" });
  addPlane(db, "N4VIA", "Viasat");
  addFleet(db, "N4VIA", "negative", {
    aircraftType: "Boeing 737-900",
    verifiedWifi: "Viasat",
    verifiedAt: now - DAY,
  });
  addFlight(db, "N4VIA", "UA500", "IAH", now + 2 * DAY, { arrivalAirport: "EWR" });
  // Two legs on two planes: a yes for one leg only. Both depart on one local
  // day at any hour the suite runs: a page holds a leg to its own airport's day.
  addFlight(db, "N37529", "UA403", "SFO", UA403_SFO, { arrivalAirport: "ORD" });
  addFlight(db, "N4VIA", "UA403", "ORD", UA403_ORD, { arrivalAirport: "FLL" });
  addPlane(db, "N644AS", "Starlink", { airline: "AS", aircraft: "737-700" });
  addFleet(db, "N644AS", "confirmed", {
    airline: "AS",
    aircraftType: "737-700",
    verifiedWifi: "Starlink",
  });
  addFlight(db, "N644AS", "AS12", "SEA", now + 2 * DAY, { arrivalAirport: "SFO", airline: "AS" });
  app = createApp(db);
});

const get = (host: string, path: string, headers: Record<string, string> = OUR_PAGE) =>
  app.dispatch(req(path, host, { headers }));
const pageHtml = async (host: string, path: string) => (await get(host, path, {})).text();
/** The local date at `zone` of a departure, by default one seeded at now + 2 days. */
const dateAt = (zone: string, departure = now + 2 * DAY) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(new Date(departure * 1000));
const plain = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replaceAll(" ", " ")
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
const cardHeadline = (html: string) =>
  plain(html.match(/id="flight-answer"[^>]*>.*?<h2[^>]*>(.*?)<\/h2>/s)?.[1] ?? "");

describe("a row's answer", () => {
  const flights: Array<[string, string, string, string, string, number]> = [
    [UA, "UA1932", "America/Denver", "", "yes", now + 2 * DAY],
    [UA, "UA500", "America/Chicago", "", "no", now + 2 * DAY],
    [UA, "UA403", "America/Los_Angeles", "", "partial", UA403_SFO],
    [UA, "UA403", "America/Chicago", "?origin=ORD&destination=FLL", "no", UA403_ORD],
    [AS, "AS12", "America/Los_Angeles", "", "yes", now + 2 * DAY],
  ];

  test.each(flights)(
    "%s %s%s is the flight page's own headline, word for word",
    async (host, fn, zone, leg, tone, departure) => {
      const date = dateAt(zone, departure);
      const res = await get(host, `${RECENT_PREFIX}${fn}/${date}${leg}`);
      expect(res.status).toBe(200);
      const answer = (await res.json()) as RowAnswer;
      expect(answer.tone).toBe(tone);
      expect(answer.passed).toBe(false);
      const page = await pageHtml(host, `/check-flight/${fn}/${date}${leg}`);
      expect(answer.headline.length).toBeGreaterThan(10);
      expect(answer.headline).toBe(cardHeadline(page));
      // What the page tells the browser to keep is what the row is compared with.
      const config = JSON.parse(
        page.match(/id="check-flight-config"[^>]*>(.*?)<\/script>/s)?.[1] ?? "{}"
      );
      // Its words are kept too: the row holds their room while it waits.
      expect(config.seen).toEqual({
        tone: answer.tone,
        firm: answer.firm,
        tails: answer.tails,
        headline: answer.headline,
      });
    }
  );

  test("a yes for some legs names its own aircraft, and a no names the one assigned", async () => {
    const partial = (await (
      await get(UA, `${RECENT_PREFIX}UA403/${dateAt("America/Los_Angeles", UA403_SFO)}`)
    ).json()) as RowAnswer;
    expect(partial).toMatchObject({ tone: "partial", firm: true, tails: ["N37529"] });
    expect(partial.headline).toContain("not on ORD → FLL");
    const firmNo = (await (
      await get(UA, `${RECENT_PREFIX}UA500/${dateAt("America/Chicago")}`)
    ).json()) as RowAnswer;
    expect(firmNo).toMatchObject({ tone: "no", firm: true, tails: ["N4VIA"] });
  });

  test("a forecast is not firm and names no aircraft", async () => {
    const answer = (await (await get(UA, `${RECENT_PREFIX}UA1932/${LATER}`)).json()) as RowAnswer;
    expect(answer.firm).toBe(false);
    expect(answer.tails).toEqual([]);
    expect(answer.passed).toBe(false);
    // A figure is kept only as the headline prints it, and only for odds.
    expect(answer.odds).toMatch(/^(?:[<>]?\d{1,3})%$/);
    expect(["likely", "maybe", "unlikely"]).toContain(answer.tone);
    expect(answer.headline.toLowerCase()).toContain(labelPhrase(answer.odds ?? "").toLowerCase());
    const page = await pageHtml(UA, `/check-flight/UA1932/${LATER}`);
    const config = JSON.parse(
      page.match(/id="check-flight-config"[^>]*>(.*?)<\/script>/s)?.[1] ?? "{}"
    );
    expect(config.seen.odds).toBe(answer.odds);
  });

  test("a date already over says so, and its page tells the browser to keep nothing", async () => {
    const answer = (await (
      await get(UA, `${RECENT_PREFIX}UA1932/${LONG_AGO}`)
    ).json()) as RowAnswer;
    expect(answer.passed).toBe(true);
    const page = await pageHtml(UA, `/check-flight/UA1932/${LONG_AGO}`);
    expect(page).toContain('id="check-flight-config"');
    expect(page).not.toContain('"seen"');
  });

  test("it is ours alone: not cacheable, not indexable, no cross-origin grant", async () => {
    const res = await get(UA, `${RECENT_PREFIX}UA1932/${SOON}`);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  test("only a browser on our own page is answered", async () => {
    const path = `${RECENT_PREFIX}UA1932/${SOON}`;
    const callers: Array<Record<string, string>> = [
      {},
      { "user-agent": BROWSER },
      { ...OUR_PAGE, "sec-fetch-site": "cross-site" },
      { ...OUR_PAGE, "sec-fetch-site": "none" },
      { ...OUR_PAGE, "sec-fetch-site": "same-site" },
      { ...OUR_PAGE, "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" },
      { ...OUR_PAGE, "user-agent": "curl/8.5.0" },
      { ...OUR_PAGE, origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" },
    ];
    for (const headers of callers) {
      const res = await get(UA, path, headers);
      expect(res.status, JSON.stringify(headers)).toBe(404);
      expect(await res.text()).toBe("Not found");
    }
  });

  test("nothing but a flight of this site, canonically spelled, on a real date", async () => {
    for (const rest of [
      "",
      "UA1932",
      `ua1932/${SOON}`,
      `UA01932/${SOON}`,
      `UA1932/${SOON}/`,
      `UA1932/${SOON}/x`,
      "UA1932/2026-02-30",
      "UA1932/tomorrow",
      `AS12/${SOON}`,
      `DL100/${SOON}`,
      `UA0/${SOON}`,
      `%E0%A4%A/${SOON}`,
      `../check-flight/UA1932/${SOON}`,
      `<script>/${SOON}`,
    ]) {
      expect((await get(UA, `${RECENT_PREFIX}${rest}`)).status, rest).toBe(404);
    }
    // The hub has no flight pages, so it has no such answer either.
    expect((await get(HUB, `${RECENT_PREFIX}UA1932/${SOON}`)).status).toBe(404);
  });

  test("a leg that does not parse answers for the whole flight, as the page does", async () => {
    const date = dateAt("America/Denver");
    const res = await get(UA, `${RECENT_PREFIX}UA1932/${date}?origin=<x>&destination=!!`);
    const answer = (await res.json()) as RowAnswer;
    expect(answer.headline).toBe(
      cardHeadline(await pageHtml(UA, `/check-flight/UA1932/${date}?origin=<x>&destination=!!`))
    );
  });

  test("any method but GET is refused", async () => {
    const res = await app.dispatch(
      req(`${RECENT_PREFIX}UA1932/${SOON}`, UA, { method: "POST", headers: OUR_PAGE })
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
  });
});

describe("the count", () => {
  const spy = spyOn(metrics, "increment");
  afterEach(() => spy.mockClear());
  const counted = (name: string) =>
    spy.mock.calls.filter(([n]) => n === name).map(([, tags]) => tags as Record<string, unknown>);
  const tap = (host: string, body: string | null, headers: Record<string, string> = {}) =>
    app.dispatch(
      req(RECENT_TAP_PATH, host, { method: "POST", body, headers: { ...OUR_PAGE, ...headers } })
    );

  test.each([
    [UA, "shown", "united"],
    [AS, "opened", "alaska"],
    [HUB, "cleared", "all"],
  ])("a use on %s is one word and the site", async (host, action, airline) => {
    const res = await tap(host, action);
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(counted(COUNTERS.RECENT_CHECKS)).toEqual([{ airline, action }]);
  });

  test("nothing but the three words is counted", async () => {
    for (const body of [
      "",
      "copy",
      "SHOWN",
      "shown ",
      "UA1932",
      "x".repeat(10_000),
      '{"f":"UA1"}',
    ]) {
      expect((await tap(UA, body)).status, body.slice(0, 12)).toBe(202);
    }
    expect((await tap(UA, null)).status).toBe(202);
    expect(counted(COUNTERS.RECENT_CHECKS)).toEqual([]);
    for (const bad of [null, undefined, "", "sheet", "Shown", "constructor"]) {
      expect(normalizeRecentAction(bad)).toBeNull();
    }
  });

  test("a caller that is not a browser on our own page is answered and not counted", async () => {
    for (const headers of [
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "none" },
      { "user-agent": "Mozilla/5.0 (compatible; bingbot/2.0)" },
      { "user-agent": "curl/8.5.0" },
    ]) {
      expect((await tap(UA, "shown", headers)).status).toBe(202);
    }
    expect(counted(COUNTERS.RECENT_CHECKS)).toEqual([]);
    const fetched = await get(UA, RECENT_TAP_PATH);
    expect(fetched.status).toBe(405);
  });

  test("both addresses are filed under /static: no new route, no new tag key", async () => {
    const before = await app.dispatch(req("/static/nothing-here.png", UA));
    expect(before.status).toBe(404);
    const keys = Object.keys(counted(COUNTERS.HTTP_REQUEST)[0]).sort();
    spy.mockClear();
    await tap(UA, "shown");
    await get(UA, `${RECENT_PREFIX}UA1932/${SOON}`);
    const requests = counted(COUNTERS.HTTP_REQUEST);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.route).toBe("/static");
      expect(Object.keys(request).sort()).toEqual(keys);
    }
    expect(app.routeTags.some((t) => t.includes("recent"))).toBe(false);
    // A row's answer is not a lookup someone made, a share control shown, a
    // calendar offer shown, or a call to anyone else's server.
    for (const name of [
      COUNTERS.FLIGHT_LOOKUP_RESULT,
      COUNTERS.SHARE_CONTROL,
      COUNTERS.WATCH_CTA_SHOWN,
      COUNTERS.VENDOR_REQUEST,
    ]) {
      expect(name).toBeString();
      expect(counted(name), name).toEqual([]);
    }
  });

  test("no flight, date or address reaches a metric", async () => {
    await tap(UA, "opened");
    await get(UA, `${RECENT_PREFIX}UA1932/${SOON}?origin=DEN&destination=ORD`);
    const said = JSON.stringify(spy.mock.calls);
    for (const secret of ["UA1932", SOON, "DEN", "ORD", "N37529"]) {
      expect(said).not.toContain(secret);
    }
  });
});

describe("the served pages", () => {
  test.each([UA, AS, HUB])("%s's homepage holds nothing of the list", async (host) => {
    const html = await pageHtml(host, "/");
    for (const mark of ["recent-checks", "data-recent", "Your flights", "this browser only"]) {
      expect(html, mark).not.toContain(mark);
    }
    expect(html).toMatch(/<script[^>]+src="\/static\/home\.[a-z0-9]+\.js"/);
  });

  test("the list goes under the form each homepage already has", async () => {
    // The script finds its place by these ids (placement in recent-checks.ts).
    expect(await pageHtml(UA, "/")).toContain('id="home-flight-search"');
    expect(await pageHtml(AS, "/")).toContain('id="home-flight-search"');
    expect(await pageHtml(HUB, "/")).toContain('id="hub-check-flight"');
  });

  const bundle = async (host: string, path: string, name: string) => {
    const html = await pageHtml(host, path);
    const src = html.match(new RegExp(`src="(/static/${name}\\.[a-z0-9]+\\.js)"`))?.[1];
    expect(src, `${name} on ${host}${path}`).toBeDefined();
    return (await get(host, src as string, {})).text();
  };

  test("the bundles keep the list, and hold no address a crawler could lift", async () => {
    for (const code of [
      await bundle(UA, "/", "home"),
      await bundle(HUB, "/", "hub"),
      await bundle(UA, `/check-flight/UA1932/${SOON}`, "check-flight"),
    ]) {
      expect(code).toContain(RECENT_KEY);
      expect(code).not.toContain("/static/recent");
      expect(code).not.toContain("recent/tap");
    }
  });
});
