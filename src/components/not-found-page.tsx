import type { SiteConfig } from "../airlines/registry";
import { ButtonLink, PageHeader, PageShell, primaryNavLinks } from "./layout";

/** Brand-static on purpose: the 404 is edge-cached, so nothing on it may vary
 * by request beyond the host's tenant. */
export default function NotFoundPage({ site }: { site: SiteConfig }) {
  const links = primaryNavLinks(site);
  return (
    <PageShell site={site}>
      <PageHeader title="Page not found" dek="That page doesn't exist, or it has moved." />
      <div className="relative mx-auto mb-12 flex flex-wrap justify-center gap-3 text-sm">
        <ButtonLink href="/">Go to the homepage</ButtonLink>
        {links.slice(0, 2).map((l) => (
          <ButtonLink key={l.href} href={l.href} variant="secondary">
            {l.label}
          </ButtonLink>
        ))}
      </div>
    </PageShell>
  );
}
