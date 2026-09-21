import type React from "react";
import type { SiteConfig } from "../../airlines/registry";
import { Panel, Section } from "../layout";

export const CHROME_EXTENSION_URL =
  "https://chromewebstore.google.com/detail/google-flights-starlink-i/jjfljoifenkfdbldliakmmjhdkbhehoi";

function ToolCard({
  id,
  icon,
  name,
  audience,
  href,
  cta,
  external = false,
  children,
}: {
  id: string;
  icon: React.ReactNode;
  name: string;
  audience: string;
  href: string;
  cta: string;
  external?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Panel id={id} className="flex flex-col scroll-mt-4">
      <div className="flex items-start gap-3 mb-3">
        {icon}
        <div>
          <div className="font-display text-primary text-sm">{name}</div>
          <div className="text-xs text-muted">{audience}</div>
        </div>
      </div>
      <p className="text-sm text-secondary leading-relaxed mb-4 flex-1">{children}</p>
      <a
        href={href}
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        className="text-xs text-accent hover:underline font-mono"
      >
        {cta}
      </a>
    </Panel>
  );
}

const ChromeIcon = () => (
  <svg
    className="w-8 h-8 flex-shrink-0"
    viewBox="0 0 48 48"
    xmlns="http://www.w3.org/2000/svg"
    role="img"
    aria-label="Chrome"
  >
    <defs>
      <linearGradient
        id="chrome-a"
        x1="3.2173"
        y1="15"
        x2="44.7812"
        y2="15"
        gradientUnits="userSpaceOnUse"
      >
        <stop offset="0" stopColor="#d93025" />
        <stop offset="1" stopColor="#ea4335" />
      </linearGradient>
      <linearGradient
        id="chrome-b"
        x1="20.7219"
        y1="47.6791"
        x2="41.5039"
        y2="11.6837"
        gradientUnits="userSpaceOnUse"
      >
        <stop offset="0" stopColor="#fcc934" />
        <stop offset="1" stopColor="#fbbc04" />
      </linearGradient>
      <linearGradient
        id="chrome-c"
        x1="26.5981"
        y1="46.5015"
        x2="5.8161"
        y2="10.506"
        gradientUnits="userSpaceOnUse"
      >
        <stop offset="0" stopColor="#1e8e3e" />
        <stop offset="1" stopColor="#34a853" />
      </linearGradient>
    </defs>
    <circle cx="24" cy="23.9947" r="12" fill="#fff" />
    <path
      d="M24,12H44.7812a23.9939,23.9939,0,0,0-41.5639.0029L13.6079,30l.0093-.0024A11.9852,11.9852,0,0,1,24,12Z"
      fill="url(#chrome-a)"
    />
    <circle cx="24" cy="24" r="9.5" fill="#1a73e8" />
    <path
      d="M34.3913,30.0029,24.0007,48A23.994,23.994,0,0,0,44.78,12.0031H23.9989l-.0025.0093A11.985,11.985,0,0,1,34.3913,30.0029Z"
      fill="url(#chrome-b)"
    />
    <path
      d="M13.6086,30.0031,3.218,12.006A23.994,23.994,0,0,0,24.0025,48L34.3931,30.0029l-.0067-.0068a11.9852,11.9852,0,0,1-20.7778.007Z"
      fill="url(#chrome-c)"
    />
  </svg>
);

const McpIcon = () => (
  <div className="w-8 h-8 flex-shrink-0 rounded bg-accent/20 border border-accent/40 flex items-center justify-center">
    <svg
      className="w-5 h-5 text-accent"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      role="img"
      aria-label="AI"
    >
      <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
    </svg>
  </div>
);

/** The Chrome extension and the MCP server, where the site offers them. */
export function ToolsSection({ site }: { site: SiteConfig }) {
  const f = site.features;
  if (!f.chromeExtension && !f.mcpPage) return null;
  return (
    <Section bare wide id="integrations" className="scroll-mt-4" title="Tools and integrations">
      <div className="grid sm:grid-cols-2 gap-3">
        {f.chromeExtension && (
          <ToolCard
            id="chrome-extension"
            icon={<ChromeIcon />}
            name="Chrome Extension"
            audience="For Google Flights"
            href={CHROME_EXTENSION_URL}
            cta="Add to Chrome →"
            external
          >
            See which flights have Starlink right in your Google Flights results.
          </ToolCard>
        )}
        {f.mcpPage && (
          <ToolCard
            id="mcp"
            icon={<McpIcon />}
            name="MCP Server"
            audience="For Claude, Cursor & AI assistants"
            href="/mcp"
            cta="Setup instructions →"
          >
            Ask your AI assistant to check a flight, estimate its Starlink odds or plan a route,
            using this tracker's live data.
          </ToolCard>
        )}
      </div>
    </Section>
  );
}
