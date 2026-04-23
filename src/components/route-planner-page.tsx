import React from "react";
import { AIRLINES, type PageBrand, type SiteConfig } from "../airlines/registry";

interface RoutePlannerPageProps {
  brand?: PageBrand;
  site?: SiteConfig;
}

export default function RoutePlannerPage({ brand, site }: RoutePlannerPageProps) {
  const cfg = site?.scope && site.scope !== "ALL" ? AIRLINES[site.scope] : AIRLINES.UA;
  const airlineName = cfg.name;
  const shortName = airlineName.replace(/ Airlines?$/i, "");
  const homeTitle = brand?.title ?? cfg.brand.title;

  return (
    <div className="w-full mx-auto px-4 sm:px-6 md:px-8 bg-base min-h-screen flex flex-col relative">
      <div className="absolute inset-0 grid-pattern opacity-50 pointer-events-none" />

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

      <header className="relative py-5 sm:py-6 text-center mb-6">
        <a href="/" className="block">
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-primary mb-2 tracking-tight hover:text-accent transition-colors">
            Starlink Route Planner
          </h1>
        </a>
        <p className="text-base text-secondary font-display">
          Find the best way to fly {airlineName} with Starlink WiFi
        </p>
      </header>

      <div className="relative max-w-2xl mx-auto w-full mb-8">
        <div className="bg-surface rounded-lg border border-subtle p-6 glow-accent">
          <form id="route-form" className="space-y-4">
            <div className="flex flex-col sm:flex-row gap-4 items-end">
              <div className="flex-1">
                <label
                  htmlFor="origin"
                  className="block text-xs font-mono text-muted mb-2 uppercase tracking-wider"
                >
                  From
                </label>
                <input
                  type="text"
                  id="origin"
                  name="origin"
                  placeholder="SFO"
                  maxLength={4}
                  className="airport-input w-full bg-base border border-subtle rounded px-3 py-3 text-primary font-mono text-lg focus:outline-none focus:border-accent focus:glow-accent-strong"
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
                <label
                  htmlFor="destination"
                  className="block text-xs font-mono text-muted mb-2 uppercase tracking-wider"
                >
                  To
                </label>
                <input
                  type="text"
                  id="destination"
                  name="destination"
                  placeholder="JAX"
                  maxLength={4}
                  className="airport-input w-full bg-base border border-subtle rounded px-3 py-3 text-primary font-mono text-lg focus:outline-none focus:border-accent focus:glow-accent-strong"
                  required
                  autoComplete="off"
                />
              </div>
            </div>
            <button
              type="submit"
              className="w-full bg-accent/20 border border-accent text-accent font-display font-semibold py-3 px-4 rounded hover:bg-accent/30 transition-colors cursor-pointer tracking-wide"
            >
              Find Starlink Routings
            </button>
          </form>
          <p className="text-xs text-muted mt-3 text-center font-mono">
            Searches direct flights + connections · Ranked by Starlink probability
          </p>
        </div>
      </div>

      <div id="route-results" className="relative max-w-3xl mx-auto w-full mb-10" />

      <div className="relative max-w-2xl mx-auto w-full mb-10">
        <div className="bg-surface rounded-lg border border-subtle p-6">
          <h2 className="font-display text-lg font-semibold text-primary mb-3">How this works</h2>
          <div className="space-y-3 text-sm text-muted leading-relaxed">
            <p>
              We track historical aircraft assignments for {shortName} flights. When a flight number
              consistently gets Starlink-equipped planes, we can predict with better confidence that
              it will keep happening.
            </p>
            <p>
              The planner looks for the best balance between travel time and Starlink coverage. A
              connection can sometimes beat the direct flight if the nonstop is usually assigned to
              a non-Starlink aircraft.
            </p>
            <p className="text-xs">
              <span className="text-yellow-400">⚠</span> Probabilities are estimates based on
              historical patterns. Aircraft assignments can change — use{" "}
              <a href="/check-flight" className="text-accent hover:underline">
                Check Flight
              </a>{" "}
              1-2 days before departure for a firmer answer.
            </p>
          </div>
        </div>
      </div>

      <div className="relative text-center mb-6">
        <a href="/" className="text-sm text-accent hover:underline font-display">
          ← Back to {homeTitle}
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

      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static inline script, no user input
        dangerouslySetInnerHTML={{
          __html: `
        document.addEventListener('DOMContentLoaded', function() {
          var form = document.getElementById('route-form');
          var resultsDiv = document.getElementById('route-results');
          var originInput = document.getElementById('origin');
          var destInput = document.getElementById('destination');

          var pathParts = window.location.pathname.split('/').filter(Boolean);
          if (pathParts.length >= 3) {
            originInput.value = decodeURIComponent(pathParts[1]);
            destInput.value = decodeURIComponent(pathParts[2]);
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
            return p >= 0.7 ? '#22c55e' : p >= 0.4 ? '#eab308' : '#5a6a80';
          }

          function renderLeg(leg, isPositioning) {
            var pct = Math.round(leg.probability * 100);
            var color = probColor(leg.probability);
            var parts = leg.route.split('-');
            if (isPositioning) {
              return '<div class="flex items-center justify-between py-2 border-l-2 border-subtle pl-3 ml-1">' +
                '<div class="text-sm font-mono">' +
                '<div class="text-muted">' + parts[0] + ' → ' + parts[1] + '</div>' +
                '<div class="text-xs text-muted opacity-70">book any flight · positioning segment</div>' +
                '</div>' +
                '<div class="flex items-center gap-2">' +
                probBars(leg.probability, color) +
                '<span class="font-mono text-xs w-10 text-right" style="color:' + color + '">' + pct + '%</span>' +
                '</div>' +
                '</div>';
            }
            var conf = leg.confidence === 'high' ? '' : ' · ' + leg.confidence;
            return '<div class="flex items-center justify-between py-2 border-l-2 pl-3 ml-1" style="border-color:' + color + '">' +
              '<div class="text-sm font-mono">' +
              '<div class="text-secondary">' + leg.flight_number + ' <span class="text-muted">' + parts[0] + ' → ' + parts[1] + '</span></div>' +
              '<div class="text-xs text-muted opacity-70">' + leg.n_observations + ' obs' + conf + '</div>' +
              '</div>' +
              '<div class="flex items-center gap-2">' +
              probBars(leg.probability, color) +
              '<span class="font-mono text-xs w-10 text-right" style="color:' + color + '">' + pct + '%</span>' +
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
              var nodeColor = isLast ? color : (live && legs[li+1].probability >= 0.7 ? '#22c55e' : '#5a6a80');
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

            var badge = isDirect
              ? '<span class="text-xs font-mono text-accent">DIRECT</span>'
              : '<span class="text-xs font-mono text-muted">via ' + via.join('→') + ' · ' + nStops + ' stop' + (nStops>1?'s':'') + '</span>';

            var airportLabels = '<span>' + origCode + '</span>';
            for (var vi = 0; vi < via.length; vi++) {
              airportLabels += '<span class="text-center flex-1">' + via[vi] + '</span>';
            }
            if (via.length === 0) airportLabels += '<span class="flex-1"></span>';
            airportLabels += '<span>' + destCode + '</span>';

            return '<div class="itin-card bg-surface border border-subtle rounded-lg p-4 mb-3 hover:border-accent/50 transition-colors">' +
              '<div class="flex items-center justify-between mb-3">' +
              '<div class="flex items-center gap-3">' +
              '<span class="font-mono text-xs text-muted">#' + rank + '</span>' +
              badge +
              '</div>' +
              '<div class="font-display font-semibold text-right" style="color:' + headerColor + '">' +
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

          function renderResults(data) {
            var itins = data.itineraries;
            if (!itins || itins.length === 0) {
              resultsDiv.innerHTML = '<div class="bg-surface border border-subtle rounded-lg p-6 text-center">' +
                '<div class="text-secondary font-display font-medium mb-2">No Starlink routings found</div>' +
                '<p class="text-sm text-muted">Neither the direct route nor available connections have shown a strong Starlink pattern on this routing yet.</p>' +
                '</div>';
              return;
            }

            var fullItins = itins.filter(function(i) { return i.coverage === 'full'; });
            var partialItins = itins.filter(function(i) { return i.coverage === 'partial'; });

            var html = '';
            if (fullItins.length > 0) {
              html += '<div class="mb-6">' +
                '<h3 class="font-display text-sm font-semibold text-primary mb-3 uppercase tracking-wider">Full Starlink Coverage</h3>' +
                fullItins.map(function(it, i) { return renderItinerary(it, i + 1); }).join('') +
                '</div>';
            }
            if (partialItins.length > 0) {
              var partialHeader = fullItins.length === 0
                ? '<div class="text-xs text-muted mb-3 leading-relaxed">No all-Starlink path found yet. These options keep at least one leg on a stronger Starlink pattern.</div>'
                : '';
              html += '<div>' +
                '<h3 class="font-display text-sm font-semibold text-yellow-400 mb-2 uppercase tracking-wider">Partial Coverage</h3>' +
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

            history.replaceState(null, '', '/route-planner/' + encodeURIComponent(origin) + '/' + encodeURIComponent(dest));

            resultsDiv.innerHTML = '<div class="text-center text-sm text-muted font-mono py-8">Computing routings...</div>';

            fetch('/api/plan-route?origin=' + encodeURIComponent(origin) + '&destination=' + encodeURIComponent(dest))
              .then(function(r) { return r.json(); })
              .then(renderResults)
              .catch(function() {
                resultsDiv.innerHTML = '<div class="text-sm text-red-400 text-center">Error loading routings. Please try again.</div>';
              });
          });

          if (originInput.value && destInput.value) {
            form.dispatchEvent(new Event('submit'));
          }
        });
      `,
        }}
      />
    </div>
  );
}
