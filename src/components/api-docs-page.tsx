import type React from "react";
import { type SiteConfig, siteAirline } from "../airlines/registry";

interface ApiDocsPageProps {
  site: SiteConfig;
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="bg-base rounded-lg border border-subtle p-4 overflow-x-auto text-xs font-mono text-secondary leading-relaxed">
      <code>{children}</code>
    </pre>
  );
}

function Endpoint({
  method,
  path,
  children,
}: {
  method: string;
  path: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-surface rounded-lg border border-subtle p-5 sm:p-6">
      <h2 className="font-display text-lg font-semibold text-primary mb-1">
        <span className="text-accent font-mono text-sm mr-2">{method}</span>
        <span className="font-mono text-base">{path}</span>
      </h2>
      {children}
    </div>
  );
}

export default function ApiDocsPage({ site }: ApiDocsPageProps) {
  const cfg = siteAirline(site);
  const host = site.canonicalHost;
  const base = `https://${host}`;
  const iata = cfg.iata;

  return (
    <div className="w-full mx-auto px-4 sm:px-6 md:px-8 bg-base min-h-screen flex flex-col relative">
      <div className="absolute inset-0 grid-pattern opacity-50 pointer-events-none" />

      <header className="relative py-5 sm:py-6 text-center mb-3">
        <a href="/" className="block">
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-primary mb-2 tracking-tight hover:text-accent transition-colors">
            Starlink Tracker API
          </h1>
        </a>
        <p className="text-base text-secondary font-display max-w-xl mx-auto">
          Free JSON API for {cfg.shortName} Starlink WiFi status — no auth, no key, CORS enabled.
        </p>
      </header>

      <div className="relative max-w-3xl mx-auto w-full mb-8 space-y-6">
        <div className="bg-surface rounded-lg border border-subtle p-5 sm:p-6 text-sm text-muted space-y-2">
          <p>
            All endpoints are <code className="font-mono text-xs text-accent">GET</code>, return
            JSON, and serve from the live tracker database (never live scraping in the request
            path). Rate limit: ~100 requests/min per IP. Responses carry{" "}
            <code className="font-mono text-xs text-accent">Access-Control-Allow-Origin: *</code>,
            so browser calls work from any origin.
          </p>
          <p>
            Response shapes are stable: existing keys never change meaning or disappear; new keys
            are additive. If you build something on this, please link back to {host} so more
            travelers find the data.
          </p>
        </div>

        <Endpoint method="GET" path="/api/check-flight">
          <p className="text-sm text-muted mb-3">
            Does a specific flight have Starlink? Firm answer when the aircraft assignment is
            published (~2 days out), probability estimate before that.
          </p>
          <CodeBlock>{`curl "${base}/api/check-flight?flight_number=${iata}123&date=2026-06-01"`}</CodeBlock>
          <p className="text-xs text-muted my-2">
            <strong className="text-secondary">Parameters:</strong>{" "}
            <code className="font-mono">flight_number</code> ({iata}123 or just the digits),{" "}
            <code className="font-mono">date</code> (YYYY-MM-DD, the traveler's printed local
            departure date).
          </p>
          <p className="text-xs text-muted mb-2">Assignment published (firm answer):</p>
          <CodeBlock>{`{
  "hasStarlink": true,
  "confidence": "verified",
  "evidence": "observed",
  "freshness": { "data_updated_at": "2026-05-30T14:02:11.000Z",
                 "retrieved_at":    "2026-06-01T09:15:00.000Z" },
  "flights": [
    {
      "tail_number": "N127SY",
      "aircraft_type": "Embraer E175",
      "flight_number": "${iata}123",
      "departure_airport": "SFO",
      "arrival_airport": "SAN",
      "departure_time": 1780000000,
      "departure_time_formatted": "2026-06-01T16:26:40.000Z",
      "arrival_time": 1780005600,
      "arrival_time_formatted": "2026-06-01T18:00:00.000Z",
      "operated_by": "SkyWest Airlines",
      "fleet_type": "express"
    }
  ]
}`}</CodeBlock>
          <p className="text-xs text-muted my-2">No assignment yet (probability estimate):</p>
          <CodeBlock>{`{
  "hasStarlink": null,
  "confidence": "predicted",
  "evidence": "predicted",
  "freshness": { "data_updated_at": "...", "retrieved_at": "..." },
  "prediction": { "probability": 0.91, "confidence": "high", "n_observations": 14 },
  "message": "Aircraft assignment not yet published — ...",
  "flights": []
}`}</CodeBlock>
          <p className="text-xs text-muted mt-2">
            <code className="font-mono">hasStarlink</code> is tri-state:{" "}
            <code className="font-mono">true</code>/<code className="font-mono">false</code> only
            for a verified assignment; <code className="font-mono">null</code> means no firm answer
            yet — read <code className="font-mono">prediction</code> instead of treating it as a no.
          </p>
        </Endpoint>

        <Endpoint method="GET" path="/api/predict-flight">
          <p className="text-sm text-muted mb-3">
            Starlink probability for a flight number, date-agnostic — for dates too far out for an
            assignment.
          </p>
          <CodeBlock>{`curl "${base}/api/predict-flight?flight_number=${iata}4680"`}</CodeBlock>
          <p className="text-xs text-muted my-2">Response:</p>
          <CodeBlock>{`{
  "flight_number": "${iata}4680",
  "probability": 0.93,
  "confidence": "high",
  "method": "flight_history_smoothed",
  "n_observations": 21,
  "evidence": "predicted",
  "freshness": { "data_updated_at": "...", "retrieved_at": "..." }
}`}</CodeBlock>
          <p className="text-xs text-muted mt-2">
            Probability and confidence are independent: confidence reflects sample size (
            <code className="font-mono">n_observations</code>), not how high the probability is.
            Carriers without a flight-history model answer from aircraft-type rules instead (
            <code className="font-mono">"confidence": "type"</code>, with a{" "}
            <code className="font-mono">message</code> and no{" "}
            <code className="font-mono">method</code>).
          </p>
        </Endpoint>

        {cfg.flightHistoryModel ? (
          <Endpoint method="GET" path="/api/plan-route">
            <p className="text-sm text-muted mb-3">
              Ranked Starlink routings between two airports, including connections — ranked by
              coverage ratio (expected Starlink hours / total flight hours).
            </p>
            <CodeBlock>{`curl "${base}/api/plan-route?origin=SFO&destination=JAX&max_stops=2"`}</CodeBlock>
            <p className="text-xs text-muted my-2">Response (abridged):</p>
            <CodeBlock>{`{
  "origin": "SFO",
  "destination": "JAX",
  "itineraries": [
    {
      "via": ["IAH"],
      "legs": [ { "flight_number": "${iata}1567", "route": "SFO-IAH",
                  "probability": 0.88, "confidence": "high",
                  "n_observations": 12, "duration_hours": 3.9 }, ... ],
      "joint_probability": 0.81,
      "coverage": "full",
      "total_flight_hours": 6.1,
      "expected_starlink_hours": 5.2,
      "coverage_ratio": 0.85
    }
  ]
}`}</CodeBlock>
            <p className="text-xs text-muted mt-2">
              Routings are probability-ranked, not bookable itineraries — connection timing is not
              validated.
            </p>
          </Endpoint>
        ) : null}

        <Endpoint method="GET" path="/api/data">
          <p className="text-sm text-muted mb-3">
            The full tracker snapshot: every Starlink-equipped aircraft, subfleet stats, and
            upcoming flights by tail.
          </p>
          <CodeBlock>{`curl "${base}/api/data"`}</CodeBlock>
          <p className="text-xs text-muted my-2">Response (abridged):</p>
          <CodeBlock>{`{
  "totalCount": 123,
  "lastUpdated": "2026-06-01 09:00 UTC",
  "starlinkPlanes": [
    { "TailNumber": "N127SY", "Aircraft": "Embraer E175", "WiFi": "StrLnk",
      "DateFound": "2026-03-14", "OperatedBy": "SkyWest Airlines",
      "fleet": "express" }, ...
  ],
  "fleetStats": { "express":  { "total": 500, "starlink": 400, "percentage": 80.0 },
                  "mainline": { "total": 900, "starlink": 150, "percentage": 16.7 } },
  "flightsByTail": { "N127SY": [ ... ] }
}`}</CodeBlock>
        </Endpoint>

        <div className="bg-surface rounded-lg border border-subtle p-5 sm:p-6">
          <h2 className="font-display text-lg font-semibold text-primary mb-3">Evidence classes</h2>
          <p className="text-sm text-muted mb-3">
            The additive <code className="font-mono text-xs text-accent">evidence</code> field says
            how strong the claim is, strongest first:
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-muted">
              <tbody>
                {[
                  ["observed", "per-tail verification against the airline's own systems, dated"],
                  ["fleet_data", "tracked as equipped in fleet data, not yet verified"],
                  ["type_derived", "determined by aircraft type (no per-tail signal)"],
                  ["predicted", "statistical estimate from flight history or fleet install rate"],
                  ["none", "no data — honest abstention, not a no"],
                ].map(([k, v]) => (
                  <tr key={k} className="border-t border-subtle">
                    <td className="py-1.5 pr-4 font-mono text-accent whitespace-nowrap">{k}</td>
                    <td className="py-1.5">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted mt-3">
            <code className="font-mono">freshness.data_updated_at</code> is the underlying data's
            own last-update stamp (null if never stamped) —{" "}
            <code className="font-mono">retrieved_at</code> is when the response was generated.
          </p>
        </div>

        {site.features.mcpPage ? (
          <div className="bg-surface rounded-lg border border-subtle p-5 sm:p-6 text-sm text-muted">
            <h2 className="font-display text-lg font-semibold text-primary mb-2">
              Using an AI assistant?
            </h2>
            <p>
              The same data is exposed over MCP at{" "}
              <code className="font-mono text-xs text-accent">{base}/mcp</code> — 7 tools with
              structured, provenance-tagged results.{" "}
              <a href="/mcp" className="text-accent hover:underline">
                Setup takes one URL →
              </a>
            </p>
          </div>
        ) : null}
      </div>

      <div className="relative text-center mb-6">
        <a href="/" className="text-sm text-accent hover:underline font-display">
          ← Back to {site.brand.title}
        </a>
      </div>

      <footer className="relative py-6 text-center border-t border-subtle text-muted text-sm">
        <a
          href="https://x.com/martinamps"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center text-secondary hover:text-primary transition-colors"
        >
          Built with
          <svg
            className="w-4 h-4 mx-1 text-red-400"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-label="Heart"
            role="img"
          >
            <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
          </svg>
          by @martinamps
        </a>
      </footer>
    </div>
  );
}
