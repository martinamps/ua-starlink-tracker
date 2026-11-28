/**
 * The /check-flight answer card, rendered from an /api/check-flight body.
 *
 * One renderer for both sides: the server calls it for a dated permalink so
 * the answer is in the HTML, and the browser bundle calls it when a live
 * re-check comes back. Plain strings (no React) because the browser has no
 * React; every interpolated value goes through esc(). Keep imports
 * dependency-free: this file is bundled for the browser.
 */
import { aircraftName } from "../airlines/aircraft-families";
import {
  ageLabel,
  capitalize,
  flightLabel,
  flightPhrase,
  flightShare,
  fmt,
  monthDay,
  probTier,
  utcDayTime,
  wholeDates,
  zonedDeparture,
  zonedIsoDate,
} from "../components/ui/format";
import { TONE_TEXT, type Tone, toneColor } from "../components/ui/tone-classes";
import { type SeatbackLiveTv, seatbackLiveTv } from "../utils/aircraft-specs";
import { toIata } from "../utils/airport-code";
import { esc } from "./esc";
import { meterHtml } from "./meter";
import { shareControlHtml } from "./share";

interface WireFlight {
  tail_number?: string | null;
  aircraft_type?: string | null;
  flight_number?: string | null;
  ua_flight_number?: string | null;
  departure_airport?: string | null;
  arrival_airport?: string | null;
  departure_time?: number | null;
  operated_by?: string | null;
  fleet_type?: string | null;
}

interface WireSegment {
  tail_number: string;
  aircraft_model?: string | null;
  origin?: string | null;
  destination?: string | null;
  hasStarlink: boolean | null;
  verified_wifi?: string | null;
  verified_at?: number | null;
}

interface WireAlternative {
  flight_number: string;
  departure_time: number;
  tail_number: string;
  aircraft_type?: string | null;
}

/** The subset of the /api/check-flight body the card reads. */
export interface CheckFlightBody {
  hasStarlink?: boolean | null;
  confidence?: string;
  message?: string;
  reason?: string;
  error?: string;
  prediction?: { probability: number; confidence?: string; n_observations?: number };
  flights?: WireFlight[];
  fallback?: { segments?: WireSegment[] };
  /** The scheduled aircraft a type answer names. */
  assignment?: { tail_number?: string | null };
  /** The airline's own dated count, where it and not our tail list decided the answer. */
  airline_count?: {
    airline?: string;
    aircraft?: string;
    connected?: number;
    total?: number;
    as_of?: string;
  };
  sameDayAlternatives?: WireAlternative[];
}

export const ANSWER_TONES = [
  "yes",
  "partial",
  "no",
  "likely",
  "maybe",
  "unlikely",
  "unknown",
] as const;
export type AnswerTone = (typeof ANSWER_TONES)[number];

/** One leg of the number on the date asked, as the server's own tables hold it. */
export interface DayLeg {
  origin: string;
  destination: string;
  departure_time: number | null;
  /** The aircraft we hold on the leg that date, if any. */
  tail: string | null;
  /** Null for an aircraft we haven't checked, and for a leg with none known. */
  starlink: boolean | null;
  /** Held for this date; false for a leg known only from the number's recent routes. */
  dated: boolean;
}

export interface AnswerContext {
  flightNumber: string;
  /** YYYY-MM-DD the viewer asked about. */
  date: string;
  /** Whole UTC days from today to `date`; negative is past. */
  daysOut: number;
  /** IANA zone of the flight's usual departure airport: its clock decides
   * whether `date` has passed and renders times when the body names no airport. */
  origin?: string | null;
  originZone?: string | null;
  nowSec: number;
  airlineName: string;
  /** How a listed, unsettled tail reads for this airline (listedWording's
   * status); the united wording when absent. */
  listedStatus?: string;
  /** IANA zone for an airport code, undefined when unmapped. */
  zoneFor: (airport: string) => string | undefined;
  liveTv: Record<SeatbackLiveTv, string> | null;
  watchEnabled: boolean;
  routePlannerEnabled: boolean;
  /** /fleet/{tail} serves on this host, for the planes we list. */
  tailPages: boolean;
  /** The date's legs beyond those a yes names, on a page with no leg chosen. */
  dayLegs?: DayLeg[];
  /** The answer's aircraft is a logged sighting read back, last seen then
   * (unix seconds); absent for an answer made now. */
  seenAt?: number;
  /** Host for webcal:// links. */
  host: string;
  /** This answer's own page: canonical host, with its date and leg. Absent
   * where the answer has no page of its own. */
  shareUrl?: string;
  /** The flight-change notice's public key, beside the calendar offer; absent
   * while its switch is off, and the card is then the one it always was. */
  noticeKey?: string;
}

export interface FlightAnswer {
  tone: AnswerTone;
  /** Plain-text answer sentence, also used for the page title on dated views. */
  headline: string;
  html: string;
  /** True when the answer names an assigned aircraft; a live re-check can't improve it. */
  firm: boolean;
  /** A partial answer's Starlink legs ("ORD → FLL"), for surfaces that print a figure. */
  yesLegs?: string[];
  /** A forecast's figure as its headline prints it ("74%", "<1%"). */
  odds?: string;
}

const WATCH_MAX_DAYS_OUT = 330;

/** Departure clock at the airport, like a boarding pass: "Sun, Sep 21" / "8:38 AM PDT".
 * Without an airport it falls back to the flight's usual origin, then UTC. */
function departs(unix: number, airport: string | null | undefined, ctx: AnswerContext) {
  const zone = airport ? ctx.zoneFor(toIata(airport)) : (ctx.originZone ?? undefined);
  return zonedDeparture(unix, zone);
}

/**
 * Has `date` ended at the departure airport? A UTC comparison calls a US
 * evening flight "yesterday" hours before it leaves; with no known zone the
 * last place on Earth still on `date` (UTC-12) decides.
 */
export function datePassed(ctx: Pick<AnswerContext, "date" | "daysOut" | "nowSec" | "originZone">) {
  if (ctx.originZone) return ctx.date < zonedIsoDate(ctx.nowSec, ctx.originZone);
  return ctx.daysOut < -1;
}

/** verified_wifi 'None' means no Wi-Fi installed; it is never a provider name. */
function wifiPhrase(v: string | null | undefined): string {
  const w = String(v ?? "").trim();
  if (!w || /^none$/i.test(w)) return "no Wi-Fi";
  if (/^non-starlink$/i.test(w)) return "Wi-Fi that isn't Starlink";
  return `${w} Wi-Fi`;
}

const ANSWER_TONE: Record<AnswerTone, Tone> = {
  yes: "success",
  partial: "warn",
  likely: "success",
  maybe: "warn",
  no: "neutral",
  unlikely: "neutral",
  unknown: "neutral",
};

// Written out whole so the Tailwind scanner finds every class verbatim.
const TONE_CARD: Partial<Record<Tone, string>> = {
  success: "border-success/50 bg-success/10",
  warn: "border-warn/40 bg-warn/5",
};
const NEUTRAL_CARD = "border-subtle bg-surface-elevated";

/** A no reads as plainly as a yes: neutral headlines stay primary, not muted. */
const headlineClass = (tone: Tone) => (tone === "neutral" ? "text-primary" : TONE_TEXT[tone]);

/** The card headline's colour for an answer, for a surface that prints the
 * headline outside the card (the homepage's remembered flights). */
export const answerHeadlineClass = (answer: AnswerTone) => headlineClass(ANSWER_TONE[answer]);

function row(label: string, valueHtml: string): string {
  return `<div class="flex gap-3"><dt class="w-24 shrink-0 text-muted">${esc(label)}</dt> <dd class="min-w-0 text-secondary">${valueHtml}</dd></div> `;
}

const tail = (t: string | null | undefined) =>
  `<span class="font-mono text-primary">${esc(t)}</span>`;

/** A plane on our Starlink list, linked to its page where the host has them.
 * Only for listed tails: a fallback segment's tail may be on no roster. */
const listedTail = (t: string | null | undefined, ctx: AnswerContext) =>
  ctx.tailPages && t && /^N[A-Z0-9]{1,5}$/.test(t)
    ? `<a href="${tailPagePath(t)}" class="font-mono text-primary hover:text-accent transition-colors">${esc(t)}</a>`
    : tail(t);

// Joined at run time: written as one template, the address sat whole in the
// browser bundle, and crawlers that read scripts for links requested the
// template itself as a page (a 404 each time).
const tailPagePath = (t: string) => ["", "fleet", esc(t)].join("/");

const typeName = (t: string | null | undefined) => (t ? ` · ${esc(aircraftName(t))}` : "");

function flightRows(f: WireFlight, ctx: AnswerContext): string {
  const dep = toIata(f.departure_airport);
  const arr = toIata(f.arrival_airport);
  const rows: string[] = [];
  if (dep && arr) rows.push(row("Route", `${esc(dep)} → ${esc(arr)}`));
  if (f.departure_time) {
    const when = departs(f.departure_time, dep, ctx);
    rows.push(row("Departs", `${esc(when.day)}, ${esc(when.time)}`));
  }
  if (f.tail_number) {
    rows.push(row("Aircraft", `${listedTail(f.tail_number, ctx)}${typeName(f.aircraft_type)}`));
  }
  if (f.operated_by) rows.push(row("Operated by", esc(f.operated_by)));
  return ` <dl class="mt-3 space-y-1.5 text-sm">${rows.join("")}</dl>`;
}

function liveTvLine(f: WireFlight, ctx: AnswerContext, leg = "", link = true): string {
  if (!ctx.liveTv) return "";
  const tier = seatbackLiveTv(f.fleet_type, f.aircraft_type);
  const more = link
    ? ' <a href="/live-tv" class="text-accent hover:underline">Which planes have live TV</a>'
    : "";
  return ` <p class="mt-3 text-sm text-secondary">${esc(leg)}${esc(ctx.liveTv[tier])}${more}</p>`;
}

const legLabel = (f: WireFlight) => {
  const dep = toIata(f.departure_airport);
  const arr = toIata(f.arrival_airport);
  return dep && arr ? `${dep} → ${arr}` : null;
};

type Pair = { origin: string; destination: string };

const flightPair = (f: WireFlight): Pair | null => {
  const origin = toIata(f.departure_airport);
  const destination = toIata(f.arrival_airport);
  return origin && destination ? { origin, destination } : null;
};

const pairLabel = (p: Pair) => `${p.origin} → ${p.destination}`;
const samePair = (a: Pair, b: Pair) => a.origin === b.origin && a.destination === b.destination;

/**
 * How each flight's leg reads in the answer. One leg held twice that date on
 * two planes (two departures, or a swap whose new row is minutes off the old)
 * would print one label twice, so those carry their departure time.
 */
function legLabels(flights: WireFlight[], ctx: AnswerContext): (string | null)[] {
  return flights.map((f) => {
    const leg = legLabel(f);
    if (!leg || !f.departure_time) return leg;
    const twice = flights.some(
      (o) => o !== f && legLabel(o) === leg && o.tail_number !== f.tail_number
    );
    return twice ? `${leg} ${departs(f.departure_time, f.departure_airport, ctx).time}` : leg;
  });
}

/**
 * The aircraft a yes names. A number can fly two legs in a day on two planes,
 * and a traveller is on one of them: each leg then carries its own plane, in
 * departure order. One plane, on one leg or on all of them, is named alone.
 */
function yesPlanes(flights: WireFlight[], ctx: AnswerContext): string | null {
  const tails = new Set(flights.map((f) => f.tail_number).filter(Boolean));
  if (tails.size < 2) return flights[0]?.tail_number ?? null;
  const labels = legLabels(flights, ctx);
  return flights
    .flatMap((f, i) =>
      f.tail_number ? [labels[i] ? `${labels[i]} on ${f.tail_number}` : f.tail_number] : []
    )
    .join(", ");
}

/**
 * The date's legs a yes does not cover: a yes lists Starlink legs only, so a
 * leg on another aircraft, or one whose aircraft we don't hold, is absent
 * from it. Dated legs always count. A leg known only from the number's recent
 * routes counts when it connects to a leg already held, and no held leg
 * already fills that place: routes that don't connect are other days'
 * routings. Empty when the yes names no leg to tell the others from.
 */
export function unansweredLegs(
  flights: WireFlight[] | undefined,
  dayLegs: DayLeg[] | undefined
): DayLeg[] {
  if (!flights?.length || !dayLegs?.length) return [];
  const answered: Pair[] = [];
  for (const f of flights) {
    const p = flightPair(f);
    if (!p) return [];
    answered.push(p);
  }
  const others: DayLeg[] = [];
  const held = () => [...answered, ...others];
  const fresh = (l: DayLeg) => l.origin !== l.destination && !held().some((h) => samePair(h, l));
  for (const l of dayLegs) if (l.dated && fresh(l)) others.push(l);
  const connects = (l: DayLeg) =>
    held().some(
      (h) =>
        (l.destination === h.origin && !held().some((o) => o.destination === h.origin)) ||
        (l.origin === h.destination && !held().some((o) => o.origin === h.destination))
    );
  for (let grew = true; grew; ) {
    grew = false;
    for (const l of dayLegs) {
      if (!l.dated && fresh(l) && connects(l)) {
        others.push(l);
        grew = true;
      }
    }
  }
  return others;
}

/**
 * Legs in the order they are flown: by departure time where every leg has
 * one, else by how they connect (a leg nothing else arrives at leads).
 */
export function inTravelOrder<T extends Pair & { departure_time?: number | null }>(legs: T[]): T[] {
  if (legs.every((l) => l.departure_time)) {
    return [...legs].sort((a, b) => (a.departure_time ?? 0) - (b.departure_time ?? 0));
  }
  const left = [...legs];
  const out: T[] = [];
  while (left.length > 0) {
    const last = out[out.length - 1];
    const i = Math.max(
      0,
      last
        ? left.findIndex((l) => l.origin === last.destination)
        : left.findIndex((l) => !left.some((o) => o !== l && o.destination === l.origin))
    );
    out.push(...left.splice(i, 1));
  }
  return out;
}

/** The legs a yes does not cover, placed in travel order around the legs it does. */
function uncoveredInOrder(flights: WireFlight[], dayLegs: DayLeg[] | undefined): DayLeg[] {
  const others = unansweredLegs(flights, dayLegs);
  if (others.length < 2) return others;
  const covered = flights.flatMap((f) => {
    const p = flightPair(f);
    return p ? [{ ...p, departure_time: f.departure_time }] : [];
  });
  return inTravelOrder<Pair & { departure_time?: number | null }>([...covered, ...others]).filter(
    (l): l is DayLeg => others.includes(l as DayLeg)
  );
}

/** What we hold of a leg the yes does not cover, as a clause of the headline. */
function otherLegClause(l: DayLeg): string {
  const leg = pairLabel(l);
  if (!l.tail) return `we have no aircraft for ${leg} yet`;
  return l.starlink === false
    ? `not on ${leg} (${l.tail})`
    : `${leg} is on ${l.tail}, which we haven't checked`;
}

/**
 * The headline of a yes that holds for some of the date's legs only. It names
 * the legs it is for and says what we hold of each other leg, and never
 * opens with a yes: a traveller on the other leg would read it as theirs.
 */
function partialHeadline(
  on: string,
  flights: WireFlight[],
  others: DayLeg[],
  status: string,
  ctx: AnswerContext
): string {
  const labels = legLabels(flights, ctx);
  const tails = new Set(flights.map((f) => f.tail_number).filter(Boolean));
  const [onlyTail] = tails;
  const yes =
    tails.size === 1
      ? `${[...new Set(labels)].join(" and ")} (${onlyTail}, ${status})`
      : `${flights.map((f, i) => (f.tail_number ? `${labels[i]} on ${f.tail_number}` : labels[i])).join(", ")} (${status})`;
  const clauses = others.map(otherLegClause);
  const nos = clauses.filter((c) => c.startsWith("not on "));
  const rest = clauses.filter((c) => !c.startsWith("not on "));
  return `${on} has Starlink on ${yes}${nos.map((c) => `, ${c}`).join("")}${rest.map((c) => `; ${c}`).join("")}`;
}

/** The legs a partial yes does not cover, each with what we hold and its own page. */
function otherLegsHtml(others: DayLeg[], ctx: AnswerContext): string {
  const blocks = others
    .map((l) => {
      const href = `/check-flight/${encodeURIComponent(ctx.flightNumber)}/${encodeURIComponent(ctx.date)}?origin=${encodeURIComponent(l.origin)}&destination=${encodeURIComponent(l.destination)}`;
      const rows = [
        row("Route", esc(pairLabel(l))),
        row("Aircraft", l.tail ? tail(l.tail) : "Not known to us yet"),
        ...(l.tail ? [row("Wi-Fi", l.starlink === false ? "No Starlink" : "Not checked yet")] : []),
      ];
      return ` <dl class="mt-3 space-y-1.5 text-sm">${rows.join("")}</dl> <p class="mt-3 text-sm"><a href="${esc(href)}" rel="nofollow" class="text-accent hover:underline">Check ${esc(pairLabel(l))} on its own</a></p>`;
    })
    .join("");
  return ` <div class="mt-4"><h3 class="text-sm font-semibold text-primary">${others.length === 1 ? "The other leg" : "The other legs"} that day</h3>${blocks}</div>`;
}

/** Live TV goes by aircraft type: legs on types that differ each get their own line. */
function liveTvLines(flights: WireFlight[], ctx: AnswerContext): string {
  const first = flights[0] ?? {};
  if (!ctx.liveTv) return "";
  const tier = (f: WireFlight) => seatbackLiveTv(f.fleet_type, f.aircraft_type);
  const labels = legLabels(flights, ctx);
  const labelled = flights.flatMap((f, i) => (labels[i] ? [{ f, label: labels[i] }] : []));
  if (labelled.length < 2 || labelled.every(({ f }) => tier(f) === tier(labelled[0].f))) {
    return liveTvLine(first, ctx);
  }
  return labelled
    .map(({ f, label }, i) => liveTvLine(f, ctx, `${label}: `, i === labelled.length - 1))
    .join("");
}

function flightAwareLink(f: WireFlight, ctx: AnswerContext): string {
  if (!f.flight_number) return "";
  const dep = toIata(f.departure_airport);
  const arr = toIata(f.arrival_airport);
  const utcDate = f.departure_time
    ? new Date(f.departure_time * 1000).toISOString().slice(0, 10).replace(/-/g, "")
    : ctx.date.replace(/-/g, "");
  const icao = (c: string) => (c.length === 3 ? `K${c}` : c);
  const url = `https://www.flightaware.com/live/flight/${encodeURIComponent(f.flight_number)}/history/${utcDate}/${icao(dep)}/${icao(arr)}`;
  return ` <p class="mt-3 text-sm"><a href="${esc(url)}" target="_blank" rel="nofollow noopener noreferrer" class="text-accent hover:underline">View on FlightAware</a></p>`;
}

function alternativesHtml(
  list: WireAlternative[] | undefined,
  ctx: AnswerContext,
  origin?: string | null
) {
  if (!list?.length) return "";
  const items = list
    .map(
      (a) =>
        `<li><a href="/check-flight/${encodeURIComponent(a.flight_number)}/${encodeURIComponent(ctx.date)}" class="text-accent hover:underline">${esc(a.flight_number)}</a> at ${esc(departs(a.departure_time, origin, ctx).time)} · ${listedTail(a.tail_number, ctx)}${typeName(a.aircraft_type)}</li> `
    )
    .join("");
  return ` <div class="mt-4"><h3 class="text-sm font-semibold text-primary">Starlink flights on this route that day</h3> <ul class="mt-1 space-y-1 text-sm text-secondary">${items}</ul></div>`;
}

function routePlannerCta(
  origin: string | null | undefined,
  destination: string | null | undefined,
  ctx: AnswerContext
) {
  const o = toIata(origin);
  const d = toIata(destination);
  if (!ctx.routePlannerEnabled || !/^[A-Z]{3}$/.test(o) || !/^[A-Z]{3}$/.test(d)) return "";
  return ` <p class="mt-3 text-sm"><a href="/route-planner/${o}/${d}" rel="nofollow" class="text-accent hover:underline">Find Starlink flights from ${o} to ${d}</a></p>`;
}

/** Anchor of the calendar offer, for links from the undated flight page. */
export const CALENDAR_OFFER_ID = "flight-calendar";

/** The feed serves this flight and date: same gate as /cal (src/server/watch.ts). */
export const calendarOffered = (
  ctx: Pick<AnswerContext, "watchEnabled" | "date" | "daysOut" | "nowSec" | "originZone">
) => ctx.watchEnabled && !datePassed(ctx) && ctx.daysOut <= WATCH_MAX_DAYS_OUT;

// Each sentence claims only what the feed does (src/utils/ics.ts): the event is
// re-rendered from our rows on every fetch, and the app decides when to fetch.
const CALENDAR_LEAD_FIRM =
  "The event shows this answer and changes if we see a different aircraft on the flight.";
const CALENDAR_LEAD_PENDING =
  "The event shows today's answer, then the aircraft and a yes or no once we see it assigned, usually about 2 days before departure. It changes again if the aircraft is swapped.";
const CALENDAR_LAG =
  "Your calendar app fetches changes on its own schedule, from about hourly to once a day, so this is not an instant alert.";

const CALENDAR_BUTTON =
  "inline-flex min-h-11 items-center rounded border border-neutral bg-base px-3 text-sm text-primary transition-colors hover:border-accent hover:text-accent focus:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/50";

/**
 * The calendar offer. The two subscriptions keep fetching the feed; the file
 * is imported once and never fetched again, so it is set apart and says so.
 */
function watchRow(ctx: AnswerContext, firm: boolean): string {
  if (!calendarOffered(ctx)) return "";
  const path = `/cal/${encodeURIComponent(ctx.flightNumber)}/${encodeURIComponent(ctx.date)}.ics`;
  const webcal = `webcal://${ctx.host}${path}`;
  const google = `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`;
  const heading = `${CALENDAR_OFFER_ID}-title`;
  const add = '<span class="sr-only">Add to </span>';
  return ` <section id="${CALENDAR_OFFER_ID}" aria-labelledby="${heading}" class="mt-4 border-t border-subtle pt-4"><h3 id="${heading}" class="text-sm font-semibold text-primary">Add this flight to your calendar</h3> <p class="mt-1 text-sm text-secondary">${firm ? CALENDAR_LEAD_FIRM : CALENDAR_LEAD_PENDING}</p> <ul class="mt-3 flex flex-wrap gap-2"><li><a href="${esc(webcal)}" data-watch="webcal" class="${CALENDAR_BUTTON}">${add}Apple Calendar or Outlook</a></li> <li><a href="${esc(google)}" data-watch="google" target="_blank" rel="noopener noreferrer" class="${CALENDAR_BUTTON}">${add}Google Calendar</a></li></ul> <p class="mt-3 text-xs text-muted">${CALENDAR_LAG} Or <a href="${esc(path)}" data-watch="ics" download class="text-accent underline hover:no-underline">download the event as a file</a>, a one-time copy that will not update.</p>${noticeRow(ctx)}</section>`;
}

/** The notice control's wrapper, found by the page script. */
export const NOTICE_CONTROL_ID = "flight-notice";

/**
 * "Tell me if this changes", under the calendar offer. Drawn hidden: the
 * page script shows it only where the browser can take a notice, and on an
 * iPhone outside a home-screen site it shows the hint instead, so the
 * calendar above stays the way to follow the flight there.
 */
function noticeRow(ctx: AnswerContext): string {
  if (!ctx.noticeKey) return "";
  return ` <div id="${NOTICE_CONTROL_ID}" data-notice-key="${esc(ctx.noticeKey)}" hidden class="mt-4"><button type="button" data-notice-toggle hidden class="${CALENDAR_BUTTON}">Tell me if this changes</button> <p data-notice-status hidden class="mt-2 text-xs text-muted">${NOTICE_LEAD}</p><p data-notice-ios hidden class="mt-2 text-xs text-muted">On an iPhone, notices work once this site is added to your Home Screen. The calendar above follows the flight without that.</p></div>`;
}

export const NOTICE_LEAD =
  "A browser notice when we see a different aircraft on this flight or its Starlink answer changes, and once when the aircraft is first assigned. No account or email. It stops after departure.";

/** The page's one swap caveat: firm cards carry it, nothing else repeats it. */
const CHANGE_NOTE = "Aircraft can be swapped before departure.";

/** The caveat with its remedy right under it: a calendar event that follows a swap. */
const swapNote = (ctx: AnswerContext) =>
  ` <p class="mt-3 text-sm text-muted">${ctx.seenAt ? `${esc(seenNote(ctx.seenAt))} ` : ""}${CHANGE_NOTE}</p>${watchRow(ctx, true)}`;

/** A read-back sighting dated in UTC: true however late the page is read. */
export const seenNote = (seenAt: number) => `Aircraft as of ${utcDayTime(seenAt)}.`;

/** A no's one aircraft and what it has instead, as the card's rows say it;
 * null for any other answer, and for a no that names several aircraft. */
export function noPlaneLine(body: CheckFlightBody): string | null {
  const segments = body.fallback?.segments ?? [];
  const [only] = segments;
  if (body.hasStarlink !== false || segments.length !== 1 || only.hasStarlink !== false) {
    return null;
  }
  const type = only.aircraft_model ? ` (${aircraftName(only.aircraft_model)})` : "";
  return `${only.tail_number}${type} has ${wifiPhrase(only.verified_wifi)}.`;
}

function card(answer: AnswerTone, headline: string, body: string): string {
  const tone = ANSWER_TONE[answer];
  return `<div class="rounded-lg border p-5 ${TONE_CARD[tone] ?? NEUTRAL_CARD}" data-tone="${answer}"><h2 class="font-display text-xl ${headlineClass(tone)} text-balance">${wholeDates(esc(headline))}</h2> ${body}</div>`;
}

/** The API's lead on a subfleet answer, "~4% Starlink probability: ", which
 * the card's headline already says. The share's edges take no "~". */
const SHARE_LEAD = /^(?:~\d+|<1|>99)% Starlink probability: /;

function probabilityBar(p: number, answer: AnswerTone, tracked = 1): string {
  return meterHtml(p, {
    color: toneColor(ANSWER_TONE[answer]),
    size: "md",
    className: "mt-3",
    bg: "bg-base",
    label: `${flightLabel(p, tracked)} chance of Starlink`,
  });
}

/** The API's degraded-FR24 sentence, when present; the rest of the message is restated here. */
function degradedNote(message: string | undefined): string | null {
  return message && /couldn't confirm/i.test(message)
    ? "We couldn't confirm the aircraft assignment just now. Try again shortly."
    : null;
}

/** The sentence a forecast card prints after its basis: a degraded lookup's
 * notice, else the swap caveat when an aircraft is already named, else when a
 * firm answer comes. A dated page's meta description reuses it word for word. */
export function forecastNote(body: CheckFlightBody, ctx: AnswerContext): string {
  return (
    degradedNote(body.message) ??
    (body.assignment?.tail_number ? CHANGE_NOTE : timingNote(ctx, ctx.airlineName))
  );
}

function timingNote(ctx: AnswerContext, airlineName: string): string {
  if (ctx.daysOut > 2) {
    return `${airlineName} assigns aircraft about 2 days before departure. Check again then for a firm answer.`;
  }
  return "We don't have the aircraft assignment yet. Check again closer to departure.";
}

/**
 * An answer that rests on the airline's own count at either end of it: none
 * connected, or every one. A count is the airline's and has a date, so the
 * headline says whose it is and when, never our "0%" or our yes. The API's
 * sentence stays under it. Null for any share in between, which reads as odds.
 */
function countedAnswer(
  body: CheckFlightBody,
  ctx: AnswerContext,
  on: string,
  probability: number | null
): FlightAnswer | null {
  const c = body.airline_count;
  if (
    !c ||
    typeof c.airline !== "string" ||
    typeof c.aircraft !== "string" ||
    typeof c.as_of !== "string" ||
    typeof c.connected !== "number" ||
    typeof c.total !== "number"
  ) {
    return null;
  }
  const none = probability !== null && probability <= 0;
  const every = probability === null && c.total > 0 && c.connected >= c.total;
  if (!none && !every) return null;
  const whose = `${c.airline}'s own count (${monthDay(c.as_of, ctx.nowSec)})`;
  const headline = every
    ? `By ${whose}, every ${c.aircraft} is connected — we haven't confirmed the one on ${on}`
    : c.connected <= 0
      ? `Not yet for ${on} — ${whose} has no ${c.aircraft} connected`
      : `Not yet for ${on}, by ${whose}`;
  const tone: AnswerTone = every ? "unknown" : probTier(0);
  const said = capitalize((body.message ?? "").replace(SHARE_LEAD, ""));
  const note = forecastNote(body, ctx);
  const html = card(
    tone,
    headline,
    `<p class="mt-3 text-sm text-secondary">${wholeDates(esc(said))} ${esc(note)}</p>${watchRow(ctx, false)}`
  );
  return { tone, headline, html, firm: false };
}

/**
 * What an answer said, as the homepage's "Your flights" keeps it and compares
 * it later (src/client/recent-checks.ts). One builder for the flight page, its
 * live re-check and the row's own answer, so all three keep the same facts.
 */
export function answerShown(answer: FlightAnswer, body: CheckFlightBody) {
  return {
    tone: answer.tone,
    firm: answer.firm,
    tails: answerTails(body),
    headline: answer.headline,
    ...(answer.odds ? { odds: answer.odds } : {}),
  };
}

/**
 * The aircraft an answer names, sorted: a yes's planes, a no's, or the one a
 * type answer was scheduled on. Empty for an answer that names none.
 */
export function answerTails(body: CheckFlightBody): string[] {
  const named =
    body.hasStarlink === true
      ? (body.flights ?? []).map((f) => f.tail_number)
      : body.hasStarlink === false
        ? [
            ...(body.fallback?.segments ?? []).map((s) => s.tail_number),
            body.message?.match(/assigned to tail (\S+),/)?.[1],
          ]
        : [body.assignment?.tail_number];
  return [...new Set(named.filter((t): t is string => !!t))].sort();
}

/** The answer has a page worth passing on: not a failed lookup, and not a
 * date already over, whose card says only that we can't tell. */
export const shareOffered = (body: CheckFlightBody, ctx: AnswerContext) =>
  !!ctx.shareUrl && !body.error && !datePassed(ctx);

/** The answer card, with the share control as its last line for every verdict alike. */
export function renderFlightAnswer(body: CheckFlightBody, ctx: AnswerContext): FlightAnswer {
  const answer = answerCard(body, ctx);
  if (!ctx.shareUrl || !shareOffered(body, ctx)) return answer;
  // card() closes with the one </div> this goes in front of.
  return {
    ...answer,
    html: `${answer.html.slice(0, -"</div>".length)}${shareControlHtml(ctx.shareUrl)}</div>`,
  };
}

function answerCard(body: CheckFlightBody, ctx: AnswerContext): FlightAnswer {
  const fn = ctx.flightNumber;
  const on = `${fn} on ${monthDay(ctx.date, ctx.nowSec)}`;

  if (body.error) {
    const headline = `We couldn't check ${fn}`;
    return {
      tone: "unknown",
      headline,
      firm: false,
      html: card(
        "unknown",
        headline,
        `<p class="mt-2 text-sm text-secondary">${esc(body.error)}</p>`
      ),
    };
  }

  if (body.hasStarlink === true) {
    const flights = body.flights ?? [];
    const first = flights[0] ?? {};
    const verified = body.confidence !== "likely";
    const status = verified ? "verified" : (ctx.listedStatus ?? "listed, not yet verified");
    const others = uncoveredInOrder(flights, ctx.dayLegs);
    const partial = others.length > 0;
    const headline = partial
      ? partialHeadline(on, flights, others, status, ctx)
      : `Yes — ${on} has Starlink (${[yesPlanes(flights, ctx), status].filter(Boolean).join(", ")})`;
    const legs = flights.map((f) => flightRows(f, ctx)).join("");
    const tone: AnswerTone = partial ? "partial" : "yes";
    const html = card(
      tone,
      headline,
      `${legs}${body.message ? ` <p class="mt-3 text-sm text-secondary">${esc(body.message)}</p>` : ""}${liveTvLines(flights, ctx)}${flightAwareLink(first, ctx)}${partial ? otherLegsHtml(others, ctx) : ""}${swapNote(ctx)}`
    );
    return {
      tone,
      headline,
      html,
      firm: true,
      ...(partial ? { yesLegs: [...new Set(flights.map((f) => legLabel(f) ?? ""))] } : {}),
    };
  }

  const segments = body.fallback?.segments ?? [];
  if (body.hasStarlink === false && segments.length > 0) {
    const firmNo = segments.every((s) => s.hasStarlink === false);
    const first = segments[0];
    const headline = firmNo
      ? `No — ${on} doesn't have Starlink`
      : `Not sure yet — ${on} is on ${first.tail_number}, which we haven't checked`;
    const segHtml = segments
      .map((s) => {
        const rows = [row("Aircraft", `${tail(s.tail_number)}${typeName(s.aircraft_model)}`)];
        if (s.origin && s.destination)
          rows.push(row("Route", `${esc(s.origin)} → ${esc(s.destination)}`));
        rows.push(
          row(
            "Wi-Fi",
            s.hasStarlink === false
              ? `${esc(wifiPhrase(s.verified_wifi))}${s.verified_at ? `, checked ${esc(ageLabel(s.verified_at, ctx.nowSec))}` : ""}`
              : "Not checked yet"
          )
        );
        return ` <dl class="mt-3 space-y-1.5 text-sm">${rows.join("")}</dl>`;
      })
      .join("");
    const tone: AnswerTone = firmNo ? "no" : "unknown";
    const html = card(
      tone,
      headline,
      `${segHtml}${swapNote(ctx)}${alternativesHtml(body.sameDayAlternatives, ctx, first.origin ?? ctx.origin)}${routePlannerCta(first.origin, first.destination, ctx)}`
    );
    return { tone, headline, html, firm: true };
  }

  if (body.hasStarlink === false) {
    const m = body.message?.match(/assigned to tail (\S+), verified as (.+?) WiFi/);
    const headline = `No — ${on} doesn't have Starlink`;
    const detail = m
      ? `The assigned aircraft, ${tail(m[1])}, has ${esc(wifiPhrase(m[2]))}.`
      : esc(body.message ?? body.reason ?? "The assigned aircraft doesn't have Starlink.");
    const degraded =
      body.message && /degraded/i.test(body.message)
        ? " We couldn't run the live swap check just now."
        : "";
    const origin = body.flights?.[0]?.departure_airport ?? ctx.origin;
    const html = card(
      "no",
      headline,
      `<p class="mt-2 text-sm text-secondary">${detail}${degraded}</p>${swapNote(ctx)}${alternativesHtml(body.sameDayAlternatives, ctx, origin)}`
    );
    return { tone: "no", headline, html, firm: true };
  }

  const pred = body.prediction;
  const hasPred = !!pred && typeof pred.probability === "number";

  // No assignment survives the day, so a past date gets no forecast headline.
  if (datePassed(ctx)) {
    const headline = `${on} has passed`;
    const usual =
      hasPred && pred && (pred.n_observations ?? 0) > 0
        ? ` ${capitalize(flightShare(pred.probability, fn))}.`
        : "";
    return {
      tone: "unknown",
      headline,
      firm: false,
      html: card(
        "unknown",
        headline,
        `<p class="mt-2 text-sm text-secondary">We don't keep old aircraft assignments, so we can't say which aircraft flew it.${esc(usual)}</p>`
      ),
    };
  }

  const counted = countedAnswer(body, ctx, on, hasPred && pred ? pred.probability : null);
  if (counted) return counted;

  if (!hasPred || !pred) {
    const headline = `Not sure yet about ${on}`;
    const text =
      body.message ?? body.reason ?? "Starlink depends on the aircraft assigned to the flight.";
    return {
      tone: "unknown",
      headline,
      firm: false,
      html: card(
        "unknown",
        headline,
        `<p class="mt-2 text-sm text-secondary">${esc(text)}</p>${watchRow(ctx, false)}`
      ),
    };
  }

  // A type rule is a yes for every aircraft that can fly the number, not a forecast.
  const n = pred.n_observations ?? 0;
  const typeRule = body.confidence === "type" && pred.probability >= 1 && !body.airline_count;
  const tone: AnswerTone = typeRule ? "yes" : probTier(pred.probability);
  const headline = typeRule
    ? `Yes — every aircraft that flies ${fn} has Starlink`
    : `${capitalize(flightPhrase(pred.probability, n))} chance ${on} has Starlink`;
  // The headline already gives the number, so the API's "~N% Starlink probability:" lead goes.
  const basis =
    body.confidence === "predicted"
      ? n > 0
        ? `Based on the aircraft on ${fmt(n)} recent ${fn} flights.`
        : `We haven't seen ${fn} yet, so this is our estimate for flights like it.`
      : capitalize((body.message ?? "").replace(SHARE_LEAD, ""));
  const note = forecastNote(body, ctx);
  // A type rule's headline is the whole answer; the API's sentence would repeat it.
  const detail = typeRule
    ? ""
    : `${probabilityBar(pred.probability, tone, n)} <p class="mt-3 text-sm text-secondary">${esc(basis)} ${esc(note)}</p>`;
  const html = card(tone, headline, `${detail}${watchRow(ctx, false)}`);
  return typeRule
    ? { tone, headline, html, firm: false }
    : { tone, headline, html, firm: false, odds: flightLabel(pred.probability, n) };
}
