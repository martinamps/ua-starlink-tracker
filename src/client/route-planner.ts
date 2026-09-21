/**
 * /route-planner: ask /api/plan-route and draw each itinerary as a path of
 * legs colored by their Starlink odds. The search lives in ?origin=&destination=
 * rather than /route-planner/O/D: that path is the route page, and it 404s for
 * pairs without data, so a reload would lose the search.
 */
import { probLabel, probTier } from "../components/ui/format";
import { esc } from "./esc";

interface Leg {
  route: string;
  flight_number: string;
  probability: number;
  confidence: string;
  n_observations: number;
}

interface Itinerary {
  legs: Leg[];
  via: string[];
  coverage: "full" | "partial";
  joint_probability: number;
  at_least_one_probability: number;
  total_flight_hours?: number;
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

function renderLeg(leg: Leg): string {
  const color = probColor(leg.probability);
  const [from, to] = leg.route.split("-").map(esc);
  const odds = `<div class="flex items-center gap-2">${probBars(leg.probability, color)}<span class="text-xs w-10 text-right tabular-nums" style="color:${color}">${probLabel(leg.probability)}</span></div>`;
  if (leg.flight_number === "(any)") {
    return `<div class="flex items-center justify-between py-2 border-l-2 border-subtle pl-3 ml-1"><div class="text-sm"><div class="font-mono text-muted">${from} → ${to}</div><div class="text-xs text-muted">Any flight works for this leg</div></div>${odds}</div>`;
  }
  const conf = leg.confidence === "high" ? "" : ` · ${esc(leg.confidence)} confidence`;
  const checks = `${leg.n_observations} check${leg.n_observations === 1 ? "" : "s"}`;
  return `<div class="flex items-center justify-between py-2 border-l-2 pl-3 ml-1" style="border-color:${color}"><div class="text-sm"><div class="font-mono text-secondary">${esc(leg.flight_number)} <span class="text-muted">${from} → ${to}</span></div><div class="text-xs text-muted">Based on ${checks}${conf}</div></div>${odds}</div>`;
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
  const headerPct = probLabel(full ? it.joint_probability : it.at_least_one_probability);
  const headerLabel = full ? (direct ? "Starlink" : "all legs") : "final leg Starlink";
  const headerColor = probColor(full ? it.joint_probability : legs[legs.length - 1].probability);
  const flying =
    typeof it.total_flight_hours === "number" ? ` · ${fmtHours(it.total_flight_hours)} flying` : "";
  const badge = direct
    ? '<span class="text-xs text-accent">Nonstop</span>'
    : `<span class="text-xs text-muted">via <span class="font-mono">${via.map(esc).join("→")}</span> · ${via.length} stop${via.length > 1 ? "s" : ""}${flying}</span>`;
  const airports = `<span>${origin}</span>${via.map((v) => `<span class="text-center flex-1">${esc(v)}</span>`).join("")}${direct ? '<span class="flex-1"></span>' : ""}<span>${dest}</span>`;
  return `<div class="itin-card bg-surface border border-subtle rounded-lg p-4 mb-3 hover:border-accent/50 transition-colors"><div class="flex items-center justify-between mb-3"><div class="flex items-center gap-3"><span class="text-xs text-muted tabular-nums">#${rank}</span>${badge}</div><div class="font-display text-right" style="color:${headerColor}">${headerPct} <span class="text-xs text-muted font-normal">${headerLabel}</span></div></div><div class="mb-3"><div class="flex items-center gap-2 text-xs font-mono text-muted mb-1">${airports}</div>${flightPath(legs)}</div><div class="space-y-1">${legs.map(renderLeg).join("")}</div></div>`;
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

function renderResults(out: HTMLElement, data: PlanBody): void {
  const itins = data.itineraries ?? [];
  if (itins.length === 0) {
    // A sparse nonstop's budget yields to the fastest connection, so an empty
    // result there also means no connection has Starlink legs.
    const soft =
      data.baseline?.duration_source === "great_circle" ||
      data.baseline?.duration_source === "sparse_history";
    const message =
      data.message ||
      (soft
        ? "No connection between these airports has Starlink on its legs."
        : "No connection adds meaningful Starlink time without a long detour over the nonstop.");
    out.innerHTML = `<div class="bg-surface border border-subtle rounded-lg p-6 text-center"><div class="text-secondary font-display mb-2">No Starlink options found</div><p class="text-sm text-muted">${esc(message)}</p>${baselineHtml(data.baseline)}</div>`;
    return;
  }
  const full = itins.filter((i) => i.coverage === "full");
  const partial = itins.filter((i) => i.coverage === "partial");
  let html = itins.some((i) => i.via.length === 0) ? "" : baselineHtml(data.baseline);
  if (full.length > 0) {
    html += `<div class="mb-6"><h3 class="font-display text-lg text-primary mb-3">Starlink on every leg</h3>${full.map((it, i) => renderItinerary(it, i + 1)).join("")}</div>`;
  }
  if (partial.length > 0) {
    const note =
      full.length === 0
        ? '<div class="text-xs text-muted mb-3 leading-relaxed">No option has Starlink on every leg. These have it on at least one.</div>'
        : "";
    html += `<div><h3 class="font-display text-lg text-primary mb-2">Starlink on some legs</h3>${note}${partial.map((it, i) => renderItinerary(it, full.length + i + 1)).join("")}</div>`;
  }
  out.innerHTML = html;
}

export function wireRoutePlanner(): void {
  const form = document.getElementById("route-form") as HTMLFormElement | null;
  const out = document.getElementById("route-results");
  const originInput = document.getElementById("origin") as HTMLInputElement | null;
  const destInput = document.getElementById("destination") as HTMLInputElement | null;
  if (!form || !out || !originInput || !destInput) return;
  const params = new URLSearchParams(window.location.search);
  if (params.get("origin") && params.get("destination")) {
    originInput.value = params.get("origin") ?? "";
    destInput.value = params.get("destination") ?? "";
  }
  const search = () => {
    const origin = originInput.value.trim().toUpperCase();
    const dest = destInput.value.trim().toUpperCase();
    if (!origin || !dest) return;
    const query = `origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}`;
    history.replaceState(null, "", `/route-planner?${query}`);
    out.innerHTML = '<div class="text-center text-sm text-muted py-8">Finding flights…</div>';
    fetch(`/api/plan-route?${query}`)
      .then((r) => r.json() as Promise<PlanBody>)
      .then((d) => renderResults(out, d))
      .catch(() => {
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
