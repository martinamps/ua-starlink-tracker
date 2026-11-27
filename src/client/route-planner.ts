/**
 * /route-planner: list every nonstop on the pair first (/api/route-flights),
 * then ask /api/plan-route and draw each itinerary as a path of legs colored
 * by their Starlink odds. The search lives in ?origin=&destination= rather
 * than /route-planner/O/D: that path is the route page, and it 404s for pairs
 * without data, so a reload would lose the search.
 */
import type { RouteFlightBoard } from "../api/route-flights";
import { formatDuration, monthDay, probLabel, probTier } from "../components/ui/format";
import { orList, placeCodeAirports } from "../utils/airport-aliases";
import type { AirportBox, attachAirportBox } from "./airport-picker";
import { esc } from "./esc";
import { HINT_ERROR, HINT_PLAIN } from "./hint-classes";
import { renderRouteFlights } from "./route-flights";

interface Leg {
  /** Usual local times at each end ("8:15 AM"), when on record. */
  typical_departure?: string;
  typical_arrival?: string;
  /** Origin-local date the leg flies, on a dated search. */
  date?: string;
  route: string;
  flight_number: string;
  probability: number;
  confidence: string;
  n_observations: number;
  /** This host's answer page for the flight, dated when the search was. */
  page?: string;
}

interface Itinerary {
  legs: Leg[];
  via: string[];
  coverage: "full" | "partial";
  joint_probability: number;
  at_least_one_probability: number;
  total_flight_hours?: number;
  /** "same_day": each connection leaves after the previous leg usually lands. */
  schedule?: "same_day" | "unknown";
  connection_minutes?: Array<number | null>;
}

interface Baseline {
  duration_hours?: number;
  duration_source?: "great_circle" | "sparse_history" | string;
  probability: number;
  expected_starlink_hours: number;
}

interface PlanBody {
  itineraries?: Itinerary[];
  baseline?: Baseline;
  message?: string;
}

const TIER_COLOR = {
  likely: "var(--color-success)",
  maybe: "var(--color-warn)",
  unlikely: "var(--color-neutral)",
} as const;
const LIKELY = TIER_COLOR.likely;
const probColor = (p: number) => TIER_COLOR[probTier(p)];
const isLikely = (p: number) => probTier(p) === "likely";

const fmtHours = (h: number) => (h >= 1 ? `${h.toFixed(1)}h` : `${Math.round(h * 60)}m`);

function probBars(prob: number, color: string): string {
  const filled = Math.max(1, Math.round(prob * 5));
  let html = `<span class="prob-bars" style="color:${color}">`;
  for (let i = 1; i <= 5; i++) {
    html += `<span class="prob-bars__bar${i > filled ? " prob-bars__bar--off" : ""}"></span>`;
  }
  return `${html}</span>`;
}

/** The page path the API vouched for, re-checked so a stray value can't become an off-site link. */
const LEG_PAGE = /^\/check-flight\/[A-Z0-9]{3,8}(\/\d{4}-\d{2}-\d{2})?$/;

/**
 * The leg's flight number, as a link to its answer page when the API sent one:
 * that page holds the plane-swap answer and the calendar watch.
 */
function legFlight(leg: Leg): string {
  const fn = esc(leg.flight_number);
  if (!leg.page || !LEG_PAGE.test(leg.page)) return fn;
  return `<a href="${esc(leg.page)}" class="leg-link"><span>${fn}<span class="sr-only"> flight details</span></span><span aria-hidden="true" class="text-accent">›</span></a>`;
}

function renderLeg(leg: Leg): string {
  const color = probColor(leg.probability);
  const [from, to] = leg.route.split("-").map(esc);
  const odds = `<div class="flex items-center gap-2">${probBars(leg.probability, color)}<span class="text-xs w-10 text-right tabular-nums" style="color:${color}">${probLabel(leg.probability)}</span></div>`;
  if (leg.flight_number === "(any)") {
    return `<div class="flex items-center justify-between py-2 border-l-2 border-subtle pl-3 ml-1"><div class="text-sm"><div class="font-mono text-muted">${from} → ${to}</div><div class="text-xs text-muted">Any flight works for this leg</div></div>${odds}</div>`;
  }
  const conf = leg.confidence === "low" ? " · low confidence" : "";
  const checks = `${leg.n_observations} check${leg.n_observations === 1 ? "" : "s"}`;
  return `<div class="flex items-center justify-between py-2 border-l-2 pl-3 ml-1" style="border-color:${color}"><div class="text-sm"><div class="font-mono text-secondary">${legFlight(leg)} <span class="text-muted">${from} → ${to}</span></div><div class="text-xs text-muted">Based on ${checks}${conf}</div></div>${odds}</div>`;
}

const TIMING_ROW = "text-xs text-muted pl-3 ml-1";

/** The leg's usual times, dated when it flies on another day than the trip starts. */
function legTimes(leg: Leg, tripDate: string | undefined): string {
  if (!leg.typical_departure) return "";
  const day = leg.date && leg.date !== tripDate ? ` · ${esc(monthDay(leg.date))}` : "";
  const lands = leg.typical_arrival ? `, lands ${esc(leg.typical_arrival)}` : "";
  return `<div class="${TIMING_ROW}">Usually leaves ${esc(leg.typical_departure)}${lands}${day}</div>`;
}

/**
 * Time on the ground before leg `i`: the planner only shows a connection that
 * leaves after the previous leg usually lands, and says so when it can't tell.
 */
function connectionRow(it: Itinerary, i: number): string {
  if (i === 0 || it.legs[i].flight_number === "(any)" || it.legs[i - 1].flight_number === "(any)") {
    return "";
  }
  const hub = esc(it.legs[i].route.split("-")[0]);
  const minutes = it.connection_minutes?.[i - 1];
  if (typeof minutes === "number") {
    return `<div class="${TIMING_ROW}">${formatDuration(minutes * 60) ?? "0m"} to connect in ${hub}</div>`;
  }
  return `<div class="${TIMING_ROW}">Connection time in ${hub} not on record: check the flights connect</div>`;
}

function legRows(it: Itinerary): string {
  const tripDate = it.legs[0]?.date;
  return it.legs
    .map((leg, i) => `${connectionRow(it, i)}${renderLeg(leg)}${legTimes(leg, tripDate)}`)
    .join("");
}

function flightPath(legs: Leg[]): string {
  const parts = ['<div class="flight-path">'];
  legs.forEach((leg, i) => {
    const color = probColor(leg.probability);
    const live = isLikely(leg.probability);
    if (i === 0) {
      parts.push(
        `<span class="flight-path__node flight-path__node--filled" style="color:${color}"></span>`
      );
    }
    parts.push(
      `<span class="flight-path__line${live ? " flight-path__line--live" : ""}" style="color:${color}"></span>`
    );
    const last = i === legs.length - 1;
    const nodeColor = last
      ? color
      : live && isLikely(legs[i + 1].probability)
        ? LIKELY
        : "var(--color-neutral)";
    parts.push(
      `<span class="flight-path__node${last ? " flight-path__node--filled" : ""}" style="color:${nodeColor}"></span>`
    );
  });
  parts.push("</div>");
  return parts.join("");
}

function renderItinerary(it: Itinerary, rank: number): string {
  const { legs, via = [] } = it;
  const full = it.coverage === "full";
  const direct = via.length === 0;
  const origin = esc(legs[0].route.split("-")[0]);
  const dest = esc(legs[legs.length - 1].route.split("-")[1]);
  const headerP = full ? it.joint_probability : it.at_least_one_probability;
  const headerPct = probLabel(headerP);
  const headerLabel = full ? (direct ? "Starlink" : "all legs") : "at least one leg";
  const headerColor = probColor(headerP);
  const flying =
    typeof it.total_flight_hours === "number" ? ` · ${fmtHours(it.total_flight_hours)} flying` : "";
  const badge = direct
    ? '<span class="text-xs text-accent">Nonstop</span>'
    : `<span class="text-xs text-muted">via <span class="font-mono">${via.map(esc).join("→")}</span> · ${via.length} stop${via.length > 1 ? "s" : ""}${flying}</span>`;
  const airports = `<span>${origin}</span>${via.map((v) => `<span class="text-center flex-1">${esc(v)}</span>`).join("")}${direct ? '<span class="flex-1"></span>' : ""}<span>${dest}</span>`;
  return `<div class="itin-card bg-surface border border-subtle rounded-lg p-4 mb-3 hover:border-accent/50 transition-colors"><div class="flex items-center justify-between mb-3"><div class="flex items-center gap-3"><span class="text-xs text-muted tabular-nums">#${rank}</span>${badge}</div><div class="font-display text-right" style="color:${headerColor}">${headerPct} <span class="text-xs text-muted font-normal">${headerLabel}</span></div></div><div class="mb-3"><div class="flex items-center gap-2 text-xs font-mono text-muted mb-1">${airports}</div>${flightPath(legs)}</div><div class="space-y-1">${legRows(it)}</div></div>`;
}

/** The nonstop every connection is traded against: without it a 9h two-stop
 * at 94% reads as strictly better than a 5.7h nonstop. */
function baselineHtml(b: Baseline | undefined): string {
  if (!b || typeof b.duration_hours !== "number") return "";
  if (b.duration_source === "great_circle") {
    return `<div class="text-xs text-muted mb-3 leading-relaxed">No United nonstop on this pair, so every option connects (~${fmtHours(b.duration_hours)} straight-line for reference).</div>`;
  }
  const label =
    b.duration_source === "sparse_history"
      ? "Nonstop seen only occasionally (may not run on your date): ~"
      : "Nonstop baseline: ~";
  return `<div class="text-xs text-muted mb-3 leading-relaxed">${label}${probLabel(b.probability)} Starlink · ~${fmtHours(b.expected_starlink_hours)} Starlink of ~${fmtHours(b.duration_hours)} flying</div>`;
}

/**
 * Itineraries ranked as the API ranks them. When the nonstop board above has
 * rows, an empty plan says nothing more: the board already answers.
 */
function renderResults(out: HTMLElement, data: PlanBody, boardHasRows: boolean): void {
  const itins = data.itineraries ?? [];
  if (itins.length === 0) {
    if (boardHasRows) {
      out.innerHTML = "";
      return;
    }
    // A sparse nonstop's budget yields to the fastest connection, so an empty
    // result there also means no connection has Starlink legs.
    const soft =
      data.baseline?.duration_source === "great_circle" ||
      data.baseline?.duration_source === "sparse_history";
    const message =
      data.message ||
      (soft
        ? "No connection between these airports has Starlink on its legs."
        : "No same-day connection adds meaningful Starlink time without a long detour.");
    out.innerHTML = `<div class="bg-surface border border-subtle rounded-lg p-6 text-center"><p class="text-sm text-muted">${esc(message)}</p>${baselineHtml(data.baseline)}</div>`;
    return;
  }
  const baseline = itins.some((i) => i.via.length === 0) ? "" : baselineHtml(data.baseline);
  out.innerHTML = `${baseline}${itins.map((it, i) => renderItinerary(it, i + 1)).join("")}`;
}

/** Three letters, or a four-letter ICAO spelling: what the boxes took before names. */
const CODE_SHAPED = /^[A-Za-z]{3,4}$/;
const NAME_MAX = 40;

/**
 * City names in the two boxes. The page arrives taking codes only, and works
 * that way with no script. Here the boxes are opened to names, and the picker
 * with its names table (a separate bundle, `data-picker-src` on the form) is
 * fetched when a visitor first touches a box, so a page view that never
 * searches by name never pays for the table.
 */
export function wireAirportNames(
  form: HTMLFormElement,
  boxes: HTMLInputElement[]
): (box: HTMLInputElement) => Promise<string | null> {
  const src = form.dataset.pickerSrc;
  const asTyped = (box: HTMLInputElement) => Promise.resolve(box.value.trim().toUpperCase());
  if (!src) return asTyped;
  const prefer = (form.dataset.busyAirports ?? "").split(" ").filter(Boolean);
  const status = document.getElementById("airport-status");
  const announce = (text: string) => {
    if (status) status.textContent = text;
  };
  const parts = (box: HTMLInputElement) => ({
    list: document.getElementById(`${box.id}-list`),
    hint: document.getElementById(`${box.id}-hint`),
  });
  for (const box of boxes) {
    const { list, hint } = parts(box);
    if (!list || !hint) return asTyped;
    box.maxLength = NAME_MAX;
    box.placeholder = "City or code";
    box.setAttribute("role", "combobox");
    box.setAttribute("aria-autocomplete", "list");
    box.setAttribute("aria-expanded", "false");
    box.setAttribute("aria-controls", list.id);
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", list.dataset.label ?? "Matching airports");
    box.setAttribute("aria-describedby", hint.id);
  }
  const attached = new Map<HTMLInputElement, AirportBox>();
  // A code sent before the picker arrived: it must not open a list over the results.
  const sentAsTyped = new Map<HTMLInputElement, string>();
  let loading: Promise<void> | null = null;
  const load = () => {
    loading ??= new Promise<void>((done) => {
      const script = document.createElement("script");
      script.src = src;
      script.onload = () => {
        const attach = (window as unknown as { attachAirportBox?: typeof attachAirportBox })
          .attachAirportBox;
        for (const box of boxes) {
          const { list, hint } = parts(box);
          if (attach && list && hint) {
            const openNow = sentAsTyped.get(box) !== box.value;
            attached.set(box, attach({ input: box, list, hint, announce, prefer, openNow }));
          }
        }
        done();
      };
      // Offline, or blocked: the boxes still take codes, and the next name
      // sent asks for the list again rather than failing until a reload.
      script.onerror = () => {
        script.remove();
        loading = null;
        done();
      };
      document.head.append(script);
    });
    return loading;
  };
  form.addEventListener("focusin", load, { once: true });
  form.addEventListener("pointerdown", load, { once: true });
  // The line under a box while the picker is not there to write it.
  const say = (box: HTMLInputElement, text: string, error = false) => {
    const { hint } = parts(box);
    if (hint) {
      hint.textContent = text;
      hint.className = error ? HINT_ERROR : HINT_PLAIN;
    }
    if (error) box.setAttribute("aria-invalid", "true");
    else box.removeAttribute("aria-invalid");
  };
  return async (box) => {
    const typed = box.value.trim();
    // Letters shaped like a code that name a city (NYC, typed fast or arriving
    // in the address) are no code: they wait for the list like any name.
    const cityAirports = attached.has(box) ? null : placeCodeAirports(typed);
    // A code never waits on the table.
    if (!attached.has(box) && !cityAirports && CODE_SHAPED.test(typed)) {
      sentAsTyped.set(box, box.value);
      // A "did not load" line from an earlier try no longer applies, under
      // the box or in the status line.
      say(box, "");
      announce("");
      return typed.toUpperCase();
    }
    if (!attached.has(box)) {
      say(box, "Looking up airports…");
      announce("Looking up airports.");
    }
    await load();
    const picker = attached.get(box);
    if (picker) return picker.resolve();
    // Without the list, the city's airports are still known: one is searched,
    // several are named for the visitor to type.
    if (cityAirports?.length === 1) {
      box.value = cityAirports[0];
      say(box, "");
      announce("");
      return cityAirports[0];
    }
    if (cityAirports) {
      const which = `${typed.toUpperCase()} covers several airports. Enter ${orList(cityAirports)}.`;
      say(box, which, true);
      announce(which);
      box.focus();
      return null;
    }
    const failed = "The airport list did not load. Enter a 3-letter airport code, or try again.";
    say(box, failed, true);
    announce(failed);
    box.focus();
    return null;
  };
}

export function wireRoutePlanner(): void {
  const form = document.getElementById("route-form") as HTMLFormElement | null;
  const out = document.getElementById("route-results");
  const originInput = document.getElementById("origin") as HTMLInputElement | null;
  const destInput = document.getElementById("destination") as HTMLInputElement | null;
  const dateInput = document.getElementById("travel-date") as HTMLInputElement | null;
  const board = document.getElementById("route-flights");
  if (!form || !out || !originInput || !destInput) return;
  const codeOf = wireAirportNames(form, [originInput, destInput]);
  const params = new URLSearchParams(window.location.search);
  if (params.get("origin") && params.get("destination")) {
    originInput.value = (params.get("origin") ?? "").toUpperCase().slice(0, NAME_MAX);
    destInput.value = (params.get("destination") ?? "").slice(0, NAME_MAX);
    if (dateInput) dateInput.value = params.get("date") ?? "";
  } else if (params.get("origin")) {
    // An airport page's "plan a trip from here": the origin arrives filled in.
    originInput.value = (params.get("origin") ?? "").toUpperCase().slice(0, NAME_MAX);
    destInput.focus();
  }
  // A newer search aborts the one in flight, so a slow answer can't land last.
  let inFlight: AbortController | null = null;
  const search = async () => {
    if (!originInput.value.trim() || !destInput.value.trim()) return;
    // One box at a time: a box that needs a choice takes the focus.
    const origin = await codeOf(originInput);
    const dest = origin ? await codeOf(destInput) : null;
    if (!origin || !dest) return;
    inFlight?.abort();
    const ctrl = new AbortController();
    inFlight = ctrl;
    const date = dateInput?.value ?? "";
    const query = `origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}${date ? `&date=${encodeURIComponent(date)}` : ""}`;
    history.replaceState(null, "", `/route-planner?${query}`);
    if (board) board.innerHTML = "";
    out.innerHTML = '<div class="text-center text-sm text-muted py-8">Finding flights…</div>';
    const boardReq = fetch(`/api/route-flights?${query}&history=1`, { signal: ctrl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<RouteFlightBoard>) : null))
      .catch(() => null);
    const planReq = fetch(`/api/plan-route?${query}`, { signal: ctrl.signal }).then(
      (r) => r.json() as Promise<PlanBody>
    );
    Promise.all([boardReq, planReq])
      .then(([b, plan]) => {
        if (ctrl.signal.aborted) return;
        const rows = b ? renderRouteFlights(b) : "";
        if (board) board.innerHTML = rows;
        renderResults(out, plan, rows !== "");
      })
      .catch(() => {
        if (ctrl.signal.aborted) return;
        out.innerHTML =
          '<div class="text-sm text-danger text-center">Something went wrong. Please try again.</div>';
      });
  };
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    search();
  });
  if (originInput.value && destInput.value) search();
}
