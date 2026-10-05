import type React from "react";
import type { RouteFlightBoard, RouteFlightRow } from "../api/route-flights";
import { FIELD_CLASS } from "./flight-search-form";
import { LINK, Section, Td, Th, buttonClass } from "./layout";
import {
  VERIFIED_LEGEND,
  assignmentPill,
  boardDek,
  emptyBoardMessage,
  hasVerifiedRow,
  oddsCell,
  oddsDetail,
  oddsTone,
  rowMarker,
} from "./route-flights-copy";
import { Pill, TONE_TEXT } from "./ui/tone";

function FlightCell({ row, board }: { row: RouteFlightRow; board: RouteFlightBoard }) {
  const pill = assignmentPill(row);
  const marker = rowMarker(row, board);
  return (
    <Td className="pr-3">
      <a
        href={`/check-flight/${row.flight_number}`}
        className="font-mono text-primary hover:text-accent transition-colors"
      >
        {row.flight_number}
      </a>
      {row.departure_label && <span className="text-muted"> · {row.departure_label}</span>}
      {row.aircraft_types[0] && (
        <span className="text-muted sm:hidden"> · {row.aircraft_types[0]}</span>
      )}
      {marker && <span className="text-xs text-muted"> · {marker}</span>}
      {pill && (
        <div className="mt-1">
          <Pill tone={row.assignment?.starlink === "none" ? "neutral" : "success"}>{pill}</Pill>
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
  footerAction,
}: {
  board: RouteFlightBoard;
  /** The page's own path, which the date form GETs. */
  path: string;
  plannerHref: string;
  /** Rendered after the note: the slot for a per-route action (e.g. alerts). */
  footerAction?: React.ReactNode;
}) {
  const empty = emptyBoardMessage(board);
  return (
    <Section id="all-flights" title="Nonstop flights" dek={empty ? undefined : boardDek(board)}>
      {board.nonstop && (
        <form
          method="get"
          action={path}
          className="mb-4 flex flex-wrap items-end gap-2"
          aria-label="Filter by date"
        >
          <label className="text-xs text-muted" htmlFor="board-date">
            Date
            <input
              id="board-date"
              type="date"
              name="date"
              defaultValue={board.date ?? undefined}
              className={`${FIELD_CLASS} mt-1 sm:w-auto`}
            />
          </label>
          <button type="submit" className={buttonClass("secondary", "sm")}>
            Filter
          </button>
          {board.date && (
            <a href={path} className={`text-xs ${LINK}`}>
              Clear
            </a>
          )}
        </form>
      )}
      {empty ? (
        <p className="text-sm text-secondary">
          {empty}{" "}
          <a href={plannerHref} className={LINK}>
            Compare connections
          </a>
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr>
              <Th>Flight</Th>
              <Th optional>Aircraft</Th>
              <Th numeric>Odds</Th>
            </tr>
          </thead>
          <tbody>
            {board.flights.map((row) => (
              <tr key={row.flight_number} className="align-top">
                <FlightCell row={row} board={board} />
                <Td optional className="pr-3 text-secondary">
                  {row.aircraft_types.length ? row.aircraft_types.join(", ") : "—"}
                </Td>
                <Td numeric>
                  <div className={`whitespace-nowrap font-display ${TONE_TEXT[oddsTone(row)]}`}>
                    {oddsCell(row)}
                  </div>
                  <div className="text-xs text-muted">{oddsDetail(row)}</div>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-4 text-xs text-muted">
        {board.note}
        {hasVerifiedRow(board) && ` ${VERIFIED_LEGEND}`}
        {footerAction && <> {footerAction}</>}
      </p>
    </Section>
  );
}
