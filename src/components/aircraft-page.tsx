import React from "react";
import { FAMILY_DISPLAY, familySlug } from "../airlines/aircraft-families";
import { type SiteConfig, siteAirline } from "../airlines/registry";
import type { FleetFamily, FleetProgressRow, FleetTail, WifiProvider } from "../types";
import { AIRCRAFT_SPECS } from "../utils/aircraft-specs";

const EYEBROW = "text-[10px] font-mono text-muted uppercase tracking-wider mb-3";
const PANEL = "bg-surface border border-subtle rounded-lg p-5";
const SECTION = "relative w-full max-w-4xl mx-auto mb-10";

const PROVIDER_LABEL: Record<WifiProvider, string> = {
  starlink: "Starlink",
  viasat: "Viasat",
  panasonic: "Panasonic",
  thales: "Thales",
  none: "No WiFi",
  unknown: "Not yet verified",
};

export function familyMeta(family: string): { display: string; query: string } {
  return FAMILY_DISPLAY[family] ?? { display: family, query: family };
}

/** The one-line answer a family page exists to give. Claim ladder: these are
 * fleet-data installs (labeled), never a per-flight promise. */
export function familyVerdict(fam: FleetFamily, airlineName: string): string {
  const { display } = familyMeta(fam.family);
  const plural = fam.total === 1 ? "" : "s";
  if (fam.total > 0 && fam.starlink === fam.total) {
    return `Yes — all ${fam.total} ${airlineName} ${display}${plural} show Starlink installed in current fleet data.`;
  }
  if (fam.starlink > 0) {
    const pct = Math.round((fam.starlink / fam.total) * 100);
    return `Partially — ${fam.starlink} of ${fam.total} ${airlineName} ${display}${plural} (${pct}%) show Starlink installed in current fleet data. Whether your flight has it depends on which aircraft is assigned.`;
  }
  return `Not yet — none of the ${fam.total} tracked ${airlineName} ${display}${plural} show Starlink installed in current fleet data.`;
}

function timeAgo(sec: number | null): string {
  if (!sec) return "—";
  const d = Math.floor((Date.now() / 1000 - sec) / 86400);
  return d === 0 ? "today" : d === 1 ? "1d ago" : `${d}d ago`;
}

/**
 * Registrations link to /tail/{registration}, which ships on the sibling
 * roadmap/tail-pages branch — the links resolve once both land. Emitting them
 * now keeps the family pages as the crawl path into the per-tail corpus
 * instead of needing a second pass over every page to add them.
 */
function TailTable({ tails }: { tails: FleetTail[] }) {
  // Starlink tails first (the reason the reader is here), then the pipeline.
  const order: WifiProvider[] = ["starlink", "viasat", "panasonic", "thales", "none", "unknown"];
  const sorted = [...tails].sort(
    (a, b) => order.indexOf(a.provider) - order.indexOf(b.provider) || a.tail.localeCompare(b.tail)
  );
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 font-mono text-xs">
      {sorted.map((t) => (
        <a
          key={t.tail}
          href={`/tail/${t.tail}`}
          title={`${t.tail} · ${PROVIDER_LABEL[t.provider]} · verified ${timeAgo(t.verified_at)}`}
          className={`flex items-baseline gap-2 py-0.5 rounded hover:bg-surface-elevated transition-colors ${
            t.provider === "starlink" ? "text-accent" : "text-muted"
          }`}
        >
          <span className="w-2 text-center">{t.provider === "starlink" ? "◉" : "·"}</span>
          <span className={t.provider === "starlink" ? "" : "text-secondary"}>{t.tail}</span>
          <span className="text-[10px] text-muted truncate">{PROVIDER_LABEL[t.provider]}</span>
        </a>
      ))}
    </div>
  );
}

interface AircraftFamilyPageProps {
  family: FleetFamily;
  /** Install-pipeline rows matched to this family (empty when the sheet has none). */
  progress: FleetProgressRow[];
  site: SiteConfig;
}

export function AircraftFamilyPage({ family, progress, site }: AircraftFamilyPageProps) {
  const cfg = siteAirline(site);
  const { display, query } = familyMeta(family.family);
  const spec = AIRCRAFT_SPECS[family.family];
  const pct = family.total > 0 ? Math.round((family.starlink / family.total) * 100) : 0;
  const inMod = progress.reduce((s, r) => s + (r.in_mod ?? 0), 0);
  const verifying = progress.reduce((s, r) => s + (r.verification_needed ?? 0), 0);

  return (
    <div className="w-full mx-auto px-4 sm:px-6 md:px-8 bg-base min-h-screen flex flex-col relative">
      <div className="absolute inset-0 grid-pattern opacity-50 pointer-events-none" />

      <header className="relative py-5 sm:py-6 text-center mb-6">
        <h1 className="font-display text-3xl sm:text-4xl font-bold text-primary mb-2 tracking-tight">
          Does the {cfg.shortName} {query} Have Starlink?
        </h1>
        <p className="text-base text-secondary font-display max-w-2xl mx-auto">
          {familyVerdict(family, cfg.name)}
        </p>
      </header>

      <section className={SECTION}>
        <div className={PANEL}>
          <div className={EYEBROW}>{display} · Starlink rollout status</div>
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div>
              <dt className="text-[10px] font-mono text-muted uppercase tracking-wider">
                Installed
              </dt>
              <dd className="font-display text-2xl font-bold text-primary tabular-nums">
                {family.starlink}
                <span className="text-muted text-base font-normal">/{family.total}</span>
              </dd>
            </div>
            <div>
              <dt className="text-[10px] font-mono text-muted uppercase tracking-wider">
                Of this fleet
              </dt>
              <dd className="font-display text-2xl font-bold text-accent tabular-nums">{pct}%</dd>
            </div>
            <div>
              <dt className="text-[10px] font-mono text-muted uppercase tracking-wider">
                In mod line now
              </dt>
              <dd className="font-display text-2xl font-bold text-primary tabular-nums">
                {progress.length > 0 ? inMod : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-[10px] font-mono text-muted uppercase tracking-wider">
                Awaiting verification
              </dt>
              <dd className="font-display text-2xl font-bold text-primary tabular-nums">
                {progress.length > 0 ? verifying : "—"}
              </dd>
            </div>
          </dl>
          <div className="h-2 bg-surface-elevated rounded overflow-hidden mt-4">
            <div className="h-full bg-[var(--color-accent)]" style={{ width: `${pct}%` }} />
          </div>
          <p className="text-[11px] text-muted mt-4 leading-snug">
            Counts reflect current fleet data — per-tail verification where available, community
            fleet sheets otherwise. Mod-line numbers come from the community progress sheets and
            show aircraft being retrofitted before they appear as installed.
          </p>
        </div>
      </section>

      {spec && (
        <section className={SECTION}>
          <div className={PANEL}>
            <div className={EYEBROW}>{display} at a glance</div>
            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-4 font-mono text-sm text-secondary">
              <div>
                <dt className="text-[10px] text-muted uppercase tracking-wider">Seats</dt>
                <dd>{spec.seats}</dd>
              </div>
              <div>
                <dt className="text-[10px] text-muted uppercase tracking-wider">Range</dt>
                <dd>{spec.range_mi.toLocaleString()} mi</dd>
              </div>
              <div>
                <dt className="text-[10px] text-muted uppercase tracking-wider">Cruise</dt>
                <dd>{spec.cruise_mph} mph</dd>
              </div>
              <div>
                <dt className="text-[10px] text-muted uppercase tracking-wider">First flight</dt>
                <dd>{spec.first_flight}</dd>
              </div>
            </dl>
            <p className="text-[11px] text-accent/80 mt-4 leading-snug border-t border-subtle pt-3">
              {spec.fun_fact}
            </p>
          </div>
        </section>
      )}

      <section className={SECTION}>
        <div className={PANEL}>
          <div className={EYEBROW}>
            Every {cfg.shortName} {query} tail number
          </div>
          <TailTable tails={family.tails} />
          <p className="text-[11px] text-muted mt-4 leading-snug">
            ◉ marks tails showing Starlink in current fleet data. Follow a registration for that
            aircraft's page. Flying soon? A tail's status can change the week of your flight —{" "}
            <a href="/check-flight" className="text-accent hover:underline">
              check your flight number
            </a>{" "}
            for the live answer.
          </p>
        </div>
      </section>

      <section className={`${SECTION} text-center`}>
        <p className="text-sm text-secondary">
          <a href="/aircraft" className="text-accent hover:underline">
            All {cfg.shortName} aircraft types
          </a>{" "}
          or{" "}
          <a href="/fleet" className="text-accent hover:underline">
            the full fleet, tail by tail
          </a>
          .
        </p>
      </section>

      <footer className="relative py-6 text-center border-t border-subtle text-muted text-sm mt-auto">
        <a href="/" className="text-accent hover:underline font-display">
          ← Back to {site.brand.title}
        </a>
      </footer>
    </div>
  );
}

interface AircraftIndexPageProps {
  families: FleetFamily[];
  site: SiteConfig;
}

export function AircraftIndexPage({ families, site }: AircraftIndexPageProps) {
  const cfg = siteAirline(site);
  return (
    <div className="w-full mx-auto px-4 sm:px-6 md:px-8 bg-base min-h-screen flex flex-col relative">
      <div className="absolute inset-0 grid-pattern opacity-50 pointer-events-none" />

      <header className="relative py-5 sm:py-6 text-center mb-6">
        <h1 className="font-display text-3xl sm:text-4xl font-bold text-primary mb-2 tracking-tight">
          Which {cfg.shortName} Aircraft Have Starlink?
        </h1>
        <p className="text-base text-secondary font-display">
          Starlink installs by aircraft type across the {cfg.name} fleet
        </p>
      </header>

      <section className={SECTION}>
        <div className={PANEL}>
          <div className={EYEBROW}>By aircraft type · installed / fleet</div>
          <div className="space-y-3">
            {families.length === 0 && (
              <p className="text-sm text-muted">No fleet data loaded yet — check back shortly.</p>
            )}
            {families.map((fam) => {
              const pct = fam.total > 0 ? Math.round((fam.starlink / fam.total) * 100) : 0;
              return (
                <div key={fam.family}>
                  <div className="flex items-baseline justify-between mb-1">
                    <a
                      href={`/aircraft/${familySlug(fam.family)}`}
                      className="font-display text-sm font-semibold text-secondary hover:text-accent transition-colors"
                    >
                      {familyMeta(fam.family).display}
                    </a>
                    <span className="font-mono text-[10px] text-muted">
                      {fam.starlink}/{fam.total} <span className="text-accent">{pct}%</span>
                    </span>
                  </div>
                  <div className="h-2 bg-surface-elevated rounded overflow-hidden">
                    <div className="h-full bg-[var(--color-accent)]" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-muted mt-4 leading-snug">
            Per current fleet data. Each type links to its rollout page with every tail number and
            its WiFi status.
          </p>
        </div>
      </section>

      <footer className="relative py-6 text-center border-t border-subtle text-muted text-sm mt-auto">
        <a href="/" className="text-accent hover:underline font-display">
          ← Back to {site.brand.title}
        </a>
      </footer>
    </div>
  );
}
