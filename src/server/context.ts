/**
 * HTTP request context. Wraps the database-layer ScopedReader with the
 * resolved tenant + site so route handlers receive only what they need.
 */

import type { AirlineConfig, SiteConfig, Tenant } from "../airlines/registry";
import type { Database, Scope, ScopedReader } from "../database/reader";
import { createReaderFactory } from "../database/reader";

export type { Database, Scope, ScopedReader };
export { createReaderFactory };

export interface RequestContext {
  req: Request;
  url: URL;
  site: SiteConfig;
  tenant: Tenant;
  reader: ScopedReader;
  /** Mint a reader for a specific airline (hub endpoints that detect airline from flight-number prefix). */
  getReader: (scope: Scope) => ScopedReader;
}

export function tenantScope(tenant: Tenant): Scope {
  return tenant === "ALL" ? "ALL" : tenant.code;
}

export function tenantConfig(tenant: Tenant): AirlineConfig | null {
  return tenant === "ALL" ? null : tenant;
}
