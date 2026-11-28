/**
 * What an outbound span may say about the address it called. Some vendors
 * put the credential in the URL itself: a Slack incoming webhook's path is
 * the secret (anyone holding it can post to the channel), and the Sheets API
 * takes its key as a query parameter. Spans keep scheme, host and port so
 * APM still groups calls by vendor; userinfo, query and fragment always go,
 * and the path goes on hosts whose path is a credential.
 */

export const REDACTED_PATH = "/[redacted]";

const SECRET_PATH_HOSTS = new Set(["hooks.slack.com"]);

export function redactOutboundUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return REDACTED_PATH;
  }
  const path = SECRET_PATH_HOSTS.has(url.hostname.toLowerCase()) ? REDACTED_PATH : url.pathname;
  return `${url.protocol}//${url.host}${path}`;
}

interface TaggableSpan {
  setTag(name: string, value: unknown): void;
}

/**
 * dd-trace http-client `hooks.request`: runs before the span finishes, on
 * success and failure alike, so its `http.url` replaces the one the plugin
 * wrote at start.
 */
export function redactOutboundSpan(span: TaggableSpan | undefined, req: unknown): void {
  if (!span) return;
  const raw = (req as { url?: unknown } | undefined)?.url;
  span.setTag("http.url", typeof raw === "string" ? redactOutboundUrl(raw) : REDACTED_PATH);
}
