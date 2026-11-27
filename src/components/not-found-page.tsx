import { type SiteConfig, siteAirline } from "../airlines/registry";
import { ButtonLink, type Link, PageHeader, PageShell, primaryNavLinks } from "./layout";

/** What the dead address looked like: a tail we don't track, or a flight on a
 * host with no flight pages. Says where the answer is, and echoes nothing typed. */
export type NotFoundKind = "page" | "aircraft" | "aircraft-type" | "flight";

export function notFoundCopy(site: SiteConfig, kind: NotFoundKind): { title: string; dek: string } {
  if (kind === "aircraft") {
    const whose = site.scope === "ALL" ? "" : `${siteAirline(site).shortName} `;
    return {
      title: "Aircraft not found",
      dek: `That tail number isn't one of the ${whose}aircraft we track.${site.features.fleetPage ? " The fleet page lists every one." : ""}`,
    };
  }
  if (kind === "aircraft-type") {
    return {
      title: "Which aircraft did you mean?",
      dek: "That name is used for more than one aircraft type. Pick the one you're flying.",
    };
  }
  if (kind === "flight") {
    return {
      title: "No flight page here",
      dek: `The flight check on the homepage answers flights of the airlines we track, and no others.${site.features.airlinesPages ? " The airlines page lists them." : ""}`,
    };
  }
  return { title: "Page not found", dek: "That page doesn't exist, or it has moved." };
}

/** Brand-static on purpose: the 404 is edge-cached, so nothing on it may vary
 * by request beyond the host's tenant and the kind of address. */
export default function NotFoundPage({
  site,
  kind = "page",
  choices = [],
}: {
  site: SiteConfig;
  kind?: NotFoundKind;
  /** Pages the address could mean, built by the server from its own config. */
  choices?: Link[];
}) {
  const nav = primaryNavLinks(site);
  // The fleet list is where a tail is found, so it leads for one.
  const links =
    kind === "aircraft" || kind === "aircraft-type"
      ? [...nav].sort((a, b) => +(b.href === "/fleet") - +(a.href === "/fleet"))
      : nav;
  const { title, dek } = notFoundCopy(site, kind);
  return (
    <PageShell site={site}>
      <PageHeader title={title} dek={dek} />
      {choices.length > 0 && (
        <div className="relative mx-auto mb-6 flex flex-wrap justify-center gap-3 text-sm">
          {choices.map((c) => (
            <ButtonLink key={c.href} href={c.href}>
              {c.label}
            </ButtonLink>
          ))}
        </div>
      )}
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
