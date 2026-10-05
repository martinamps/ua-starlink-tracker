import { liveAirlineSites } from "../airlines/registry";
import { Eyebrow, LINK, Panel } from "./layout";

/**
 * The hub's hand-off to each airline's own tracker, worded as the questions
 * people search. The hub ranked above unitedstarlinktracker.com for United's
 * own questions; these links say which site answers them.
 */
export function TrackerLinks() {
  const trackers = liveAirlineSites();
  if (trackers.length === 0) return null;
  const names = trackers.map((t) => t.airline.shortName);
  const flying =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
  return (
    <Panel as="nav" aria-label="Airline Starlink trackers">
      <Eyebrow as="h2">Flying {flying}?</Eyebrow>
      <div className="grid gap-4 sm:grid-cols-2">
        {trackers.map(({ site, airline }) => {
          const base = `https://${site.canonicalHost}`;
          return (
            <div key={airline.code}>
              <a href={`${base}/`} className={`${LINK} font-semibold`}>
                {`${airline.shortName} Starlink Tracker`}
              </a>
              <ul className="mt-1 space-y-1 text-sm">
                {site.features.checkFlightPage && (
                  <li>
                    <a href={`${base}/check-flight`} className={LINK}>
                      {`Does my ${airline.shortName} flight have Starlink?`}
                    </a>
                  </li>
                )}
                {site.features.fleetPage && (
                  <li>
                    <a href={`${base}/fleet`} className={LINK}>
                      {`Which ${airline.shortName} planes have Starlink?`}
                    </a>
                  </li>
                )}
              </ul>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
