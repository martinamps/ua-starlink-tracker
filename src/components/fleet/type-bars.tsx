import { sharePct } from "../../airlines/aircraft-pages";
import type { BodyClass, FleetCarrier, FleetFamily, FleetTail } from "../../types";
import { Section, aircraftName, fmt } from "../layout";
import {
  PROVIDER_LABEL,
  PROVIDER_ORDER,
  type ProviderCounts,
  ProviderLegend,
  emptyProviderCounts,
} from "./providers";

/** A family with its own /fleet/{slug} page. */
export interface FleetTypeLink {
  family: string;
  slug: string;
  short: string;
}

/** A type page's own short name wins ("A321neo"), so /fleet and /fleet/{slug} agree. */
export function familyLabel(family: string, typeLinks?: Map<string, FleetTypeLink>): string {
  if (family === "unknown") return "Type not listed";
  return typeLinks?.get(family)?.short ?? aircraftName(family);
}

export function providerCounts(tails: FleetTail[]): ProviderCounts {
  const counts = emptyProviderCounts();
  for (const t of tails) counts[t.provider]++;
  return counts;
}

/**
 * One row of the share-bar family: label, a full-width track filled to the
 * share, and "n/total · pct". With `counts` the fill is stacked by Wi-Fi
 * provider (Starlink first, so its length still reads as the share); without,
 * it is a single Starlink fill. "None" and "not checked" stay bare track.
 */
export function ShareBarRow({
  label,
  href,
  n,
  total,
  counts,
}: {
  label: string;
  href?: string;
  n: number;
  total: number;
  counts?: ProviderCounts;
}) {
  const segments = counts
    ? PROVIDER_ORDER.filter((p) => p !== "none" && p !== "unknown" && counts[p] > 0).map((p) => ({
        p,
        n: counts[p],
      }))
    : [{ p: "starlink" as const, n }];
  const detail = counts
    ? PROVIDER_ORDER.filter((p) => counts[p] > 0)
        .map((p) => `${fmt(counts[p])} ${PROVIDER_LABEL[p]}`)
        .join(", ")
    : "";
  return (
    <li className="grid grid-cols-[minmax(0,5.5rem)_1fr_7rem] sm:grid-cols-[minmax(0,7rem)_1fr_7rem] items-center gap-3 py-1.5 text-sm">
      {href ? (
        <a
          href={href}
          className="truncate text-secondary underline decoration-subtle underline-offset-4 hover:text-accent transition-colors"
        >
          {label}
        </a>
      ) : (
        <span className="truncate text-secondary">{label}</span>
      )}
      <div
        className="flex h-2 overflow-hidden rounded-full bg-surface-elevated"
        role="img"
        aria-label={`${label}: ${fmt(n)} of ${fmt(total)} with Starlink (${sharePct(n, total)})${detail ? `. ${detail}` : ""}`}
      >
        {total > 0 &&
          segments.map((s) => (
            <span
              key={s.p}
              className={`wifi-${s.p} h-full`}
              style={{ width: `${(s.n / total) * 100}%` }}
            />
          ))}
      </div>
      <span className="text-right font-mono text-xs text-muted tabular-nums whitespace-nowrap">
        {fmt(n)}/{fmt(total)} ·{" "}
        <span className={n > 0 ? "text-accent" : ""}>{sharePct(n, total)}</span>
      </span>
    </li>
  );
}

const BODY_GROUPS: Array<{ key: BodyClass; label: string }> = [
  { key: "regional", label: "Regional" },
  { key: "narrowbody", label: "Narrowbody" },
  { key: "widebody", label: "Widebody" },
];

export function TypeBarsSection({
  families,
  typeLinks,
}: {
  families: FleetFamily[];
  typeLinks: Map<string, FleetTypeLink>;
}) {
  const known = families.filter((f) => f.family !== "unknown");
  const unlisted = families.find((f) => f.family === "unknown");
  const byShare = (a: FleetFamily, b: FleetFamily) =>
    b.starlink / b.total - a.starlink / a.total || b.total - a.total;
  const groups = BODY_GROUPS.map((g) => ({
    ...g,
    families: known.filter((f) => f.body === g.key).sort(byShare),
  })).filter((g) => g.families.length > 0);
  if (groups.length === 0) return null;
  return (
    <Section
      wide
      title="Starlink by aircraft type"
      dek="Sorted by share within each group. Other colors show the Wi-Fi system the rest have today."
    >
      <ProviderLegend
        className="mb-4"
        providers={["starlink", "viasat", "panasonic", "thales"]}
        after={<li className="text-muted">Empty track: no Wi-Fi or not checked yet</li>}
      />
      <div className="grid gap-x-8 gap-y-6 lg:grid-cols-3">
        {groups.map((g) => {
          const total = g.families.reduce((s, f) => s + f.total, 0);
          const starlink = g.families.reduce((s, f) => s + f.starlink, 0);
          return (
            <div key={g.key}>
              <h3 className="flex items-baseline justify-between gap-3 border-b border-subtle pb-2 text-sm">
                <span className="font-display text-base text-primary">{g.label}</span>
                <span className="text-muted tabular-nums">
                  {fmt(starlink)} of {fmt(total)} · {sharePct(starlink, total)}
                </span>
              </h3>
              <ul className="mt-1">
                {g.families.map((f) => {
                  const link = typeLinks.get(f.family);
                  return (
                    <ShareBarRow
                      key={f.family}
                      label={familyLabel(f.family, typeLinks)}
                      href={link ? `/fleet/${link.slug}` : undefined}
                      n={f.starlink}
                      total={f.total}
                      counts={providerCounts(f.tails)}
                    />
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
      {unlisted && (
        <p className="mt-4 text-xs text-muted">
          {fmt(unlisted.total)} more aircraft have no type on record, {fmt(unlisted.starlink)} of
          them with Starlink.
        </p>
      )}
    </Section>
  );
}

export function CarrierSection({ carriers }: { carriers: FleetCarrier[] }) {
  if (carriers.length === 0) return null;
  const sorted = [...carriers].sort(
    (a, b) =>
      Number(!!a.unattributed) - Number(!!b.unattributed) || b.pct - a.pct || b.total - a.total
  );
  return (
    <Section
      title="Regional carriers"
      dek="Share of each regional carrier's aircraft with Starlink."
    >
      <ul>
        {sorted.map((c) => (
          <ShareBarRow
            key={c.name}
            label={c.unattributed ? "No carrier on record" : c.name}
            n={c.confirmed}
            total={c.total}
          />
        ))}
      </ul>
    </Section>
  );
}
