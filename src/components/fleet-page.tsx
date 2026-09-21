import { sharePct } from "../airlines/aircraft-pages";
import { AIRLINES, type SiteConfig } from "../airlines/registry";
import type { FleetAnchorRow, FleetPageData } from "../types";
import { type PageLink, ShareCardLink } from "./atoms";
import { type CiteStat, CiteThis } from "./cite-this";
import { HangarFloor, TailRegistry } from "./fleet/hangar";
import { InstallPaceSection, LivePulse } from "./fleet/pace";
import { InstallPipelineSection, type PipelineMap } from "./fleet/pipeline";
import { CarrierSection, type FleetTypeLink, TypeBarsSection } from "./fleet/type-bars";
import { EYEBROW, PANEL, PageHeader, PageShell, SECTION_WIDE, fmt } from "./layout";

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
                {a.value}
              </a>{" "}
              <span className="text-muted">
                ({a.source_form}, as of {a.as_of_date})
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** Regional and mainline, the split the homepage reports (getFleetStats buckets). */
function SubfleetLine({ pace }: { pace: FleetPageData["installPace"] }) {
  if (!pace) return null;
  const parts = [
    { label: "Regional", g: pace.express },
    { label: "Mainline", g: pace.mainline },
  ].filter((x) => x.g.total > 0);
  if (parts.length < 2) return null;
  return (
    <p className="text-sm text-muted tabular-nums">
      {parts.map((x, i) => (
        <span key={x.label}>
          {i > 0 && " · "}
          {x.label} {fmt(x.g.starlink)} of {fmt(x.g.total)} ({sharePct(x.g.starlink, x.g.total)})
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
  pageLinks?: PageLink[];
  currentPath?: string;
  cite?: CiteStat | null;
  /** Served /fleet/{slug} pages. */
  typeLinks?: FleetTypeLink[];
}

export default function FleetPage({
  data,
  site,
  shareCard,
  pageLinks,
  currentPath,
  cite,
  typeLinks = [],
}: FleetPageProps) {
  const pipeline: PipelineMap = new Map(data.progressTails.map((r) => [r.tail, r]));
  const typeLinkByFamily = new Map(typeLinks.map((l) => [l.family, l]));
  const scopeCode = site.scope !== "ALL" ? site.scope : null;
  const title = scopeCode
    ? `${AIRLINES[scopeCode].name} fleet: Starlink rollout`
    : "Tracked fleets: Starlink rollout";
  // The express/mainline split only reads right when the page is one airline's.
  const pace = scopeCode ? data.installPace : null;
  return (
    <PageShell site={site} currentPath={currentPath} pageLinks={pageLinks}>
      <PageHeader
        title={title}
        dek={
          <>
            {fmt(data.totalStarlink)} of {fmt(data.totalFleet)} aircraft (
            {sharePct(data.totalStarlink, data.totalFleet)}) have Starlink.
          </>
        }
      >
        <SubfleetLine pace={pace} />
      </PageHeader>

      <TypeBarsSection families={data.families} typeLinks={typeLinkByFamily} />
      <LivePulse pulse={data.pulse} />
      <InstallPaceSection pace={data.installPace} />
      <InstallPipelineSection
        progress={data.progress}
        tails={data.progressTails}
        movements={data.movements}
      />
      <OfficialAnchorsSection anchors={data.anchors} />
      <HangarFloor families={data.families} pipeline={pipeline} typeLinks={typeLinkByFamily} />
      <CarrierSection carriers={data.carriers} allTails={data.allTails} />
      <TailRegistry allTails={data.allTails} pipeline={pipeline} typeLinks={typeLinkByFamily} />

      <ShareCardLink path={shareCard} />

      <CiteThis site={site} cite={cite} />
    </PageShell>
  );
}
