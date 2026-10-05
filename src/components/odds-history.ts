/**
 * The board's odds cell and the history card behind it: eight weeks of the
 * leg's departures, the latest few, and how the number is weighted. One
 * string renderer for the server-rendered route page and the planner's
 * bundle, so the two never draw a cell differently; client/odds-history.ts
 * opens the card on hover, focus or tap. The chart's oh-* rules live in
 * styles/tailwind.css. No JSX: browser bundles import it.
 */
import type { RouteFlightHistory, RouteFlightRow } from "../api/route-flights";
import { esc } from "../client/esc";
import { oddsBasis, oddsCell, oddsTone } from "./route-flights-copy";
import { monthDay } from "./ui/format";
import { TONE_TEXT } from "./ui/tone-classes";

const TREND = {
  up: { arrow: "↑", words: "rising lately" },
  down: { arrow: "↓", words: "falling lately" },
} as const;

function trendHtml(row: RouteFlightRow): string {
  if (!row.trend) return "";
  const t = TREND[row.trend];
  return `<span class="ml-0.5" aria-hidden="true">${t.arrow}</span><span class="sr-only">, ${t.words}</span>`;
}

const CHART_W = 256;
const BAR_W = 18;
const BAR_TOP = 2;
const BAR_H = 44;

/** One bar per week, to one scale: the track is every flight seen, the fill the Starlink share. */
function weeksChart(h: RouteFlightHistory): string {
  const slot = CHART_W / h.weeks.length;
  const bars = h.weeks
    .map((w, i) => {
      const x = i * slot + (slot - BAR_W) / 2;
      const cx = i * slot + slot / 2;
      const day = monthDay(w.start);
      // "Aug 10 17 24 31 Sep 7": the month only where it changes, so eight fit.
      const tick =
        i > 0 && h.weeks[i - 1].start.slice(5, 7) === w.start.slice(5, 7)
          ? String(Number(w.start.slice(8)))
          : day;
      const fillH = w.flights > 0 ? (BAR_H * w.starlink) / w.flights : 0;
      const track = `<rect class="${w.flights > 0 ? "oh-track" : "oh-none"}" x="${x}" y="${BAR_TOP}" width="${BAR_W}" height="${BAR_H}" rx="2"/>`;
      const fill =
        fillH > 0
          ? `<rect class="oh-fill" x="${x}" y="${(BAR_TOP + BAR_H - fillH).toFixed(1)}" width="${BAR_W}" height="${fillH.toFixed(1)}" rx="2"/>`
          : "";
      const title =
        w.flights > 0
          ? `Week of ${day}: ${w.starlink} of ${w.flights} with Starlink`
          : `Week of ${day}: none seen`;
      return `<g><title>${esc(title)}</title>${track}${fill}<text class="oh-n" x="${cx}" y="${BAR_TOP + BAR_H + 13}">${w.flights > 0 ? `${w.starlink}/${w.flights}` : "–"}</text><text class="oh-wk" x="${cx}" y="${BAR_TOP + BAR_H + 26}">${esc(tick)}</text></g>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${CHART_W} ${BAR_TOP + BAR_H + 30}" class="mt-2 block w-full" role="img" aria-label="Starlink flights by week">${bars}</svg>`;
}

function recentList(h: RouteFlightHistory): string {
  if (h.recent.length === 0) return "";
  const rows = h.recent
    .map(
      (f) =>
        `<li class="oh-row"><span class="text-muted">${esc(monthDay(f.date))}</span><span class="font-mono">${esc(f.tail)}</span><span class="truncate">${esc(f.type ?? "—")}</span>${f.starlink ? '<span class="text-success">✓<span class="sr-only"> Starlink</span></span>' : '<span class="text-muted">·<span class="sr-only"> No Starlink</span></span>'}</li>`
    )
    .join("");
  return `<div class="mt-3 font-mono text-xs uppercase tracking-wider text-muted">Latest flights</div><ul class="mt-1.5 space-y-1 text-xs text-secondary tabular-nums">${rows}</ul>`;
}

/** How the number is made, in a line, and what the arrow compares when there is one. */
function methodLine(row: RouteFlightRow, h: RouteFlightHistory): string {
  if (row.basis === "aircraft_type") {
    return "Too few flights seen yet, so the odds follow its aircraft types.";
  }
  const base = "Weighted toward recent flights.";
  if (!row.trend) return base;
  const r = h.last_14_days;
  const w = h.window;
  return `${base} Last 2 weeks: ${r.starlink} of ${r.flights} had Starlink, against ${w.starlink} of ${w.flights} overall.`;
}

function historyCard(id: string, row: RouteFlightRow, h: RouteFlightHistory): string {
  return `<div id="${id}" role="tooltip" hidden class="js-odds-card absolute right-0 top-full z-30 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-subtle bg-surface-elevated p-3 text-left shadow-xl shadow-black/40"><div class="font-mono text-xs uppercase tracking-wider text-muted">Starlink flights by week</div>${weeksChart(h)}${recentList(h)}<p class="mt-3 border-t border-subtle pt-2 text-xs text-secondary text-pretty">${esc(methodLine(row, h))}</p></div>`;
}

/** The basis line, after the odds when an assigned plane's answer is the big text. */
function detailHtml(row: RouteFlightRow): string {
  const basis = esc(oddsBasis(row));
  if (row.assignment && row.probability !== null) {
    return `${esc(row.odds_label)}${trendHtml(row)} · ${basis}`;
  }
  return basis;
}

/** The odds cell's inner markup; with a history, a button that opens its card. */
export function oddsCellHtml(row: RouteFlightRow): string {
  const big = `<div class="whitespace-nowrap font-display ${TONE_TEXT[oddsTone(row)]}">${esc(oddsCell(row))}${row.assignment ? "" : trendHtml(row)}</div>`;
  if (!row.history) return `${big}<div class="text-xs text-muted">${detailHtml(row)}</div>`;
  const id = `odds-history-${esc(row.flight_number)}`;
  return `<div class="js-odds-hist relative inline-block align-top"><button type="button" class="js-odds-trigger cursor-help rounded text-right focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50" aria-describedby="${id}">${big}<div class="text-xs text-muted underline decoration-dotted underline-offset-2">${detailHtml(row)}</div></button>${historyCard(id, row, row.history)}</div>`;
}
