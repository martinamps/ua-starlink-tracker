import { tenantCopy } from "../airlines/aircraft-pages";
import {
  BY_TYPE_METHOD,
  BY_TYPE_TAB_NOTE,
  byTypeSumBasis,
  countedNames,
  leftOutByType,
  ownCountAsOf,
  partnerIsByType,
  splitByMethod,
  trackingMethod,
} from "../airlines/published-count";
import { AIRLINES, type SiteConfig } from "../airlines/registry";
import type { AirlineChartCount } from "../database/roster";
import type { FleetAnchorRow, FleetPageData } from "../types";
import { ShareCardLink } from "./atoms";
import { type CiteStat, CiteThis } from "./cite-this";
import { HangarFloor, type TailMarks, TailRegistry } from "./fleet/hangar";
import { InstallPaceSection, LivePulse } from "./fleet/pace";
import { InstallPipelineSection, type PipelineMap } from "./fleet/pipeline";
import { providerLabels } from "./fleet/providers";
import { CarrierSection, type FleetTypeLink, TypeBarsSection } from "./fleet/type-bars";
import type { Link } from "./layout";
import { EYEBROW, PANEL, PageHeader, PageShell, SECTION_WIDE } from "./layout";
import { tailHref } from "./tail-link";
import { TrackerLinks } from "./tracker-links";
import { fmt, pct, shortDate } from "./ui/format";

export type { FleetTypeLink };

// The handful of figures the airline itself has put in SEC filings — the
// citable cross-check next to our scraped counts.
function OfficialAnchorsSection({ anchors }: { anchors: FleetAnchorRow[] }) {
  // Latest figure per metric (rows arrive ordered by as_of_date DESC), so a
  // freshly seeded quarter replaces the old one without touching this list.
  const latestByMetric = new Map<string, FleetAnchorRow>();
  for (const a of anchors) {
    if (!latestByMetric.has(a.metric)) latestByMetric.set(a.metric, a);
  }
  const shown = [...latestByMetric.values()].slice(0, 6);
  if (shown.length === 0) return null;

  return (
    <section className={SECTION_WIDE}>
      <div className={PANEL}>
        <div className={EYEBROW}>Reported in SEC filings</div>
        <ul className="text-sm text-secondary space-y-1">
          {shown.map((a) => (
            <li key={a.metric}>
              {a.scope}:{" "}
              <a
                href={a.source_url}
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline tabular-nums"
              >
                {/^\d+$/.test(a.value) ? fmt(Number(a.value)) : a.value}
              </a>{" "}
              <span className="text-muted">
                ({a.source_form}, {shortDate(a.as_of_date)})
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** Regional and mainline, the split the homepage reports (getFleetStats buckets). */
function SubfleetLine({
  pace,
  partners = [],
}: {
  pace: FleetPageData["installPace"];
  /** Programme-partner slices the header count includes (Hawaiian's Airbus on Alaska). */
  partners?: Array<{
    label: string;
    g: { starlink: number; total: number };
    /** Known by aircraft type: no share, and said so. */
    byType?: boolean;
  }>;
}) {
  if (!pace) return null;
  const parts: NonNullable<typeof partners> = [
    { label: "Regional", g: pace.express },
    { label: "Mainline", g: pace.mainline },
    ...partners,
  ].filter((x) => x.g.total > 0);
  if (parts.length < 2) return null;
  return (
    <p className="text-sm text-muted tabular-nums">
      {parts.map((x, i) => (
        <span key={x.label}>
          {i > 0 && " · "}
          {x.label} {fmt(x.g.starlink)} of {fmt(x.g.total)}
          {x.byType ? `, ${BY_TYPE_TAB_NOTE}` : ` (${pct(x.g.starlink, x.g.total)})`}
        </span>
      ))}
    </p>
  );
}

interface FleetPageProps {
  data: FleetPageData;
  site: SiteConfig;
  /** Pre-rendered share card path; null until the nightly batch produced one. */
  shareCard?: string | null;
  pageLinks?: Link[];
  currentPath?: string;
  cite?: CiteStat | null;
  /** The airline's own chart, while it counts more than the tails named here. */
  airlineCount?: AirlineChartCount | null;
  /** The header count's two parts, where it adds a by-type partner's
   * aircraft to the airline's own (programmePartsText). */
  countParts?: string | null;
  /** Served /fleet/{slug} pages. */
  typeLinks?: FleetTypeLink[];
  /** /install-rate when this host serves it. */
  installRateHref?: string | null;
}

export default function FleetPage({
  data,
  site,
  shareCard,
  pageLinks,
  currentPath,
  cite,
  airlineCount = null,
  countParts = null,
  typeLinks = [],
  installRateHref = null,
}: FleetPageProps) {
  const pipeline: PipelineMap = new Map(data.progressTails.map((r) => [r.tail, r]));
  const marks: TailMarks = {
    pipeline,
    reported: new Map(data.sheetReported.map((r) => [r.TailNumber, r])),
    fitting: new Map(data.sheetFitting.map((n) => [n.tail, n])),
  };
  const typeLinkByFamily = new Map(typeLinks.map((l) => [l.family, l]));
  const scopeCode = site.scope !== "ALL" ? site.scope : null;
  const title = scopeCode
    ? `Which ${AIRLINES[scopeCode].shortName} planes have Starlink?`
    : "Airline fleets with Starlink";
  // The express/mainline split only reads right when the page is one airline's.
  const pace = scopeCode ? data.installPace : null;
  // Known by aircraft type: the lit aircraft are a sum of fleet-list rows.
  const byType = scopeCode ? trackingMethod(AIRLINES[scopeCode]) === "type" : false;
  // Several airlines: only those counted on this site make the total. The
  // by-type ones are named beside it with their own fleet-list sum.
  const split = scopeCode ? null : splitByMethod(data.byAirline);
  const leftOut = split && leftOutByType(split);
  const labels = {
    ...providerLabels(
      scopeCode ? (tenantCopy(scopeCode).checksEveryTail ? "tail" : "type") : "mixed"
    ),
    ...(byType && { starlink_listed: "Starlink by aircraft type, not checked plane by plane" }),
    ...((leftOut || countParts) && {
      starlink_listed: "Starlink, listed or by aircraft type, not checked plane by plane",
    }),
  };
  return (
    <PageShell site={site} currentPath={currentPath} pageLinks={pageLinks}>
      <PageHeader
        title={title}
        dek={
          countParts && scopeCode ? (
            // The parts, and no share: only the first was counted on this site.
            <>
              {fmt(data.totalStarlink)} of {fmt(data.totalFleet)} aircraft on our fleet list have
              Starlink. That is {countParts}.
              {airlineCount && (
                <>
                  {" "}
                  {AIRLINES[scopeCode].shortName}'s own count is {fmt(airlineCount.connected)} of{" "}
                  {fmt(airlineCount.total)} {ownCountAsOf(airlineCount)}.
                </>
              )}
            </>
          ) : airlineCount && scopeCode ? (
            <>
              We can name {fmt(data.totalStarlink)} of {fmt(data.totalFleet)} aircraft (
              {pct(data.totalStarlink, data.totalFleet)}) with Starlink.{" "}
              {AIRLINES[scopeCode].shortName}'s own count is {fmt(airlineCount.connected)} of{" "}
              {fmt(airlineCount.total)} {ownCountAsOf(airlineCount)}.
            </>
          ) : byType && scopeCode ? (
            // No share: a part of a list picked by a type rule is not a share
            // of aircraft counted.
            <>
              {fmt(data.totalStarlink)} of the {fmt(data.totalFleet)} aircraft on our fleet list are
              of {byTypeSumBasis(scopeCode)}. They are {BY_TYPE_METHOD}.
            </>
          ) : split && leftOut ? (
            <>
              {fmt(split.counted.starlink)} of {fmt(split.counted.total)} {countedNames(split)}{" "}
              aircraft ({pct(split.counted.starlink, split.counted.total)}) have Starlink. {leftOut}
              .
            </>
          ) : (
            <>
              {fmt(data.totalStarlink)} of {fmt(data.totalFleet)} aircraft (
              {pct(data.totalStarlink, data.totalFleet)}) have Starlink.
            </>
          )
        }
      >
        <SubfleetLine
          pace={pace}
          partners={(scopeCode ? (AIRLINES[scopeCode].programmePartners?.partners ?? []) : []).map(
            (p) => {
              const fams = data.families.filter((f) => p.families.includes(f.family));
              return {
                label: p.label,
                byType: scopeCode ? partnerIsByType(AIRLINES[scopeCode], p.label) : false,
                g: {
                  starlink: fams.reduce((s, f) => s + f.starlink, 0),
                  total: fams.reduce((s, f) => s + f.total, 0),
                },
              };
            }
          )}
        />
      </PageHeader>

      {!scopeCode && (
        <div className={SECTION_WIDE}>
          <TrackerLinks />
        </div>
      )}

      <TypeBarsSection
        families={data.families}
        typeLinks={typeLinkByFamily}
        unknownLabel={labels.unknown.toLowerCase()}
      />
      <LivePulse pulse={data.pulse} />
      <InstallPaceSection pace={data.installPace} projectionHref={installRateHref} />
      <InstallPipelineSection
        progress={data.progress}
        tails={data.progressTails}
        movements={data.movements}
        fitting={data.sheetFitting}
      />
      <OfficialAnchorsSection anchors={data.anchors} />
      <HangarFloor
        families={data.families}
        marks={marks}
        typeLinks={typeLinkByFamily}
        labels={labels}
      />
      <CarrierSection carriers={data.carriers} />
      <TailRegistry
        allTails={data.allTails}
        marks={marks}
        typeLinks={typeLinkByFamily}
        labels={labels}
        tailHref={(tail) => tailHref(site, tail)}
      />

      <ShareCardLink path={shareCard} />

      <CiteThis site={site} cite={cite} />
    </PageShell>
  );
}
