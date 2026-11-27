/**
 * Counting the share control on a flight answer: how often it was served, and
 * how often it was tapped. A count is one word and the site it happened on.
 * The flight, the date, the page, the visitor's address and agent are read
 * nowhere here and reach no metric, span or log.
 *
 * The tap beacon rides the /static family (and so its `route` tag), like the
 * share pictures beside it: the tag budget has no room for a route of its own.
 */
import type { SiteConfig } from "../airlines/registry";
import {
  COUNTERS,
  type ShareAction,
  classifyPreload,
  classifyRequest,
  metrics,
  normalizeScopeTag,
  normalizeShareAction,
} from "../observability/metrics";
import { BASE_RESPONSE_HEADERS } from "../utils/constants";
import { type RequestContext, tenantScope } from "./context";
import { empty, methodNotAllowed } from "./respond";

export const SHARE_TAP_PATH = "/static/share/tap";

/** "sheet" and "copy" are four and five bytes; nothing longer is ever read. */
const MAX_TAP_BODY = 16;

const count = (scope: string, action: ShareAction) =>
  metrics.increment(COUNTERS.SHARE_CONTROL, { airline: normalizeScopeTag(scope), action });

/** The body when it is at most MAX_TAP_BODY bytes; a longer one is dropped
 * unread past that, whatever length it declared or did not. */
export async function shortBody(req: Request): Promise<string | null> {
  if (Number(req.headers.get("content-length") ?? "0") > MAX_TAP_BODY || !req.body) return null;
  const reader = req.body.getReader();
  const bytes: number[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (bytes.length + value.length > MAX_TAP_BODY) {
        await reader.cancel();
        return null;
      }
      bytes.push(...value);
    }
  } catch {
    return null;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * A request our own page's script made from a browser. Robots that fetch
 * addresses found in a script send a GET, or no Sec-Fetch-Site, or name
 * themselves in their agent; none of those count. One that drives a real
 * browser and clicks the control does count: nothing here can tell it from a
 * person.
 */
export function fromOurPageInABrowser(req: Request, url: URL): boolean {
  return (
    req.headers.get("sec-fetch-site") === "same-origin" && classifyRequest(req, url) === "browser"
  );
}

/**
 * POST /static/share/tap with the body "sheet" or "copy". Always 202 for a
 * POST, counted or not, so the answer tells a prober nothing; any other
 * method is a 405.
 */
export async function shareTap(ctx: RequestContext): Promise<Response> {
  if (ctx.req.method !== "POST") return methodNotAllowed(["POST"]);
  const accepted = empty(202, { ...BASE_RESPONSE_HEADERS, "Cache-Control": "no-store" });
  if (!fromOurPageInABrowser(ctx.req, ctx.url)) return accepted;
  const body = await shortBody(ctx.req);
  const method = normalizeShareAction(body);
  if (method) count(tenantScope(ctx.tenant), method);
  return accepted;
}

/**
 * A dated answer page went out with the control on it. Counted for a browser
 * that asked for the page itself: not a robot by its agent, and not a load
 * the browser made ahead of a click that may never come.
 */
export function recordShareShown(req: Request, url: URL, site: SiteConfig): void {
  if (req.method !== "GET") return;
  if (classifyRequest(req, url) !== "browser" || classifyPreload(req) !== "none") return;
  count(site.scope, "shown");
}
