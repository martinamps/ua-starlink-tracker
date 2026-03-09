import React from "react";

const MCP_ENDPOINT = "https://unitedstarlinktracker.com/mcp";

const CLAUDE_DESKTOP_CONFIG = `{
  "mcpServers": {
    "ua-starlink": {
      "url": "${MCP_ENDPOINT}",
      "transport": "http"
    }
  }
}`;

const TOOLS = [
  {
    name: "check_flight",
    desc: "Firm answer: is this flight scheduled on a Starlink plane? (~2-day window)",
    example: "Does UA4680 tomorrow have Starlink?",
  },
  {
    name: "predict_flight_starlink",
    desc: "Probability estimate for flights beyond our firm schedule window, based on 12k+ historical observations",
    example: "What's the Starlink probability for UA3561 next month?",
  },
  {
    name: "plan_starlink_itinerary",
    desc: "Find direct flights + 1-stop connections ranked by Starlink probability — full and partial coverage options",
    example: "Best way to fly SFO to JAX with Starlink?",
  },
  {
    name: "predict_route_starlink",
    desc: "List flight numbers on a route ranked by Starlink probability",
    example: "Which flights to Denver usually get Starlink planes?",
  },
  {
    name: "search_starlink_flights",
    desc: "Confirmed Starlink flights in the next ~2 days from/to an airport",
    example: "What Starlink flights leave ORD today?",
  },
  {
    name: "get_fleet_stats",
    desc: "Installation progress: how many aircraft have Starlink by fleet",
    example: "What percentage of United's fleet has Starlink?",
  },
  {
    name: "list_starlink_aircraft",
    desc: "Enumerate all equipped aircraft with tail numbers and types",
    example: "List all Starlink-equipped 737s",
  },
];

export default function McpPage() {
  return (
    <div className="w-full mx-auto px-4 sm:px-6 md:px-8 bg-base min-h-screen flex flex-col relative">
      <div className="absolute inset-0 grid-pattern opacity-50 pointer-events-none" />

      <header className="relative py-5 sm:py-6 text-center mb-6">
        <a href="/" className="block">
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-primary mb-2 tracking-tight hover:text-accent transition-colors">
            MCP Server for AI Assistants
          </h1>
        </a>
        <p className="text-base text-secondary font-display max-w-2xl mx-auto">
          Connect Claude, Cursor, or any MCP-compatible client to live United Starlink tracker data
        </p>
      </header>

      {/* Quick connect */}
      <div className="relative max-w-2xl mx-auto w-full mb-8">
        <div className="bg-surface rounded-lg border border-subtle p-6 glow-accent">
          <div className="text-xs font-mono text-muted uppercase tracking-wider mb-2">Endpoint</div>
          <div className="font-mono text-sm text-accent break-all mb-4">{MCP_ENDPOINT}</div>
          <div className="text-xs font-mono text-muted uppercase tracking-wider mb-2">
            Transport
          </div>
          <div className="font-mono text-sm text-secondary">
            Streamable HTTP · Stateless · No auth required
          </div>
        </div>
      </div>

      {/* Setup instructions */}
      <div className="relative max-w-2xl mx-auto w-full mb-8">
        <div className="bg-surface rounded-lg border border-subtle p-6">
          <h2 className="font-display text-lg font-semibold text-primary mb-4">Setup</h2>

          <div className="mb-6">
            <h3 className="font-display text-sm font-medium text-secondary mb-2">Claude Desktop</h3>
            <p className="text-xs text-muted mb-2">
              Add to{" "}
              <span className="font-mono text-secondary">
                ~/Library/Application Support/Claude/claude_desktop_config.json
              </span>{" "}
              (macOS) or{" "}
              <span className="font-mono text-secondary">
                %APPDATA%\Claude\claude_desktop_config.json
              </span>{" "}
              (Windows):
            </p>
            <pre className="bg-base border border-subtle rounded p-3 text-xs font-mono text-secondary overflow-x-auto">
              {CLAUDE_DESKTOP_CONFIG}
            </pre>
            <p className="text-xs text-muted mt-2">
              Restart Claude Desktop. You'll see the tracker tools available in conversations.
            </p>
          </div>

          <div className="mb-4">
            <h3 className="font-display text-sm font-medium text-secondary mb-2">
              Cursor, Continue, Cline & other MCP clients
            </h3>
            <p className="text-xs text-muted">
              Add the endpoint URL with <span className="font-mono text-secondary">http</span>{" "}
              transport to your client's MCP settings. See your client's docs for the exact config
              format.
            </p>
          </div>

          <div>
            <h3 className="font-display text-sm font-medium text-secondary mb-2">
              Programmatic access
            </h3>
            <p className="text-xs text-muted">
              The server is a standard JSON-RPC 2.0 endpoint. POST a{" "}
              <span className="font-mono text-secondary">tools/call</span> request with{" "}
              <span className="font-mono text-secondary">Content-Type: application/json</span>. No
              SDK required.{" "}
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
        </div>
      </div>

      {/* Tools */}
      <div className="relative max-w-2xl mx-auto w-full mb-8">
        <div className="bg-surface rounded-lg border border-subtle p-6">
          <h2 className="font-display text-lg font-semibold text-primary mb-4">Available tools</h2>
          <div className="space-y-4">
            {TOOLS.map((tool) => (
              <div key={tool.name} className="border-l-2 border-accent/30 pl-3">
                <div className="font-mono text-sm text-accent">{tool.name}</div>
                <div className="text-xs text-muted leading-relaxed">{tool.desc}</div>
                <div className="text-xs text-secondary italic mt-0.5">"{tool.example}"</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Example prompts */}
      <div className="relative max-w-2xl mx-auto w-full mb-8">
        <div className="bg-surface rounded-lg border border-subtle p-6">
          <h2 className="font-display text-lg font-semibold text-primary mb-3">
            Things to ask your AI
          </h2>
          <ul className="space-y-2 text-sm text-muted">
            <li className="pl-4 -indent-4">
              "I'm flying SFO to JAX on April 10 — what's my best shot at Starlink?"
            </li>
            <li className="pl-4 -indent-4">
              "Compare UA4680 vs UA5259 — which is more likely to have Starlink?"
            </li>
            <li className="pl-4 -indent-4">
              "I'd rather fly 7 hours with internet than 5 hours without — find me a routing DEN to
              ORD"
            </li>
            <li className="pl-4 -indent-4">
              "What percentage of United's express fleet has Starlink now?"
            </li>
          </ul>
        </div>
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
    </div>
  );
}
