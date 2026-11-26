import {
  AIRPORT_RANK_MIN_DEPARTURES,
  AIRPORT_RANK_OPEN_ROWS,
  type AirportRankRow,
  type AirportRanking,
} from "../api/airport-ranking";
import { Panel, SectionTitle, Td, Th } from "./layout";
import { fmt, monthDay, utcDateTime, weekdayDate } from "./ui/format";
import { Meter } from "./ui/meter";

const CODE_LINK = "font-mono text-primary hover:text-accent transition-colors";

function RankTable({
  rows,
  max,
  mainDate,
  head,
}: {
  rows: AirportRankRow[];
  max: number;
  mainDate: string | null;
  head: boolean;
}) {
  return (
    <table className="w-full text-sm">
      <thead className={head ? "" : "sr-only"}>
        <tr>
          <Th>
            <span className="sr-only">Rank</span>
          </Th>
          <Th>Airport</Th>
          <Th>Starlink departures</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.airport}>
            <Td className="w-7 pr-2 text-muted tabular-nums">{fmt(r.rank)}</Td>
            <Td className="pr-3">
              <a href={`/routes/${r.airport}`} className={CODE_LINK}>
                {r.airport}
              </a>
              {r.date !== mainDate && (
                <div className="whitespace-nowrap text-xs text-muted">{monthDay(r.date)}</div>
              )}
            </Td>
            <Td className="w-full">
              <div className="flex items-center gap-2">
                <span className="w-8 shrink-0 text-right font-semibold text-primary tabular-nums">
                  {fmt(r.departures)}
                </span>
                <Meter
                  share={max > 0 ? Math.max(0.03, r.departures / max) : 0}
                  label={`${r.airport}: ${fmt(r.departures)} Starlink departures`}
                  className="w-full min-w-8"
                />
              </div>
            </Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * /routes: every airport ranked by the Starlink departures scheduled for its
 * next local day.
 */
export function AirportRankingPanel({
  ranking,
  updatedAt,
}: { ranking: AirportRanking; updatedAt?: string | null }) {
  const { rows, unranked, date } = ranking;
  if (rows.length === 0 || !date) return null;
  const max = rows[0].departures;
  const open = rows.slice(0, AIRPORT_RANK_OPEN_ROWS);
  const rest = rows.slice(AIRPORT_RANK_OPEN_ROWS);
  const mixed = rows.some((r) => r.date !== date);
  return (
    <div id="airports" className="min-w-0 scroll-mt-4">
      <SectionTitle>Airports with the most Starlink departures</SectionTitle>
      <p className="mt-1 text-sm text-secondary text-pretty">
        {ranking.airline} departures scheduled on Starlink planes for {weekdayDate(date)}, each
        airport's own local day.
        {mixed && " An airport already past midnight shows its date."}
      </p>
      <Panel pad="sm" className="mt-4">
        <RankTable rows={open} max={max} mainDate={date} head />
        {(rest.length > 0 || unranked.length > 0) && (
          <details className="group mt-3">
            <summary className="cursor-pointer text-sm text-accent hover:underline">
              {rest.length > 0
                ? `Show all ${fmt(rows.length)} ranked airports`
                : `Show the ${fmt(unranked.length)} airports with fewer`}
            </summary>
            {rest.length > 0 && (
              <div className="mt-2">
                <RankTable rows={rest} max={max} mainDate={date} head={false} />
              </div>
            )}
            {unranked.length > 0 && (
              <p className="mt-3 text-sm text-secondary text-pretty">
                Under {fmt(AIRPORT_RANK_MIN_DEPARTURES)} that day, so not ranked:{" "}
                {unranked.map((airport, i) => (
                  <span key={airport}>
                    {i > 0 && ", "}
                    <a href={`/routes/${airport}`} className={CODE_LINK}>
                      {airport}
                    </a>
                  </span>
                ))}
                .
              </p>
            )}
          </details>
        )}
        <p className="mt-4 text-xs text-muted text-pretty">
          A count of departures scheduled on planes we list as having Starlink
          {updatedAt ? `, as we held the schedule at ${utcDateTime(updatedAt)}` : ""}. That schedule
          reaches about two days ahead and is still being added to, so a day's count can rise as the
          day nears. Planes are swapped before departure, so the day itself will differ. It is a
          count only: we hold no total of an airport's departures to set it against.
        </p>
      </Panel>
    </div>
  );
}
