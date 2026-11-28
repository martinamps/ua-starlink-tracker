import type React from "react";
import type { SiteConfig } from "../airlines/registry";
import {
  AIRPORT_NEXT_DEPARTURES,
  type AirportBoard,
  type AirportBoardDeparture,
  type AirportBoardDestination,
  airportDek,
  perDayLabel,
} from "../api/airport-board";
import { airportCity, airportPlaceName } from "../utils/airport-places";
import type { Link } from "./layout";
import {
  DataTable,
  LINK,
  PageHeader,
  PageShell,
  Panel,
  SECTION,
  Section,
  StatValue,
  Td,
  Th,
} from "./layout";
import { VERIFIED_LEGEND, VERIFIED_MARK } from "./route-flights-copy";
import { fmt, utcDateTime, weekdayDate } from "./ui/format";
import { Meter } from "./ui/meter";

interface AirportPageProps {
  site: SiteConfig;
  board: AirportBoard;
  /** The data's own freshness stamp, never request time. */
  updatedAt?: string | null;
  pageLinks?: Link[];
  currentPath?: string;
}

// Accent and an underline on hover, like every other link a traveller follows:
// bold white text read as a label (journey walk, 27 Nov).
const FLIGHT_LINK = "font-mono text-accent hover:underline";
const ROW_LINK = "whitespace-nowrap text-accent hover:underline";

/** The plane, linked to its own page where the site has tail pages. */
function Plane({ d, tailPages }: { d: AirportBoardDeparture; tailPages: boolean }) {
  const mark = d.starlink === "verified" && ` ${VERIFIED_MARK}`;
  return tailPages ? (
    <a href={`/fleet/${d.tail_number}`} className={`${FLIGHT_LINK} whitespace-nowrap`}>
      {d.tail_number}
      {mark}
    </a>
  ) : (
    <span className="font-mono text-secondary whitespace-nowrap">
      {d.tail_number}
      {mark}
    </span>
  );
}

function Stat({
  value,
  unit,
  children,
}: { value: string; unit?: string; children: React.ReactNode }) {
  return (
    <div>
      <StatValue unit={unit}>{value}</StatValue>
      <p className="mt-1.5 text-sm text-secondary text-pretty">{children}</p>
    </div>
  );
}

const departuresWord = (n: number) => (n === 1 ? "departure" : "departures");

function Stats({ board }: { board: AirportBoard }) {
  const { history, airport, today, tomorrow } = board;
  if (history.starlink === 0 && board.departures.length === 0 && !today?.departures) return null;
  const flown = history.starlink > 0;
  return (
    <Panel as="section" aria-label={`Starlink at ${airport}`} className={SECTION}>
      <div className={today && flown ? "grid gap-5 sm:grid-cols-3" : "grid gap-5 sm:grid-cols-2"}>
        {today && (
          <Stat value={fmt(today.departures)}>
            Starlink {departuresWord(today.departures)} today, {weekdayDate(today.date)}:{" "}
            {fmt(today.left)} gone, {fmt(today.toGo)} still to leave
            {today.rank !== null && (
              <>
                {" · "}
                <a href="/routes#airports" className={LINK}>
                  No. {fmt(today.rank)} of {fmt(today.ranked)} airports
                </a>
              </>
            )}
          </Stat>
        )}
        {tomorrow && (
          <Stat value={fmt(tomorrow.departures)}>
            Starlink {departuresWord(tomorrow.departures)} scheduled for tomorrow,{" "}
            {weekdayDate(tomorrow.date)}
          </Stat>
        )}
        {!today && (
          <Stat value={fmt(board.departures.length)}>
            Starlink {departuresWord(board.departures.length)} assigned in the next{" "}
            {board.windowHours} hours
          </Stat>
        )}
        {flown && (
          <Stat value={perDayLabel(history.starlink / history.days)} unit="a day">
            flown by Starlink planes: {fmt(history.starlink)} in the last {history.days} days
          </Stat>
        )}
      </div>
      {today && (
        <p className="mt-4 text-xs text-muted text-pretty">
          Counted by {airport}'s own calendar day, on planes we list as having Starlink. Today's
          figure adds those that already left to those still scheduled. Tomorrow's is the schedule
          as we hold it now: it reaches about two days ahead and is still being added to, so it can
          rise as the day nears. Planes are swapped before departure, and we hold no total of{" "}
          {airport}'s departures to set either against.
        </p>
      )}
    </Panel>
  );
}

function NextDepartures({ board, tailPages }: { board: AirportBoard; tailPages: boolean }) {
  const { airport, departures } = board;
  const shown = departures.slice(0, AIRPORT_NEXT_DEPARTURES);
  const more = departures.length - shown.length;
  const clock = board.localTimes
    ? `Times local to ${airportCity(airport) ?? airport}.`
    : `Times are in UTC: we hold no time zone for ${airport}.`;
  return (
    <Section
      id="departures"
      title="Next Starlink departures"
      dek={`${clock}${more > 0 ? ` The first ${fmt(shown.length)} of ${fmt(departures.length)}; every one is under its destination below.` : ""}`}
    >
      <DataTable>
        <thead>
          <tr>
            <Th>Leaves</Th>
            <Th>Flight</Th>
            <Th optional>Aircraft</Th>
            <Th numeric>Plane</Th>
          </tr>
        </thead>
        <tbody>
          {shown.map((d) => (
            <tr key={`${d.flight_number}-${d.departure_time}`} className="align-top">
              <Td className="pr-3">
                <div className="whitespace-nowrap text-primary">{d.time}</div>
                <div className="whitespace-nowrap text-xs text-muted">{d.day}</div>
              </Td>
              <Td className="pr-3">
                <a href={`/check-flight/${d.flight_number}`} className={FLIGHT_LINK}>
                  {d.flight_number}
                </a>{" "}
                <a href={`/route-planner/${airport}/${d.destination}`} className={ROW_LINK}>
                  to {d.destination}
                </a>
                {d.aircraft && <div className="text-xs text-muted sm:hidden">{d.aircraft}</div>}
              </Td>
              <Td optional className="pr-3 text-secondary">
                {d.aircraft ?? "—"}
              </Td>
              <Td numeric>
                <Plane d={d} tailPages={tailPages} />
              </Td>
            </tr>
          ))}
        </tbody>
      </DataTable>
    </Section>
  );
}

function DestinationRow({
  airport,
  row,
  max,
  days,
  tailPages,
}: {
  airport: string;
  row: AirportBoardDestination;
  max: number;
  days: number;
  tailPages: boolean;
}) {
  const n = row.departures.length;
  const label = `${airport} to ${row.destination}`;
  const facts = [
    airportPlaceName(row.destination),
    n > 0 ? `next ${row.departures[0].day}, ${row.departures[0].time}` : null,
    row.recent > 0 ? `${fmt(row.recent)} flown in the last ${days} days` : null,
  ].filter(Boolean);
  return (
    <li className="border-b border-subtle py-2.5 last:border-b-0">
      <div className="flex items-center gap-3 text-sm">
        {row.linkable ? (
          <a
            href={`/route-planner/${airport}/${row.destination}`}
            className={`w-28 ${FLIGHT_LINK}`}
          >
            {label}
          </a>
        ) : (
          <span className="w-28 font-mono text-primary">{label}</span>
        )}
        <Meter
          share={max > 0 ? n / max : 0}
          label={`${label}: ${fmt(n)} Starlink departures`}
          className="min-w-8 flex-1"
        />
        <span className="w-8 shrink-0 text-right font-semibold text-primary tabular-nums">
          {fmt(n)}
        </span>
      </div>
      {facts.length > 0 && <p className="mt-0.5 text-xs text-muted">{facts.join(" · ")}</p>}
      {n > 0 && (
        <details className="group mt-1">
          <summary className="cursor-pointer py-3 text-sm text-accent hover:underline">
            {n === 1 ? "Show the flight" : `Show the ${fmt(n)} flights`}
          </summary>
          <ul className="mt-1.5 space-y-1 text-sm">
            {row.departures.map((d) => (
              <li
                key={`${d.flight_number}-${d.departure_time}`}
                className="flex flex-wrap items-baseline gap-x-3"
              >
                <span className="text-secondary tabular-nums">
                  <span className="whitespace-nowrap">{d.day},</span>{" "}
                  <span className="whitespace-nowrap">{d.time}</span>
                </span>
                <a href={`/check-flight/${d.flight_number}`} className={FLIGHT_LINK}>
                  {d.flight_number}
                </a>
                {d.aircraft && <span className="text-muted">{d.aircraft}</span>}
                <Plane d={d} tailPages={tailPages} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

/** /routes/{airport}: the airport's Starlink departures in the live window,
 * soonest first and then by destination, with what flew from here lately. */
export default function AirportPage({
  site,
  board,
  updatedAt,
  pageLinks,
  currentPath,
}: AirportPageProps) {
  const { airport, place, departures, destinations, history } = board;
  const max = destinations[0]?.departures.length ?? 0;
  const anyVerified = departures.some((d) => d.starlink === "verified");
  return (
    <PageShell site={site} currentPath={currentPath} pageLinks={pageLinks}>
      <PageHeader title={`Which flights from ${place} have Starlink?`} dek={airportDek(board)} />

      <Stats board={board} />

      {departures.length > 0 && (
        <NextDepartures board={board} tailPages={site.features.tailPages} />
      )}

      {destinations.length > 0 && (
        <Section
          id="destinations"
          title={`Starlink flights from ${airport}, by destination`}
          dek={`Departures in the next ${board.windowHours} hours on a plane that has Starlink. Each route's page has the odds for every flight on it.`}
        >
          <ul>
            {destinations.map((row) => (
              <DestinationRow
                key={row.destination}
                airport={airport}
                row={row}
                max={max}
                days={history.days}
                tailPages={site.features.tailPages}
              />
            ))}
          </ul>
          <p className="mt-4 text-xs text-muted text-pretty">
            Counts only planes assigned so far, and planes can be swapped before departure.
            {anyVerified && ` ${VERIFIED_LEGEND}`}
            {updatedAt ? ` Data updated ${utcDateTime(updatedAt)}.` : ""}
          </p>
        </Section>
      )}

      <section className="relative mx-auto mb-8 w-full max-w-3xl text-center">
        <p className="text-sm text-secondary">
          <a href={`/route-planner?origin=${airport}`} className={LINK}>
            Plan a trip from {airport}
          </a>
          {" · "}
          <a href="/routes" className={LINK}>
            Every Starlink route
          </a>
        </p>
      </section>
    </PageShell>
  );
}
