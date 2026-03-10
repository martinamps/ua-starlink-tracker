import React from "react";

const MCP_URL = "https://unitedstarlinktracker.com/mcp";

export default function McpPage() {
  return (
    <div className="w-full mx-auto px-4 sm:px-6 md:px-8 bg-base min-h-screen flex flex-col relative">
      <div className="absolute inset-0 grid-pattern opacity-50 pointer-events-none" />

      <header className="relative py-5 sm:py-6 text-center mb-3">
        <a href="/" className="block">
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-primary mb-2 tracking-tight hover:text-accent transition-colors">
            Starlink Tracker for Claude
          </h1>
        </a>
        <p className="text-base text-secondary font-display max-w-xl mx-auto">
          Ask Claude which United flights have Starlink — and get ranked alternatives when they
          don't.
        </p>
      </header>

      {/* Hero: show the result first */}
      <div className="relative max-w-3xl mx-auto w-full mb-8">
        <img
          src="/static/mcp-demo.webp"
          alt="Claude Desktop window: user asks 'I'm on UA642 on 3/13 — does it have Starlink?' Response shows ~1% for the nonstop (4.2h), then a ranked table with two 1-stop alternatives at 93-94% Starlink via Savannah or Richmond (~5.3h total)."
          width="1676"
          height="1802"
          className="rounded-xl border border-subtle w-full shadow-2xl glow-accent"
        />
      </div>

      {/* URL + one-line setup */}
      <div className="relative max-w-2xl mx-auto w-full mb-8">
        <div className="bg-surface rounded-lg border border-subtle p-4 sm:p-5">
          <div className="text-xs font-mono text-muted uppercase tracking-wider mb-2">
            Claude Desktop · Settings → Connectors → Add
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

      {/* Try asking — updated with the proven demo prompts */}
      <div className="relative max-w-2xl mx-auto w-full mb-8">
        <div className="bg-surface rounded-lg border border-subtle p-6">
          <h2 className="font-display text-lg font-semibold text-primary mb-3">Try asking</h2>
          <ul className="space-y-2 text-sm text-muted">
            <li className="pl-4 -indent-4">
              <span className="text-secondary">"</span>I'm on UA642 on 3/13 — does it have Starlink?
              If not, what are my options?<span className="text-secondary">"</span>
            </li>
            <li className="pl-4 -indent-4">
              <span className="text-secondary">"</span>Flying SFO to EWR next month — plan me the
              best Starlink routing<span className="text-secondary">"</span>
            </li>
            <li className="pl-4 -indent-4">
              <span className="text-secondary">"</span>Does UA4680 tomorrow have Starlink?
              <span className="text-secondary">"</span>
            </li>
            <li className="pl-4 -indent-4">
              <span className="text-secondary">"</span>What's the Starlink install rate on United's
              regional fleet?<span className="text-secondary">"</span>
            </li>
          </ul>
        </div>
      </div>

      {/* Setup details — collapsed */}
      <div className="relative max-w-2xl mx-auto w-full mb-8">
        <details className="bg-surface rounded-lg border border-subtle p-4 group">
          <summary className="cursor-pointer list-none flex items-center justify-between">
            <span className="font-display text-sm font-medium text-secondary group-hover:text-accent transition-colors">
              Setup walkthrough & other MCP clients
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
          <div className="mt-4 space-y-4 text-sm text-muted">
            <div>
              <p className="text-secondary font-medium mb-2">
                1. Open Claude Desktop → Settings → Connectors → click{" "}
                <span className="text-accent">+</span>
              </p>
              <p>
                2. Paste{" "}
                <code className="font-mono text-xs text-accent bg-base px-1.5 py-0.5 rounded">
                  {MCP_URL}
                </code>{" "}
                and name it "Starlink Tracker"
              </p>
              <p>3. That's it — 7 tools are live in your next chat.</p>
            </div>
            <img
              src="/static/mcp-add-dialog.webp"
              alt="Claude Desktop 'Add custom connector' dialog with Starlink Tracker URL filled in"
              width="700"
              height="548"
              className="rounded-lg border border-subtle w-full max-w-md"
              loading="lazy"
            />
            <p className="pt-2 border-t border-subtle">
              <strong className="text-secondary">Other clients (Cursor, Cline, etc):</strong> same
              URL, <code className="font-mono text-xs">http</code> transport. It's a standard
              JSON-RPC 2.0 endpoint — no auth, no SDK.{" "}
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
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static inline script, no user input
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
