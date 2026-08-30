import React from "react";
import { type SiteConfig, siteAirline, wifiEvidenceKind } from "../airlines/registry";
import type { TailDeparture, TailPageRecord, TailVerificationEvent } from "../database/database";

const EYEBROW = "text-[10px] font-mono text-muted uppercase tracking-wider mb-3";
const PANEL = "bg-surface border border-subtle rounded-lg p-5";
const SECTION = "relative w-full max-w-4xl mx-auto mb-10";

const longDate = (sec: number): string =>
  new Date(sec * 1000).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

const shortDate = (sec: number): string =>
  new Date(sec * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

/** Where each verification-log source actually looked. Type-derived backends
 * say so in the label: alaskaair.com and qatarairways.com expose the equipment
 * assigned to a flight, never the wifi installed on the airframe, so captioning
 * one of their rows "via alaskaair.com" would invent provenance it never had. */
const SOURCE_LABEL: Record<string, string> = {
  united: "united.com",
  alaska: "alaskaair.com equipment type",
  qatar: "qatarairways.com equipment type",
  flightradar24: "Flightradar24",
  spreadsheet: "community fleet sheet",
};

const sourceLabel = (source: string): string => SOURCE_LABEL[source] ?? source;

/**
 * Claim-ladder tier for a tail: verified (observed in service, dated) >
 * installed per fleet data (labeled) > no Starlink yet > unknown (honest
 * abstention). `contestedAt` rides on the weaker tiers when the newest
 * in-service check disagrees with the settled fleet status.
 */
export type TailClaim = (
  | { tier: "verified"; observedAt: number }
  | { tier: "installed"; settledAt: number | null }
  | { tier: "no_starlink"; provider: string | null; settledAt: number | null }
  | { tier: "unknown" }
) & {
  /** Newest in-service observation contradicts the settled status (consensus
   * needs a rolling window to flip): assert neither side until it re-settles. */
  contestedAt?: number;
};

export function deriveTailClaim(
  record: Pick<TailPageRecord, "starlink_status" | "verified_wifi" | "verified_at">,
  timeline: TailVerificationEvent[]
): TailClaim {
  // Only an observed-wifi source can date a "verified" claim. Type-derived
  // backends and the community sheet are fleet data — promoting one to
  // "verified in service" is the wrong-yes bug class the registry forbids.
  // The NEWEST such row wins, not the newest agreeable one: the timeline is
  // printed directly under the headline, so a stale positive must never
  // outrank the fresh negative sitting above it.
  const newestObserved = timeline.find((e) => wifiEvidenceKind(e.source) === "observed");
  const nonStarlinkWifi =
    record.verified_wifi && record.verified_wifi !== "Starlink" ? record.verified_wifi : null;

  if (record.starlink_status === "confirmed") {
    if (newestObserved?.has_starlink === 1) {
      return { tier: "verified", observedAt: newestObserved.last_checked_at };
    }
    return {
      tier: "installed",
      settledAt: record.verified_at,
      ...(newestObserved ? { contestedAt: newestObserved.last_checked_at } : {}),
    };
  }
  if (record.starlink_status === "negative" || nonStarlinkWifi) {
    if (newestObserved?.has_starlink === 1) {
      return { tier: "unknown", contestedAt: newestObserved.last_checked_at };
    }
    return { tier: "no_starlink", provider: nonStarlinkWifi, settledAt: record.verified_at };
  }
  return { tier: "unknown" };
}

/** Short claim headline for the H1 ("N47280 — {headline}"). */
export function tailClaimHeadline(claim: TailClaim): string {
  if (claim.contestedAt) return "re-verifying Starlink status";
  switch (claim.tier) {
    case "verified":
      return "Starlink verified";
    case "installed":
      return "Starlink installed";
    case "no_starlink":
      return "no Starlink yet";
    default:
      return "WiFi status unknown";
  }
}

const providerPhrase = (provider: string | null, settledAt: number | null): string => {
  // Every other tier dates its claim; a present-tense "installed today" with
  // no date ages silently, so say when the record settled (or say nothing).
  const asOf = settledAt ? ` as of ${longDate(settledAt)}` : "";
  if (!provider || provider === "None") {
    return `no replacement WiFi has been observed on it${asOf || " yet"}`;
  }
  return settledAt ? `${provider} is installed${asOf}` : `${provider} is installed`;
};

/** The one-sentence answer the page exists to give — shared by the header and
 * the meta description so they can never disagree. */
export function tailVerdict(
  claim: TailClaim,
  tail: string,
  airlineName: string,
  typeLabel: string | null
): string {
  const subject = typeLabel ? `${airlineName} ${typeLabel} ${tail}` : `${airlineName} tail ${tail}`;
  switch (claim.tier) {
    case "verified":
      return `${subject} has Starlink WiFi — last verified in service on ${longDate(claim.observedAt)}.`;
    case "installed": {
      const settled = claim.settledAt ? ` (settled ${longDate(claim.settledAt)})` : "";
      if (claim.contestedAt) {
        return `Fleet data lists Starlink on ${subject}${settled}, but the latest in-service check on ${longDate(claim.contestedAt)} did not find it — re-verifying before we call it either way.`;
      }
      return `${subject} has Starlink WiFi installed per fleet data${settled}, not yet re-verified in service.`;
    }
    case "no_starlink":
      return `${subject} does not have Starlink yet — ${providerPhrase(claim.provider, claim.settledAt)}.`;
    default:
      if (claim.contestedAt) {
        return `The latest in-service check on ${longDate(claim.contestedAt)} found Starlink on ${subject}, but our settled fleet record still disagrees — re-verifying before we call it either way.`;
      }
      return `The WiFi system on ${subject} hasn't been determined yet — verification checks are ongoing.`;
  }
}

export interface TailUpcomingFlight {
  /** Canonical marketing flight number when a /check-flight permalink exists; null otherwise. */
  permalink: string | null;
  flight_number: string;
  departure_airport: string;
  arrival_airport: string;
  departure_time: number;
}

export interface TailPageData {
  tail: string;
  record: TailPageRecord;
  claim: TailClaim;
  timeline: TailVerificationEvent[];
  upcoming: TailUpcomingFlight[];
  departures: TailDeparture[];
  faa: { year_mfr: string | null; serial: string | null } | null;
}

function claimBadgeLabel(claim: TailClaim): string {
  if (claim.contestedAt) return `Checks disagree · re-verifying ${shortDate(claim.contestedAt)}`;
  switch (claim.tier) {
    case "verified":
      return `Starlink · verified ${shortDate(claim.observedAt)}`;
    case "installed":
      return `Starlink · per fleet data${claim.settledAt ? ` ${shortDate(claim.settledAt)}` : ""}`;
    case "no_starlink":
      // Dated like every other tier — a bare "No Starlink yet" reads as a
      // claim about right now no matter how old the settle is.
      return `No Starlink${claim.settledAt ? ` · as of ${shortDate(claim.settledAt)}` : " yet"}`;
    default:
      return "Not yet determined";
  }
}

function ClaimBadge({ claim }: { claim: TailClaim }) {
  const tone = claim.contestedAt
    ? "text-muted border-subtle"
    : claim.tier === "verified" || claim.tier === "installed"
      ? "text-accent border-accent/40"
      : claim.tier === "no_starlink"
        ? "text-secondary border-subtle"
        : "text-muted border-subtle";
  const label = claimBadgeLabel(claim);
  return (
    <span
      className={`inline-block font-mono text-xs px-2.5 py-1 rounded border bg-surface-elevated ${tone}`}
    >
      {label}
    </span>
  );
}

function AircraftFacts({ data, airlineName }: { data: TailPageData; airlineName: string }) {
  const { record, faa } = data;
  const rows: Array<[string, string]> = [];
  if (record.aircraft_type) rows.push(["Aircraft type", record.aircraft_type]);
  rows.push(["Operator", record.operated_by || airlineName]);
  rows.push(["Fleet group", record.fleet]);
  if (record.ship_number) rows.push(["Ship number", record.ship_number]);
  if (faa?.year_mfr) rows.push(["Year built", faa.year_mfr]);
  if (faa?.serial) rows.push(["Serial number", faa.serial]);
  rows.push(["First tracked", longDate(record.first_seen_at)]);
  if (record.sheet_date_found) rows.push(["Starlink roster since", record.sheet_date_found]);

  return (
    <div className={PANEL}>
      <div className={EYEBROW}>Aircraft</div>
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt className="text-[10px] font-mono text-muted uppercase tracking-wider">{label}</dt>
            <dd className="font-display text-sm font-semibold text-primary break-words">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-[11px] text-muted mt-4 leading-snug">
        <a
          href={`https://flightaware.com/live/flight/${data.tail}`}
          target="_blank"
          rel="nofollow noreferrer noopener"
          className="text-accent hover:underline"
        >
          Track {data.tail} live on FlightAware
        </a>
        {" · fleet facts refresh with the daily fleet sync."}
      </p>
    </div>
  );
}

function TimelineResult({ e }: { e: TailVerificationEvent }) {
  // "Confirmed" is reserved for a source that actually looked at the aircraft's
  // wifi. A type-derived row only proves which airframe flew the leg.
  const observed = wifiEvidenceKind(e.source) === "observed";
  if (e.has_starlink === 1) {
    return (
      <span className="text-accent">
        {observed ? "Starlink confirmed" : "Starlink per fleet data"}
      </span>
    );
  }
  return (
    <span className="text-secondary">
      No Starlink{observed ? "" : " per fleet data"}
      {e.wifi_provider && e.wifi_provider !== "None" ? ` — ${e.wifi_provider}` : ""}
    </span>
  );
}

function VerificationTimeline({ data }: { data: TailPageData }) {
  const { timeline, record } = data;
  return (
    <div className={PANEL}>
      <div className={EYEBROW}>Verification history</div>
      {timeline.length === 0 ? (
        <p className="text-sm text-muted">
          No verification checks on record for this tail yet.{" "}
          {record.starlink_status === "confirmed"
            ? "Its Starlink status comes from fleet data; in-service checks appear here as they run."
            : "Checks run continuously across the fleet and appear here as they land."}
        </p>
      ) : (
        <>
          <ol className="space-y-2 font-mono text-[12px]">
            {timeline.map((e) => (
              <li
                key={`${e.day}-${e.source}-${e.has_starlink}-${e.wifi_provider}`}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5"
              >
                <span className="text-primary tabular-nums">{e.day}</span>
                <TimelineResult e={e} />
                <span className="text-muted">
                  via {sourceLabel(e.source)}
                  {e.flight_number ? ` on ${e.flight_number}` : ""}
                  {e.checks > 1 ? ` · ${e.checks} checks` : ""}
                </span>
              </li>
            ))}
          </ol>
          <p className="text-[11px] text-muted mt-4 leading-snug">
            Every check we have logged against this registration and confirmed belongs to it, newest
            first — identical same-day results are collapsed into one entry. This is the same
            evidence the status above is settled from.
          </p>
        </>
      )}
    </div>
  );
}

function RecentFlying({ data }: { data: TailPageData }) {
  const { upcoming, departures } = data;
  if (upcoming.length === 0 && departures.length === 0) {
    return (
      <div className={PANEL}>
        <div className={EYEBROW}>Recent flying</div>
        <p className="text-sm text-muted">
          No flights in the current schedule window for this tail. Aircraft assignments publish
          about two days before departure.
        </p>
      </div>
    );
  }
  return (
    <div className={PANEL}>
      <div className={EYEBROW}>Recent flying</div>
      {upcoming.length > 0 && (
        <div className="mb-4">
          <div className="text-[10px] font-mono text-muted uppercase tracking-wider mb-2">
            Scheduled next
          </div>
          <ul className="space-y-1.5 font-mono text-[12px]">
            {upcoming.map((f) => (
              <li
                key={`${f.flight_number}-${f.departure_time}`}
                className="flex flex-wrap items-baseline gap-x-3"
              >
                {f.permalink ? (
                  <a href={`/check-flight/${f.permalink}`} className="text-accent hover:underline">
                    {f.permalink}
                  </a>
                ) : (
                  <span className="text-secondary">{f.flight_number}</span>
                )}
                <span className="text-secondary">
                  {f.departure_airport} → {f.arrival_airport}
                </span>
                <span className="text-muted">{shortDate(f.departure_time)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {departures.length > 0 && (
        <div>
          <div className="text-[10px] font-mono text-muted uppercase tracking-wider mb-2">
            Recent departures
          </div>
          <ul className="space-y-1.5 font-mono text-[12px]">
            {departures.map((d) => (
              <li key={`${d.airport}-${d.departed_at}`} className="flex items-baseline gap-x-3">
                <span className="text-secondary">{d.airport}</span>
                <span className="text-muted">{shortDate(d.departed_at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-[11px] text-muted mt-4 leading-snug">
        Assignments come from live schedule data and can change up to departure — follow a flight
        number for its own Starlink record.
      </p>
    </div>
  );
}

interface TailPageProps {
  data: TailPageData;
  site: SiteConfig;
}

export default function TailPage({ data, site }: TailPageProps) {
  const cfg = siteAirline(site);
  const backLabel = site.brand.title;
  return (
    <div className="w-full mx-auto px-4 sm:px-6 md:px-8 bg-base min-h-screen flex flex-col relative">
      <div className="absolute inset-0 grid-pattern opacity-50 pointer-events-none" />

      <header className="relative py-5 sm:py-6 text-center mb-6">
        <h1 className="font-display text-3xl sm:text-4xl font-bold text-primary mb-3 tracking-tight">
          {data.tail} — {tailClaimHeadline(data.claim)}
        </h1>
        <div className="mb-3">
          <ClaimBadge claim={data.claim} />
        </div>
        <p className="text-base text-secondary font-display max-w-2xl mx-auto">
          {tailVerdict(data.claim, data.tail, cfg.name, data.record.aircraft_type)}
        </p>
      </header>

      <section className={SECTION}>
        <AircraftFacts data={data} airlineName={cfg.name} />
      </section>

      <section className={SECTION}>
        <VerificationTimeline data={data} />
      </section>

      <section className={SECTION}>
        <RecentFlying data={data} />
      </section>

      <section className={`${SECTION} text-center`}>
        <p className="text-sm text-secondary">
          See the whole rollout on the{" "}
          <a href="/fleet" className="text-accent hover:underline">
            {cfg.shortName} fleet page
          </a>
          {site.features.checkFlightPage ? (
            <>
              , or{" "}
              <a href="/check-flight" className="text-accent hover:underline">
                check a specific flight
              </a>
              .
            </>
          ) : (
            "."
          )}
        </p>
      </section>

      <footer className="relative py-6 text-center border-t border-subtle text-muted text-sm mt-auto">
        <a href="/" className="text-accent hover:underline font-display">
          ← Back to {backLabel}
        </a>
      </footer>
    </div>
  );
}
