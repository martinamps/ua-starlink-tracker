/**
 * A /check-flight/{fn} permalink's crawlable substance: next departures, the
 * number's Starlink history, the routes it flies and its sibling numbers.
 */
import React from "react";
import { aircraftName } from "../../airlines/aircraft-families";
import { airportTimezone } from "../../utils/airport-tz";
import { Chip, Section, StatInline } from "../layout";
import { fmt, formatDuration, shortDate, zonedDeparture } from "../ui/format";
import type { FlightFacts } from "./types";

function lastSeenLabel(sec: number | null): string | null {
  if (!sec || sec * 1000 > Date.now()) return null;
  return `last seen ${shortDate(sec)}`;
}

export function FlightFactBlocks({
  flight,
  scheduledOnDate,
}: {
  flight: FlightFacts;
  scheduledOnDate: boolean;
}) {
  const fn = flight.flightNumber;
  const hasHistory =
    flight.observedTotal > 0 || flight.aircraftTypes.length > 0 || flight.lastStarlink !== null;
  const pred = flight.prediction;
  const modelled = !!pred && pred.n_observations > 0;
  const checked = flight.observedTotal > 0;
  const last = flight.lastStarlink;
  return (
    <>
      {flight.upcoming.length > 0 && (
        <Section title={`Next ${fn} departures`}>
          <ul className="divide-y divide-subtle text-sm">
            {flight.upcoming.map((u) => (
              <li
                key={`${u.tail_number}-${u.departure_time}`}
                className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <div className="text-primary">
                    {u.departure_airport} → {u.arrival_airport}
                    <span className="text-secondary">
                      {" · "}
                      {
                        zonedDeparture(
                          u.departure_time,
                          u.departure_tz ?? airportTimezone(u.departure_airport)
                        ).full
                      }
                    </span>
                  </div>
                  <div className="text-muted">
                    <span className="font-mono">{u.tail_number}</span>
                    {u.aircraft_type ? ` · ${aircraftName(u.aircraft_type)}` : ""}
                  </div>
                </div>
                <span
                  className={`shrink-0 whitespace-nowrap ${u.starlink ? "text-success" : "text-muted"}`}
                >
                  {u.starlink ? "Starlink" : u.wifiLabel}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {hasHistory && (
        <Section title={`${fn} Starlink history`}>
          <div className="space-y-2 text-sm leading-relaxed text-secondary">
            {(modelled || checked) && (
              <p>
                {modelled && (
                  <>
                    Based on <StatInline n={pred?.n_observations ?? 0} /> recent flights
                    {checked ? "; " : "."}
                  </>
                )}
                {checked && (
                  <>
                    Starlink found in <StatInline n={flight.observedStarlink} /> of{" "}
                    <StatInline n={flight.observedTotal} /> Wi-Fi checks
                    {flight.observedSince ? ` since ${shortDate(flight.observedSince)}` : ""}
                    {last ? (
                      <>
                        {" "}
                        (last <span className="font-mono">{last.tail}</span>,{" "}
                        {shortDate(last.checked_at)})
                      </>
                    ) : null}
                    .
                  </>
                )}
              </p>
            )}
            {last && !checked && (
              <p>
                Last verified on Starlink: <span className="font-mono">{last.tail}</span>,{" "}
                {shortDate(last.checked_at)}.
              </p>
            )}
            {flight.aircraftTypes.length > 0 && (
              <p>
                Aircraft seen on {fn}:{" "}
                {(
                  flight.aircraftTypeLinks ??
                  flight.aircraftTypes.map((label) => ({ label, href: null }))
                ).map((t, i) => (
                  <React.Fragment key={t.label}>
                    {i > 0 && ", "}
                    {t.href ? (
                      <a href={t.href} className="text-accent hover:underline">
                        {t.label}
                      </a>
                    ) : (
                      t.label
                    )}
                  </React.Fragment>
                ))}
                .
              </p>
            )}
          </div>
        </Section>
      )}

      {flight.routes.length > 0 && (
        <Section title={`Routes ${fn} flies`}>
          {flight.notObservedSince && !scheduledOnDate ? (
            <p className="mb-3 text-sm text-muted">
              Last seen {shortDate(flight.notObservedSince)}.
            </p>
          ) : null}
          <ul className="divide-y divide-subtle text-sm">
            {flight.routes.map((r) => {
              const lastSeen = lastSeenLabel(r.last_seen_at);
              return (
                <li
                  key={`${r.departure_airport}-${r.arrival_airport}`}
                  className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <div className="text-primary">
                      {r.departure_airport} → {r.arrival_airport}
                      {r.dur_sec ? (
                        <span className="text-secondary"> · {formatDuration(r.dur_sec)}</span>
                      ) : null}
                    </div>
                    <div className="text-muted">
                      Seen {fmt(r.times)} time{r.times === 1 ? "" : "s"}
                      {lastSeen ? ` · ${lastSeen}` : ""}
                    </div>
                  </div>
                  {r.linkable ? (
                    <a
                      href={`/route-planner/${r.departure_airport}/${r.arrival_airport}`}
                      className="shrink-0 whitespace-nowrap text-accent hover:underline"
                    >
                      Plan this route
                    </a>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      {flight.siblings.length > 0 && flight.routes[0] && (
        <Section
          title={`Other ${flight.routes[0].departure_airport} → ${flight.routes[0].arrival_airport} flights`}
        >
          <div className="flex flex-wrap gap-2">
            {flight.siblings.map((s) => (
              <Chip key={s} href={`/check-flight/${s}`}>
                {s}
              </Chip>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}
