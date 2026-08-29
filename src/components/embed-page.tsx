import { AIRLINES, type SiteConfig } from "../airlines/registry";
import { PageFooter } from "./atoms";

const EYEBROW = "text-[10px] font-mono text-muted uppercase tracking-wider mb-3";
const PANEL = "bg-surface border border-subtle rounded-lg p-5 mb-4";
const SECTION = "relative w-full max-w-2xl mx-auto mb-8";

interface EmbedPageProps {
  site: SiteConfig;
}

function Snippet({ label, code }: { label: string; code: string }) {
  return (
    <div className="mb-4 last:mb-0">
      <div className="text-[10px] font-mono text-muted uppercase tracking-wider mb-1">{label}</div>
      <pre className="bg-surface-elevated border border-subtle rounded p-3 overflow-x-auto font-mono text-xs text-secondary whitespace-pre-wrap break-all">
        {code}
      </pre>
    </div>
  );
}

export default function EmbedPage({ site }: EmbedPageProps) {
  const host = site.canonicalHost;
  const scopeCode = site.scope !== "ALL" ? site.scope : null;
  const subject = scopeCode ? AIRLINES[scopeCode].name : "tracked airlines";
  const alt = scopeCode
    ? `${AIRLINES[scopeCode].shortName} Starlink rollout status`
    : "Airline Starlink rollout status";
  const badgeUrl = `https://${host}/badge.svg`;
  const homeUrl = `https://${host}/`;

  return (
    <div className="w-full mx-auto px-4 sm:px-6 md:px-8 bg-base min-h-screen flex flex-col relative">
      <div className="absolute inset-0 grid-pattern opacity-50 pointer-events-none" />

      <header className="relative py-5 sm:py-6 text-center mb-6">
        <a href="/" className="block">
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-primary mb-2 tracking-tight hover:text-accent transition-colors">
            Embed the Live Starlink Badge
          </h1>
        </a>
        <p className="text-base text-secondary font-display max-w-xl mx-auto">
          A tiny SVG badge with the live count of {subject} aircraft that have Starlink — it updates
          itself, your page never goes stale.
        </p>
      </header>

      <section className={SECTION}>
        <div className={PANEL}>
          <div className={EYEBROW}>Preview</div>
          <p className="mb-3">
            <img src="/badge.svg" alt={alt} height={20} />
          </p>
          <p className="text-[11px] text-muted leading-snug">
            Served straight from this tracker's database and cached for an hour, so the number is
            always the current one. No script, no tracking — one cacheable SVG.
          </p>
        </div>

        <div className={PANEL}>
          <div className={EYEBROW}>Copy a snippet</div>
          <Snippet
            label="HTML"
            code={`<a href="${homeUrl}"><img src="${badgeUrl}" alt="${alt}" height="20"></a>`}
          />
          <Snippet label="Markdown" code={`[![${alt}](${badgeUrl})](${homeUrl})`} />
          <p className="text-[11px] text-muted leading-snug">
            The badge is an image, so it works anywhere an <code>&lt;img&gt;</code> works — READMEs,
            blog posts, forum signatures, wikis. Linking it back here keeps readers one click from
            the full per-aircraft data, but the badge works without the link too.
          </p>
        </div>

        <div className={PANEL}>
          <div className={EYEBROW}>Want the numbers instead?</div>
          <p className="text-sm text-muted leading-relaxed">
            The same live data is available as JSON at{" "}
            <a href="/api/fleet-summary" className="text-accent hover:underline font-mono text-xs">
              /api/fleet-summary
            </a>{" "}
            (CORS enabled, no auth) if you'd rather render your own widget
            {site.features.newlyEquippedPage ? (
              <>
                , and the{" "}
                <a href="/feed.xml" className="text-accent hover:underline">
                  Atom feed
                </a>{" "}
                announces each newly equipped aircraft
              </>
            ) : null}
            .
          </p>
        </div>
      </section>

      <PageFooter site={site} />
    </div>
  );
}
