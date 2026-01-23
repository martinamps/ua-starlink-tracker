import React from "react";

export default function CheckFlightPage() {
  return (
    <div className="w-full mx-auto px-4 sm:px-6 md:px-8 bg-base min-h-screen flex flex-col relative">
      <div className="absolute inset-0 grid-pattern opacity-50 pointer-events-none" />

      <header className="relative py-5 sm:py-6 text-center mb-6">
        <a href="/" className="block">
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-primary mb-2 tracking-tight hover:text-accent transition-colors">
            Check If Your United Flight Has Starlink WiFi
          </h1>
        </a>
        <p className="text-base text-secondary font-display">
          Enter your flight number and date to see if your aircraft has free Starlink internet
        </p>
      </header>

      {/* Flight Check Form */}
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
                  placeholder="UA123"
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

          {/* Results area */}
          <div id="flight-result" className="mt-4 hidden" />
        </div>
      </div>

      {/* Other ways to check */}
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

        <div className="bg-surface rounded-lg border border-subtle p-6">
          <h2 className="font-display text-lg font-semibold text-primary mb-3">
            Use the Chrome extension
          </h2>
          <p className="text-sm text-muted leading-relaxed mb-3">
            Install our free Chrome extension to see Starlink badges directly on Google Flights
            while you search for United flights. No extra steps needed — just search and see which
            flights have Starlink.
          </p>
          <a
            href="https://chromewebstore.google.com/detail/google-flights-starlink-i/jjfljoifenkfdbldliakmmjhdkbhehoi"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-sm text-accent hover:underline"
          >
            <svg className="w-4 h-4" viewBox="0 0 48 48" fill="none" role="img" aria-label="Chrome">
              <circle cx="24" cy="24" r="22" fill="#4285F4" />
              <circle cx="24" cy="24" r="9" fill="white" />
              <circle cx="24" cy="24" r="4" fill="#4285F4" />
            </svg>
            Add to Chrome — Free
          </a>
        </div>
      </div>

      {/* FAQ for this page */}
      <div className="relative max-w-xl mx-auto w-full mb-12">
        <div className="bg-surface rounded-lg border border-subtle p-4">
          <h2 className="font-display text-lg font-semibold text-primary mb-3 px-2">FAQ</h2>
          <div className="space-y-0 divide-y divide-subtle">
            <details className="group py-4 px-2">
              <summary className="cursor-pointer list-none flex items-start justify-between">
                <h3 className="font-display text-base font-medium text-secondary group-hover:text-accent transition-colors">
                  How do I check if my United flight has Starlink?
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
                  Enter your flight number (e.g., UA123) and travel date in the form above. The tool
                  checks our database of Starlink-equipped aircraft against the scheduled aircraft
                  for that flight.
                </p>
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
                  We verify Starlink status against United's own systems and cross-reference with
                  flight schedules from aviation data providers. Aircraft assignments can change, so
                  check closer to your departure date for the most accurate results.
                </p>
              </div>
            </details>
          </div>
        </div>
      </div>

      {/* Back to homepage */}
      <div className="relative text-center mb-6">
        <a href="/" className="text-sm text-accent hover:underline font-display">
          ← Back to United Starlink Tracker
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

      {/* Breadcrumb schema for site hierarchy */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            itemListElement: [
              {
                "@type": "ListItem",
                position: 1,
                name: "United Starlink Tracker",
                item: "https://unitedstarlinktracker.com/",
              },
              {
                "@type": "ListItem",
                position: 2,
                name: "Check Flight",
                item: "https://unitedstarlinktracker.com/check-flight",
              },
            ],
          }),
        }}
      />

      {/* Check-flight specific FAQ schema */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: [
              {
                "@type": "Question",
                name: "How do I check if my United flight has Starlink?",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: "Enter your flight number (e.g., UA123) and travel date in the form on this page. The tool checks our database of Starlink-equipped aircraft against the scheduled aircraft for that flight.",
                },
              },
              {
                "@type": "Question",
                name: "How do I know if my United flight has Starlink WiFi?",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: "Use this page to check by flight number, search by tail number on the main tracker, or install our free Chrome extension to see Starlink badges directly on Google Flights.",
                },
              },
            ],
          }),
        }}
      />

      {/* Client-side form handling */}
      <script
        dangerouslySetInnerHTML={{
          __html: `
        document.addEventListener('DOMContentLoaded', function() {
          var form = document.getElementById('check-flight-form');
          var resultDiv = document.getElementById('flight-result');
          var dateInput = document.getElementById('flight-date');

          // Parse URL path for shared links: /check-flight/UA5445/2026-01-24
          var pathParts = window.location.pathname.split('/').filter(Boolean);
          var urlFlight = pathParts.length >= 2 ? decodeURIComponent(pathParts[1]) : null;
          var urlDate = pathParts.length >= 3 ? decodeURIComponent(pathParts[2]) : null;

          // Set default date to today, or from URL
          if (dateInput) {
            dateInput.value = urlDate || new Date().toISOString().split('T')[0];
          }
          if (urlFlight && document.getElementById('flight-number')) {
            document.getElementById('flight-number').value = urlFlight;
          }

          if (form) {
            form.addEventListener('submit', function(e) {
              e.preventDefault();
              var flightNumber = document.getElementById('flight-number').value.trim();
              var date = document.getElementById('flight-date').value;

              if (!flightNumber || !date) return;

              // Normalize: add UA prefix if just a number
              if (/^\\d+$/.test(flightNumber)) {
                flightNumber = 'UA' + flightNumber;
              }

              // Update URL for shareability: /check-flight/UA5445/2026-01-24
              var newUrl = '/check-flight/' + encodeURIComponent(flightNumber) + '/' + encodeURIComponent(date);
              history.replaceState(null, '', newUrl);

              resultDiv.className = 'mt-4';
              resultDiv.innerHTML = '<div class="text-sm text-muted font-mono">Checking...</div>';

              fetch('/api/check-flight?flight_number=' + encodeURIComponent(flightNumber) + '&date=' + encodeURIComponent(date))
                .then(function(res) { return res.json(); })
                .then(function(data) {
                  if (data.hasStarlink) {
                    var flight = data.flights[0];
                    var depTime = new Date(flight.departure_time * 1000);
                    var timeStr = depTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
                    var dateStr = depTime.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                    var displayFlight = flight.ua_flight_number || flight.flight_number;
                    var aircraftInfo = flight.aircraft_type ? ' (' + flight.aircraft_type + ')' : '';
                    var dep = (flight.departure_airport || '').replace(/^K/, '');
                    var arr = (flight.arrival_airport || '').replace(/^K/, '');
                    // Build FlightAware deep link with date and route (no time — more forgiving if schedule shifts)
                    var utcDate = depTime.toISOString().slice(0, 10).replace(/-/g, '');
                    var depIcao = dep.length === 3 ? 'K' + dep : dep;
                    var arrIcao = arr.length === 3 ? 'K' + arr : arr;
                    var faUrl = 'https://www.flightaware.com/live/flight/' + flight.flight_number + '/history/' + utcDate + '/' + depIcao + '/' + arrIcao;
                    resultDiv.innerHTML = '<div class="bg-green-900/30 border border-green-700/50 rounded p-4">' +
                      '<div class="flex items-center gap-2 mb-2">' +
                      '<span class="text-green-400 text-lg">&#10003;</span>' +
                      '<span class="font-display font-semibold text-green-400">This flight has Starlink WiFi!</span>' +
                      '</div>' +
                      '<div class="text-sm text-muted font-mono space-y-1">' +
                      '<div>Flight: <span class="text-secondary">' + displayFlight + '</span> <span class="text-muted">(' + dep + ' → ' + arr + ')</span></div>' +
                      '<div>Departs: <span class="text-secondary">' + dateStr + ' at ' + timeStr + '</span></div>' +
                      '<div>Aircraft: <span class="text-secondary">' + (flight.tail_number || '') + aircraftInfo + '</span></div>' +
                      (flight.operated_by ? '<div>Operated by: <span class="text-secondary">' + flight.operated_by + '</span></div>' : '') +
                      '<div class="pt-2"><a href="' + faUrl + '" target="_blank" rel="noopener noreferrer" class="text-accent hover:underline text-xs">View on FlightAware →</a></div>' +
                      '</div></div>';
                  } else {
                    resultDiv.innerHTML = '<div class="bg-surface-elevated border border-subtle rounded p-4">' +
                      '<div class="flex items-center gap-2 mb-2">' +
                      '<span class="text-muted text-lg">—</span>' +
                      '<span class="font-display font-medium text-secondary">No Starlink found for this flight</span>' +
                      '</div>' +
                      '<p class="text-sm text-muted">This flight may not have a Starlink-equipped aircraft assigned yet, or the aircraft assignment hasn\\\'t been published. Try checking closer to your departure date.</p>' +
                      '</div>';
                  }
                })
                .catch(function(err) {
                  resultDiv.innerHTML = '<div class="text-sm text-red-400">Error checking flight. Please try again.</div>';
                });
            });

            // Auto-submit if URL has flight/date params
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
