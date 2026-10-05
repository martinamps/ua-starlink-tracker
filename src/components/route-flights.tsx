import type { RouteFlightBoard, RouteFlightRow } from "../api/route-flights";
import { FIELD_CLASS } from "./flight-search-form";
import { LINK, Section, Td, Th, buttonClass } from "./layout";
import {
  ASSIGNMENT_CAVEAT,
  assignmentTone,
  boardDek,
  emptyBoardMessage,
  oddsDetail,
  oddsTone,
} from "./route-flights-copy";
import { Pill, TONE_TEXT } from "./ui/tone";

function FlightCell({ row }: { row: RouteFlightRow }) {
  return (
    <Td className="pr-3">
      <a
        href={`/check-flight/${row.flight_number}`}
        className="font-mono text-primary hover:text-accent transition-colors"
      >
        {row.flight_number}
      </a>
      <span className="whitespace-nowrap text-muted">
        {" "}
        · {row.typical_departure ? `usually ${row.typical_departure}` : "time not logged"}
      </span>
      {row.assignment && (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-secondary">
          <Pill tone={assignmentTone(row)}>{row.assignment.label}</Pill>
          <span className="text-muted">{ASSIGNMENT_CAVEAT}</span>
        </div>
      )}
    </Td>
  );
}

/** The nonstop board: every flight on the pair, best Starlink odds first. */
export function RouteFlightsSection({
  board,
  path,
  plannerHref,
}: {
  board: RouteFlightBoard;
  /** The page's own path, which the date form GETs. */
  path: string;
  plannerHref: string;
}) {
  const empty = emptyBoardMessage(board);
  return (
    <Section id="all-flights" title="All nonstop flights" dek={boardDek(board)}>
      {board.nonstop && (
        <form
          method="get"
          action={path}
          className="mb-4 flex flex-wrap items-end gap-2"
          aria-label="Filter by travel date"
        >
          <label className="text-xs text-muted" htmlFor="board-date">
            Travel date (optional)
            <input
              id="board-date"
              type="date"
              name="date"
              defaultValue={board.date ?? undefined}
              className={`${FIELD_CLASS} mt-1 sm:w-auto`}
            />
          </label>
          <button type="submit" className={buttonClass("secondary", "sm")}>
            Show flights that day
          </button>
          {board.date && (
            <a href={path} className={`text-xs ${LINK}`}>
              Clear date
            </a>
          )}
        </form>
      )}
      {empty ? (
        <p className="text-sm text-secondary text-pretty">
          {empty}{" "}
          <a href={plannerHref} className={LINK}>
            Compare connections
          </a>
          .
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr>
              <Th>Flight</Th>
              <Th optional>Usually flies</Th>
              <Th numeric>Starlink odds</Th>
            </tr>
          </thead>
          <tbody>
            {board.flights.map((row) => (
              <tr key={row.flight_number} className="align-top">
                <FlightCell row={row} />
                <Td optional className="pr-3 text-secondary">
                  {row.aircraft_types.length ? row.aircraft_types.join(", ") : "—"}
                </Td>
                <Td numeric>
                  <div className={`whitespace-nowrap font-display ${TONE_TEXT[oddsTone(row)]}`}>
                    {row.odds_label}
                  </div>
                  <div className="text-xs text-muted">{oddsDetail(row)}</div>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-4 text-xs text-muted text-pretty">{board.note}</p>
    </Section>
  );
}
