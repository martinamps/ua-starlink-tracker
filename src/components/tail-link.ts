import type { SiteConfig } from "../airlines/registry";

/**
 * /fleet/{tail} where this host has a page for the plane, else null and the
 * tail stays text. `airline` is the row's own airline when a list mixes
 * several: a tail page is the site airline's, never a partner's.
 */
export function tailHref(site: SiteConfig, tail: string, airline?: string): string | null {
  if (!site.features.tailPages) return null;
  if (airline !== undefined && airline !== site.scope) return null;
  return `/fleet/${tail}`;
}
