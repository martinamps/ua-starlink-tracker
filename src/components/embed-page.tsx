import { AIRLINES, type SiteConfig } from "../airlines/registry";
import type { Link } from "./layout";
import { EYEBROW, Eyebrow, PANEL, PageHeader, PageShell, SECTION } from "./layout";

interface EmbedPageProps {
  site: SiteConfig;
  /** Does this tenant actually appear in /api/fleet-summary? The endpoint
   * serves publicAirlines() only, so on a non-hub tenant (QR) the documented
   * link would hand a visitor three other carriers and none of theirs. */
  inFleetSummary: boolean;
  /** Is /feed.xml live here? It rides both the feature flag and the
   * install-log data gate, so the flag alone would link a 404. */
  feedAvailable: boolean;
  pageLinks?: Link[];
  currentPath?: string;
}

function Snippet({ label, code }: { label: string; code: string }) {
  return (
    <div className="mb-4 last:mb-0">
      <Eyebrow className="mb-1">{label}</Eyebrow>
      <pre className="bg-surface-elevated border border-subtle rounded p-3 overflow-x-auto font-mono text-xs text-secondary whitespace-pre-wrap break-all">
        {code}
      </pre>
    </div>
  );
}

export default function EmbedPage({
  site,
  inFleetSummary,
  feedAvailable,
  pageLinks,
  currentPath,
}: EmbedPageProps) {
  const host = site.canonicalHost;
  const scopeCode = site.scope !== "ALL" ? site.scope : null;
  const subject = scopeCode ? AIRLINES[scopeCode].name : "tracked airlines";
  const alt = scopeCode
    ? `${AIRLINES[scopeCode].shortName} Starlink rollout status`
    : "Airline Starlink rollout status";
  const badgeUrl = `https://${host}/badge.svg`;
  const homeUrl = `https://${host}/`;

  return (
    <PageShell site={site} currentPath={currentPath} pageLinks={pageLinks}>
      <PageHeader
        title="Embed the Live Starlink Badge"
        dek={
          <>
            A tiny SVG badge with the live count of {subject} aircraft that have Starlink — it
            updates itself, your page never goes stale.
          </>
        }
      />

      <section className={SECTION}>
        <div className={`${PANEL} mb-4`}>
          <div className={EYEBROW}>Preview</div>
          <p className="mb-3">
            <img src="/badge.svg" alt={alt} height={20} />
          </p>
          <p className="text-xs text-muted leading-snug">
            Served straight from this tracker's database and updated hourly — caches may hold an
            older copy for up to a day. No script, no tracking — one cacheable SVG.
          </p>
        </div>

        <div className={`${PANEL} mb-4`}>
          <div className={EYEBROW}>Copy a snippet</div>
          <Snippet
            label="HTML"
            code={`<a href="${homeUrl}"><img src="${badgeUrl}" alt="${alt}" height="20"></a>`}
          />
          <Snippet label="Markdown" code={`[![${alt}](${badgeUrl})](${homeUrl})`} />
          <p className="text-xs text-muted leading-snug">
            The badge is an image, so it works anywhere an <code>&lt;img&gt;</code> works — READMEs,
            blog posts, forum signatures, wikis. Linking it back here keeps readers one click from
            the full per-aircraft data, but the badge works without the link too.
          </p>
        </div>

        {(inFleetSummary || feedAvailable) && (
          <div className={`${PANEL} mb-4`}>
            <div className={EYEBROW}>Want the numbers instead?</div>
            {inFleetSummary && (
              <p className="text-sm text-muted leading-relaxed">
                The same live data is available as JSON at{" "}
                <a
                  href="/api/fleet-summary"
                  className="text-accent hover:underline font-mono text-xs"
                >
                  /api/fleet-summary
                </a>{" "}
                (CORS enabled, no auth) if you'd rather render your own widget.
              </p>
            )}
            {feedAvailable && (
              <p className="text-sm text-muted leading-relaxed mt-2">
                The{" "}
                <a href="/feed.xml" className="text-accent hover:underline">
                  Atom feed
                </a>{" "}
                announces each newly equipped aircraft as it lands.
              </p>
            )}
          </div>
        )}
      </section>
    </PageShell>
  );
}
