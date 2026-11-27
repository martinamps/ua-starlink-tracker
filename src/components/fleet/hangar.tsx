import { type CSSProperties, Fragment } from "react";
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
import { H2, SECTION_WIDE, SkipLink, SkipTarget, TextGap } from "../layout";
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

function tailTitle(t: FleetTail, marks?: TailMarks, labels = PROVIDER_LABEL): string {
  return `${t.tail} · ${labels[t.provider]}${marks ? markNote(marks, t.tail) : ""}`;
}

/** A tail's title after the tail itself: its Wi-Fi system and any mark. */
function wifiNote(t: FleetTail, marks: TailMarks, labels: Record<WifiProvider, string>): string {
  return tailTitle(t, marks, labels).slice(`${t.tail} · `.length);
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
 * the list of tails below it on the same page (the /fleet registry, a type
 * page's tail list). `anchorBase` names another page's list.
 */
export function TailGrid({
  tails,
  marks,
  anchorBase = "",
  size = "sm",
  labels,
}: {
  tails: FleetTail[];
  marks?: TailMarks;
  /** The legend's wording for each square's title, where the page has its own. */
  labels?: Record<WifiProvider, string>;
  anchorBase?: string;
  /** "sm" packs ten 8px cells per hangar block (wider on phones); "lg" wraps 12px cells to the container. */
  size?: "sm" | "lg";
}) {
  // "sm" is the hangar's: ten columns from 768px, the block's full width
  // below it (.fam-grid), where a ten-wide strip left most of a phone blank.
  // The hangar's 1.6k squares take their size, corners and hover from
  // `.fam-grid > a` in the stylesheet rather than five utilities each.
  const grid =
    size === "sm" ? "fam-grid grid gap-[2px]" : "grid grid-cols-[repeat(auto-fill,12px)] gap-[3px]";
  const cell = size === "sm" ? "" : " w-3 h-3 rounded-[1px] hover:scale-150 transition-transform";
  return (
    <div className={grid}>
      {tails.map((t) => (
        // biome-ignore lint/a11y/useAnchorContent: the title is the accessible name; inline text on 1.5k cells would add ~50KB
        <a
          key={t.tail}
          href={`${anchorBase}#t-${t.tail}`}
          // An empty link takes its name from its title, so an aria-label
          // carrying the same words only doubled them on every square.
          title={tailTitle(t, marks, labels)}
          // The list below links every tail again, in rows a finger can
          // hit, so the squares stay out of the tab order: a keyboard would
          // otherwise stop on each aircraft twice.
          tabIndex={anchorBase === "" ? -1 : undefined}
          className={`${WIFI_CLASS[t.provider]}${markCellClass(marks, t.tail)}${cell}`}
        />
      ))}
    </div>
  );
}

function SpecCard({ id, name, spec }: { id: string; name: string; spec: AircraftSpec }) {
  const row = (label: string, value: string | number, unit = "") => (
    <>
      <div className="flex justify-between gap-4">
        <dt className="text-muted">{label}</dt>{" "}
        <dd className="text-secondary text-right tabular-nums">
          {value}
          {unit && (
            <>
              <TextGap />
              <span className="text-muted ml-0.5">{unit}</span>
            </>
          )}
        </dd>
      </div>{" "}
    </>
  );
  return (
    <span
      id={id}
      // Out of the block heading's name, which read the whole card aloud
      // ("CRJ700 CRJ700 Seats 70 Wingspan…"); the trigger still describes
      // itself with it.
      aria-hidden="true"
      className="spec-card absolute top-full left-0 mt-1 w-64 bg-surface-elevated border border-subtle rounded-lg p-3 text-xs shadow-xl z-20 block"
    >
      <span className="block font-display text-sm text-primary mb-2">{name}</span>{" "}
      <dl className="space-y-1 mb-2">
        {row("Seats", spec.seats)}
        {row("Wingspan", spec.wingspan_ft, "ft")}
        {row("Length", spec.length_ft, "ft")}
        {row("Range", fmt(spec.range_mi), "mi")}
        {row("Cruise", spec.cruise_mph, "mph")}
        {row("First flight", spec.first_flight)}
        {row("Engines", spec.engines)}
      </dl>{" "}
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
  labels,
}: {
  fam: FleetFamily;
  marks: TailMarks;
  typeLink?: FleetTypeLink;
  typeLinks: Map<string, FleetTypeLink>;
  labels: Record<WifiProvider, string>;
}) {
  const spec = AIRCRAFT_SPECS[fam.family];
  const name = familyLabel(fam.family, typeLinks);
  const specId = `spec-${fam.family.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  // One link per block, placed by CSS: beside the name on a phone, under the
  // squares from 768px. The other copy is display:none, so neither a reader
  // nor the keyboard meets it twice.
  const details = (className: string) =>
    typeLink && (
      <a href={`/fleet/${typeLink.slug}`} className={className}>
        Details →
      </a>
    );
  // Always open: on a phone the blocks were folded shut, so the picture the
  // section exists for showed only after eighteen taps.
  return (
    <div
      className="bg-surface border border-subtle rounded"
      id={typeLink ? `fam-${typeLink.slug}` : undefined}
    >
      <div className="fam-head flex items-start justify-between gap-2 p-2">
        <div className="fam-title min-w-0">
          <span
            className={`spec-trigger relative block font-display text-sm ${
              spec ? "text-secondary hover:text-accent cursor-help" : "text-secondary"
            }`}
            tabIndex={spec ? 0 : -1}
            aria-describedby={spec ? specId : undefined}
          >
            <span className="block truncate">{name}</span>{" "}
            {spec && <SpecCard id={specId} name={name} spec={spec} />}
          </span>{" "}
          <span className="text-xs text-muted tabular-nums">
            {fmt(fam.starlink)}/{fmt(fam.total)}
            {fam.starlink > 0 && (
              <>
                <TextGap />
                <span className="text-accent ml-1.5">{pct(fam.starlink, fam.total)}</span>
              </>
            )}
          </span>
        </div>{" "}
        {details("fam-details-head shrink-0 text-xs text-accent hover:underline")}
      </div>{" "}
      <div className="px-2 pb-2">
        <TailGrid tails={fam.tails} marks={marks} labels={labels} />{" "}
        {details("fam-details-foot mt-2 text-xs text-accent hover:underline")}
      </div>
    </div>
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
  const hangarFamilies = families.filter((f) => !f.outsideProgramme);
  const counts = providerCounts(hangarFamilies.flatMap((f) => f.tails));
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
      <h2 className={H2}>Every aircraft</h2>{" "}
      <p className="mt-1 mb-3 text-sm text-secondary">
        One square per aircraft, colored by Wi-Fi system.
      </p>{" "}
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
            )}{" "}
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
        {hangarFamilies.map((fam) => (
          <Fragment key={fam.family}>
            <FamilyBlock
              labels={labels}
              fam={fam}
              marks={marks}
              typeLink={typeLinks.get(fam.family)}
              typeLinks={typeLinks}
            />{" "}
          </Fragment>
        ))}
      </div>
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

function registryDot(t: FleetTail, marks: TailMarks): { ch?: string; cls: string } {
  const { pipeline, reported } = marks;
  if (t.provider === "starlink") return { ch: "◉", cls: "" };
  // Counted with Starlink, so it keeps the lit row, but a half-filled glyph
  // says nobody has seen it carrying Starlink yet.
  if (t.provider === "starlink_listed") return { ch: "◍", cls: "" };
  if (fittingNow(marks, t.tail)) return { ch: "○", cls: " tail-dot-mod" };
  if (reported.has(t.tail)) return { ch: "◎", cls: " tail-dot-verif" };
  const state = pipeline.get(t.tail)?.state;
  if (state === "in_mod") return { ch: "○", cls: " tail-dot-mod" };
  if (state === "verification_needed") return { ch: "◎", cls: " tail-dot-verif" };
  if (state === "scheduled") return { ch: "◌", cls: " tail-dot-mod" };
  return { cls: "" };
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
      {allTails.length > 0 && <SkipLink to="tail-registry-end">Skip the tail registry</SkipLink>}{" "}
      <h2 className={H2}>Tail registry</h2>{" "}
      <p className="mt-1 mb-3 text-sm text-secondary">
        All {fmt(allTails.length)} aircraft. Click one{" "}
        {ownPages
          ? "for its page: Starlink status, checks and flights."
          : "to open it on FlightAware."}
      </p>{" "}
      <ProviderLegend counts={counts} labels={labels} className="mb-4" />
      <div
        className="tail-registry bg-surface border border-subtle rounded-lg p-4 font-mono text-xs leading-[2] columns-[20ch] gap-x-3"
        style={{ "--tail-rows": allTails.length } as CSSProperties}
      >
        {allTails.map((t) => {
          const dot = registryDot(t, marks);
          const own = tailHref?.(t.tail) ?? null;
          const abbr = t.family === "unknown" ? "—" : familyLabel(t.family, typeLinks);
          // The space after each row draws nothing between these flex rows,
          // but keeps one row's type from running into the next tail in the
          // page's plain text ("E175N105SY"), as a crawler that doesn't
          // render reads it. The glyph that used to sit there is CSS now.
          return (
            <Fragment key={t.tail}>
              <a
                id={`t-${t.tail}`}
                {...(own
                  ? { href: own }
                  : {
                      href: `https://flightaware.com/live/flight/${t.tail}`,
                      target: "_blank",
                      rel: "nofollow noreferrer noopener",
                    })}
                title={`${familyLabel(t.family, typeLinks)} · ${tailTitle(t, marks, labels)}`}
                // The row shows a tail and a type; its Wi-Fi is colour and a
                // glyph, so the name says it (a title alone is often skipped).
                // It opens with the row's own text, space and all, as speech
                // control expects (WCAG 2.5.3).
                aria-label={`${t.tail} ${abbr} · ${wifiNote(t, marks, labels)}`}
                // The glyph is drawn by CSS from data-dot (an empty box where
                // there is none), as on a type page's list: one element fewer
                // on each of 1.6k rows. The name above already says it.
                data-dot={dot.ch}
                className={`${registryClass(t, marks)}${dot.cls}`}
              >
                <span className="tail-num">{t.tail}</span> <span className="tail-abbr">{abbr}</span>
              </a>{" "}
            </Fragment>
          );
        })}
      </div>
      {allTails.length > 0 && (
        <SkipTarget id="tail-registry-end">End of the tail registry.</SkipTarget>
      )}
    </section>
  );
}

/**
 * A type page's tails as rows a finger or a keyboard can hit: its squares are
 * 12px and out of the tab order, and each jumps to its row here. One element
 * per tail, the glyph drawn by CSS from data-dot, so a type with 200 aircraft
 * adds 200 elements and not 600.
 */
export function TypeTailList({
  tails,
  labels = PROVIDER_LABEL,
  tailHref,
}: {
  tails: FleetTail[];
  labels?: Record<WifiProvider, string>;
  /** The tail's own page where this host has one; otherwise the row opens FlightAware. */
  tailHref: (tail: string) => string | null;
}) {
  return (
    <div className="type-tails font-mono text-xs leading-[2] columns-[12ch] gap-x-3">
      {tails.map((t) => {
        const own = tailHref(t.tail);
        const lit = isStarlinkProvider(t.provider);
        return (
          <Fragment key={t.tail}>
            <a
              id={`t-${t.tail}`}
              {...(own
                ? { href: own }
                : {
                    href: `https://flightaware.com/live/flight/${t.tail}`,
                    target: "_blank",
                    rel: "nofollow noreferrer noopener",
                  })}
              title={labels[t.provider]}
              aria-label={`${t.tail} · ${labels[t.provider]}`}
              data-dot={lit ? (t.provider === "starlink" ? "◉" : "◍") : undefined}
              className={lit ? "tail-sl" : "tail-dim"}
            >
              {t.tail}
            </a>{" "}
          </Fragment>
        );
      })}
    </div>
  );
}
