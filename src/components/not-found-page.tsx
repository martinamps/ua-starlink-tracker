import type { SiteConfig } from "../airlines/registry";
import { PageHeader, PageShell, primaryNavLinks } from "./layout";

/** Brand-static on purpose: the 404 is edge-cached, so nothing on it may vary
 * by request beyond the host's tenant. */
export default function NotFoundPage({ site }: { site: SiteConfig }) {
  const links = primaryNavLinks(site);
  return (
    <PageShell site={site}>
      <PageHeader title="Page not found" dek="That page doesn't exist, or it has moved." />
      <div className="relative mx-auto mb-12 flex flex-wrap justify-center gap-3 text-sm">
        <a
          href="/"
          className="rounded border border-accent bg-accent/20 px-4 py-2 text-accent hover:bg-accent/30 transition-colors"
        >
          Go to the homepage
        </a>
        {links.slice(0, 2).map((l) => (
          <a
            key={l.href}
            href={l.href}
            className="rounded border border-subtle bg-surface px-4 py-2 text-secondary hover:border-accent hover:text-accent transition-colors"
          >
            {l.label}
          </a>
        ))}
      </div>
    </PageShell>
  );
}
