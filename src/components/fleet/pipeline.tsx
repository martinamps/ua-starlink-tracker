import { TYPE_DISPLAY } from "../../airlines/aircraft-pages";
import type { FleetMovement, FleetProgressRow, FleetProgressTailRow } from "../../types";
import { EYEBROW, H2, PANEL, SECTION_WIDE, aircraftName, fmt, pct } from "../layout";

export type PipelineMap = Map<string, FleetProgressTailRow>;

// Mod-line stations as the progress sheets abbreviate them. Only entries we're
// sure of — an unlisted code renders as the bare code rather than a guess.
export const STATION_NAMES: Record<string, string> = {
  MLB: "Melbourne, FL",
  MIA: "Miami, FL",
  LCQ: "Lake City, FL",
  BFM: "Mobile, AL",
  GSO: "Greensboro, NC",
  RFD: "Rockford, IL",
  MCO: "Orlando, FL",
  IAB: "Wichita, KS",
  PNS: "Pensacola, FL",
  GYR: "Goodyear, AZ",
  ROW: "Roswell, NM",
  ILN: "Wilmington, OH",
  INT: "Winston-Salem, NC",
  SAL: "San Salvador, El Salvador",
  BQN: "Aguadilla, Puerto Rico",
  XMN: "Xiamen, China",
  HKG: "Hong Kong",
  GIG: "Rio de Janeiro, Brazil",
  SFO: "San Francisco, CA",
  LAX: "Los Angeles, CA",
  IAH: "Houston, TX",
  EWR: "Newark, NJ",
  ORD: "Chicago, IL",
  GUM: "Guam",
  MDE: "Medellín, Colombia",
  PEK: "Beijing, China",
  SIN: "Singapore",
  FTW: "Fort Worth, TX",
  AMA: "Amarillo, TX",
  VCV: "Victorville, CA",
  CWF: "Lake Charles, LA",
};

// "MLB (Melbourne, FL)" — the code stays first so the vocabulary gets taught,
// not replaced; an unknown code renders bare.
function stationPhrase(code: string): string {
  const name = STATION_NAMES[code];
  return name ? `${code} (${name})` : code;
}

/** "MLB Melbourne, FL · MIA Miami, FL" for every decodable code in `codes`:
 * mobile has no hover, so each code painted on a chip is spelled out once. */
export function stationKey(codes: Array<string | null>): string {
  return [...new Set(codes)]
    .filter((c): c is string => !!c && !!STATION_NAMES[c])
    .sort()
    .map((c) => `${c} ${STATION_NAMES[c]}`)
    .join(" · ");
}

/** Progress-sheet column code ("39M", "77W") as the aircraft name the rest of the page uses. */
export function sheetTypeName(code: string): string {
  return TYPE_DISPLAY[code] ?? aircraftName(code);
}

const PIPELINE_LABEL: Record<FleetProgressTailRow["state"], string> = {
  in_mod: "Starlink install under way",
  verification_needed: "install finished, awaiting verification",
  scheduled: "queued for a future mod line",
};

export function pipelinePhrase(state: FleetProgressTailRow["state"], loc: string | null): string {
  return `${PIPELINE_LABEL[state]}${loc ? ` at ${stationPhrase(loc)}` : ""}`;
}

// anchorBase lets a type page point chips at the /fleet registry rows, the
// only page that carries the t-{tail} ids.
export function PipelineTailChip({
  row,
  anchorBase = "",
}: { row: FleetProgressTailRow; anchorBase?: string }) {
  const cls =
    row.state === "in_mod"
      ? "pipe-chip pipe-chip-mod"
      : row.state === "verification_needed"
        ? "pipe-chip pipe-chip-verif"
        : "pipe-chip pipe-chip-sched";
  return (
    <a
      href={`${anchorBase}#t-${row.tail}`}
      title={`${sheetTypeName(row.type_code)} · ${pipelinePhrase(row.state, row.mod_location)}`}
      className={cls}
    >
      {row.tail}
      {row.mod_location && <span className="opacity-60 ml-1">{row.mod_location}</span>}
    </a>
  );
}

// One bar per segment card: complete → verifying → in mod → queued, ordered by
// proximity to completion so the cyan mass anchors left; the bare track is
// "not started". Every nonzero state keeps a 3px floor — 4 verifying of 900 is
// the point of the bar, not a rounding error.
export function PipelineBar({
  complete,
  verifying,
  inMod,
  queued,
  total,
}: {
  complete: number;
  verifying: number;
  inMod: number;
  queued: number;
  total: number | null;
}) {
  if (!total || total <= 0) return null;
  const segs = [
    { n: complete, cls: "bar-complete", label: "complete" },
    { n: verifying, cls: "bar-verif", label: "awaiting verification" },
    { n: inMod, cls: "bar-inmod", label: "in a mod line" },
    { n: queued, cls: "bar-queued", label: "queued" },
  ].filter((s) => s.n > 0);
  return (
    <div
      className="flex gap-px h-3 rounded overflow-hidden bg-surface-elevated mt-2"
      role="img"
      aria-label={
        segs.length > 0
          ? `${segs.map((s) => `${fmt(s.n)} ${s.label}`).join(", ")}, of ${fmt(total)}`
          : "no installs yet"
      }
    >
      {segs.map((s) => (
        <span
          key={s.label}
          title={`${s.label}: ${fmt(s.n)}`}
          className={s.cls}
          style={{ width: `${(s.n / total) * 100}%`, minWidth: 3 }}
        />
      ))}
    </div>
  );
}

const MOVEMENT_GLYPH: Record<FleetMovement["kind"], { ch: string; cls: string }> = {
  entered_mod: { ch: "○", cls: "dot-mod" },
  to_verification: { ch: "◎", cls: "dot-verif" },
  queued: { ch: "◌", cls: "text-muted" },
  confirmed: { ch: "◉", cls: "text-accent" },
};

function movementText(m: FleetMovement): string {
  switch (m.kind) {
    case "entered_mod":
      return m.mod_location ? `entered the ${m.mod_location} mod line` : "entered a mod line";
    case "to_verification":
      return "install finished, awaiting verification";
    case "queued":
      return m.mod_location
        ? `queued for the ${m.mod_location} mod line`
        : "queued for a future mod line";
    case "confirmed":
      return "now showing Starlink";
  }
}

function movementDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function MovementsPanel({
  movements,
  anchorBase = "",
}: { movements: FleetMovement[]; anchorBase?: string }) {
  return (
    <div className={`${PANEL} mt-4`}>
      <div className={EYEBROW}>Last 14 days</div>
      {movements.length === 0 ? (
        <p className="text-sm text-muted">No aircraft moved through the pipeline.</p>
      ) : (
        <ul className="space-y-1 max-w-xl">
          {movements.map((m) => {
            const glyph = MOVEMENT_GLYPH[m.kind];
            return (
              <li key={`${m.tail}-${m.kind}-${m.date}`}>
                <a
                  href={`${anchorBase}#t-${m.tail}`}
                  className="flex items-baseline gap-2 px-2 py-1 rounded text-sm hover:bg-surface-elevated transition-colors group"
                >
                  <span aria-hidden="true" className={`w-4 text-center shrink-0 ${glyph.cls}`}>
                    {glyph.ch}
                  </span>
                  <span className="font-mono text-xs text-primary group-hover:text-accent transition-colors w-16 shrink-0">
                    {m.tail}
                  </span>
                  <span className="text-muted w-20 truncate hidden sm:inline shrink-0">
                    {sheetTypeName(m.type_code)}
                  </span>
                  <span className="text-secondary flex-1 truncate">{movementText(m)}</span>
                  <span className="text-muted shrink-0 tabular-nums">{movementDate(m.date)}</span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const SEGMENT_LABELS: Record<string, string> = {
  mainline_nb: "Mainline narrowbody",
  mainline_wb: "Mainline widebody",
  express: "Express & regional",
};

function Swatch({ cls }: { cls: string }) {
  return <span aria-hidden="true" className={`inline-block w-2 h-2 rounded-[1px] mr-1.5 ${cls}`} />;
}

// Forward-looking: aircraft in or queued for a mod line. The historical
// counterpart is InstallPaceSection.
export function InstallPipelineSection({
  progress,
  tails,
  movements,
}: {
  progress: FleetProgressRow[];
  tails: FleetProgressTailRow[];
  movements: FleetMovement[];
}) {
  const totals = progress.filter((r) => r.type_code === "Totals");
  if (totals.length === 0) return null;
  const updated = totals.find((r) => r.sheet_updated)?.sheet_updated;
  const inModTypes = progress.filter(
    (r) => r.type_code !== "Totals" && ((r.in_mod ?? 0) > 0 || (r.verification_needed ?? 0) > 0)
  );
  const bySegment = new Map<string, FleetProgressTailRow[]>();
  for (const t of tails) {
    if (!bySegment.has(t.segment)) bySegment.set(t.segment, []);
    bySegment.get(t.segment)?.push(t);
  }
  const scheduled = tails.filter((t) => t.state === "scheduled");
  const stations = stationKey(tails.map((t) => t.mod_location));

  return (
    <section className={SECTION_WIDE}>
      <h2 className={H2}>Install pipeline</h2>
      <p className="mt-1 mb-4 text-sm text-secondary text-pretty">
        Aircraft in a mod line now, from the community progress sheet
        {updated ? ` (updated ${updated} ET)` : ""}. The sheet keeps its own fleet list, so its
        totals run slightly different from our counts above.
      </p>
      <div className="grid md:grid-cols-3 gap-4">
        {totals.map((seg) => {
          const segRows = bySegment.get(seg.segment) ?? [];
          const segTails = segRows.filter((t) => t.state !== "scheduled");
          const segQueued = segRows.length - segTails.length;
          const complete = seg.starlink_complete ?? 0;
          return (
            <div key={seg.segment} className={PANEL}>
              <div className={EYEBROW}>{SEGMENT_LABELS[seg.segment] ?? seg.segment}</div>
              <div className="font-display text-2xl text-primary tabular-nums">
                {fmt(complete)}
                <span className="text-sm font-normal text-muted">
                  {" "}
                  of {seg.total !== null ? fmt(seg.total) : "?"} complete
                  {seg.total ? ` · ${pct(complete, seg.total)}` : ""}
                </span>
              </div>
              <PipelineBar
                complete={complete}
                verifying={seg.verification_needed ?? 0}
                inMod={seg.in_mod ?? 0}
                queued={segQueued}
                total={seg.total}
              />
              <ul className="text-sm text-secondary mt-3 space-y-1">
                {seg.in_mod !== null && (
                  <li>
                    <Swatch cls="bar-inmod" />
                    {fmt(seg.in_mod)} in a mod line now
                  </li>
                )}
                {seg.verification_needed !== null && (
                  <li>
                    <Swatch cls="bar-verif" />
                    {fmt(seg.verification_needed)} awaiting verification
                  </li>
                )}
                {segQueued > 0 && (
                  <li>
                    <Swatch cls="bar-queued" />
                    {fmt(segQueued)} queued
                  </li>
                )}
              </ul>
              {segTails.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {segTails.map((t) => (
                    <PipelineTailChip key={t.tail} row={t} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {(inModTypes.length > 0 || scheduled.length > 0) && (
        <div className="grid md:grid-cols-2 gap-4 mt-4">
          {inModTypes.length > 0 && (
            <div className={PANEL}>
              <div className={EYEBROW}>Active mod lines by type</div>
              <ul className="grid grid-cols-2 gap-2 text-sm text-secondary">
                {inModTypes.map((r) => (
                  <li key={`${r.segment}-${r.type_code}`}>
                    {sheetTypeName(r.type_code)}: {fmt(r.in_mod ?? 0)} in mod
                    {(r.verification_needed ?? 0) > 0
                      ? `, ${fmt(r.verification_needed ?? 0)} verifying`
                      : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {scheduled.length > 0 && (
            <div className={PANEL}>
              <div className={EYEBROW}>Queued for future mod lines</div>
              <div className="flex flex-wrap gap-1.5">
                {scheduled.map((t) => (
                  <PipelineTailChip key={t.tail} row={t} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {tails.length > 0 && <MovementsPanel movements={movements} />}
      {stations && <p className="text-xs text-muted mt-3">Mod stations: {stations}</p>}
    </section>
  );
}
