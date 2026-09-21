/**
 * The /check-flight answer card, rendered from an /api/check-flight body.
 *
 * One renderer for both sides: the server calls it for a dated permalink so
 * the answer is in the HTML, and the browser bundle calls it when a live
 * re-check comes back. Plain strings (no React) because the browser has no
 * React; every interpolated value goes through esc(). Keep imports
 * dependency-free: this file is bundled for the browser.
 */
import { ageLabel, fmt, monthDay, zonedDeparture } from "../components/ui/format";
import { type SeatbackLiveTv, seatbackLiveTv } from "../utils/aircraft-specs";
import { esc } from "./esc";
import { METER_FILL, METER_HEIGHT, METER_TRACK, meterWidth } from "./meter";

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
  sameDayAlternatives?: WireAlternative[];
}

type AnswerTone = "yes" | "no" | "likely" | "maybe" | "unlikely" | "unknown";

export interface AnswerContext {
  flightNumber: string;
  /** YYYY-MM-DD the viewer asked about. */
  date: string;
  /** Whole days from today to `date`; negative is past. */
  daysOut: number;
  nowSec: number;
  airlineName: string;
  /** IANA zone for an airport code, undefined when unmapped. */
  zoneFor: (airport: string) => string | undefined;
  liveTv: Record<SeatbackLiveTv, string> | null;
  watchEnabled: boolean;
  routePlannerEnabled: boolean;
  /** Host for webcal:// links. */
  host: string;
}

export interface FlightAnswer {
  tone: AnswerTone;
  /** Plain-text answer sentence, also used for the page title on dated views. */
  headline: string;
  html: string;
  /** True when the answer names an assigned aircraft; a live re-check can't improve it. */
  firm: boolean;
}

const WATCH_MAX_DAYS_OUT = 330;

const stripK = (code: string | null | undefined) => {
  const c = String(code ?? "").toUpperCase();
  return c.length === 4 && (c[0] === "K" || c[0] === "C") ? c.slice(1) : c;
};

/** Departure clock at the airport, like a boarding pass: "Sun, Sep 21" / "8:38 AM PDT". */
const departs = (unix: number, airport: string | null | undefined, ctx: AnswerContext) =>
  zonedDeparture(unix, ctx.zoneFor(stripK(airport)));

/** verified_wifi 'None' means no Wi-Fi installed; it is never a provider name. */
function wifiPhrase(v: string | null | undefined): string {
  const w = String(v ?? "").trim();
  if (!w || /^none$/i.test(w)) return "no Wi-Fi";
  if (/^non-starlink$/i.test(w)) return "Wi-Fi that isn't Starlink";
  return `${w} Wi-Fi`;
}

function pctPhrase(p: number): string {
  const pct = Math.round(p * 100);
  if (pct < 1) return "under 1%";
  if (pct > 99) return "over 99%";
  return `about ${pct}%`;
}

function toneFor(p: number): AnswerTone {
  const pct = Math.round(p * 100);
  return pct >= 70 ? "likely" : pct >= 40 ? "maybe" : "unlikely";
}

const TONE_LABEL: Record<AnswerTone, string> = {
  yes: "Yes",
  no: "No",
  likely: "Likely",
  maybe: "Maybe",
  unlikely: "Unlikely",
  unknown: "Not sure yet",
};

// Written out whole so the Tailwind scanner finds every class verbatim.
const TONE_CARD: Record<AnswerTone, string> = {
  yes: "border-success/50 bg-success/10",
  likely: "border-success/40 bg-success/5",
  maybe: "border-warn/40 bg-warn/5",
  no: "border-subtle bg-surface-elevated",
  unlikely: "border-subtle bg-surface-elevated",
  unknown: "border-subtle bg-surface-elevated",
};
const TONE_TEXT: Record<AnswerTone, string> = {
  yes: "text-success",
  likely: "text-success",
  maybe: "text-warn",
  no: "text-primary",
  unlikely: "text-primary",
  unknown: "text-primary",
};
const TONE_BAR: Record<AnswerTone, string> = {
  yes: "bg-success",
  likely: "bg-success",
  maybe: "bg-warn",
  no: "bg-muted",
  unlikely: "bg-muted",
  unknown: "bg-muted",
};

function row(label: string, valueHtml: string): string {
  return `<div class="flex gap-3"><dt class="w-24 shrink-0 text-muted">${esc(label)}</dt><dd class="min-w-0 text-secondary">${valueHtml}</dd></div>`;
}

const tail = (t: string | null | undefined) =>
  `<span class="font-mono text-primary">${esc(t)}</span>`;

function flightRows(f: WireFlight, ctx: AnswerContext): string {
  const dep = stripK(f.departure_airport);
  const arr = stripK(f.arrival_airport);
  const rows: string[] = [];
  if (dep && arr) rows.push(row("Route", `${esc(dep)} → ${esc(arr)}`));
  if (f.departure_time) {
    rows.push(
      row(
        "Departs",
        `${esc(departs(f.departure_time, dep, ctx).day)}, ${esc(departs(f.departure_time, dep, ctx).time)}`
      )
    );
  }
  if (f.tail_number) {
    rows.push(
      row(
        "Aircraft",
        `${tail(f.tail_number)}${f.aircraft_type ? ` · ${esc(f.aircraft_type)}` : ""}`
      )
    );
  }
  if (f.operated_by) rows.push(row("Operated by", esc(f.operated_by)));
  return `<dl class="mt-3 space-y-1.5 text-sm">${rows.join("")}</dl>`;
}

function liveTvLine(f: WireFlight, ctx: AnswerContext): string {
  if (!ctx.liveTv) return "";
  const tier = seatbackLiveTv(f.fleet_type, f.aircraft_type);
  return `<p class="mt-3 text-sm text-secondary">${esc(ctx.liveTv[tier])} <a href="/live-tv" class="text-accent hover:underline">Which planes have live TV</a></p>`;
}

function flightAwareLink(f: WireFlight, ctx: AnswerContext): string {
  if (!f.flight_number) return "";
  const dep = stripK(f.departure_airport);
  const arr = stripK(f.arrival_airport);
  const utcDate = f.departure_time
    ? new Date(f.departure_time * 1000).toISOString().slice(0, 10).replace(/-/g, "")
    : ctx.date.replace(/-/g, "");
  const icao = (c: string) => (c.length === 3 ? `K${c}` : c);
  const url = `https://www.flightaware.com/live/flight/${encodeURIComponent(f.flight_number)}/history/${utcDate}/${icao(dep)}/${icao(arr)}`;
  return `<p class="mt-3 text-sm"><a href="${esc(url)}" target="_blank" rel="nofollow noopener noreferrer" class="text-accent hover:underline">View on FlightAware</a></p>`;
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
        `<li><a href="/check-flight/${encodeURIComponent(a.flight_number)}/${encodeURIComponent(ctx.date)}" class="text-accent hover:underline">${esc(a.flight_number)}</a> at ${esc(departs(a.departure_time, origin, ctx).time)} · ${tail(a.tail_number)}${a.aircraft_type ? ` · ${esc(a.aircraft_type)}` : ""}</li>`
    )
    .join("");
  return `<div class="mt-4"><h3 class="text-sm font-semibold text-primary">Starlink flights on this route that day</h3><ul class="mt-1 space-y-1 text-sm text-secondary">${items}</ul></div>`;
}

function routePlannerCta(
  origin: string | null | undefined,
  destination: string | null | undefined,
  ctx: AnswerContext
) {
  const o = stripK(origin);
  const d = stripK(destination);
  if (!ctx.routePlannerEnabled || !/^[A-Z]{3}$/.test(o) || !/^[A-Z]{3}$/.test(d)) return "";
  return `<p class="mt-3 text-sm"><a href="/route-planner/${o}/${d}" rel="nofollow" class="text-accent hover:underline">Find Starlink flights from ${o} to ${d}</a></p>`;
}

function watchRow(ctx: AnswerContext): string {
  if (!ctx.watchEnabled) return "";
  if (!(ctx.daysOut >= -1 && ctx.daysOut <= WATCH_MAX_DAYS_OUT)) return "";
  const path = `/cal/${encodeURIComponent(ctx.flightNumber)}/${encodeURIComponent(ctx.date)}.ics`;
  const webcal = `webcal://${ctx.host}${path}`;
  const google = `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`;
  return `<div class="mt-4 border-t border-subtle pt-4"><h3 class="text-sm font-semibold text-primary">Watch this flight</h3><div class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm"><a href="${esc(webcal)}" data-watch="webcal" class="text-accent hover:underline">Apple / Outlook</a><a href="${esc(google)}" data-watch="google" target="_blank" rel="noopener noreferrer" class="text-accent hover:underline">Google Calendar</a><a href="${esc(path)}" data-watch="ics" download class="text-accent hover:underline">Download .ics</a></div><p class="mt-2 text-xs text-muted">A calendar event that updates itself when the aircraft is assigned or swapped. Apple refreshes about hourly, Google every 8–24 hours.</p></div>`;
}

const CHANGE_NOTE = "Aircraft can change. Check again the day before.";

function card(tone: AnswerTone, headline: string, body: string): string {
  return `<div class="rounded-lg border p-5 ${TONE_CARD[tone]}" data-tone="${tone}"><h2 class="font-display text-xl ${TONE_TEXT[tone]} text-balance">${esc(headline)}</h2>${body}</div>`;
}

function probabilityBar(p: number, tone: AnswerTone): string {
  const w = Math.max(0, Math.min(100, Math.round(p * 100)));
  return `<div class="mt-3 ${METER_TRACK} bg-base ${METER_HEIGHT.md}" role="img" aria-label="${w}% chance of Starlink"><div class="${METER_FILL} ${TONE_BAR[tone]}" style="width:${meterWidth(w / 100)}"></div></div>`;
}

/** The API's degraded-FR24 sentence, when present; the rest of the message is restated here. */
function degradedNote(message: string | undefined): string | null {
  return message && /couldn't confirm/i.test(message)
    ? "We couldn't confirm the aircraft assignment just now. Try again shortly."
    : null;
}

function timingNote(ctx: AnswerContext, airlineName: string): string {
  if (ctx.daysOut > 2) {
    return `${airlineName} assigns aircraft about 2 days before departure. Check again then for a firm answer.`;
  }
  if (ctx.daysOut >= -1) return "No aircraft is assigned yet. Check again closer to departure.";
  return "This date has passed, and we don't keep old assignments.";
}

export function renderFlightAnswer(body: CheckFlightBody, ctx: AnswerContext): FlightAnswer {
  const fn = ctx.flightNumber;
  const on = `${fn} on ${monthDay(ctx.date)}`;

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
    const headline = `Yes — ${on} has Starlink (${[first.tail_number, verified ? "verified" : "install reported"].filter(Boolean).join(", ")})`;
    const legs = flights.map((f) => flightRows(f, ctx)).join("");
    const html = card(
      "yes",
      headline,
      `${legs}${body.message ? `<p class="mt-3 text-sm text-secondary">${esc(body.message)}</p>` : ""}${liveTvLine(first, ctx)}<p class="mt-3 text-sm text-muted">${CHANGE_NOTE}</p>${flightAwareLink(first, ctx)}${watchRow(ctx)}`
    );
    return { tone: "yes", headline, html, firm: true };
  }

  const segments = body.fallback?.segments ?? [];
  if (body.hasStarlink === false && segments.length > 0) {
    const firmNo = segments.every((s) => s.hasStarlink === false);
    const first = segments[0];
    const headline = firmNo
      ? `No — ${on} doesn't have Starlink (${first.tail_number}, verified)`
      : `Not sure yet — ${on} is on ${first.tail_number}, which we haven't checked`;
    const segHtml = segments
      .map((s) => {
        const rows = [
          row(
            "Aircraft",
            `${tail(s.tail_number)}${s.aircraft_model ? ` · ${esc(s.aircraft_model)}` : ""}`
          ),
        ];
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
        return `<dl class="mt-3 space-y-1.5 text-sm">${rows.join("")}</dl>`;
      })
      .join("");
    const tone: AnswerTone = firmNo ? "no" : "unknown";
    const html = card(
      tone,
      headline,
      `${segHtml}<p class="mt-3 text-sm text-muted">${CHANGE_NOTE}</p>${alternativesHtml(body.sameDayAlternatives, ctx, first.origin)}${routePlannerCta(first.origin, first.destination, ctx)}${watchRow(ctx)}`
    );
    return { tone, headline, html, firm: true };
  }

  if (body.hasStarlink === false) {
    const m = body.message?.match(/assigned to tail (\S+), verified as (.+?) WiFi/);
    const headline = `No — ${on} doesn't have Starlink (${m ? `${m[1]}, ` : ""}verified)`;
    const detail = m
      ? `The assigned aircraft, ${tail(m[1])}, has ${esc(wifiPhrase(m[2]))}.`
      : esc(body.message ?? body.reason ?? "The assigned aircraft doesn't have Starlink.");
    const degraded =
      body.message && /degraded/i.test(body.message)
        ? " We couldn't run the live swap check just now."
        : "";
    const origin = body.flights?.[0]?.departure_airport;
    const html = card(
      "no",
      headline,
      `<p class="mt-2 text-sm text-secondary">${detail}${degraded}</p><p class="mt-3 text-sm text-muted">${CHANGE_NOTE}</p>${alternativesHtml(body.sameDayAlternatives, ctx, origin)}${watchRow(ctx)}`
    );
    return { tone: "no", headline, html, firm: true };
  }

  const pred = body.prediction;
  if (!pred || typeof pred.probability !== "number") {
    const headline = `Not sure yet — it depends on the aircraft ${on} gets`;
    const text =
      body.message ?? body.reason ?? "Starlink depends on the aircraft assigned to the flight.";
    return {
      tone: "unknown",
      headline,
      firm: false,
      html: card(
        "unknown",
        headline,
        `<p class="mt-2 text-sm text-secondary">${esc(text)}</p>${watchRow(ctx)}`
      ),
    };
  }

  const tone = toneFor(pred.probability);
  const headline = `${TONE_LABEL[tone]} — ${pctPhrase(pred.probability)} chance ${on} has Starlink`;
  const n = pred.n_observations ?? 0;
  const basis =
    body.confidence === "predicted"
      ? n > 0
        ? `Based on the aircraft on ${fmt(n)} recent ${fn} flights.`
        : `We haven't seen ${fn} yet, so this is our estimate for flights like it.`
      : (body.message ?? "");
  const note = degradedNote(body.message) ?? timingNote(ctx, ctx.airlineName);
  const html = card(
    tone,
    headline,
    `${probabilityBar(pred.probability, tone)}<p class="mt-3 text-sm text-secondary">${esc(basis)} ${esc(note)}</p>${watchRow(ctx)}`
  );
  return { tone, headline, html, firm: false };
}
