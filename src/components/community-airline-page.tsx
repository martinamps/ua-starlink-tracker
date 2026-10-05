/**
 * Hub /airlines/{slug} for a community-source airline (AF): the answer is per
 * programme type and per tail, never one blended fleet percentage, and every
 * count is labelled for what it is — a floor from a community-curated list.
 */

import {
  type AirlineConfig,
  GUIDE_MARK_TTL_DAYS,
  type SiteConfig,
  isGuideStale,
  programTypeOf,
} from "../airlines/registry";
import { type AirlineFactsEntry, formatFactDate } from "../airlines/rollout-facts";
import type { FleetGuideTail, TypeProgress } from "../database/database";
import { typeShare } from "../scripts/starlink-predictor";
import { FactsList, StatusPill } from "./airlines-page";
import { FIELD_CLASS, FlightSearchForm } from "./flight-search-form";
import { ClientScriptTag } from "./layout";
import type { Link } from "./layout";
import { Eyebrow, PageHeader, PageShell, Panel, SECTION, StatValue } from "./layout";
import { fmt } from "./ui/format";
import { Meter } from "./ui/meter";

// A stale guide can say none were listed, not that none have started.
function typeRowText(t: TypeProgress, stale: boolean): { text: string; tone: string } {
  if (t.excluded)
    return { text: `Retiring — not in the programme (${t.total})`, tone: "text-muted" };
  if (t.equipped === 0) {
    return {
      text: `${stale ? "None listed" : "Not started"} — 0 of ${t.total}`,
      tone: "text-muted",
    };
  }
  if (t.equipped === t.total) return { text: `All ${t.total}`, tone: "text-success" };
  return { text: `At least ${t.equipped} of ${t.total}`, tone: "text-warn" };
}

/** Programme totals: excluded (retiring) types never enter a denominator. */
function programmeTotals(types: readonly TypeProgress[]): {
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
  stale = false,
  compact = false,
}: {
  types: readonly TypeProgress[];
  stale?: boolean;
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
        const { text, tone } = typeRowText(t, stale);
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

// Past the TTL only a Starlink mark is still a status (registry.ts).
function tailChip(t: FleetGuideTail, stale: boolean): Chip {
  if (!t.inRoster) return { text: "Not in current fleet", tone: "text-muted" };
  if (t.delisted) return { text: "Delisted — recheck", tone: "text-warn" };
  if (stale && (t.mark === "legacy" || t.mark === "none")) {
    return { text: "Not listed then — may have it now", tone: "text-muted" };
  }
  switch (t.mark) {
    case "starlink":
      return { text: "Starlink", tone: "text-success" };
    case "legacy":
      return { text: "Legacy Wi-Fi", tone: "text-secondary" };
    case "none":
      return { text: "No Wi-Fi listed", tone: "text-muted" };
    default:
      return { text: "Not in guide yet", tone: "text-muted" };
  }
}

function TailLookup({
  cfg,
  tails,
  stale,
}: { cfg: AirlineConfig; tails: readonly FleetGuideTail[]; stale: boolean }) {
  return (
    <Panel>
      <Eyebrow as="label" htmlFor="tail-filter" className="mb-2 block">
        Look up a tail number
      </Eyebrow>
      <input
        id="tail-filter"
        type="search"
        placeholder="F-HTYA"
        autoComplete="off"
        className={`${FIELD_CLASS} mb-3 font-mono`}
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
              const chip = tailChip(t, stale);
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
    </Panel>
  );
}

// A firm yes only on hasStarlink true; everything else is the server's own
// sentence, since the guide behind the answer is community-curated.
function FlightCheck({
  site,
  cfg,
  types,
}: { site: SiteConfig; cfg: AirlineConfig; types: readonly TypeProgress[] }) {
  return (
    <Panel>
      <Eyebrow className="mb-2">Check a flight</Eyebrow>
      <FlightSearchForm
        site={site}
        id="community-check"
        mode="check-any"
        answer="community"
        placeholder={`${cfg.iata}1006`}
        prefillDate
        hideLabels
        withScript={false}
        extra={
          <select
            name="aircraft_type"
            aria-label="Aircraft type on your booking (optional)"
            className={`${FIELD_CLASS} sm:w-auto`}
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
        }
      />
    </Panel>
  );
}

export function CommunityAirlinePage({
  site,
  cfg,
  types,
  tails,
  guideUpdated,
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
  facts: AirlineFactsEntry | null;
  nowMs: number;
  pageLinks?: Link[];
  currentPath?: string;
}) {
  const source = cfg.communitySource;
  const { equipped, total } = programmeTotals(types);
  const guideDate = guideUpdated ? formatFactDate(guideUpdated.slice(0, 10)) : null;
  const stale = isGuideStale(guideUpdated, nowMs);
  const target = source?.fleetTarget;
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
              Latest reported figure ({formatFactDate(official.asOf as string)}): {official.fact}{" "}
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
          {types.length > 0 && <TypeShareTable types={types} stale={stale} />}
        </Panel>
      </section>

      {types.length > 0 && (
        <section className={SECTION}>
          <FlightCheck site={site} cfg={cfg} types={types} />
        </section>
      )}

      {tails.length > 0 && (
        <section className={SECTION}>
          <TailLookup cfg={cfg} tails={tails} stale={stale} />
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
              {guideDate ? ` as of ${guideDate}` : ""}. The fleet roster is from FlightRadar24.
            </p>
            <p className="text-sm text-muted leading-relaxed">
              Community-curated — not verified against {cfg.verifySite}. A Starlink mark in the
              guide reads as "likely" here, never "verified", and an aircraft the guide doesn't mark
              is unknown, not a no.
            </p>
            {stale && (
              <p className="text-sm text-warn leading-relaxed mt-2">
                Our copy of the guide is over {GUIDE_MARK_TTL_DAYS} days old. Its Starlink marks
                still stand (a retrofit isn't removed), but recent installs are missing, so an
                aircraft it doesn't mark may well have Starlink now.
                {target && (
                  <>
                    {" "}
                    {target.text} (
                    <a
                      href={target.source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent hover:underline"
                    >
                      {target.source.label}
                    </a>
                    , {formatFactDate(target.asOf)}).
                  </>
                )}
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
      <ClientScriptTag name="hub" />
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
