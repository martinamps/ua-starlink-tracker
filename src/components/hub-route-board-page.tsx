import type { SiteConfig } from "../airlines/registry";
import type { HubRouteBoard, HubRouteRow } from "../api/hub-route-board";
import { airportCityWithCode, routePairLabel } from "../utils/airport-places";
import { AIRPORT_QUERY_MAX } from "../utils/airport-search";
import { FIELD_CLASS } from "./flight-search-form";
import {
  ClientScriptTag,
  DataTable,
  LINK,
  type Link,
  PageHeader,
  PageShell,
  Section,
  Td,
  Th,
  buttonClass,
} from "./layout";
import { oddsCellHtml } from "./odds-history";
import {
  VERIFIED_LEGEND,
  assignmentPill,
  emptyBoardMessage,
  rowMarker,
} from "./route-flights-copy";
import { fmt } from "./ui/format";
import { Pill } from "./ui/tone";

/** A typed airport that matched several, with the codes to choose from. */
export interface AirportChoice {
  side: "from" | "to";
  typed: string;
  matches: Array<{ code: string; name: string; href: string }>;
}

export interface RouteSearchValues {
  from: string;
  to: string;
  date: string;
}

const LABEL = "mb-1 block text-xs text-muted";

/** The caveat every airline's board note ends on, said once under the table. */
const SWAP_NOTE = "Planes can be swapped before departure.";
const sourceOf = (note: string) =>
  note.endsWith(SWAP_NOTE) ? note.slice(0, -SWAP_NOTE.length).trim() : note;

export function HubRouteSearchForm({
  values,
  id = "hub-route-board",
}: {
  values: RouteSearchValues;
  id?: string;
}) {
  return (
    <form
      id={id}
      method="get"
      action="/routes/"
      className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end"
      aria-label="Flights between two airports"
    >
      <label className={LABEL} htmlFor={`${id}-from`}>
        From
        <input
          id={`${id}-from`}
          name="from"
          type="text"
          required
          autoComplete="off"
          maxLength={AIRPORT_QUERY_MAX}
          placeholder="SFO or San Francisco"
          defaultValue={values.from}
          className={`${FIELD_CLASS} mt-1`}
        />
      </label>{" "}
      <label className={LABEL} htmlFor={`${id}-to`}>
        To
        <input
          id={`${id}-to`}
          name="to"
          type="text"
          required
          autoComplete="off"
          maxLength={AIRPORT_QUERY_MAX}
          placeholder="HNL or Honolulu"
          defaultValue={values.to}
          className={`${FIELD_CLASS} mt-1`}
        />
      </label>{" "}
      <label className={LABEL} htmlFor={`${id}-date`}>
        Date (optional)
        <input
          id={`${id}-date`}
          name="date"
          type="date"
          defaultValue={values.date || undefined}
          className={`${FIELD_CLASS} mt-1`}
        />
      </label>{" "}
      <button type="submit" className={`${buttonClass()} min-h-11`}>
        Show flights
      </button>
    </form>
  );
}

function FlightCell({ r, board }: { r: HubRouteRow; board: HubRouteBoard }) {
  const { row } = r;
  const pill = assignmentPill(row);
  const own = board.airlines.find((a) => a.code === r.airline)?.board;
  const marker = own ? rowMarker(row, own) : null;
  return (
    <Td className="pr-3">
      {r.page ? (
        <a href={r.page} className="font-mono text-primary hover:text-accent transition-colors">
          {row.flight_number}
        </a>
      ) : (
        <span className="font-mono text-primary">{row.flight_number}</span>
      )}
      {row.departure_label && <span className="text-muted"> · {row.departure_label}</span>}
      <span className="block text-xs text-secondary">
        {r.airlineName}
        {row.aircraft_types[0] && (
          <span className="text-muted sm:hidden"> · {row.aircraft_types[0]}</span>
        )}
        {marker && <span className="text-muted"> · {marker}</span>}
      </span>
      {pill && " "}
      {pill && (
        <div className="mt-1">
          <Pill tone={row.assignment?.starlink === "none" ? "neutral" : "success"}>{pill}</Pill>
        </div>
      )}
    </Td>
  );
}

function boardDek(board: HubRouteBoard, airlinesWithFlights: string[]): string {
  const n = board.rows.length;
  const who =
    airlinesWithFlights.length === 1
      ? airlinesWithFlights[0]
      : `${airlinesWithFlights.slice(0, -1).join(", ")} and ${airlinesWithFlights.at(-1)}`;
  const times = board.utc_times ? "Times in UTC" : `Times local to ${board.origin}`;
  return `${fmt(n)} ${who} nonstop${n === 1 ? "" : "s"} seen on this route in the past week, best Starlink odds first. ${times}.`;
}

export default function HubRouteBoardPage({
  site,
  board,
  values,
  choices = [],
  sameAirport,
  reverseLinkable = false,
  pageLinks,
  currentPath,
}: {
  site: SiteConfig;
  /** Absent on the bare search, or when a typed airport needs choosing. */
  board?: HubRouteBoard;
  values: RouteSearchValues;
  choices?: AirportChoice[];
  /** Both boxes settled to this one airport. */
  sameAirport?: string;
  /** The way back has a page of its own. */
  reverseLinkable?: boolean;
  pageLinks?: Link[];
  currentPath?: string;
}) {
  const title = board
    ? `Which ${routePairLabel(board.origin, board.destination).replaceAll(" (", " (")} flights have Starlink?`
    : "Starlink on every flight between two airports";
  const withFlights = board?.airlines.filter((a) => a.board.flights.length > 0) ?? [];
  const without = board?.airlines.filter((a) => a.board.flights.length === 0) ?? [];
  const verified = board?.rows.some((r) => r.row.assignment?.starlink === "verified");
  return (
    <PageShell site={site} currentPath={currentPath} pageLinks={pageLinks}>
      <PageHeader
        title={title}
        dek="Every nonstop we track between two airports, across airlines, each with the Starlink answer its airline's own tracker gives."
      />

      <section className="relative mx-auto mb-8 w-full max-w-3xl">
        <HubRouteSearchForm values={values} />
        {sameAirport && (
          <p className="mt-3 text-sm text-secondary">
            Both boxes name the same airport ({sameAirport}). Pick a different airport for one of
            them.
          </p>
        )}
        {choices.map((c) => (
          <p key={c.side} className="mt-3 text-sm text-secondary">
            {c.matches.length > 0 ? (
              <>
                Several airports match “{c.typed}”:{" "}
                {c.matches.map((m, i) => (
                  <span key={m.code}>
                    {i > 0 && " · "}
                    <a href={m.href} className={LINK}>
                      {m.name} ({m.code})
                    </a>
                  </span>
                ))}
              </>
            ) : (
              <>No airport matches “{c.typed}”. Try its three-letter code.</>
            )}
          </p>
        ))}
      </section>

      {board && (
        <Section
          id="all-flights"
          title="Nonstop flights"
          dek={
            withFlights.length > 0
              ? boardDek(
                  board,
                  withFlights.map((a) => a.shortName)
                )
              : undefined
          }
        >
          {board.rows.length === 0 ? (
            <p className="text-sm text-secondary">
              {board.airlines[0] ? emptyBoardMessage(board.airlines[0].board) : null}
            </p>
          ) : (
            <DataTable>
              <thead>
                <tr>
                  <Th>Flight</Th>
                  <Th optional>Aircraft</Th>
                  <Th numeric>Odds</Th>
                </tr>
              </thead>
              <tbody>
                {board.rows.map((r) => (
                  <tr key={r.row.flight_number} className="align-top">
                    <FlightCell r={r} board={board} />
                    <Td optional className="pr-3 text-secondary">
                      {r.row.aircraft_types.length ? r.row.aircraft_types.join(", ") : "—"}
                    </Td>
                    <Td numeric>
                      <div
                        // biome-ignore lint/security/noDangerouslySetInnerHtml: oddsCellHtml escapes every value; the airline route pages draw the same cell
                        dangerouslySetInnerHTML={{ __html: oddsCellHtml(r.row) }}
                      />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}{" "}
          <div className="mt-4 space-y-1 text-xs text-muted">
            {withFlights.map((a) => (
              <p key={a.code}>
                {a.shortName}: {sourceOf(a.board.note)}
                {a.routePage && (
                  <>
                    {" "}
                    <a href={a.routePage} className={LINK}>
                      {a.shortName} connections →
                    </a>
                  </>
                )}
              </p>
            ))}
            {without.length > 0 && withFlights.length > 0 && (
              <p>
                No {without.map((a) => a.shortName).join(" or ")} nonstop seen on this route this
                week.
              </p>
            )}
            {withFlights.some((a) => a.board.note.endsWith(SWAP_NOTE)) && <p>{SWAP_NOTE}</p>}
            {verified && <p>{VERIFIED_LEGEND}</p>}
            <p>
              Other airlines are not answered flight by flight.{" "}
              <a href="/airlines" className={LINK}>
                Their Starlink status, dated →
              </a>
            </p>
          </div>
          {board.rows.some((r) => r.row.history) && <ClientScriptTag name="route-board" />}
        </Section>
      )}

      {board && reverseLinkable && (
        <section className="relative mx-auto mb-8 w-full max-w-3xl text-center">
          <p className="text-sm text-secondary">
            <a href={`/routes/${board.destination}-${board.origin}`} className={LINK}>
              {airportCityWithCode(board.destination)} to {airportCityWithCode(board.origin)}
            </a>
          </p>
        </section>
      )}
    </PageShell>
  );
}
