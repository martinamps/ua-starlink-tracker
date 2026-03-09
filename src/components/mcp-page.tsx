import React from "react";

const MCP_URL = "https://unitedstarlinktracker.com/mcp";

export default function McpPage() {
  return (
    <div className="w-full mx-auto px-4 sm:px-6 md:px-8 bg-base min-h-screen flex flex-col relative">
      <div className="absolute inset-0 grid-pattern opacity-50 pointer-events-none" />

      <header className="relative py-5 sm:py-6 text-center mb-4">
        <a href="/" className="block">
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-primary mb-2 tracking-tight hover:text-accent transition-colors">
            Add Starlink Tracker to Claude
          </h1>
        </a>
        <p className="text-base text-secondary font-display max-w-xl mx-auto">
          Ask your AI assistant to check flights, predict Starlink probability, or plan routes —
          with live tracker data.
        </p>
      </header>

      {/* Quick URL copy */}
      <div className="relative max-w-2xl mx-auto w-full mb-8">
        <div className="bg-surface rounded-lg border border-subtle p-4 sm:p-5 glow-accent">
          <div className="text-xs font-mono text-muted uppercase tracking-wider mb-2">
            Connector URL
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-sm text-accent break-all select-all bg-base rounded px-3 py-2 border border-subtle">
              {MCP_URL}
            </code>
            <button
              type="button"
              id="copy-url-btn"
              className="px-3 py-2 bg-accent/20 border border-accent text-accent text-xs font-display rounded hover:bg-accent/30 transition-colors cursor-pointer whitespace-nowrap"
            >
              Copy
            </button>
          </div>
        </div>
      </div>

      {/* Visual walkthrough */}
      <div className="relative max-w-2xl mx-auto w-full mb-8 space-y-8">
        {/* Step 1 */}
        <div>
          <div className="flex items-center gap-3 mb-3">
            <span className="w-7 h-7 rounded-full bg-accent/20 border border-accent text-accent font-mono text-sm flex items-center justify-center flex-shrink-0">
              1
            </span>
            <h2 className="font-display text-lg font-semibold text-primary">
              Open Claude Desktop → Settings → Connectors → click{" "}
              <span className="text-accent">+</span>
            </h2>
          </div>
        </div>

        {/* Step 2 */}
        <div>
          <div className="flex items-center gap-3 mb-3">
            <span className="w-7 h-7 rounded-full bg-accent/20 border border-accent text-accent font-mono text-sm flex items-center justify-center flex-shrink-0">
              2
            </span>
            <h2 className="font-display text-lg font-semibold text-primary">
              Paste the URL and click Add
            </h2>
          </div>
          <img
            src="/static/mcp-add-dialog.webp"
            alt="Claude Desktop 'Add custom connector' dialog with Starlink Tracker name and unitedstarlinktracker.com/mcp URL filled in"
            width="700"
            height="548"
            className="rounded-lg border border-subtle w-full max-w-lg mx-auto"
            loading="lazy"
          />
        </div>

        {/* Step 3 */}
        <div>
          <div className="flex items-center gap-3 mb-3">
            <span className="w-7 h-7 rounded-full bg-accent/20 border border-accent text-accent font-mono text-sm flex items-center justify-center flex-shrink-0">
              3
            </span>
            <h2 className="font-display text-lg font-semibold text-primary">
              Done — 7 tools ready
            </h2>
          </div>
          <img
            src="/static/mcp-connectors.webp"
            alt="Claude Desktop Connectors settings showing Starlink Tracker with 7 tools: check_flight, get_fleet_stats, list_starlink_aircraft, plan_starlink_itinerary, predict_flight_starlink, predict_route_starlink, search_starlink_flights"
            width="1100"
            height="780"
            className="rounded-lg border border-subtle w-full"
            loading="lazy"
          />
        </div>
      </div>

      {/* What to ask */}
      <div className="relative max-w-2xl mx-auto w-full mb-8">
        <div className="bg-surface rounded-lg border border-subtle p-6">
          <h2 className="font-display text-lg font-semibold text-primary mb-3">Try asking</h2>
          <ul className="space-y-2 text-sm text-muted">
            <li className="pl-4 -indent-4">
              <span className="text-secondary">"</span>Does UA4680 next Tuesday have Starlink?
              <span className="text-secondary">"</span>
            </li>
            <li className="pl-4 -indent-4">
              <span className="text-secondary">"</span>I'm flying SFO to JAX on April 10 — what's my
              best shot at Starlink?<span className="text-secondary">"</span>
            </li>
            <li className="pl-4 -indent-4">
              <span className="text-secondary">"</span>I'd rather fly 7 hours with internet than 5
              hours without — find me a routing from DEN to ORD
              <span className="text-secondary">"</span>
            </li>
            <li className="pl-4 -indent-4">
              <span className="text-secondary">"</span>What percentage of United's express fleet has
              Starlink now?<span className="text-secondary">"</span>
            </li>
          </ul>
        </div>
      </div>

      {/* Other clients (collapsed) */}
      <div className="relative max-w-2xl mx-auto w-full mb-8">
        <details className="bg-surface rounded-lg border border-subtle p-4 group">
          <summary className="cursor-pointer list-none flex items-center justify-between">
            <span className="font-display text-sm font-medium text-secondary group-hover:text-accent transition-colors">
              Using Cursor, Cline, or another MCP client?
            </span>
            <svg
              className="w-4 h-4 text-muted group-open:rotate-45 transition-transform"
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
          <div className="mt-4 space-y-3 text-sm text-muted">
            <p>
              Add the same URL with <span className="font-mono text-secondary">http</span> transport
              in your client's MCP settings. See your client's docs for the config format.
            </p>
            <p>
              For programmatic access: it's a standard JSON-RPC 2.0 endpoint. POST to{" "}
              <span className="font-mono text-secondary">{MCP_URL}</span> with{" "}
              <span className="font-mono text-secondary">Content-Type: application/json</span>. No
              auth, no SDK needed.{" "}
              <a
                href="https://modelcontextprotocol.io/specification/2025-06-18/basic/transports"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                MCP spec →
              </a>
            </p>
          </div>
        </details>
      </div>

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

      {/* Copy button handler */}
      <script
        dangerouslySetInnerHTML={{
          __html: `
        document.addEventListener('DOMContentLoaded', function() {
          var btn = document.getElementById('copy-url-btn');
          if (btn) {
            btn.addEventListener('click', function() {
              navigator.clipboard.writeText('${MCP_URL}').then(function() {
                btn.textContent = 'Copied!';
                setTimeout(function() { btn.textContent = 'Copy'; }, 2000);
              });
            });
          }
        });
      `,
        }}
      />
    </div>
  );
}
