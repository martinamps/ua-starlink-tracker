/**
 * Response builders for the dispatcher and its handlers. JSON always carries
 * SECURITY_HEADERS.api (CSP, nosniff and the /api CORS contract), so a handler
 * can't ship a JSON body the extension can't read cross-origin.
 */

import { BASE_RESPONSE_HEADERS, MCP_CORS_HEADERS, SECURITY_HEADERS } from "../utils/constants";

export { CORS_ANY_ORIGIN } from "../utils/constants";

export const CACHE = {
  fiveMinutes: "public, max-age=300",
  fifteenMinutes: "public, max-age=900",
  hour: "public, max-age=3600",
  hourStaleDay: "public, max-age=3600, stale-while-revalidate=86400",
  day: "public, max-age=86400",
  year: "public, max-age=31536000, immutable",
} as const;

export interface ResponseOptions {
  status?: number;
  cache?: string;
  headers?: Record<string, string>;
}

function headersFor(base: Record<string, string>, opts: ResponseOptions): Record<string, string> {
  return {
    ...base,
    ...(opts.cache ? { "Cache-Control": opts.cache } : {}),
    ...opts.headers,
  };
}

export function json(body: unknown, opts: ResponseOptions & { pretty?: boolean } = {}): Response {
  return new Response(JSON.stringify(body, null, opts.pretty ? 2 : undefined), {
    status: opts.status,
    headers: headersFor(SECURITY_HEADERS.api, opts),
  });
}

export function jsonError(status: number, error: string, opts: ResponseOptions = {}): Response {
  return json({ error }, { ...opts, status });
}

export function text(
  body: BodyInit | null,
  contentType = "text/plain",
  opts: ResponseOptions = {}
): Response {
  return new Response(body, {
    status: opts.status,
    headers: headersFor({ "Content-Type": contentType }, opts),
  });
}

export function xml(body: string, opts: ResponseOptions = {}): Response {
  return text(body, "application/xml", opts);
}

/** 405 with the Allow header RFC 9110 requires. */
export function methodNotAllowed(
  allow: readonly string[],
  asJson = false,
  headers: Record<string, string> = {}
): Response {
  const opts = { status: 405, headers: { Allow: allow.join(", "), ...headers } };
  return asJson
    ? json({ error: "Method not allowed" }, opts)
    : text("Method not allowed", "text/plain", opts);
}

const MCP_HEADERS = { ...BASE_RESPONSE_HEADERS, ...MCP_CORS_HEADERS };

/** A /mcp protocol response: the MCP CORS contract rather than /api's, and no
 * Cache-Control (the pinned MCP headers carry none). Null body for a 202. */
export function jsonRpc(body: unknown, status = 200): Response {
  return body === null
    ? new Response(null, { status, headers: MCP_HEADERS })
    : text(JSON.stringify(body), "application/json", { status, headers: MCP_HEADERS });
}

export function mcpMethodNotAllowed(): Response {
  return methodNotAllowed(["POST"], false, MCP_HEADERS);
}

/** A same-origin redirect. The Location stays relative so local and staging
 * hosts keep their own origin. */
export function redirect(location: string, status: 301 | 302 = 302): Response {
  return new Response(null, { status, headers: { Location: location } });
}

/** Copy `res` with `defaults` filled in wherever the handler set nothing. */
export function withDefaultHeaders(
  res: Response,
  defaults: Record<string, string>,
  edit?: (headers: Headers) => boolean
): Response {
  const headers = new Headers(res.headers);
  let changed = false;
  for (const [k, v] of Object.entries(defaults)) {
    if (!headers.has(k)) {
      headers.set(k, v);
      changed = true;
    }
  }
  if (edit?.(headers)) changed = true;
  if (!changed) return res;
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
