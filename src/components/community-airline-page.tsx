/**
 * Hub /airlines/{slug} for a community-source airline (AF): the answer is per
 * programme type and per tail, never one blended fleet percentage, and every
 * count is labelled for what it is — a floor from a community-curated list.
 */

import { type AirlineConfig, type SiteConfig, programTypeOf } from "../airlines/registry";
import { type AirlineFactsEntry, formatFactDate } from "../airlines/rollout-facts";
import type { FleetGuideTail, TypeProgress } from "../database/database";
import { typeShare } from "../scripts/starlink-predictor";
import { FactsList, StatusPill } from "./airlines-page";
import type { PageLink } from "./atoms";
import { Eyebrow, PANEL, PageHeader, PageShell, Panel, SECTION, StatValue, fmt } from "./layout";
import { Meter } from "./ui/meter";

/** Past this, the guide may be missing installs and the page says so. */
export const GUIDE_STALE_DAYS = 45;

function typeRowText(t: TypeProgress): { text: string; tone: string } {
  if (t.excluded)
    return { text: `Retiring — not in the programme (${t.total})`, tone: "text-muted" };
  if (t.equipped === 0) return { text: `Not started — 0 of ${t.total}`, tone: "text-muted" };
  if (t.equipped === t.total) return { text: `All ${t.total}`, tone: "text-success" };
  return { text: `At least ${t.equipped} of ${t.total}`, tone: "text-warn" };
}

/** Programme totals: excluded (retiring) types never enter a denominator. */
export function programmeTotals(types: readonly TypeProgress[]): {
  equipped: number;
  total: number;
} {
  const live = types.filter((t) => !t.excluded);
  return {
    equipped: live.reduce((s, t) => s + t.equipped, 0),
    total: live.reduce((s, t) => s + t.total, 0),
  };
}

export function TypeShareTable({
  types,
  compact = false,
}: {
  types: readonly TypeProgress[];
  compact?: boolean;
}) {
  return (
    <div className="mb-4">
      <Eyebrow className="mb-1">By aircraft type</Eyebrow>
      {!compact && (
        <p className="text-xs text-muted leading-relaxed mb-2">
          Your booking shows the aircraft type — the best guide until the plane is assigned about
          two days out. On a 777, check whether it is the -300ER or -200ER.
        </p>
      )}
      {types.map((t) => {
        const { text, tone } = typeRowText(t);
        return (
          <div key={t.key} className="py-1.5 border-b border-subtle last:border-0">
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-xs text-primary shrink-0">{t.label}</span>
              <span className={`font-mono text-xs text-right ${tone}`}>{text}</span>
            </div>
            {!t.excluded && (
              <Meter share={typeShare(t)} color="var(--color-success)" size="xs" className="mt-1" />
            )}
            {!compact && !t.excluded && t.notInGuide > 0 && (
              <div className="font-mono text-xs text-muted mt-1">
                +{t.notInGuide} newer aircraft not yet in the guide
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

type Chip = { text: string; tone: string };

function tailChip(t: FleetGuideTail): Chip {
  if (!t.inRoster) return { text: "Not in current fleet", tone: "text-muted" };
  if (t.delisted) return { text: "Delisted — recheck", tone: "text-warn" };
  switch (t.mark) {
    case "starlink":
      return { text: "Starlink", tone: "text-success" };
    case "legacy":
      return { text: "Legacy WiFi", tone: "text-secondary" };
    case "none":
      return { text: "No WiFi listed", tone: "text-muted" };
    default:
      return { text: "Not in guide yet", tone: "text-muted" };
  }
}

// Registrations are [A-Z-] only, so matching on the row id is safe; "FHRBB"
// is accepted for "F-HRBB" because people type it without the dash.
const TAIL_FILTER_SCRIPT = `(function(){var i=document.getElementById('tail-filter');if(!i)return;var rows=document.querySelectorAll('[data-tail-row]');i.addEventListener('input',function(){var q=i.value.toUpperCase().replace(/[^A-Z]/g,'');rows.forEach(function(r){r.hidden=q.length>0&&r.id.replace('-','').indexOf(q)<0;});});})();`;

function TailLookup({ cfg, tails }: { cfg: AirlineConfig; tails: readonly FleetGuideTail[] }) {
  return (
    <div className={PANEL}>
      <label
        htmlFor="tail-filter"
        className="block text-xs font-mono text-muted uppercase tracking-wider mb-2"
      >
        Look up a tail number
      </label>
      <input
        id="tail-filter"
        type="search"
        placeholder="F-HTYA"
        autoComplete="off"
        className="w-full bg-base border border-subtle rounded px-3 py-2 text-primary font-mono text-sm mb-3 focus:outline-none focus:border-accent"
      />
      <div className="max-h-96 overflow-y-auto">
        <table className="w-full text-left font-mono text-xs">
          <thead>
            <tr className="text-muted">
              <th className="font-normal py-1">Tail</th>
              <th className="font-normal py-1">Type</th>
              <th className="font-normal py-1 text-right">Guide</th>
            </tr>
          </thead>
          <tbody>
            {tails.map((t) => {
              const chip = tailChip(t);
              return (
                <tr key={t.tail} id={t.tail} data-tail-row="" className="border-t border-subtle">
                  <td className="py-1 text-primary">{t.tail}</td>
                  <td className="py-1 text-secondary">
                    {t.aircraftType ? programTypeOf(cfg, t.aircraftType).label : "—"}
                  </td>
                  <td className={`py-1 text-right ${chip.tone}`}>{chip.text}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static inline script, no user input
        dangerouslySetInnerHTML={{ __html: TAIL_FILTER_SCRIPT }}
      />
    </div>
  );
}

// Same endpoint and rendering rules as the hub homepage check: a firm yes
// only on hasStarlink true; everything else is the server's own sentence.
const CHECK_SCRIPT = `document.addEventListener('DOMContentLoaded',function(){var f=document.getElementById('community-check');var out=document.getElementById('community-check-result');if(!f||!out)return;var di=f.elements.namedItem('date');if(di&&!di.value)di.value=new Date().toLocaleDateString('en-CA');function esc(s){var d=document.createElement('div');d.textContent=String(s==null?'':s);return d.innerHTML;}f.addEventListener('submit',function(e){e.preventDefault();var fd=new FormData(f);var q='flight_number='+encodeURIComponent(fd.get('flight_number'))+'&date='+encodeURIComponent(fd.get('date'));var t=fd.get('aircraft_type');if(t)q+='&aircraft_type='+encodeURIComponent(t);out.classList.remove('hidden');out.textContent='Checking…';fetch('/api/check-any-flight?'+q).then(function(r){return r.json()}).then(function(d){if(d.error){out.innerHTML='<span class="text-warn">'+esc(d.error)+'</span>';return;}var lead=d.hasStarlink===true?'<span class="text-success">Starlink (likely)</span> · ':'';out.innerHTML=lead+esc(d.reason||d.message||'');}).catch(function(){out.textContent='Lookup failed.';});});});`;

function FlightCheck({ cfg, types }: { cfg: AirlineConfig; types: readonly TypeProgress[] }) {
  return (
    <div className={PANEL}>
      <div className="text-xs font-mono text-muted uppercase tracking-wider mb-2">
        Check a flight
      </div>
      <form id="community-check" className="flex flex-col sm:flex-row gap-2">
        <input
          name="flight_number"
          required
          placeholder={`${cfg.iata}1006`}
          autoComplete="off"
          className="bg-base border border-subtle rounded px-3 py-2 text-primary font-mono text-sm focus:outline-none focus:border-accent sm:w-32"
        />
        <input
          name="date"
          type="date"
          aria-label="Departure date"
          required
          className="bg-base border border-subtle rounded px-3 py-2 text-primary font-mono text-sm focus:outline-none focus:border-accent"
        />
        <select
          name="aircraft_type"
          aria-label="Aircraft type on your booking (optional)"
          className="bg-base border border-subtle rounded px-3 py-2 text-primary font-mono text-sm focus:outline-none focus:border-accent"
        >
          <option value="">Type (optional)</option>
          {types
            .filter((t) => t.total > 0)
            .map((t) => (
              <option key={t.key} value={t.label}>
                {t.label}
              </option>
            ))}
        </select>
        <button
          type="submit"
          className="px-5 py-2 bg-accent/20 border border-accent text-accent font-display font-semibold rounded hover:bg-accent/30 transition-colors cursor-pointer"
        >
          Check
        </button>
      </form>
      <div
        id="community-check-result"
        aria-live="polite"
        className="hidden font-mono text-xs text-secondary leading-relaxed mt-3"
      />
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static inline script, no user input
        dangerouslySetInnerHTML={{ __html: CHECK_SCRIPT }}
      />
    </div>
  );
}

function daysBetween(fromIso: string, nowMs: number): number {
  return Math.floor((nowMs - Date.parse(fromIso)) / 86400_000);
}

export function CommunityAirlinePage({
  site,
  cfg,
  types,
  tails,
  guideUpdated,
  lastSynced,
  facts,
  nowMs,
  pageLinks,
  currentPath,
}: {
  site: SiteConfig;
  cfg: AirlineConfig;
  types: readonly TypeProgress[];
  tails: readonly FleetGuideTail[];
  /** Curator's last edit, full ISO; null before the first sync. */
  guideUpdated: string | null;
  lastSynced: string | null;
  facts: AirlineFactsEntry | null;
  nowMs: number;
  pageLinks?: PageLink[];
  currentPath?: string;
}) {
  const source = cfg.communitySource;
  const { equipped, total } = programmeTotals(types);
  const guideDate = guideUpdated ? formatFactDate(guideUpdated.slice(0, 10)) : null;
  const stale = guideUpdated !== null && daysBetween(guideUpdated, nowMs) > GUIDE_STALE_DAYS;
  const official = facts?.facts.find((f) => f.asOf);
  return (
    <PageShell site={site} pageLinks={pageLinks} currentPath={currentPath}>
      <PageHeader
        title={`Does my ${cfg.name} flight have Starlink?`}
        dek={`${cfg.rollout.statusLabel} — ${cfg.rollout.phaseNote}`}
      />
      <section className={SECTION}>
        <Panel>
          <div className="flex items-center justify-between gap-2 mb-3">
            <Eyebrow as="span" className="">
              Rollout status
            </Eyebrow>
            <StatusPill cfg={cfg} />
          </div>
          {total > 0 ? (
            <StatValue className="mb-2" unit={`of ${fmt(total)} aircraft`}>
              At least {fmt(equipped)}
            </StatValue>
          ) : (
            <p className="text-sm text-muted">No per-aircraft data yet.</p>
          )}
          {official && (
            <p className="text-xs text-muted leading-relaxed mb-3">
              {cfg.shortName}'s own figure ({formatFactDate(official.asOf as string)}):{" "}
              {official.fact}{" "}
              <a
                href={official.source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                {official.source.label}
              </a>
              . The guide trails installs, so read every count here as a floor.
            </p>
          )}
          {types.length > 0 && <TypeShareTable types={types} />}
        </Panel>
      </section>

      {types.length > 0 && (
        <section className={SECTION}>
          <FlightCheck cfg={cfg} types={types} />
        </section>
      )}

      {tails.length > 0 && (
        <section className={SECTION}>
          <TailLookup cfg={cfg} tails={tails} />
        </section>
      )}

      {source && (
        <section className={SECTION}>
          <Panel>
            <Eyebrow className="mb-2">Where this comes from</Eyebrow>
            <p className="text-sm text-secondary leading-relaxed mb-2">
              Per-aircraft status is from the{" "}
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                {source.label}
              </a>
              {source.author ? `, curated by ${source.author}` : ""}
              {guideDate ? ` (last updated ${guideDate})` : ""}
              {lastSynced ? `; synced here ${formatFactDate(lastSynced.slice(0, 10))}` : ""}. The
              fleet roster is from FlightRadar24.
            </p>
            <p className="text-sm text-muted leading-relaxed">
              Community-curated — not verified against {cfg.verifySite}. A Starlink mark in the
              guide reads as "likely" here, never "verified", and an aircraft the guide doesn't mark
              is unknown, not a no.
            </p>
            {stale && (
              <p className="text-sm text-warn leading-relaxed mt-2">
                The guide hasn't been updated in over {GUIDE_STALE_DAYS} days — recent installs may
                be missing from these counts.
              </p>
            )}
          </Panel>
        </section>
      )}

      {facts && (
        <section className={SECTION}>
          <FactsList entry={facts} />
        </section>
      )}
    </PageShell>
  );
}

/** Meta description: the floor count and the types under way, never a ratio
 * in the title (the guide lags, and a lagging ratio reads as a regression). */
export function communityPageDescription(
  cfg: AirlineConfig,
  types: readonly TypeProgress[],
  guideUpdated: string | null
): string {
  const { equipped, total } = programmeTotals(types);
  const date = guideUpdated ? ` (${formatFactDate(guideUpdated.slice(0, 10))})` : "";
  const label = cfg.communitySource?.label ?? "community fleet guide";
  // No type list: with real counts it always ran past the meta clamp.
  return total > 0
    ? `At least ${equipped} of ${total} ${cfg.name} jets have Starlink per the ${label}${date}. Check your flight, aircraft type or tail.`
    : cfg.brand.description;
}
