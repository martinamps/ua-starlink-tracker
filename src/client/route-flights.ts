/**
 * The planner's copy of the route page's nonstop board (components/
 * route-flights.tsx), drawn from /api/route-flights. Wording and tones come
 * from the same module, so the two surfaces phrase a row identically.
 */
import type { RouteFlightBoard, RouteFlightRow } from "../api/route-flights";
import {
  ASSIGNMENT_CAVEAT,
  assignmentTone,
  boardDek,
  emptyBoardMessage,
  oddsDetail,
  oddsTone,
} from "../components/route-flights-copy";
import { TONE_TEXT, pillStyle, toneColor } from "../components/ui/tone-classes";
import { esc } from "./esc";

const TH =
  "border-b border-subtle pb-2 pr-3 last:pr-0 text-left font-mono text-xs uppercase tracking-wider text-muted";
const TD = "border-b border-subtle py-2 tabular-nums";

function row(r: RouteFlightRow): string {
  const time = r.typical_departure ? `usually ${esc(r.typical_departure)}` : "time not logged";
  const assigned = r.assignment
    ? `<div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-secondary"><span class="shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium" style="${pillStyle(toneColor(assignmentTone(r)))}">${esc(r.assignment.label)}</span><span class="text-muted">${ASSIGNMENT_CAVEAT}</span></div>`
    : "";
  const types = r.aircraft_types.length ? esc(r.aircraft_types.join(", ")) : "—";
  return `<tr class="align-top"><td class="${TD} pr-3"><a href="/check-flight/${esc(r.flight_number)}" class="font-mono text-primary hover:text-accent transition-colors">${esc(r.flight_number)}</a><span class="whitespace-nowrap text-muted"> · ${time}</span>${assigned}</td><td class="${TD} hidden sm:table-cell pr-3 text-secondary">${types}</td><td class="${TD} text-right"><div class="whitespace-nowrap font-display ${TONE_TEXT[oddsTone(r)]}">${esc(r.odds_label)}</div><div class="text-xs text-muted">${esc(oddsDetail(r))}</div></td></tr>`;
}

export function renderRouteFlights(board: RouteFlightBoard): string {
  const empty = emptyBoardMessage(board);
  const pagePath = `/route-planner/${encodeURIComponent(board.origin)}/${encodeURIComponent(board.destination)}`;
  const head = `<h2 class="font-display text-xl text-primary">All nonstop flights</h2><p class="mt-1 text-sm text-secondary text-pretty">${esc(boardDek(board))}</p>`;
  const body = empty
    ? `<p class="text-sm text-secondary text-pretty">${esc(empty)} Connections are below.</p>`
    : `<table class="w-full text-sm"><thead><tr><th scope="col" class="${TH}">Flight</th><th scope="col" class="${TH} hidden sm:table-cell">Usually flies</th><th scope="col" class="${TH} text-right">Starlink odds</th></tr></thead><tbody>${board.flights.map(row).join("")}</tbody></table><p class="mt-3 text-xs"><a href="${pagePath}" class="text-accent hover:underline">${esc(board.origin)} to ${esc(board.destination)} route page →</a></p>`;
  return `${head}<div class="bg-surface border border-subtle rounded-lg p-4 mt-4 mb-8">${body}<p class="mt-4 text-xs text-muted text-pretty">${esc(board.note)}</p></div>`;
}
