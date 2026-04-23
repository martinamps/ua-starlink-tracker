import React from "react";
import { AIRLINES, type PageBrand, type SiteConfig } from "../airlines/registry";

interface CheckFlightPageProps {
  brand?: PageBrand;
  site?: SiteConfig;
}

export default function CheckFlightPage({ brand, site }: CheckFlightPageProps) {
  const cfg = site?.scope && site.scope !== "ALL" ? AIRLINES[site.scope] : AIRLINES.UA;
  const airlineName = cfg.name;
  const homeTitle = brand?.title ?? cfg.brand.title;
  const host = site?.canonicalHost ?? cfg.canonicalHost;
  const flightExample = `${cfg.iata}123`;
  const shortName = airlineName.replace(/ Airlines?$/i, "");
  const showChromeExtension = site?.features.chromeExtension ?? cfg.code === "UA";
  const accuracyCopy =
    cfg.verifierBackend === "united"
      ? "We verify Starlink status against united.com and cross-reference with flight schedules from aviation data providers."
      : cfg.verifierBackend === "alaska-json"
        ? `We cross-reference ${shortName}'s own status data, public fleet data, and observed aircraft assignments.`
        : "We cross-reference public fleet data, rollout updates, and observed aircraft assignments.";
  const faqAnswer = `Enter your flight number (for example ${flightExample}) and travel date in the form above. The tool checks our database of Starlink-equipped aircraft against the scheduled aircraft for that flight.`;
  const extensionAnswer = showChromeExtension
    ? "Use this page to check by flight number, search by tail number on the main tracker, or install the free Chrome extension to see Starlink badges directly on Google Flights."
    : "Use this page to check by flight number, or search by tail number on the main tracker.";

  return (
    <div className="w-full mx-auto px-4 sm:px-6 md:px-8 bg-base min-h-screen flex flex-col relative">
      <div className="absolute inset-0 grid-pattern opacity-50 pointer-events-none" />

      <header className="relative py-5 sm:py-6 text-center mb-6">
        <a href="/" className="block">
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-primary mb-2 tracking-tight hover:text-accent transition-colors">
            Check If Your {airlineName} Flight Has Starlink WiFi
          </h1>
        </a>
        <p className="text-base text-secondary font-display">
          Enter your flight number and date to see if your aircraft has free Starlink internet
        </p>
      </header>

      <div className="relative max-w-xl mx-auto w-full mb-10">
        <div className="bg-surface rounded-lg border border-subtle p-6">
          <h2 className="font-display text-lg font-semibold text-primary mb-4">
            Check by flight number
          </h2>
          <form id="check-flight-form" className="space-y-4">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="flex-1">
                <label
                  htmlFor="flight-number"
                  className="block text-xs font-mono text-muted mb-1 uppercase tracking-wider"
                >
                  Flight Number
                </label>
                <input
                  type="text"
                  id="flight-number"
                  name="flight_number"
                  placeholder={flightExample}
                  className="w-full bg-base border border-subtle rounded px-3 py-2 text-primary font-mono text-sm focus:outline-none focus:border-accent"
                  required
                />
              </div>
              <div className="flex-1">
                <label
                  htmlFor="flight-date"
                  className="block text-xs font-mono text-muted mb-1 uppercase tracking-wider"
                >
                  Date
                </label>
                <input
                  type="date"
                  id="flight-date"
                  name="date"
                  className="w-full bg-base border border-subtle rounded px-3 py-2 text-primary font-mono text-sm focus:outline-none focus:border-accent"
                  required
                />
              </div>
            </div>
            <button
              type="submit"
              className="w-full bg-accent/20 border border-accent text-accent font-display font-semibold py-2 px-4 rounded hover:bg-accent/30 transition-colors cursor-pointer"
            >
              Check Flight
            </button>
          </form>

          <div id="flight-result" className="mt-4 hidden" />
        </div>
      </div>

      <div className="relative max-w-xl mx-auto w-full mb-10 space-y-6">
        <div className="bg-surface rounded-lg border border-subtle p-6">
          <h2 className="font-display text-lg font-semibold text-primary mb-3">
            Check by tail number
          </h2>
          <p className="text-sm text-muted leading-relaxed">
            If you know your aircraft's tail number (found on your boarding pass or the aircraft
            fuselage), search for it on the{" "}
            <a href="/" className="text-accent hover:underline">
              homepage tracker
            </a>
            . The search bar filters all Starlink-equipped aircraft instantly.
          </p>
        </div>

        {showChromeExtension && (
          <div className="bg-surface rounded-lg border border-subtle p-6">
            <h2 className="font-display text-lg font-semibold text-primary mb-3">
              Use the Chrome extension
            </h2>
            <p className="text-sm text-muted leading-relaxed mb-3">
              Install the free Chrome extension to see Starlink badges directly on Google Flights
              while you search for {shortName} flights. No extra steps needed.
            </p>
            <a
              href="https://chromewebstore.google.com/detail/google-flights-starlink-i/jjfljoifenkfdbldliakmmjhdkbhehoi"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-sm text-accent hover:underline"
            >
              <svg
                className="w-4 h-4"
                viewBox="0 0 48 48"
                fill="none"
                role="img"
                aria-label="Chrome"
              >
                <circle cx="24" cy="24" r="22" fill="#4285F4" />
                <circle cx="24" cy="24" r="9" fill="white" />
                <circle cx="24" cy="24" r="4" fill="#4285F4" />
              </svg>
              Add to Chrome — Free
            </a>
          </div>
        )}
      </div>

      <div className="relative max-w-xl mx-auto w-full mb-12">
        <div className="bg-surface rounded-lg border border-subtle p-4">
          <h2 className="font-display text-lg font-semibold text-primary mb-3 px-2">FAQ</h2>
          <div className="space-y-0 divide-y divide-subtle">
            <details className="group py-4 px-2">
              <summary className="cursor-pointer list-none flex items-start justify-between">
                <h3 className="font-display text-base font-medium text-secondary group-hover:text-accent transition-colors">
                  How do I check if my {shortName} flight has Starlink?
                </h3>
                <svg
                  className="w-4 h-4 text-muted group-open:rotate-45 transition-transform ml-4 flex-shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  role="img"
                  aria-label="Expand"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                  />
                </svg>
              </summary>
              <div className="mt-3 text-sm text-muted leading-relaxed">
                <p>{faqAnswer}</p>
              </div>
            </details>
            <details className="group py-4 px-2">
              <summary className="cursor-pointer list-none flex items-start justify-between">
                <h3 className="font-display text-base font-medium text-secondary group-hover:text-accent transition-colors">
                  Is this information accurate?
                </h3>
                <svg
                  className="w-4 h-4 text-muted group-open:rotate-45 transition-transform ml-4 flex-shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  role="img"
                  aria-label="Expand"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                  />
                </svg>
              </summary>
              <div className="mt-3 text-sm text-muted leading-relaxed">
                <p>
                  {accuracyCopy} Aircraft assignments can change, so check closer to your departure
                  date for the most accurate results.
                </p>
              </div>
            </details>
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
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="currentColor"
            stroke="currentColor"
            strokeWidth="0"
            aria-label="Heart"
            role="img"
          >
            <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
          </svg>
          by @martinamps
        </a>
      </footer>

      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD, no user input
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            itemListElement: [
              {
                "@type": "ListItem",
                position: 1,
                name: homeTitle,
                item: `https://${host}/`,
              },
              {
                "@type": "ListItem",
                position: 2,
                name: "Check Flight",
                item: `https://${host}/check-flight`,
              },
            ],
          }),
        }}
      />

      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD, no user input
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: [
              {
                "@type": "Question",
                name: `How do I check if my ${shortName} flight has Starlink?`,
                acceptedAnswer: {
                  "@type": "Answer",
                  text: faqAnswer,
                },
              },
              {
                "@type": "Question",
                name: `How do I know if my ${shortName} flight has Starlink WiFi?`,
                acceptedAnswer: {
                  "@type": "Answer",
                  text: extensionAnswer,
                },
              },
            ],
          }),
        }}
      />

      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static inline script, no user input
        dangerouslySetInnerHTML={{
          __html: `
        document.addEventListener('DOMContentLoaded', function() {
          var form = document.getElementById('check-flight-form');
          var resultDiv = document.getElementById('flight-result');
          var dateInput = document.getElementById('flight-date');
          var carrierPrefix = ${JSON.stringify(cfg.iata)};

          var pathParts = window.location.pathname.split('/').filter(Boolean);
          var urlFlight = pathParts.length >= 2 ? decodeURIComponent(pathParts[1]) : null;
          var urlDate = pathParts.length >= 3 ? decodeURIComponent(pathParts[2]) : null;

          if (dateInput) {
            dateInput.value = urlDate || new Date().toISOString().split('T')[0];
          }
          if (urlFlight && document.getElementById('flight-number')) {
            document.getElementById('flight-number').value = urlFlight.toUpperCase();
          }

          if (form) {
            form.addEventListener('submit', function(e) {
              e.preventDefault();
              var flightNumber = document.getElementById('flight-number').value.trim();
              var date = document.getElementById('flight-date').value;

              if (!flightNumber || !date) return;

              flightNumber = flightNumber.toUpperCase();
              if (/^\\d+$/.test(flightNumber)) {
                flightNumber = carrierPrefix + flightNumber;
              }

              var newUrl = '/check-flight/' + encodeURIComponent(flightNumber) + '/' + encodeURIComponent(date);
              history.replaceState(null, '', newUrl);

              resultDiv.className = 'mt-4';
              resultDiv.innerHTML = '<div class="text-sm text-muted font-mono">Checking...</div>';

              fetch('/api/check-flight?flight_number=' + encodeURIComponent(flightNumber) + '&date=' + encodeURIComponent(date))
                .then(function(res) { return res.json(); })
                .then(function(data) {
                  if (data.hasStarlink) {
                    var flight = data.flights[0] || {};
                    var depTime = flight.departure_time ? new Date(flight.departure_time * 1000) : null;
                    var timeStr = depTime ? depTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) : 'TBD';
                    var dateStr = depTime ? depTime.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : date;
                    var displayFlight = flight.ua_flight_number || flight.flight_number || flightNumber;
                    var aircraftInfo = flight.aircraft_type ? ' (' + flight.aircraft_type + ')' : '';
                    var dep = (flight.departure_airport || '').replace(/^K/, '');
                    var arr = (flight.arrival_airport || '').replace(/^K/, '');
                    var utcDate = depTime ? depTime.toISOString().slice(0, 10).replace(/-/g, '') : date.replace(/-/g, '');
                    var depIcao = dep.length === 3 ? 'K' + dep : dep;
                    var arrIcao = arr.length === 3 ? 'K' + arr : arr;
                    var faUrl = flight.flight_number
                      ? 'https://www.flightaware.com/live/flight/' + flight.flight_number + '/history/' + utcDate + '/' + depIcao + '/' + arrIcao
                      : 'https://www.flightaware.com';
                    resultDiv.innerHTML = '<div class="bg-green-900/30 border border-green-700/50 rounded p-4">' +
                      '<div class="flex items-center gap-2 mb-2">' +
                      '<span class="text-green-400 text-lg">&#10003;</span>' +
                      '<span class="font-display font-semibold text-green-400">This flight has Starlink WiFi!</span>' +
                      '</div>' +
                      '<div class="text-sm text-muted font-mono space-y-1">' +
                      '<div>Flight: <span class="text-secondary">' + displayFlight + '</span>' + (dep && arr ? ' <span class="text-muted">(' + dep + ' → ' + arr + ')</span>' : '') + '</div>' +
                      '<div>Departs: <span class="text-secondary">' + dateStr + ' at ' + timeStr + '</span></div>' +
                      '<div>Aircraft: <span class="text-secondary">' + (flight.tail_number || '') + aircraftInfo + '</span></div>' +
                      (flight.operated_by ? '<div>Operated by: <span class="text-secondary">' + flight.operated_by + '</span></div>' : '') +
                      '<div class="pt-2"><a href="' + faUrl + '" target="_blank" rel="noopener noreferrer" class="text-accent hover:underline text-xs">View on FlightAware →</a></div>' +
                      '</div></div>';
                  } else if (data.fallback && data.fallback.segments && data.fallback.segments.length > 0) {
                    var esc = function(s) { var d = document.createElement('div'); d.textContent = String(s || ''); return d.innerHTML; };
                    var seg = data.fallback.segments[0];
                    var age = seg.verified_at ? Math.floor((Date.now()/1000 - seg.verified_at) / 86400) : null;
                    var provider = esc(seg.verified_wifi || 'non-Starlink WiFi');
                    var tail = esc(seg.tail_number);
                    var model = seg.aircraft_model ? ' (' + esc(seg.aircraft_model) + ')' : '';
                    var ageStr = age !== null ? ' ' + age + ' day' + (age === 1 ? '' : 's') + ' ago' : '';
                    var note = (age !== null && age > 7)
                      ? 'Retrofits happen mid-cycle — if you see Starlink onboard, we have flagged this plane for re-check.'
                      : 'Aircraft swaps can happen, but this assignment is current.';
                    resultDiv.innerHTML = '<div class="bg-surface-elevated border border-subtle rounded p-4">' +
                      '<div class="font-display font-semibold text-secondary mb-2">Assigned aircraft: ' + tail + model + '</div>' +
                      '<p class="text-sm text-muted">Last verified <span class="text-secondary">' + provider + '</span>' + ageStr + '. ' + note + '</p>' +
                      '</div>';
                  } else {
                    resultDiv.innerHTML = '<div class="text-sm text-muted font-mono">No firm assignment yet — estimating probability...</div>';
                    var daysOut = (new Date(date + 'T00:00:00Z').getTime() - Date.now()) / 86400000;
                    var timingNote = daysOut > 2
                      ? 'Aircraft assignments firm up ~2 days before departure — check back then for a confirmed answer.'
                      : daysOut >= -1
                      ? 'No live tail assignment found — the flight may have an equipment swap in progress, or this flight number may be a codeshare.'
                      : 'This date is in the past — we do not retain historical assignments.';
                    fetch('/api/predict-flight?flight_number=' + encodeURIComponent(flightNumber))
                      .then(function(r) { return r.json(); })
                      .then(function(pred) {
                        var pct = Math.round(pred.probability * 100);
                        var isLikely = pct >= 70;
                        var isPossible = pct >= 40 && pct < 70;
                        var label = isLikely ? 'Likely' : isPossible ? 'Possible' : 'Unlikely';
                        var barColor = isLikely ? 'bg-green-500' : isPossible ? 'bg-yellow-500' : 'bg-surface-elevated';
                        var borderColor = isLikely ? 'border-green-700/50 bg-green-900/20' : isPossible ? 'border-yellow-700/50 bg-yellow-900/20' : 'border-subtle bg-surface-elevated';
                        var iconColor = isLikely ? 'text-green-400' : isPossible ? 'text-yellow-400' : 'text-muted';
                        var detail = pred.n_observations > 0
                          ? 'Based on <span class="text-secondary">' + pred.n_observations + '</span> historical observation' + (pred.n_observations === 1 ? '' : 's') + ' of aircraft on this flight number (' + pred.confidence + ' confidence).'
                          : 'No historical data for this flight number — this is the fleet install rate (treat as upper bound).';
                        resultDiv.innerHTML = '<div class="rounded p-4 border ' + borderColor + '">' +
                          '<div class="flex items-center gap-2 mb-3">' +
                          '<span class="text-lg ' + iconColor + '">~</span>' +
                          '<span class="font-display font-semibold ' + iconColor + '">' + label + ' — estimated ' + pct + '% chance of Starlink</span>' +
                          '</div>' +
                          '<div class="mb-3"><div class="w-full bg-base rounded-full h-2 overflow-hidden"><div class="' + barColor + ' h-2 rounded-full" style="width: ' + pct + '%"></div></div></div>' +
                          '<p class="text-xs text-muted leading-relaxed">' + detail + ' ' + timingNote + '</p>' +
                          '</div>';
                      })
                      .catch(function() {
                        resultDiv.innerHTML = '<div class="bg-surface-elevated border border-subtle rounded p-4">' +
                          '<div class="flex items-center gap-2 mb-2">' +
                          '<span class="text-muted text-lg">—</span>' +
                          '<span class="font-display font-medium text-secondary">No Starlink found for this flight</span>' +
                          '</div>' +
                          '<p class="text-sm text-muted">Try checking closer to your departure date.</p>' +
                          '</div>';
                      });
                  }
                })
                .catch(function() {
                  resultDiv.innerHTML = '<div class="text-sm text-red-400">Error checking flight. Please try again.</div>';
                });
            });

            if (urlFlight && urlDate) {
              form.dispatchEvent(new Event('submit'));
            }
          }
        });
      `,
        }}
      />
    </div>
  );
}
