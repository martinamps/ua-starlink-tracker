/**
 * "Your flights" on a homepage (src/client/recent-checks.ts): the two
 * addresses its script calls, and who may call them.
 *
 * The list of flights lives in the visitor's browser and never reaches the
 * server. The script asks for one flight's answer at a time, the request the
 * flight's own page makes, and sends one word when the list is shown, opened
 * or cleared. Neither request carries a cookie, an identifier or the list.
 *
 * Both ride the /static family (and so its `route` tag), like the share
 * control's beacon: the tag budget has no room for a route of their own.
 * Neither is a public interface: both answer only a browser on this host's
 * own pages (fromOurPageInABrowser). The answer is our own page's sentence
 * for our own page, shaped to change with it; the API is /api/check-flight.
 */
import {
  COUNTERS,
  metrics,
  normalizeRecentAction,
  normalizeScopeTag,
} from "../observability/metrics";
import { BASE_RESPONSE_HEADERS } from "../utils/constants";
import { type RequestContext, tenantScope } from "./context";
import { empty, methodNotAllowed } from "./respond";
import { fromOurPageInABrowser, shortBody } from "./share-tap";

export const RECENT_PREFIX = "/static/recent/";
export const RECENT_TAP_PATH = "/static/recent/tap";

/**
 * POST /static/recent/tap with the body "shown", "opened" or "cleared".
 * Always 202 for a POST, counted or not, so the answer tells a prober
 * nothing; any other method is a 405.
 */
export async function recentTap(ctx: RequestContext): Promise<Response> {
  if (ctx.req.method !== "POST") return methodNotAllowed(["POST"]);
  const accepted = empty(202, { ...BASE_RESPONSE_HEADERS, "Cache-Control": "no-store" });
  if (!fromOurPageInABrowser(ctx.req, ctx.url)) return accepted;
  const action = normalizeRecentAction(await shortBody(ctx.req));
  if (action) {
    metrics.increment(COUNTERS.RECENT_CHECKS, {
      airline: normalizeScopeTag(tenantScope(ctx.tenant)),
      action,
    });
  }
  return accepted;
}
