import React from "react";
import { type SiteConfig, siteAirline } from "../airlines/registry";
import type { PageLink } from "./atoms";
import { Chip, Eyebrow, PageHeader, PageShell, Panel, SectionTitle, buttonClass } from "./layout";

interface RoutePlannerPageProps {
  site: SiteConfig;
  pageLinks?: PageLink[];
  currentPath?: string;
  popularRoutes?: Array<{ origin: string; destination: string }>;
}

export default function RoutePlannerPage({
  site,
  pageLinks,
  currentPath,
  popularRoutes = [],
}: RoutePlannerPageProps) {
  const cfg = siteAirline(site);
  const airlineName = cfg.name;
  const shortName = cfg.shortName;

  return (
    <PageShell site={site} currentPath={currentPath} pageLinks={pageLinks}>
      <style
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static CSS, no user input
        dangerouslySetInnerHTML={{
          __html: `
        .flight-path {
          position: relative;
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }
        .flight-path__node {
          flex-shrink: 0;
          width: 10px;
          height: 10px;
          border-radius: 50%;
          border: 2px solid currentColor;
          background: var(--color-base);
          position: relative;
          z-index: 1;
        }
        .flight-path__node--filled {
          background: currentColor;
        }
        .flight-path__line {
          flex: 1;
          height: 2px;
          background: currentColor;
          position: relative;
          opacity: 0.4;
        }
        .flight-path__line--live::after {
          content: '';
          position: absolute;
          width: 20px;
          height: 2px;
          background: linear-gradient(90deg, transparent, currentColor, transparent);
          animation: signal-pulse 2.5s linear infinite;
          left: -20px;
        }
        @keyframes signal-pulse {
          0% { left: -20px; opacity: 0; }
          10% { opacity: 1; }
          90% { opacity: 1; }
          100% { left: 100%; opacity: 0; }
        }
        .prob-bars {
          display: inline-flex;
          gap: 2px;
          align-items: flex-end;
          height: 14px;
        }
        .prob-bars__bar {
          width: 3px;
          background: currentColor;
          border-radius: 1px;
          transition: opacity 0.3s;
        }
        .prob-bars__bar:nth-child(1) { height: 40%; }
        .prob-bars__bar:nth-child(2) { height: 55%; }
        .prob-bars__bar:nth-child(3) { height: 70%; }
        .prob-bars__bar:nth-child(4) { height: 85%; }
        .prob-bars__bar:nth-child(5) { height: 100%; }
        .prob-bars__bar--off { opacity: 0.15; }
        @keyframes itin-enter {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .itin-card {
          animation: itin-enter 0.4s ease-out both;
        }
        .itin-card:nth-child(1) { animation-delay: 0.05s; }
        .itin-card:nth-child(2) { animation-delay: 0.1s; }
        .itin-card:nth-child(3) { animation-delay: 0.15s; }
        .itin-card:nth-child(4) { animation-delay: 0.2s; }
        .itin-card:nth-child(5) { animation-delay: 0.25s; }
        .itin-card:nth-child(6) { animation-delay: 0.3s; }
        .itin-card:nth-child(7) { animation-delay: 0.35s; }
        .itin-card:nth-child(8) { animation-delay: 0.4s; }
        .airport-input {
          text-transform: uppercase;
          letter-spacing: 0.15em;
          text-align: center;
          font-weight: 600;
        }
        .airport-input::placeholder {
          text-transform: none;
          letter-spacing: normal;
          font-weight: 400;
        }
      `,
        }}
      />

      <PageHeader
        title="Find the flights most likely to have Starlink"
        dek={<>Search {airlineName} nonstops and connections between any two airports.</>}
      />

      <div className="relative max-w-2xl mx-auto w-full mb-8">
        <Panel className="glow-accent">
          <form id="route-form" className="space-y-4">
            <div className="flex flex-col sm:flex-row gap-4 items-end">
              <div className="flex-1">
                <Eyebrow as="label" htmlFor="origin" className="mb-2 block">
                  From
                </Eyebrow>
                <input
                  type="text"
                  id="origin"
                  name="origin"
                  placeholder="SFO"
                  maxLength={4}
                  className="airport-input w-full bg-base border border-subtle rounded px-3 py-3 text-primary font-mono text-lg focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
                  required
                  autoComplete="off"
                />
              </div>

              <div className="hidden sm:flex items-center pb-3 text-muted">
                <svg
                  width="32"
                  height="12"
                  viewBox="0 0 32 12"
                  fill="none"
                  role="img"
                  aria-label="to"
                >
                  <path d="M0 6h28M24 2l6 4-6 4" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </div>

              <div className="flex-1">
                <Eyebrow as="label" htmlFor="destination" className="mb-2 block">
                  To
                </Eyebrow>
                <input
                  type="text"
                  id="destination"
                  name="destination"
                  placeholder="JAX"
                  maxLength={4}
                  className="airport-input w-full bg-base border border-subtle rounded px-3 py-3 text-primary font-mono text-lg focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
                  required
                  autoComplete="off"
                />
              </div>
            </div>
            <button type="submit" className={`${buttonClass("primary", "lg")} w-full`}>
              Find flights
            </button>
          </form>
          <p className="text-xs text-muted mt-3 text-center">
            Ranked by the odds of Starlink on each leg.
          </p>
        </Panel>
      </div>

      <div id="route-results" className="relative max-w-3xl mx-auto w-full mb-10" />

      <div className="relative max-w-2xl mx-auto w-full mb-10">
        <Panel>
          <SectionTitle className="mb-3">How it works</SectionTitle>
          <div className="space-y-3 text-sm text-secondary leading-relaxed">
            <p>
              Odds come from which aircraft each {shortName} flight has used recently. A connection
              can beat the nonstop when the nonstop usually gets an aircraft without Starlink.
            </p>
            <p>
              Aircraft can change.{" "}
              <a href="/check-flight" className="text-accent hover:underline">
                Check your flight
              </a>{" "}
              1–2 days out to confirm.
            </p>
          </div>
        </Panel>
      </div>

      {popularRoutes.length > 0 && (
        <section className="relative w-full max-w-4xl mx-auto mb-8">
          <Panel>
            <SectionTitle className="mb-3">Popular Starlink routes</SectionTitle>
            <div className="flex flex-wrap gap-2">
              {popularRoutes.map((r) => (
                <Chip
                  key={`${r.origin}-${r.destination}`}
                  href={`/route-planner/${r.origin}/${r.destination}`}
                >
                  {r.origin} → {r.destination}
                </Chip>
              ))}
            </div>
          </Panel>
        </section>
      )}

      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static inline script, no user input
        dangerouslySetInnerHTML={{
          __html: `
        document.addEventListener('DOMContentLoaded', function() {
          var form = document.getElementById('route-form');
          var resultsDiv = document.getElementById('route-results');
          var originInput = document.getElementById('origin');
          var destInput = document.getElementById('destination');

          // Query params, not /route-planner/O/D: that path is the route page,
          // and it 404s for pairs without data, so a reload lost the search.
          var params = new URLSearchParams(window.location.search);
          if (params.get('origin') && params.get('destination')) {
            originInput.value = params.get('origin');
            destInput.value = params.get('destination');
          }

          function probBars(prob, color) {
            var filled = Math.max(1, Math.round(prob * 5));
            var html = '<span class="prob-bars" style="color:' + color + '">';
            for (var i = 1; i <= 5; i++) {
              html += '<span class="prob-bars__bar' + (i > filled ? ' prob-bars__bar--off' : '') + '"></span>';
            }
            return html + '</span>';
          }

          function probColor(p) {
            return p >= 0.7 ? 'var(--color-success)' : p >= 0.4 ? 'var(--color-warn)' : 'var(--color-neutral)';
          }

          function renderLeg(leg, isPositioning) {
            var pct = Math.round(leg.probability * 100);
            var color = probColor(leg.probability);
            var parts = leg.route.split('-');
            if (isPositioning) {
              return '<div class="flex items-center justify-between py-2 border-l-2 border-subtle pl-3 ml-1">' +
                '<div class="text-sm">' +
                '<div class="font-mono text-muted">' + parts[0] + ' → ' + parts[1] + '</div>' +
                '<div class="text-xs text-muted">Any flight works for this leg</div>' +
                '</div>' +
                '<div class="flex items-center gap-2">' +
                probBars(leg.probability, color) +
                '<span class="text-xs w-10 text-right tabular-nums" style="color:' + color + '">' + pct + '%</span>' +
                '</div>' +
                '</div>';
            }
            var conf = leg.confidence === 'high' ? '' : ' · ' + leg.confidence + ' confidence';
            return '<div class="flex items-center justify-between py-2 border-l-2 pl-3 ml-1" style="border-color:' + color + '">' +
              '<div class="text-sm">' +
              '<div class="font-mono text-secondary">' + leg.flight_number + ' <span class="text-muted">' + parts[0] + ' → ' + parts[1] + '</span></div>' +
              '<div class="text-xs text-muted">Based on ' + leg.n_observations + ' check' + (leg.n_observations === 1 ? '' : 's') + conf + '</div>' +
              '</div>' +
              '<div class="flex items-center gap-2">' +
              probBars(leg.probability, color) +
              '<span class="text-xs w-10 text-right tabular-nums" style="color:' + color + '">' + pct + '%</span>' +
              '</div>' +
              '</div>';
          }

          function renderItinerary(it, rank) {
            var jointPct = Math.round(it.joint_probability * 100);
            var atLeastPct = Math.round(it.at_least_one_probability * 100);
            var isFull = it.coverage === 'full';
            var legs = it.legs;
            var via = it.via || [];
            var nStops = via.length;
            var isDirect = nStops === 0;
            var origCode = legs[0].route.split('-')[0];
            var destCode = legs[legs.length - 1].route.split('-')[1];

            var pathParts = ['<div class="flight-path">'];
            for (var li = 0; li < legs.length; li++) {
              var leg = legs[li];
              var color = probColor(leg.probability);
              var live = leg.probability >= 0.7;
              if (li === 0) {
                pathParts.push('<span class="flight-path__node flight-path__node--filled" style="color:' + color + '"></span>');
              }
              pathParts.push('<span class="flight-path__line' + (live ? ' flight-path__line--live' : '') + '" style="color:' + color + '"></span>');
              var isLast = li === legs.length - 1;
              var nodeFilled = isLast ? ' flight-path__node--filled' : '';
              var nodeColor = isLast ? color : (live && legs[li+1].probability >= 0.7 ? 'var(--color-success)' : 'var(--color-neutral)');
              pathParts.push('<span class="flight-path__node' + nodeFilled + '" style="color:' + nodeColor + '"></span>');
            }
            pathParts.push('</div>');
            var pathHtml = pathParts.join('');

            var headerPct = isFull ? jointPct : atLeastPct;
            var headerLabel = isFull ? (isDirect ? 'Starlink' : 'all legs') : 'final leg Starlink';
            var headerColor = probColor(isFull ? it.joint_probability : legs[legs.length-1].probability);
            var legsHtml = legs.map(function(l) {
              return renderLeg(l, l.flight_number === '(any)');
            }).join('');

            var flyingStr = typeof it.total_flight_hours === 'number' ? ' · ' + fmtHours(it.total_flight_hours) + ' flying' : '';
            var badge = isDirect
              ? '<span class="text-xs text-accent">Nonstop</span>'
              : '<span class="text-xs text-muted">via <span class="font-mono">' + via.join('→') + '</span> · ' + nStops + ' stop' + (nStops>1?'s':'') + flyingStr + '</span>';

            var airportLabels = '<span>' + origCode + '</span>';
            for (var vi = 0; vi < via.length; vi++) {
              airportLabels += '<span class="text-center flex-1">' + via[vi] + '</span>';
            }
            if (via.length === 0) airportLabels += '<span class="flex-1"></span>';
            airportLabels += '<span>' + destCode + '</span>';

            return '<div class="itin-card bg-surface border border-subtle rounded-lg p-4 mb-3 hover:border-accent/50 transition-colors">' +
              '<div class="flex items-center justify-between mb-3">' +
              '<div class="flex items-center gap-3">' +
              '<span class="text-xs text-muted tabular-nums">#' + rank + '</span>' +
              badge +
              '</div>' +
              '<div class="font-display text-right" style="color:' + headerColor + '">' +
              headerPct + '% <span class="text-xs text-muted font-normal">' + headerLabel + '</span>' +
              '</div>' +
              '</div>' +
              '<div class="mb-3">' +
              '<div class="flex items-center gap-2 text-xs font-mono text-muted mb-1">' +
              airportLabels +
              '</div>' +
              pathHtml +
              '</div>' +
              '<div class="space-y-1">' + legsHtml + '</div>' +
              '</div>';
          }

          function fmtHours(h) {
            return h >= 1 ? h.toFixed(1) + 'h' : Math.round(h * 60) + 'm';
          }

          // The nonstop every connection is traded against — without it a
          // 9h two-stop at 94% reads as strictly better than a 5.7h nonstop.
          function baselineHtml(b) {
            if (!b || typeof b.duration_hours !== 'number') return '';
            if (b.duration_source === 'great_circle') {
              return '<div class="text-xs text-muted mb-3 leading-relaxed">No United nonstop on this pair, so every option connects (~' +
                fmtHours(b.duration_hours) + ' straight-line for reference).</div>';
            }
            var label = b.duration_source === 'sparse_history'
              ? 'Nonstop seen only occasionally (may not run on your date): ~'
              : 'Nonstop baseline: ~';
            return '<div class="text-xs text-muted mb-3 leading-relaxed">' + label +
              Math.round(b.probability * 100) + '% Starlink · ~' + fmtHours(b.expected_starlink_hours) +
              ' Starlink of ~' + fmtHours(b.duration_hours) + ' flying</div>';
          }

          function renderResults(data) {
            var itins = data.itineraries;
            if (!itins || itins.length === 0) {
              resultsDiv.innerHTML = '<div class="bg-surface border border-subtle rounded-lg p-6 text-center">' +
                '<div class="text-secondary font-display mb-2">No Starlink options found</div>' +
                '<p class="text-sm text-muted"></p>' +
                baselineHtml(data.baseline) +
                '</div>';
              // message is server-built registry prose (no user input); set via
              // textContent anyway so this stays injection-proof.
              // A sparse nonstop's budget yields to the fastest connection, so an
              // empty result there also means no connection has Starlink legs.
              var softBudget = data.baseline && (data.baseline.duration_source === 'great_circle' ||
                data.baseline.duration_source === 'sparse_history');
              resultsDiv.querySelector('p').textContent = data.message || (softBudget
                ? 'No connection between these airports has Starlink on its legs.'
                : 'No connection adds meaningful Starlink time without a long detour over the nonstop.');
              return;
            }
            var hasDirect = itins.some(function(i) { return i.via.length === 0; });

            var fullItins = itins.filter(function(i) { return i.coverage === 'full'; });
            var partialItins = itins.filter(function(i) { return i.coverage === 'partial'; });

            var html = hasDirect ? '' : baselineHtml(data.baseline);
            if (fullItins.length > 0) {
              html += '<div class="mb-6">' +
                '<h3 class="font-display text-lg text-primary mb-3">Starlink on every leg</h3>' +
                fullItins.map(function(it, i) { return renderItinerary(it, i + 1); }).join('') +
                '</div>';
            }
            if (partialItins.length > 0) {
              var partialHeader = fullItins.length === 0
                ? '<div class="text-xs text-muted mb-3 leading-relaxed">No option has Starlink on every leg. These have it on at least one.</div>'
                : '';
              html += '<div>' +
                '<h3 class="font-display text-lg text-primary mb-2">Starlink on some legs</h3>' +
                partialHeader +
                partialItins.map(function(it, i) { return renderItinerary(it, fullItins.length + i + 1); }).join('') +
                '</div>';
            }
            resultsDiv.innerHTML = html;
          }

          form.addEventListener('submit', function(e) {
            e.preventDefault();
            var origin = originInput.value.trim().toUpperCase();
            var dest = destInput.value.trim().toUpperCase();
            if (!origin || !dest) return;

            history.replaceState(null, '', '/route-planner?origin=' + encodeURIComponent(origin) + '&destination=' + encodeURIComponent(dest));

            resultsDiv.innerHTML = '<div class="text-center text-sm text-muted py-8">Finding flights…</div>';

            fetch('/api/plan-route?origin=' + encodeURIComponent(origin) + '&destination=' + encodeURIComponent(dest))
              .then(function(r) { return r.json(); })
              .then(renderResults)
              .catch(function() {
                resultsDiv.innerHTML = '<div class="text-sm text-danger text-center">Something went wrong. Please try again.</div>';
              });
          });

          if (originInput.value && destInput.value) {
            form.dispatchEvent(new Event('submit'));
          }
        });
      `,
        }}
      />
    </PageShell>
  );
}
