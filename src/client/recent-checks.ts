/**
 * "Your flights": the dated flights this browser checked, listed on the
 * homepage with each one's answer now.
 *
 * The list lives in this browser's localStorage and nowhere else. No account,
 * cookie or identifier exists for it; the server is never sent the list, only
 * asked for one flight's answer at a time, the way opening that flight's page
 * asks. A flight leaves when its date is over, when the visitor removes it,
 * or when a fifth pushes out the one looked at longest ago.
 *
 * Every storage call is guarded: private modes and blocked site data throw on
 * access, and the homepage must then be exactly the page it is without this.
 *
 * A change note compares the answer now with what this browser last showed on
 * the flight's own page (on the hub, its form), and says what moved in plain
 * words: an aircraft newly assigned, a different aircraft, a firm answer that
 * moved, or a forecast whose odds moved by ODDS_STEP points or across a
 * likely / maybe / unlikely cut. Smaller drift, a printed figure that did not
 * change (its tier can still flip at a cut), and a firm answer that is
 * missing today (a lookup that failed reads the same), get no note. The note
 * stays until the flight is checked again, so it reads the same on every return.
 *
 * Requests are bounded: at most RECENT_MAX a visit, one at a time, and none
 * for a row whose answer this browser read within FRESH_SEC. That row is drawn
 * from the answer kept with it, the flight page's own or the list's last read.
 *
 * A row is drawn before its answer is in. The browser keeps the words each
 * answer last had, and the waiting row holds exactly their room, unseen, so an
 * answer that has not changed arrives without moving anything. One that has
 * changed is held until the others are in, so the list moves once.
 */
import { canonicalFlightInput } from "../airlines/flight-input";
import { EYEBROW_TEXT, PANEL_PAD, SURFACE } from "../components/ui/box-classes";
import { labelPhrase, monthDay, wholeDates } from "../components/ui/format";
import { esc } from "./esc";
import { ANSWER_TONES, type AnswerTone, answerHeadlineClass } from "./flight-answer";
import {
  type CheckAnyBody,
  type CheckPages,
  LEAD_CLASSES,
  type LeadClass,
  checkAnyLead,
  checkPageHref,
} from "./flight-search";

export const RECENT_KEY = "recent_checks_v1";
/** Each row is one request when the homepage opens, so the list stays short. */
export const RECENT_MAX = 4;

/** The hub's answers carry no forecast tiers: firm yes, firm no, or open. */
const TONES: readonly string[] = [...ANSWER_TONES, "open"];

/** What an answer said, reduced to what a change note compares. */
export interface Seen {
  tone: string;
  /** The answer rests on an assigned aircraft (a hub answer: it is a yes or a no). */
  firm: boolean;
  /** The aircraft it named, sorted; empty when it named none. */
  tails: string[];
  /** A forecast's figure as it was printed ("74%", "≥40%"); absent for a firm
   * answer, and in rows kept before figures were. */
  odds?: string;
}

/** An answer as a flight's page or its row prints it: `Seen`, and its words. */
export interface Shown extends Seen {
  headline: string;
}

export interface RecentCheck {
  /** Flight number, canonical: "UA1932". */
  f: string;
  /** YYYY-MM-DD. */
  d: string;
  /** The leg asked about, where one was. */
  o?: string;
  a?: string;
  /** Hub only: the aircraft type typed for an airline answered by type. */
  t?: string;
  /** The answer's words when last shown. Never printed: a waiting row holds
   * their room (see the file header). */
  h?: string;
  /** Hub only: the airline that answer named, whose site its link opens. */
  k?: string;
  /** Hub only: the colour of that answer's label. */
  c?: LeadClass;
  seen: Seen;
  /** When `seen` was shown (unix seconds). */
  at: number;
  /** The list's own last read of the answer, so a return within FRESH_SEC
   * draws it without asking again. Never the note's baseline: that is `seen`. */
  r?: RowRead;
}

/** An answer the list read: its words, what it said, and for the hub its colour. */
export interface RowRead {
  h: string;
  seen: Seen;
  c?: LeadClass;
  at: number;
}

export type RecentStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** localStorage, or null where reading the property itself throws. */
export function browserStore(): RecentStore | null {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

const FLIGHT_RE = /^[A-Z0-9]{3,8}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AIRPORT_RE = /^[A-Z]{3}$/;
const TAIL_RE = /^[A-Z0-9-]{2,8}$/;
const MAX_TAILS = 6;
const MAX_TYPE_LENGTH = 40;
const MAX_WORDS_LENGTH = 400;
const MAX_AIRLINE_LENGTH = 40;
const ODDS_RE = /^(?:[<>≥]?\d{1,3})%$/;
/** A row whose answer was read this recently is drawn without a request. */
export const FRESH_SEC = 10 * 60;

const isSeen = (v: unknown): v is Seen => {
  const s = v as Seen | null;
  return (
    !!s &&
    typeof s === "object" &&
    TONES.includes(s.tone) &&
    typeof s.firm === "boolean" &&
    Array.isArray(s.tails) &&
    s.tails.length <= MAX_TAILS &&
    s.tails.every((t) => typeof t === "string" && TAIL_RE.test(t)) &&
    (s.odds === undefined || (typeof s.odds === "string" && ODDS_RE.test(s.odds)))
  );
};

const copySeen = (s: Seen): Seen => ({
  tone: s.tone,
  firm: s.firm,
  tails: [...s.tails],
  ...(s.odds ? { odds: s.odds } : {}),
});

const isLeadClass = (v: unknown): v is LeadClass =>
  (LEAD_CLASSES as readonly unknown[]).includes(v);

/** A kept read, or null: anything off-shape loses the read, not the row. */
function validRead(v: unknown): RowRead | null {
  const r = v as RowRead | null;
  if (!r || typeof r !== "object") return null;
  if (typeof r.h !== "string" || !r.h || r.h.length > MAX_WORDS_LENGTH) return null;
  if (!isSeen(r.seen) || typeof r.at !== "number" || !Number.isFinite(r.at)) return null;
  if (r.c !== undefined && !isLeadClass(r.c)) return null;
  return { h: r.h, seen: copySeen(r.seen), ...(r.c ? { c: r.c } : {}), at: r.at };
}

/** Stored text is read back as untrusted: anything off-shape is dropped whole. */
function validCheck(v: unknown): RecentCheck | null {
  const c = v as RecentCheck | null;
  if (!c || typeof c !== "object") return null;
  if (typeof c.f !== "string" || !FLIGHT_RE.test(c.f)) return null;
  if (typeof c.d !== "string" || !DATE_RE.test(c.d)) return null;
  for (const code of [c.o, c.a]) {
    if (code !== undefined && (typeof code !== "string" || !AIRPORT_RE.test(code))) return null;
  }
  for (const [text, max] of [
    [c.t, MAX_TYPE_LENGTH],
    [c.h, MAX_WORDS_LENGTH],
    [c.k, MAX_AIRLINE_LENGTH],
  ] as const) {
    if (text !== undefined && (typeof text !== "string" || !text || text.length > max)) return null;
  }
  if (!isSeen(c.seen) || typeof c.at !== "number" || !Number.isFinite(c.at)) return null;
  if (c.c !== undefined && !isLeadClass(c.c)) return null;
  const read = c.r === undefined ? null : validRead(c.r);
  return {
    f: c.f,
    d: c.d,
    ...(c.o ? { o: c.o } : {}),
    ...(c.a ? { a: c.a } : {}),
    ...(c.t ? { t: c.t } : {}),
    ...(c.h ? { h: c.h } : {}),
    ...(c.k ? { k: c.k } : {}),
    ...(c.c ? { c: c.c } : {}),
    seen: copySeen(c.seen),
    at: c.at,
    ...(read ? { r: read } : {}),
  };
}

/** One flight, date and leg is one row, however often it is checked. */
export const checkKey = (c: Pick<RecentCheck, "f" | "d" | "o" | "a" | "t">) =>
  [c.f, c.d, c.o ?? "", c.a ?? "", c.t ?? ""].join("|");

export function readRecent(store: RecentStore | null): RecentCheck[] {
  if (!store) return [];
  try {
    const parsed: unknown = JSON.parse(store.getItem(RECENT_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: RecentCheck[] = [];
    for (const item of parsed) {
      const c = validCheck(item);
      if (!c || seen.has(checkKey(c))) continue;
      seen.add(checkKey(c));
      out.push(c);
    }
    return out.slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

/** False when the browser refused the write; the page goes on without it. */
export function writeRecent(store: RecentStore | null, list: RecentCheck[]): boolean {
  if (!store) return false;
  try {
    if (list.length === 0) store.removeItem(RECENT_KEY);
    else store.setItem(RECENT_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/**
 * Is `date` over everywhere on Earth? The last place still on a date is
 * UTC-12. The airline sites' answers say when a date is over at the flight's
 * own airport, which is sooner; this is the rule that needs no answer.
 */
export function overEverywhere(date: string, nowSec: number): boolean {
  return date < new Date((nowSec - 12 * 3600) * 1000).toISOString().slice(0, 10);
}

/** The list with every flight whose date is over everywhere dropped, written back if it shrank. */
export function currentChecks(store: RecentStore | null, nowSec: number): RecentCheck[] {
  const all = readRecent(store);
  const kept = all.filter((c) => !overEverywhere(c.d, nowSec));
  if (kept.length !== all.length) writeRecent(store, kept);
  return kept;
}

/**
 * Remember an answer just shown. Checking a flight again replaces its row and
 * what it last said; a new flight past the limit pushes out the row looked at
 * longest ago.
 */
export function rememberCheck(
  store: RecentStore | null,
  check: Omit<RecentCheck, "at">,
  nowSec: number
): boolean {
  const entry = validCheck({ ...check, at: nowSec });
  if (!entry || overEverywhere(entry.d, nowSec)) return false;
  const others = currentChecks(store, nowSec).filter((c) => checkKey(c) !== checkKey(entry));
  const kept = [...others].sort((x, y) => y.at - x.at).slice(0, RECENT_MAX - 1);
  return writeRecent(store, [entry, ...kept]);
}

export function forgetCheck(store: RecentStore | null, key: string): void {
  writeRecent(
    store,
    readRecent(store).filter((c) => checkKey(c) !== key)
  );
}

/** Keep the list's own read of a row's answer with it; the note's baseline stays. */
export function rememberRead(store: RecentStore | null, key: string, read: RowRead): void {
  const list = readRecent(store);
  const valid = validRead(read);
  if (!valid || !list.some((c) => checkKey(c) === key)) return;
  writeRecent(
    store,
    list.map((c) => (checkKey(c) === key ? { ...c, r: valid } : c))
  );
}

/**
 * The answer a row can be drawn from with no request: the list's last read,
 * or the answer the flight page itself just showed, when either is under
 * FRESH_SEC old. A hub row needs its label's colour, which rows kept before
 * colours were lack. Null: ask.
 */
export function freshAnswer(c: RecentCheck, nowSec: number, hub: boolean): RowRead | null {
  const fresh = (at: number) => at <= nowSec && nowSec - at < FRESH_SEC;
  const usable = (r: RowRead) => fresh(r.at) && (!hub || !!r.c);
  if (c.r && c.r.at >= c.at && usable(c.r)) return c.r;
  const own: RowRead | null = c.h
    ? { h: c.h, seen: c.seen, ...(c.c ? { c: c.c } : {}), at: c.at }
    : null;
  return own && usable(own) ? own : null;
}

export function clearChecks(store: RecentStore | null): void {
  try {
    store?.removeItem(RECENT_KEY);
  } catch {
    // Nothing was kept, or nothing can be: either way the list is gone from the page.
  }
}

/** The next departure first; the same day in the order last looked at. */
export const inShowOrder = (list: RecentCheck[]) =>
  [...list].sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : y.at - x.at));

/** "on Nov 25", or "earlier today", for when the visitor last looked, on their own calendar. */
export function checkedWhen(
  atSec: number,
  nowSec: number,
  localDay: (sec: number) => string = (sec) => new Date(sec * 1000).toLocaleDateString("en-CA")
): string {
  const day = localDay(atSec);
  if (day === localDay(nowSec)) return "earlier today";
  return `on ${DATE_RE.test(day) ? monthDay(day, nowSec) : day}`;
}

const WAS: Record<string, string> = {
  yes: "the answer was a yes",
  partial: "the answer was a yes for some of its legs",
  no: "the answer was a no",
  unknown: "the aircraft hadn't been checked",
};

/** A forecast's tier, for a row kept before figures were. */
const WAS_FORECAST: Record<string, string> = {
  yes: "the answer was a yes",
  likely: "the forecast was likely",
  maybe: "the forecast was a maybe",
  unlikely: "the forecast was unlikely",
};

/** Odds that moved less than this, within one tier, are drift, not news. */
export const ODDS_STEP = 10;

/** A printed figure as a number to compare: "<1%" is 0, ">99%" is 100. */
function oddsValue(label: string): number {
  if (label.startsWith("<")) return 0;
  if (label.startsWith(">")) return 100;
  return Number(label.replace(/[^\d]/g, ""));
}

const planes = (tails: string[]) => tails.join(" and ");

/** What a forecast said before, when it moved enough to say so; else null. */
function forecastWas(prev: Seen, now: Seen): string | null {
  if (prev.odds && now.odds) {
    // The row shows the figure; its tier is only a colour. An unseen flight's
    // figure floors while its tier rounds, so near a cut the tier can flip
    // with the figure the same: nothing the reader sees moved.
    if (prev.odds === now.odds) return null;
    const moved =
      prev.tone !== now.tone || Math.abs(oddsValue(prev.odds) - oddsValue(now.odds)) >= ODDS_STEP;
    return moved ? `the odds were ${labelPhrase(prev.odds)}` : null;
  }
  // Only a known tier moving to another is news; "not sure yet" is no answer to compare.
  if (prev.tone === now.tone || now.tone === "unknown" || now.tone === "open") return null;
  return WAS_FORECAST[prev.tone] ?? null;
}

/**
 * The note under a row whose answer changed since this browser last showed
 * it, or null. `when` is checkedWhen's phrase. See the file header for what
 * counts.
 */
export function changeNote(prev: Seen, now: Seen, when: string, hub = false): string | null {
  if (!now.firm) {
    if (prev.firm) return null;
    const was = forecastWas(prev, now);
    return was ? `Changed since you checked ${when}: ${was}.` : null;
  }
  if (!prev.firm) {
    const odds = prev.odds ? `; the odds were ${labelPhrase(prev.odds)}` : "";
    return `New since you checked ${when}: ${hub ? "a firm answer" : "an aircraft is assigned"}${odds}.`;
  }
  const swapped =
    prev.tails.length > 0 && now.tails.length > 0 && prev.tails.join() !== now.tails.join();
  const moved = prev.tone !== now.tone;
  if (!swapped && !moved) return null;
  // More or fewer aircraft named is a leg added, dropped or answered
  // differently, which is not a plane changed: only the names are certain.
  const sameCount = prev.tails.length === now.tails.length;
  const said = [
    ...(swapped
      ? [
          `${sameCount ? "the plane was" : "the answer named"} ${planes(prev.tails)}, now ${planes(now.tails)}`,
        ]
      : []),
    ...(moved && WAS[prev.tone] ? [WAS[prev.tone]] : []),
  ];
  if (said.length === 0) return null;
  return `Changed since you checked ${when}: ${said.join("; ")}.`;
}

/**
 * A hub answer as its row prints it: the label the form leads with and the
 * airline, one line on a phone ("≥40% Starlink · United Airlines"). The form's
 * whole sentence is the airline site's page, which the row links. Plain text,
 * escaped where it is printed.
 */
export function hubWords(d: CheckAnyBody): Pick<RecentCheck, "h" | "k" | "c"> {
  const lead = checkAnyLead(d, false);
  const airline = d.airline && d.airline.length <= MAX_AIRLINE_LENGTH ? d.airline : undefined;
  const words = lead ? [lead.label, ...(airline ? [airline] : [])].join(" · ") : "";
  return {
    h: words && words.length <= MAX_WORDS_LENGTH ? words : undefined,
    k: airline,
    c: lead?.cls,
  };
}

/** What a hub answer said, for the note: yes, no or open, the aircraft where
 * it names them, and the figure its label printed. */
export function hubSeen(d: CheckAnyBody): Seen {
  const firm = typeof d.hasStarlink === "boolean";
  const flights = Array.isArray(d.flights) ? d.flights : [];
  const tails = flights
    .map((f) => (f as { tail_number?: unknown } | null)?.tail_number)
    .filter((t): t is string => typeof t === "string" && TAIL_RE.test(t));
  const odds = firm ? undefined : checkAnyLead(d, false)?.odds;
  return {
    tone: d.hasStarlink === true ? "yes" : firm ? "no" : "open",
    firm,
    tails: [...new Set(tails)].sort().slice(0, MAX_TAILS),
    ...(odds && ODDS_RE.test(odds) ? { odds } : {}),
  };
}

/**
 * Remember a hub answer: a dated check that got one. A community airline's
 * form answers differently (flight-search.ts), so its checks are not kept:
 * the list would print them in the hub form's words.
 */
export function rememberHubCheck(
  store: RecentStore | null,
  form: HTMLFormElement,
  asked: URLSearchParams,
  answer: CheckAnyBody,
  nowSec: number
): boolean {
  if (answer.error || form.dataset.answer === "community") return false;
  const code = (name: string) => asked.get(name)?.trim().toUpperCase() || undefined;
  return rememberCheck(
    store,
    {
      f: canonicalFlightInput(asked.get("flight_number") ?? ""),
      d: asked.get("date") ?? "",
      o: code("origin"),
      a: code("destination"),
      t: asked.get("aircraft_type")?.trim() || undefined,
      ...hubWords(answer),
      seen: hubSeen(answer),
    },
    nowSec
  );
}

// --- The homepage list -----------------------------------------------------

/** An airline site's answer for one row (GET /static/recent/…, app.ts). */
export interface RowAnswer extends Shown {
  /** The date is over at the flight's own airport. */
  passed: boolean;
}

const SECTION_ID = "recent-checks";
const TITLE_ID = "recent-checks-title";
const ROW_ACTION =
  "text-muted transition-colors hover:text-primary focus:outline-none focus-visible:text-primary focus-visible:ring-2 focus-visible:ring-accent/50";

const idLine = (c: RecentCheck, nowSec: number) =>
  [c.f, monthDay(c.d, nowSec), ...(c.o && c.a ? [`${c.o} → ${c.a}`] : []), ...(c.t ? [c.t] : [])]
    .map(esc)
    .join(" · ");

/** The flight's own page on this site, with its date and leg. */
function answerPath(c: RecentCheck): string {
  const leg = new URLSearchParams();
  if (c.o) leg.set("origin", c.o);
  if (c.a) leg.set("destination", c.a);
  const query = leg.toString();
  // Joined at run time so the bundle holds no address template a crawler can
  // lift and request (see tailPagePath in flight-answer.ts).
  return `${["", "check-flight", encodeURIComponent(c.f), encodeURIComponent(c.d)].join("/")}${query ? `?${query}` : ""}`;
}

/**
 * A hub row's way to the rest of its answer: the airline site's page for the
 * flight. Short, so the row stays two lines on a phone; the airline is named
 * on the line above, and the label names the site for a screen reader.
 */
export function hubRowLink(
  airline: string | undefined,
  pages: CheckPages,
  c: Pick<RecentCheck, "f" | "d">,
  counted = false
): string {
  const page = checkPageHref({ airline }, pages, c.f, c.d);
  if (!page) return "";
  return `<a${counted ? " data-recent-open" : ""} href="${esc(page.href)}" aria-label="Full answer for ${esc(page.fn)} on ${esc(page.site)}" class="mt-1 block py-2 text-accent hover:underline">Full answer →</a>`;
}

/** The headline's type, for the answer and for the room held for it. */
const HEADLINE_TYPE = "font-display text-base text-balance";

/**
 * A waiting row's answer: "Checking…" over the words the answer last had,
 * unseen and unread, in the answer's own markup so they take the room it will.
 * A row kept before those words were (none are, bar a hand-edited list) waits
 * on two plain lines.
 */
function waitingHtml(c: RecentCheck, hub: boolean, pages: CheckPages): string {
  if (!c.h) return "<span data-recent-wait>Checking…</span>";
  const held = hub
    ? `<span aria-hidden="true" class="invisible block">${esc(c.h)}${hubRowLink(c.k, pages, c)}</span>`
    : `<span aria-hidden="true" class="invisible ${HEADLINE_TYPE}">${wholeDates(esc(c.h))}</span>`;
  return `<span data-recent-wait class="absolute inset-x-0 top-0">Checking…</span>${held}`;
}

/**
 * One row, before its answer is in. On an airline site the row is a link to
 * the flight's page; the hub has no such page, so its answer brings its own
 * link to the airline's site.
 */
export function recentRowHtml(
  c: RecentCheck,
  nowSec: number,
  hub: boolean,
  pages: CheckPages = {}
): string {
  const inner = `<span class="block font-mono text-xs text-muted">${wholeDates(idLine(c, nowSec))}</span> <span data-recent-answer class="relative mt-1 block min-h-10 text-sm leading-5 text-secondary">${waitingHtml(c, hub, pages)}</span>`;
  const main = hub
    ? `<div class="min-w-0 flex-1 py-3">${inner}</div>`
    : `<a href="${esc(answerPath(c))}" rel="nofollow" data-recent-open class="group block min-w-0 flex-1 rounded py-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">${inner}</a>`;
  return `<li data-recent-row="${esc(checkKey(c))}" class="flex items-start gap-2 border-t border-subtle first:border-t-0">${main} <button type="button" data-recent-remove aria-label="Remove ${esc(c.f)} on ${esc(monthDay(c.d, nowSec))} from your flights" class="-mr-2 grid size-11 shrink-0 place-items-center rounded text-lg leading-none ${ROW_ACTION}">×</button></li>`;
}

/** The whole list. Nothing is drawn for an empty one: the caller draws no section. */
export function recentSectionHtml(
  list: RecentCheck[],
  nowSec: number,
  hub: boolean,
  pages: CheckPages = {}
): string {
  const rows = inShowOrder(list)
    .map((c) => recentRowHtml(c, nowSec, hub, pages))
    .join(" ");
  return `<div class="${SURFACE} ${PANEL_PAD.sm}"><h2 id="${TITLE_ID}" class="${EYEBROW_TEXT}">Your flights</h2> <ul class="mt-1">${rows}</ul> <p class="mt-1 flex flex-wrap items-center justify-between gap-x-3 border-t border-subtle pt-2 text-xs text-muted"><span>Kept in this browser only.</span> <button type="button" data-recent-clear class="-mx-2 min-h-11 rounded px-2 underline ${ROW_ACTION}">Clear all</button></p></div>`;
}

const noteHtml = (note: string | null) =>
  note
    ? ` <span data-recent-note class="mt-2 block border-l-2 border-accent pl-2 text-sm text-primary">${wholeDates(esc(note))}</span>`
    : "";

/** An airline site's answer line: the answer page's own headline, in its colour. */
export function airlineAnswerHtml(
  answer: Pick<RowAnswer, "headline" | "tone">,
  note: string | null
): string {
  const tone = (ANSWER_TONES as readonly string[]).includes(answer.tone)
    ? (answer.tone as AnswerTone)
    : "unknown";
  return `<span class="${HEADLINE_TYPE} group-hover:underline ${answerHeadlineClass(tone)}">${wholeDates(esc(answer.headline))}</span>${noteHtml(note)}`;
}

/**
 * A hub row's answer: the form's label in its colour and the airline (hubWords),
 * the note, then the link to the airline site's page, which has the rest.
 */
export function hubAnswerHtml(
  read: Pick<RowRead, "h" | "c">,
  note: string | null,
  link: string
): string {
  const cut = read.h.indexOf(" · ");
  const label = cut < 0 ? read.h : read.h.slice(0, cut);
  const rest = cut < 0 ? "" : `<span class="text-secondary">${esc(read.h.slice(cut))}</span>`;
  const cls = read.c && isLeadClass(read.c) ? read.c : "text-muted";
  return `<span class="${cls}">${esc(label)}</span>${rest}${noteHtml(note)}${link}`;
}

// True of a lookup that failed once and of a browser that never gets one (the
// answer needs a request header Safari sends only from 16.4).
const FAILED = "Couldn't get the answer here.";
const FAILED_OPEN = `${FAILED} Open the flight's page for it.`;
/** How long a changed answer waits for the others before the list moves without them. */
const LATE_MS = 1500;

function isRowAnswer(v: unknown): v is RowAnswer {
  const r = v as RowAnswer | null;
  return isSeen(r) && typeof r.headline === "string" && typeof r.passed === "boolean";
}

// In pieces, like the answer page's address above.
const ANSWER_PATH = ["", "static", "recent"];
const TAP_PATH = [...ANSWER_PATH, "tap"];

export type RecentAction = "shown" | "opened" | "cleared";

/** Count a use: one word, to our own host. No flight, date or list is sent. */
function countUse(action: RecentAction): void {
  try {
    navigator.sendBeacon?.(TAP_PATH.join("/"), action);
  } catch {
    // Counting never gets in the way of the list.
  }
}

/** The form the list sits under, and the box it goes after so the form never moves. */
function placement(): { hub: boolean; after: Element; pages: CheckPages } | null {
  const hubForm = document.getElementById("hub-check-flight");
  if (hubForm?.parentElement) {
    let pages: CheckPages = {};
    try {
      pages = JSON.parse(hubForm.dataset.checkPages ?? "{}");
    } catch {
      // The answers print without their hand-off links.
    }
    return { hub: true, after: hubForm.parentElement, pages };
  }
  const box = document.getElementById("home-flight-search")?.parentElement?.parentElement;
  return box ? { hub: false, after: box, pages: {} } : null;
}

async function askAirlineSite(c: RecentCheck): Promise<RowAnswer | null> {
  const leg = new URLSearchParams();
  if (c.o) leg.set("origin", c.o);
  if (c.a) leg.set("destination", c.a);
  const query = leg.toString();
  const path = [...ANSWER_PATH, encodeURIComponent(c.f), encodeURIComponent(c.d)].join("/");
  const res = await fetch(`${path}${query ? `?${query}` : ""}`);
  if (!res.ok) return null;
  const body: unknown = await res.json();
  return isRowAnswer(body) ? body : null;
}

async function askHub(c: RecentCheck): Promise<CheckAnyBody | null> {
  const params = new URLSearchParams({ flight_number: c.f, date: c.d });
  if (c.o) params.set("origin", c.o);
  if (c.a) params.set("destination", c.a);
  if (c.t) params.set("aircraft_type", c.t);
  const res = await fetch(`/api/check-any-flight?${params}`);
  const body = (await res.json()) as CheckAnyBody;
  return body && typeof body === "object" && !body.error ? body : null;
}

/**
 * Draw the list under the homepage's flight form and fill in each answer, one
 * request at a time. With nothing remembered, or storage out of reach, the
 * page is left exactly as it was served.
 */
export function wireRecentChecks(): void {
  const store = browserStore();
  const nowSec = Math.floor(Date.now() / 1000);
  const list = currentChecks(store, nowSec);
  const place = list.length > 0 ? placement() : null;
  if (!place || document.getElementById(SECTION_ID)) return;
  const { hub, pages } = place;

  const section = document.createElement("section");
  section.id = SECTION_ID;
  section.setAttribute("aria-labelledby", TITLE_ID);
  if (!hub) section.className = "relative mx-auto mb-6 w-full max-w-xl";
  section.innerHTML = recentSectionHtml(list, nowSec, hub, pages);
  place.after.insertAdjacentElement("afterend", section);
  countUse("shown");

  const rowOf = (c: RecentCheck) =>
    Array.from(section.querySelectorAll<HTMLElement>("[data-recent-row]")).find(
      (el) => el.dataset.recentRow === checkKey(c)
    );
  const dropRow = (row: Element | undefined) => {
    row?.remove();
    if (!section.querySelector("[data-recent-row]")) section.remove();
  };

  section.addEventListener("click", (e) => {
    const target = e.target as Element | null;
    if (target?.closest("[data-recent-clear]")) {
      clearChecks(store);
      section.remove();
      countUse("cleared");
      return;
    }
    const row = target?.closest<HTMLElement>("[data-recent-row]");
    if (row && target?.closest("[data-recent-remove]")) {
      forgetCheck(store, row.dataset.recentRow ?? "");
      dropRow(row);
      return;
    }
    if (target?.closest("[data-recent-open]") && e.isTrusted) countUse("opened");
  });

  // An answer in the words its row holds room for goes in as it arrives. Any
  // other changes the row's height, so it waits for the rest: the list then
  // moves once, not row by row.
  const late: Array<() => void> = [];
  let lateTimer: ReturnType<typeof setTimeout> | undefined;
  const showLate = () => {
    clearTimeout(lateTimer);
    lateTimer = undefined;
    for (const draw of late.splice(0)) draw();
  };
  const show = (steady: boolean, draw: () => void) => {
    if (steady) return draw();
    late.push(draw);
    lateTimer ??= setTimeout(showLate, LATE_MS);
  };
  // Over the held room where there is some, so the row keeps its height.
  const fail = (out: Element, words: string) => {
    (out.querySelector("[data-recent-wait]") ?? out).textContent = words;
  };

  // Steady when nothing changed and the words are the ones the row holds room for.
  const draw = (c: RecentCheck, out: Element, read: RowRead, airline = c.k) => {
    const note = changeNote(c.seen, read.seen, checkedWhen(c.at, nowSec), hub);
    show(!note && read.h === c.h && airline === c.k, () => {
      out.innerHTML = hub
        ? hubAnswerHtml(read, note, hubRowLink(airline, pages, c, true))
        : airlineAnswerHtml({ headline: read.h, tone: read.seen.tone }, note);
    });
  };

  const fill = async (c: RecentCheck): Promise<void> => {
    const out = rowOf(c)?.querySelector("[data-recent-answer]");
    if (!out) return;
    const fresh = freshAnswer(c, nowSec, hub);
    if (fresh) return draw(c, out, fresh);
    try {
      if (hub) {
        const body = await askHub(c);
        const words = body ? hubWords(body) : null;
        if (!body || !words?.h) return fail(out, FAILED);
        const read: RowRead = { h: words.h, seen: hubSeen(body), c: words.c, at: nowSec };
        rememberRead(store, checkKey(c), read);
        return draw(c, out, read, words.k);
      }
      const answer = await askAirlineSite(c);
      if (!answer) return fail(out, FAILED_OPEN);
      if (answer.passed) {
        forgetCheck(store, checkKey(c));
        show(false, () => dropRow(rowOf(c)));
        return;
      }
      const seen: Seen = {
        tone: answer.tone,
        firm: answer.firm,
        tails: answer.tails,
        ...(answer.odds ? { odds: answer.odds } : {}),
      };
      const read: RowRead = { h: answer.headline, seen, at: nowSec };
      rememberRead(store, checkKey(c), read);
      draw(c, out, read);
    } catch {
      fail(out, hub ? FAILED : FAILED_OPEN);
    }
  };

  // Once the page has loaded and drawn, and never two at once: these are the
  // visitor's own few flights, not a batch.
  const run = async () => {
    for (const c of inShowOrder(list)) await fill(c);
    showLate();
  };
  const start = () => setTimeout(() => void run(), 0);
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start, { once: true });
}
