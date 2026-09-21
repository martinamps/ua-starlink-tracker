import React from "react";
import { type SiteConfig, siteAirline } from "../airlines/registry";
import { ClientScriptTag } from "./flight-search-form";
import type { Link } from "./layout";
import {
  ButtonLink,
  Eyebrow,
  PageHeader,
  PageShell,
  Panel,
  SectionTitle,
  buttonClass,
} from "./layout";

interface McpPageProps {
  site: SiteConfig;
  pageLinks?: Link[];
  currentPath?: string;
}

export default function McpPage({ site, pageLinks, currentPath }: McpPageProps) {
  const cfg = siteAirline(site);
  const mcpUrl = `https://${site.canonicalHost}/mcp`;
  const claudeConnectorsUrl = "https://claude.ai/settings/connectors?modal=add-custom-connector";
  const claudeCodeCommand = `claude mcp add --transport http starlink ${mcpUrl}`;
  const cursorInstallUrl = `cursor://anysphere.cursor-deeplink/mcp/install?name=starlink&config=${encodeURIComponent(btoa(JSON.stringify({ url: mcpUrl })))}`;
  const vscodeInstallUrl = `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: "starlink", type: "http", url: mcpUrl }))}`;
  return (
    <PageShell site={site} currentPath={currentPath} pageLinks={pageLinks}>
      <PageHeader
        title="Starlink Tracker for Claude"
        dek={
          <>
            Ask Claude whether your {cfg.shortName} flight has Starlink, and get alternatives if it
            doesn't.
          </>
        }
      />

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
        <Panel pad="sm">
          <Eyebrow className="mb-2">Claude Desktop · Settings → Connectors → Add</Eyebrow>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-sm text-accent break-all select-all bg-base rounded px-3 py-2 border border-subtle">
              {mcpUrl}
            </code>
            <button
              type="button"
              id="copy-url-btn"
              data-copy={mcpUrl}
              className={buttonClass("primary", "sm")}
            >
              Copy
            </button>
          </div>
          <div className="flex items-center gap-2 mt-3 pt-3 border-t border-subtle text-xs text-muted">
            <span className="whitespace-nowrap">Using Claude.ai or mobile?</span>
            <ButtonLink
              href={claudeConnectorsUrl}
              target="_blank"
              rel="noopener noreferrer"
              size="sm"
            >
              Open Connectors →
            </ButtonLink>
            <span>then paste the URL above.</span>
          </div>
        </Panel>
      </div>

      {/* Try asking — updated with the proven demo prompts */}
      <div className="relative max-w-2xl mx-auto w-full mb-8">
        <Panel>
          <SectionTitle className="mb-3">Try asking</SectionTitle>
          <ul className="space-y-2 text-sm text-muted">
            <li className="pl-4 -indent-4">
              <span className="text-secondary">"</span>I'm on {cfg.iata}642 on 3/13 — does it have
              Starlink? If not, what are my options?<span className="text-secondary">"</span>
            </li>
            <li className="pl-4 -indent-4">
              <span className="text-secondary">"</span>Flying SFO to EWR next month — plan me the
              best Starlink routing<span className="text-secondary">"</span>
            </li>
            <li className="pl-4 -indent-4">
              <span className="text-secondary">"</span>Does {cfg.iata}4680 tomorrow have Starlink?
              <span className="text-secondary">"</span>
            </li>
            <li className="pl-4 -indent-4">
              <span className="text-secondary">"</span>What's the Starlink install rate on{" "}
              {cfg.shortName}'s fleet?<span className="text-secondary">"</span>
            </li>
          </ul>
        </Panel>
      </div>

      {/* Setup details — collapsed */}
      <div className="relative max-w-2xl mx-auto w-full mb-8">
        <details className="bg-surface rounded-lg border border-subtle p-4 group">
          <summary className="cursor-pointer list-none flex items-center justify-between">
            <span className="font-display text-sm font-semibold text-secondary group-hover:text-accent transition-colors">
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
                  {mcpUrl}
                </code>{" "}
                and name it "Starlink Tracker"
              </p>
              <p>3. That's it. Seven tools are ready in your next chat.</p>
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
              <strong className="text-secondary">ChatGPT &amp; other MCP clients:</strong> same URL,{" "}
              <code className="font-mono text-xs">http</code> transport. It's a standard JSON-RPC
              2.0 endpoint with no auth and no SDK. In ChatGPT, enable Developer Mode in Advanced
              settings, then Settings → Connectors → Create.{" "}
              <a
                href="https://modelcontextprotocol.io/specification/2025-06-18/basic/transports"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                MCP spec →
              </a>
            </p>
            <div className="pt-2 border-t border-subtle space-y-2">
              <p>
                <strong className="text-secondary">Claude Code:</strong>
              </p>
              <code className="block font-mono text-xs text-accent break-all select-all bg-base rounded px-3 py-2 border border-subtle">
                {claudeCodeCommand}
              </code>
              <p className="flex items-center gap-2 pt-1">
                <ButtonLink href={cursorInstallUrl} size="sm">
                  Add to Cursor
                </ButtonLink>
                <ButtonLink href={vscodeInstallUrl} size="sm">
                  Add to VS Code
                </ButtonLink>
              </p>
            </div>
          </div>
        </details>
      </div>

      {(site.features.checkFlightPage || site.features.routePlannerPage) && (
        <p className="relative mx-auto mb-8 w-full max-w-2xl text-center text-sm text-secondary">
          Rather use the site?{" "}
          {site.features.checkFlightPage && (
            <a href="/check-flight" className="text-accent hover:underline">
              Check a flight
            </a>
          )}
          {site.features.checkFlightPage && site.features.routePlannerPage && " or "}
          {site.features.routePlannerPage && (
            <a href="/route-planner" className="text-accent hover:underline">
              plan a route
            </a>
          )}
          .
        </p>
      )}

      <ClientScriptTag name="mcp" />
    </PageShell>
  );
}
