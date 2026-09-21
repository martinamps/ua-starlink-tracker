import type { FleetFamily, FleetTail } from "../../types";
import { AIRCRAFT_SPECS, type AircraftSpec } from "../../utils/aircraft-specs";
import { H2, SECTION_WIDE } from "../layout";
import { fmt, pct } from "../ui/format";
import { type PipelineMap, pipelinePhrase } from "./pipeline";
import { PROVIDER_LABEL, ProviderLegend, WIFI_CLASS } from "./providers";
import { type FleetTypeLink, familyLabel, providerCounts } from "./type-bars";

function pipelineNote(p: PipelineMap, tail: string): string {
  const row = p.get(tail);
  return row ? ` · ${pipelinePhrase(row.state, row.mod_location)}` : "";
}

function tailTitle(t: FleetTail, pipeline?: PipelineMap): string {
  return `${t.tail} · ${PROVIDER_LABEL[t.provider]}${pipeline ? pipelineNote(pipeline, t.tail) : ""}`;
}

// The two pipeline states worth a visual on the grid — "scheduled" stays
// title-only (a dashed 8px cell reads as rendering noise, not information).
function pipelineCellClass(p: PipelineMap | undefined, tail: string): string {
  const state = p?.get(tail)?.state;
  if (state === "in_mod") return " pipe-mod";
  if (state === "verification_needed") return " pipe-verif";
  return "";
}

/**
 * One square per tail, colored by Wi-Fi provider, each linking to its row in
 * the /fleet registry. `anchorBase` is "/fleet" off that page.
 */
export function TailGrid({
  tails,
  pipeline,
  anchorBase = "",
  size = "sm",
}: {
  tails: FleetTail[];
  pipeline?: PipelineMap;
  anchorBase?: string;
  /** "sm" packs ten 8px cells per hangar block; "lg" wraps 12px cells to the container. */
  size?: "sm" | "lg";
}) {
  const grid =
    size === "sm"
      ? "grid grid-cols-[repeat(10,8px)] gap-[2px]"
      : "grid grid-cols-[repeat(auto-fill,12px)] gap-[3px]";
  const cell = size === "sm" ? "w-2 h-2" : "w-3 h-3";
  return (
    <div className={grid}>
      {tails.map((t) => (
        // biome-ignore lint/a11y/useAnchorContent: aria-label provides the accessible name; inline text on 1.5k cells would add ~50KB
        <a
          key={t.tail}
          href={`${anchorBase}#t-${t.tail}`}
          title={tailTitle(t, pipeline)}
          aria-label={tailTitle(t, pipeline)}
          className={`${WIFI_CLASS[t.provider]}${pipelineCellClass(pipeline, t.tail)} ${cell} rounded-[1px] hover:scale-150 transition-transform`}
        />
      ))}
    </div>
  );
}

function SpecCard({ name, spec }: { name: string; spec: AircraftSpec }) {
  const row = (label: string, value: string | number, unit = "") => (
    <div className="flex justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="text-secondary text-right tabular-nums">
        {value}
        {unit && <span className="text-muted ml-0.5">{unit}</span>}
      </dd>
    </div>
  );
  return (
    <span className="spec-card absolute top-full left-0 mt-1 w-64 bg-surface-elevated border border-subtle rounded-lg p-3 text-xs shadow-xl z-20 block">
      <span className="block font-display text-sm text-primary mb-2">{name}</span>
      <dl className="space-y-1 mb-2">
        {row("Seats", spec.seats)}
        {row("Wingspan", spec.wingspan_ft, "ft")}
        {row("Length", spec.length_ft, "ft")}
        {row("Range", fmt(spec.range_mi), "mi")}
        {row("Cruise", spec.cruise_mph, "mph")}
        {row("First flight", spec.first_flight)}
        {row("Engines", spec.engines)}
      </dl>
      <span className="block text-xs text-secondary leading-snug pt-2 border-t border-subtle">
        {spec.fun_fact}
      </span>
    </span>
  );
}

function FamilyBlock({
  fam,
  pipeline,
  typeLink,
  typeLinks,
}: {
  fam: FleetFamily;
  pipeline: PipelineMap;
  typeLink?: FleetTypeLink;
  typeLinks: Map<string, FleetTypeLink>;
}) {
  const spec = AIRCRAFT_SPECS[fam.family];
  const name = familyLabel(fam.family, typeLinks);
  return (
    <details
      className="fam-block bg-surface border border-subtle rounded"
      id={typeLink ? `fam-${typeLink.slug}` : undefined}
      open
    >
      <summary className="fam-summary list-none flex items-start justify-between gap-2 p-2">
        <div className="min-w-0">
          <span
            className={`spec-trigger relative block font-display text-sm ${
              spec ? "text-secondary hover:text-accent cursor-help" : "text-secondary"
            }`}
            tabIndex={spec ? 0 : -1}
          >
            <span className="block truncate">{name}</span>
            {spec && <SpecCard name={name} spec={spec} />}
          </span>
          <span className="text-xs text-muted tabular-nums">
            {fmt(fam.starlink)}/{fmt(fam.total)}
            {fam.starlink > 0 && (
              <span className="text-accent ml-1.5">{pct(fam.starlink, fam.total)}</span>
            )}
          </span>
        </div>
        <svg
          className="fam-caret w-3 h-3 text-muted shrink-0"
          viewBox="0 0 16 16"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M8 11L3 6h10z" />
        </svg>
      </summary>
      <div className="px-2 pb-2">
        <TailGrid tails={fam.tails} pipeline={pipeline} />
        {typeLink && (
          <a
            href={`/fleet/${typeLink.slug}`}
            className="block mt-2 text-xs text-accent hover:underline"
          >
            Details →
          </a>
        )}
      </div>
    </details>
  );
}

export function HangarFloor({
  families,
  pipeline,
  typeLinks,
}: {
  families: FleetFamily[];
  pipeline: PipelineMap;
  typeLinks: Map<string, FleetTypeLink>;
}) {
  const count = (state: string) => [...pipeline.values()].filter((r) => r.state === state).length;
  const inMod = count("in_mod");
  const verifying = count("verification_needed");
  return (
    <section className={SECTION_WIDE}>
      <h2 className={H2}>Every aircraft</h2>
      <p className="mt-1 mb-3 text-sm text-secondary">
        One square per aircraft, colored by Wi-Fi system.
      </p>
      <ProviderLegend
        className="mb-4"
        after={
          <>
            {inMod > 0 && (
              <li className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="pipe-mod inline-block w-2.5 h-2.5 rounded-[1px]"
                />
                In a mod line
              </li>
            )}
            {verifying > 0 && (
              <li className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="pipe-verif inline-block w-2.5 h-2.5 rounded-[1px]"
                />
                Install awaiting verification
              </li>
            )}
          </>
        }
      />
      <div className="fam-container gap-3">
        {families.map((fam) => (
          <FamilyBlock
            key={fam.family}
            fam={fam}
            pipeline={pipeline}
            typeLink={typeLinks.get(fam.family)}
            typeLinks={typeLinks}
          />
        ))}
      </div>
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static inline script, no user input
        dangerouslySetInnerHTML={{
          __html: `if(matchMedia('(max-width:767px)').matches)document.querySelectorAll('.fam-block').forEach(d=>d.removeAttribute('open'))`,
        }}
      />
    </section>
  );
}

function registryClass(t: FleetTail, pipeline: PipelineMap): string {
  if (t.provider === "starlink") return "tail-sl";
  return pipeline.has(t.tail) ? "tail-dim tail-pipe" : "tail-dim";
}

function registryDot(t: FleetTail, pipeline: PipelineMap): { ch: string; cls: string } {
  if (t.provider === "starlink") return { ch: "◉", cls: "" };
  const state = pipeline.get(t.tail)?.state;
  if (state === "in_mod") return { ch: "○", cls: " dot-mod" };
  if (state === "verification_needed") return { ch: "◎", cls: " dot-verif" };
  if (state === "scheduled") return { ch: "◌", cls: " dot-mod" };
  return { ch: " ", cls: "" };
}

export function TailRegistry({
  allTails,
  pipeline,
  typeLinks,
}: {
  allTails: FleetTail[];
  pipeline: PipelineMap;
  typeLinks: Map<string, FleetTypeLink>;
}) {
  const counts = providerCounts(allTails);
  return (
    <section className={SECTION_WIDE}>
      <h2 className={H2}>Tail registry</h2>
      <p className="mt-1 mb-3 text-sm text-secondary">
        All {fmt(allTails.length)} aircraft. Search with{" "}
        <kbd className="px-1 bg-surface border border-subtle rounded text-xs">⌘F</kbd>; click one to
        open it on FlightAware.
      </p>
      <ProviderLegend counts={counts} className="mb-4" />
      <div className="bg-surface border border-subtle rounded-lg p-4 font-mono text-xs leading-[1.7] columns-[20ch] gap-x-3">
        {allTails.map((t) => {
          const dot = registryDot(t, pipeline);
          return (
            <a
              key={t.tail}
              id={`t-${t.tail}`}
              href={`https://flightaware.com/live/flight/${t.tail}`}
              target="_blank"
              rel="nofollow noreferrer noopener"
              title={`${familyLabel(t.family, typeLinks)} · ${tailTitle(t, pipeline)}`}
              className={registryClass(t, pipeline)}
            >
              <span aria-hidden="true" className={`tail-dot${dot.cls}`}>
                {dot.ch}
              </span>
              <span className="tail-num">{t.tail}</span>
              <span className="tail-abbr">
                {t.family === "unknown" ? "—" : familyLabel(t.family, typeLinks)}
              </span>
            </a>
          );
        })}
      </div>
    </section>
  );
}
