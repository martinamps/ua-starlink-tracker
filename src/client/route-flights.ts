/**
 * The planner's copy of the route page's nonstop board (components/
 * route-flights.tsx), drawn from /api/route-flights. Wording and tones come
 * from the same module, so the two surfaces phrase a row identically.
 */
import type { RouteFlightBoard, RouteFlightRow } from "../api/route-flights";
import { oddsCellHtml } from "../components/odds-history";
import {
  VERIFIED_LEGEND,
  assignmentPill,
  boardDek,
  hasVerifiedRow,
  rowMarker,
} from "../components/route-flights-copy";
import { pillStyle, toneColor } from "../components/ui/tone-classes";
import { esc } from "./esc";

const TH =
  "border-b border-subtle pb-2 pr-3 last:pr-0 text-left font-mono text-xs uppercase tracking-wider text-muted";
const TD = "border-b border-subtle py-2 tabular-nums";

function row(r: RouteFlightRow, board: RouteFlightBoard): string {
  const time = r.departure_label
    ? `<span class="text-muted"> · ${esc(r.departure_label)}</span>`
    : "";
  const type = r.aircraft_types[0]
    ? `<span class="text-muted sm:hidden"> · ${esc(r.aircraft_types[0])}</span>`
    : "";
  const marker = rowMarker(r, board);
  const mark = marker ? `<span class="text-xs text-muted"> · ${esc(marker)}</span>` : "";
  const pill = assignmentPill(r);
  const tone = r.assignment?.starlink === "none" ? "neutral" : "success";
  const assigned = pill
    ? `<div class="mt-1"><span class="shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium" style="${pillStyle(toneColor(tone))}">${esc(pill)}</span></div>`
    : "";
  const types = r.aircraft_types.length ? esc(r.aircraft_types.join(", ")) : "—";
  return `<tr class="align-top"><td class="${TD} pr-3"><a href="/check-flight/${esc(r.flight_number)}" class="font-mono text-primary hover:text-accent transition-colors">${esc(r.flight_number)}</a>${time}${type}${mark}${assigned}</td><td class="${TD} hidden sm:table-cell pr-3 text-secondary">${types}</td><td class="${TD} text-right">${oddsCellHtml(r)}</td></tr>`;
}

/**
 * The board for the planner, or "" when the pair has no nonstop (the
 * itineraries below already say so). `footerAction` is trusted markup for
 * the note's per-route action slot.
 */
export function renderRouteFlights(board: RouteFlightBoard, footerAction = ""): string {
  if (board.flights.length === 0) return "";
  const pagePath = `/route-planner/${encodeURIComponent(board.origin)}/${encodeURIComponent(board.destination)}`;
  const head = `<h2 class="font-display text-xl text-primary">Nonstop flights</h2><p class="mt-1 text-sm text-secondary text-pretty">${esc(boardDek(board))}</p>`;
  const table = `<table class="w-full text-sm"><thead><tr><th scope="col" class="${TH}">Flight</th><th scope="col" class="${TH} hidden sm:table-cell">Aircraft</th><th scope="col" class="${TH} text-right">Odds</th></tr></thead><tbody>${board.flights.map((r) => row(r, board)).join("")}</tbody></table><p class="mt-3 text-xs"><a href="${pagePath}" class="text-accent hover:underline">Route page →</a></p>`;
  const legend = hasVerifiedRow(board) ? ` ${esc(VERIFIED_LEGEND)}` : "";
  const action = footerAction ? ` ${footerAction}` : "";
  return `${head}<div class="bg-surface border border-subtle rounded-lg p-4 mt-4 mb-8">${table}<p class="mt-4 text-xs text-muted">${esc(board.note)}${legend}${action}</p></div>`;
}
