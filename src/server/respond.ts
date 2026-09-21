/**
 * Response builders for the dispatcher and its handlers. JSON always carries
 * SECURITY_HEADERS.api (CSP, nosniff and the /api CORS contract), so a handler
 * can't ship a JSON body the extension can't read cross-origin.
 */

import { SECURITY_HEADERS } from "../utils/constants";

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

export function methodNotAllowed(asJson = false): Response {
  return asJson
    ? jsonError(405, "Method not allowed")
    : text("Method not allowed", "text/plain", { status: 405 });
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
