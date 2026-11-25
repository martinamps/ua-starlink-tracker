import type { CSSProperties } from "react";
import { isStarlinkProvider } from "../../database/sql/equipped";
import type {
  FleetFamily,
  FleetTail,
  ReportedInstall,
  SheetModNote,
  WifiProvider,
} from "../../types";
import { AIRCRAFT_SPECS, type AircraftSpec } from "../../utils/aircraft-specs";
import { reportedClause } from "../../utils/reported-reason";
import { H2, SECTION_WIDE } from "../layout";
import { fmt, pct } from "../ui/format";
import { type PipelineMap, fittingPhrase, pipelinePhrase } from "./pipeline";
import { PROVIDER_LABEL, PROVIDER_ORDER, ProviderLegend, WIFI_CLASS } from "./providers";
import { type FleetTypeLink, familyLabel, providerCounts } from "./type-bars";

/** Sheet-listed tails no count includes, by tail (FleetPageData.sheetReported). */
export type ReportedMap = Map<string, ReportedInstall>;

/** The fleet sheet's Starlink hangar notes, by tail (FleetPageData.sheetFitting). */
export type FittingMap = Map<string, SheetModNote>;

/** The marks a tail carries beyond its provider. The sheet's own listing
 * outranks the progress workbook's colour: it is the list we count from. */
export interface TailMarks {
  pipeline: PipelineMap;
  reported: ReportedMap;
  fitting: FittingMap;
}

/** A hangar note the sheet is sure of: dated and per tail, so it speaks first. */
function fittingNow(m: TailMarks | undefined, tail: string): SheetModNote | null {
  const note = m?.fitting.get(tail);
  return note && !note.unsure ? note : null;
}

function markNote(m: TailMarks, tail: string): string {
  const fitting = fittingNow(m, tail);
  if (fitting) return ` · ${fittingPhrase(fitting)}`;
  const reported = m.reported.get(tail);
  if (reported) return ` · sheet lists Starlink, not counted: ${reportedClause(reported)}`;
  const row = m.pipeline.get(tail);
  if (row) return ` · ${pipelinePhrase(row.state, row.mod_location)}`;
  const doubted = m.fitting.get(tail);
  return doubted ? ` · ${fittingPhrase(doubted)}` : "";
}

function tailTitle(t: FleetTail, marks?: TailMarks): string {
  return `${t.tail} · ${PROVIDER_LABEL[t.provider]}${marks ? markNote(marks, t.tail) : ""}`;
}

// The two pipeline states worth a visual on the grid — "scheduled" stays
// title-only (a dashed 8px cell reads as rendering noise, not information).
function markCellClass(m: TailMarks | undefined, tail: string): string {
  if (fittingNow(m, tail)) return " pipe-mod";
  if (m?.reported.has(tail)) return " pipe-verif";
  const state = m?.pipeline.get(tail)?.state;
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
  marks,
  anchorBase = "",
  size = "sm",
}: {
  tails: FleetTail[];
  marks?: TailMarks;
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
          title={tailTitle(t, marks)}
          aria-label={tailTitle(t, marks)}
          // On /fleet the registry below links every tail again, so the
          // squares stay out of the tab order: a keyboard would otherwise
          // stop on each of the fleet's aircraft twice.
          tabIndex={anchorBase === "" ? -1 : undefined}
          className={`${WIFI_CLASS[t.provider]}${markCellClass(marks, t.tail)} ${cell} rounded-[1px] hover:scale-150 transition-transform`}
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
  marks,
  typeLink,
  typeLinks,
}: {
  fam: FleetFamily;
  marks: TailMarks;
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
        <TailGrid tails={fam.tails} marks={marks} />
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
  marks,
  typeLinks,
  labels = PROVIDER_LABEL,
}: {
  families: FleetFamily[];
  marks: TailMarks;
  typeLinks: Map<string, FleetTypeLink>;
  labels?: Record<WifiProvider, string>;
}) {
  const counts = providerCounts(families.flatMap((f) => f.tails));
  const { pipeline, reported } = marks;
  const fitting = new Set([...marks.fitting.values()].filter((n) => !n.unsure).map((n) => n.tail));
  // A fitting tail wears the install mark, and a reported one the verification
  // mark, whatever the workbook says of either.
  const count = (state: string) =>
    [...pipeline.values()].filter(
      (r) => r.state === state && !reported.has(r.tail) && !fitting.has(r.tail)
    ).length;
  const inMod = count("in_mod") + fitting.size;
  const verifying =
    count("verification_needed") + [...reported.keys()].filter((t) => !fitting.has(t)).length;
  return (
    <section className={SECTION_WIDE}>
      <h2 className={H2}>Every aircraft</h2>
      <p className="mt-1 mb-3 text-sm text-secondary">
        One square per aircraft, colored by Wi-Fi system.
      </p>
      <ProviderLegend
        className="mb-4"
        providers={PROVIDER_ORDER.filter((p) => counts[p] > 0)}
        labels={labels}
        after={
          <>
            {inMod > 0 && (
              <li className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="pipe-mod inline-block w-2.5 h-2.5 rounded-[1px]"
                />
                Being installed
              </li>
            )}
            {verifying > 0 && (
              <li className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="pipe-verif inline-block w-2.5 h-2.5 rounded-[1px]"
                />
                Awaiting verification
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
            marks={marks}
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

function registryClass(t: FleetTail, marks: TailMarks): string {
  if (isStarlinkProvider(t.provider)) return "tail-sl";
  const { pipeline, reported } = marks;
  return pipeline.has(t.tail) || reported.has(t.tail) || fittingNow(marks, t.tail)
    ? "tail-dim tail-pipe"
    : "tail-dim";
}

function registryDot(t: FleetTail, marks: TailMarks): { ch: string; cls: string } {
  const { pipeline, reported } = marks;
  if (t.provider === "starlink") return { ch: "◉", cls: "" };
  // Counted with Starlink, so it keeps the lit row, but a half-filled glyph
  // says nobody has seen it carrying Starlink yet.
  if (t.provider === "starlink_listed") return { ch: "◍", cls: "" };
  if (fittingNow(marks, t.tail)) return { ch: "○", cls: " dot-mod" };
  if (reported.has(t.tail)) return { ch: "◎", cls: " dot-verif" };
  const state = pipeline.get(t.tail)?.state;
  if (state === "in_mod") return { ch: "○", cls: " dot-mod" };
  if (state === "verification_needed") return { ch: "◎", cls: " dot-verif" };
  if (state === "scheduled") return { ch: "◌", cls: " dot-mod" };
  return { ch: " ", cls: "" };
}

export function TailRegistry({
  allTails,
  marks,
  typeLinks,
  labels = PROVIDER_LABEL,
  tailHref,
}: {
  allTails: FleetTail[];
  marks: TailMarks;
  typeLinks: Map<string, FleetTypeLink>;
  labels?: Record<WifiProvider, string>;
  /** The tail's own page where this host has one; otherwise the row opens FlightAware. */
  tailHref?: (tail: string) => string | null;
}) {
  const counts = providerCounts(allTails);
  const ownPages = allTails.length > 0 && allTails.every((t) => tailHref?.(t.tail));
  return (
    <section className={SECTION_WIDE}>
      <h2 className={H2}>Tail registry</h2>
      <p className="mt-1 mb-3 text-sm text-secondary">
        All {fmt(allTails.length)} aircraft. Click one{" "}
        {ownPages
          ? "for its page: Starlink status, checks and flights."
          : "to open it on FlightAware."}
      </p>
      <ProviderLegend counts={counts} labels={labels} className="mb-4" />
      <div
        className="tail-registry bg-surface border border-subtle rounded-lg p-4 font-mono text-xs leading-[2] columns-[20ch] gap-x-3"
        style={{ "--tail-rows": allTails.length } as CSSProperties}
      >
        {allTails.map((t) => {
          const dot = registryDot(t, marks);
          const own = tailHref?.(t.tail) ?? null;
          return (
            <a
              key={t.tail}
              id={`t-${t.tail}`}
              {...(own
                ? { href: own }
                : {
                    href: `https://flightaware.com/live/flight/${t.tail}`,
                    target: "_blank",
                    rel: "nofollow noreferrer noopener",
                  })}
              title={`${familyLabel(t.family, typeLinks)} · ${tailTitle(t, marks)}`}
              className={registryClass(t, marks)}
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
