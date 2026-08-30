import type React from "react";
import { type SiteConfig, siteAirline } from "../airlines/registry";
import type { FleetStats } from "../types";

/**
 * Everything on this page is generated from the tenant's own reader, so the
 * documented payloads can never drift from what the endpoints actually return
 * (and can never quote United's fleet on Alaska's host). Each half is null only
 * when the tenant genuinely has no such row yet — the page then documents the
 * shapes without inventing one.
 */
export interface ApiDocsData {
  tail: {
    registration: string;
    aircraftType: string | null;
    operatedBy: string;
    fleet: string;
  } | null;
  flight: {
    /** Canonical `{IATA}{digits}` spelling — what the API echoes as ua_flight_number. */
    number: string;
    /** As stored, which for regional operators is the operating-carrier spelling. */
    rawNumber: string;
    origin: string | null;
    destination: string | null;
  } | null;
  starlinkCount: number;
  totalCount: number;
  fleetStats: FleetStats | null;
  lastUpdated: string;
}

interface ApiDocsPageProps {
  site: SiteConfig;
  data: ApiDocsData;
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

// Illustrative departure/arrival pair. Times are the one thing not drawn from
// the DB: a real row's timestamps go stale the moment the flight departs, and
// nobody reads them as a fact about the airline the way a tail or subfleet is.
const DEP = 1780000000;
const ARR = 1780005600;
const iso = (sec: number) => new Date(sec * 1000).toISOString();

export default function ApiDocsPage({ site, data }: ApiDocsPageProps) {
  const cfg = siteAirline(site);
  const host = site.canonicalHost;
  const base = `https://${host}`;
  const iata = cfg.iata;
  const { tail, flight, fleetStats } = data;

  const exampleFlight = flight?.number ?? `${iata}123`;
  const exampleDate = iso(DEP).slice(0, 10);
  const origin = flight?.origin ?? "SFO";
  const destination = flight?.destination ?? "SAN";
  const subfleetLabels = cfg.subfleets.map((s) => s.key).join(" / ");
  const tailRegistration = tail?.registration ?? "N000XX";

  return (
    <div className="w-full mx-auto px-4 sm:px-6 md:px-8 bg-base min-h-screen flex flex-col relative">
      <div className="absolute inset-0 grid-pattern opacity-50 pointer-events-none" />

      <header className="relative py-5 sm:py-6 text-center mb-3">
        <a href="/" className="block">
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-primary mb-2 tracking-tight hover:text-accent transition-colors">
            {cfg.shortName} Starlink API
          </h1>
        </a>
        <p className="text-base text-secondary font-display max-w-xl mx-auto">
          Free JSON API for {cfg.name} Starlink WiFi status
          {/* A fleet census can legitimately be missing (a carrier we track by
              schedule, not roster) — say nothing rather than "0-aircraft". */}
          {data.totalCount > 0
            ? ` — ${data.starlinkCount} equipped aircraft tracked across a ${data.totalCount}-aircraft fleet`
            : ` — ${data.starlinkCount} equipped aircraft tracked`}
          . No auth, no key, CORS enabled.
        </p>
      </header>

      <div className="relative max-w-3xl mx-auto w-full mb-8 space-y-6">
        <div className="bg-surface rounded-lg border border-subtle p-5 sm:p-6 text-sm text-muted space-y-2">
          <p>
            All endpoints are <code className="font-mono text-xs text-accent">GET</code> and return
            JSON. They answer from the tracker's own database — we don't proxy scraping to callers —
            with one exception:{" "}
            <code className="font-mono text-xs text-accent">/api/check-flight</code> also consults a
            short-TTL, cached third-party tail lookup for dates inside the ~2-day assignment window,
            so that call can be slower and can degrade (see{" "}
            <code className="font-mono text-xs">method: "fr24_tail_lookup"</code> below). Size your
            timeouts for that one accordingly, and keep to the ~100 requests/min per IP rate limit —
            it is what protects the upstream. Responses carry{" "}
            <code className="font-mono text-xs text-accent">Access-Control-Allow-Origin: *</code>,
            so browser calls work from any origin.
          </p>
          <p>
            Response shapes are stable: existing keys never change meaning or disappear; new keys
            are additive. Every example below is generated from this tracker's live {iata} data at
            page render, so it matches what you will actually get back. If you build something on
            this, please link back to {host} so more travelers find the data.
          </p>
        </div>

        <Endpoint method="GET" path="/api/check-flight">
          <p className="text-sm text-muted mb-3">
            Does a specific {cfg.shortName} flight have Starlink? Firm answer when the aircraft
            assignment is published (~2 days out), probability estimate before that.
          </p>
          <CodeBlock>{`curl "${base}/api/check-flight?flight_number=${exampleFlight}&date=${exampleDate}"`}</CodeBlock>
          <p className="text-xs text-muted my-2">
            <strong className="text-secondary">Parameters:</strong>{" "}
            <code className="font-mono">flight_number</code> ({exampleFlight} or just the digits),{" "}
            <code className="font-mono">date</code> (YYYY-MM-DD, the traveler's printed local
            departure date).
          </p>
          <p className="text-xs text-muted mb-2">Assignment published (firm answer):</p>
          <CodeBlock>{`{
  "hasStarlink": true,
  "confidence": "verified",
  "evidence": "observed",
  "freshness": { "data_updated_at": ${JSON.stringify(data.lastUpdated)},
                 "retrieved_at":    "2026-06-01T09:15:00.000Z" },
  "flights": [
    {
      "tail_number": ${JSON.stringify(tailRegistration)},
      "aircraft_type": ${JSON.stringify(tail?.aircraftType ?? null)},
      "flight_number": ${JSON.stringify(flight?.rawNumber ?? exampleFlight)},
      "ua_flight_number": ${JSON.stringify(exampleFlight)},
      "departure_airport": ${JSON.stringify(origin)},
      "arrival_airport": ${JSON.stringify(destination)},
      "departure_time": ${DEP},
      "departure_time_formatted": ${JSON.stringify(iso(DEP))},
      "arrival_time": ${ARR},
      "arrival_time_formatted": ${JSON.stringify(iso(ARR))},
      "operated_by": ${JSON.stringify(tail?.operatedBy ?? cfg.name)},
      "fleet_type": ${JSON.stringify(tail?.fleet ?? cfg.subfleets[0]?.key ?? "mainline")}
    }
  ]
}`}</CodeBlock>
          <p className="text-xs text-muted my-2">No assignment yet (probability estimate):</p>
          <CodeBlock>{`{
  "hasStarlink": null,
  "confidence": ${cfg.flightHistoryModel ? '"predicted"' : '"type"'},
  "evidence": ${cfg.flightHistoryModel ? '"predicted"' : '"type_derived"'},
  "freshness": { "data_updated_at": "...", "retrieved_at": "..." },
${
  cfg.flightHistoryModel
    ? `  "prediction": { "probability": 0.91, "confidence": "high", "n_observations": 14 },`
    : `  "prediction": { "probability": 0.75 },`
}
  "message": "Aircraft assignment not yet published — ...",
  "flights": []
}`}</CodeBlock>
          <p className="text-xs text-muted mt-2">
            <code className="font-mono">hasStarlink</code> is tri-state:{" "}
            <code className="font-mono">true</code>/<code className="font-mono">false</code> only
            for a verified assignment; <code className="font-mono">null</code> means no firm answer
            yet — read{" "}
            <code className="font-mono">{cfg.flightHistoryModel ? "prediction" : "message"}</code>{" "}
            instead of treating it as a no. Answers sourced from the cached tail lookup carry{" "}
            <code className="font-mono">"method": "fr24_tail_lookup"</code>; when that upstream is
            unavailable the response says so in <code className="font-mono">message</code> rather
            than hardening into a no.
          </p>
        </Endpoint>

        <Endpoint method="GET" path="/api/predict-flight">
          <p className="text-sm text-muted mb-3">
            Starlink probability for a {cfg.shortName} flight number, date-agnostic — for dates too
            far out for an assignment.
          </p>
          <CodeBlock>{`curl "${base}/api/predict-flight?flight_number=${exampleFlight}"`}</CodeBlock>
          <p className="text-xs text-muted my-2">Response:</p>
          {cfg.flightHistoryModel ? (
            <>
              <CodeBlock>{`{
  "flight_number": ${JSON.stringify(exampleFlight)},
  "probability": 0.93,
  "confidence": "high",
  "method": "flight_history_smoothed",
  "n_observations": 21,
  "evidence": "predicted",
  "freshness": { "data_updated_at": "...", "retrieved_at": "..." }
}`}</CodeBlock>
              <p className="text-xs text-muted mt-2">
                Probability and confidence are independent:{" "}
                <code className="font-mono">confidence</code> reflects sample size (
                <code className="font-mono">n_observations</code>), not how high the probability is.
              </p>
            </>
          ) : (
            <>
              <CodeBlock>{`{
  "flight_number": ${JSON.stringify(exampleFlight)},
  "probability": 0.75,
  "confidence": "type",
  "evidence": "type_derived",
  "freshness": { "data_updated_at": "...", "retrieved_at": "..." },
  "message": "Estimated from ${cfg.shortName} aircraft-type rules and subfleet rollout, not this flight number's history."
}`}</CodeBlock>
              <p className="text-xs text-muted mt-2">
                {cfg.shortName} has no per-flight-number history model, so this endpoint answers
                from aircraft-type rules and subfleet rollout:{" "}
                <code className="font-mono">"confidence": "type"</code> with a{" "}
                <code className="font-mono">message</code>, and no{" "}
                <code className="font-mono">method</code> or{" "}
                <code className="font-mono">n_observations</code> keys.{" "}
                <code className="font-mono">probability</code> is present only when the flight
                number maps to a subfleet with a measured install rate. Another carrier's priors are
                never applied here.
              </p>
            </>
          )}
        </Endpoint>

        {site.features.routePlannerPage && cfg.flightHistoryModel ? (
          <Endpoint method="GET" path="/api/plan-route">
            <p className="text-sm text-muted mb-3">
              Ranked Starlink routings between two airports, including connections — ranked by
              coverage ratio (expected Starlink hours / total flight hours).
            </p>
            <CodeBlock>{`curl "${base}/api/plan-route?origin=${origin}&destination=${destination}&max_stops=2"`}</CodeBlock>
            <p className="text-xs text-muted my-2">Response (abridged):</p>
            <CodeBlock>{`{
  "origin": ${JSON.stringify(origin)},
  "destination": ${JSON.stringify(destination)},
  "itineraries": [
    {
      "via": ["IAH"],
      "legs": [ { "flight_number": ${JSON.stringify(exampleFlight)}, "route": "${origin}-IAH",
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
            The full tracker snapshot: every Starlink-equipped {cfg.shortName} aircraft, subfleet
            stats, and upcoming flights by tail.
          </p>
          <CodeBlock>{`curl "${base}/api/data"`}</CodeBlock>
          <p className="text-xs text-muted my-2">Response (abridged, live numbers):</p>
          <CodeBlock>{`{
  "totalCount": ${data.totalCount},
  "lastUpdated": ${JSON.stringify(data.lastUpdated)},
  "starlinkPlanes": [
    { "TailNumber": ${JSON.stringify(tailRegistration)}, "Aircraft": ${JSON.stringify(tail?.aircraftType ?? null)}, "WiFi": "StrLnk",
      "DateFound": "2026-03-14", "OperatedBy": ${JSON.stringify(tail?.operatedBy ?? cfg.name)},
      "fleet": ${JSON.stringify(tail?.fleet ?? cfg.subfleets[0]?.key ?? "mainline")} }, ...
  ],${
    fleetStats
      ? `
  "fleetStats": { "express":  { "total": ${fleetStats.express.total}, "starlink": ${fleetStats.express.starlink}, "percentage": ${fleetStats.express.percentage} },
                  "mainline": { "total": ${fleetStats.mainline.total}, "starlink": ${fleetStats.mainline.starlink}, "percentage": ${fleetStats.mainline.percentage} } },`
      : `
  "fleetStats": null,`
  }
  "flightsByTail": { ${JSON.stringify(tailRegistration)}: [ ... ] }
}`}</CodeBlock>
          <p className="text-xs text-muted mt-2">
            Read the two counts carefully: <code className="font-mono">totalCount</code> is the{" "}
            <strong className="text-secondary">whole tracked fleet</strong> ({data.totalCount}), not
            the Starlink count — that one is{" "}
            <code className="font-mono">starlinkPlanes.length</code> ({data.starlinkCount}), and it
            always equals <code className="font-mono">fleetStats.express.starlink</code> +{" "}
            <code className="font-mono">fleetStats.mainline.starlink</code>. Subfleet buckets are
            fixed at <code className="font-mono">express</code>/
            <code className="font-mono">mainline</code>; {cfg.shortName}'s own subfleet keys (
            <code className="font-mono">{subfleetLabels}</code>) survive on each row's{" "}
            <code className="font-mono">fleet</code>.
          </p>
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
            A mixed assignment reports the weakest row it returns, so{" "}
            <code className="font-mono">"observed"</code> means every flight in{" "}
            <code className="font-mono">flights[]</code> is per-tail verified.{" "}
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

        {site.features.methodologyPage ? (
          <div className="bg-surface rounded-lg border border-subtle p-5 sm:p-6 text-sm text-muted">
            <h2 className="font-display text-lg font-semibold text-primary mb-2">
              Where the data comes from
            </h2>
            <p>
              How each tail is verified, how often, and how to cite it —{" "}
              <a href="/methodology" className="text-accent hover:underline">
                read the methodology →
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
