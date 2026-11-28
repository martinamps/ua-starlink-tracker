/**
 * The three addresses of "Tell me if this changes" (database/flight-notice.ts):
 *
 *   GET  /static/notice/sw.js         the service worker, at a stable path
 *   POST /static/notice/subscribe     {endpoint, keys, f, d, o?}
 *   POST /static/notice/unsubscribe   {endpoint, f, d}
 *
 * They ride the /static family, and so its `route` tag, like the share and
 * "Your flights" beacons: the tag budget has no room for a family of its own.
 * With the switch off none of them exists: the request falls through to the
 * static directory exactly as before. Subscribing answers only a browser on
 * this host's own pages (fromOurPageInABrowser), for a flight page this host
 * serves. Nothing from the request but the push endpoint, its keys, the
 * flight, the date and the chosen leg is stored, logged or tagged.
 */
import { clientScriptCode } from "../client/bundle";
import { MAX_PER_ENDPOINT, type NoticeStore } from "../database/flight-notice";
import {
  COUNTERS,
  metrics,
  normalizeNoticeAction,
  normalizeScopeTag,
} from "../observability/metrics";
import { flightDateWindow } from "../utils/airport-tz";
import { BASE_RESPONSE_HEADERS } from "../utils/constants";
import { type RequestContext, tenantConfig, tenantScope } from "./context";
import { CACHE, json, methodNotAllowed, text } from "./respond";
import { fromOurPageInABrowser } from "./share-tap";

export const NOTICE_PREFIX = "/static/notice/";
export const NOTICE_WORKER_PATH = "/static/notice/sw.js";
const SUBSCRIBE_PATH = "/static/notice/subscribe";
const UNSUBSCRIBE_PATH = "/static/notice/unsubscribe";

/** Endpoint (≤1 KB), two keys, a flight, a date and an airport fit well inside. */
const MAX_BODY = 2048;
/** The calendar feed's own horizon (flight-answer.ts WATCH_MAX_DAYS_OUT). */
const MAX_DAYS_OUT = 330;

export function countNotice(scope: string, raw: string): void {
  const action = normalizeNoticeAction(raw);
  if (action)
    metrics.increment(COUNTERS.FLIGHT_NOTICE, { airline: normalizeScopeTag(scope), action });
}

async function boundedJson(req: Request): Promise<Record<string, unknown> | null> {
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY || !req.body) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BODY) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The page's own flight, in the one spelling its address uses; null for any other. */
export type FlightCheck = (ctx: RequestContext, f: string, d: string) => string | null;

const noStore = {
  ...BASE_RESPONSE_HEADERS,
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
};

/**
 * The handler for the three addresses, or null for a path that isn't one of
 * them or while the switch is off: the caller then serves the static file.
 */
export function createNoticeHandler(
  store: NoticeStore,
  checkFlight: FlightCheck
): (ctx: RequestContext) => Promise<Response> | null {
  return (ctx) => {
    const path = ctx.url.pathname;
    if (!path.startsWith(NOTICE_PREFIX) || !store.enabled()) return null;
    if (path === NOTICE_WORKER_PATH) return Promise.resolve(worker(ctx));
    if (path === SUBSCRIBE_PATH || path === UNSUBSCRIBE_PATH)
      return change(ctx, path === SUBSCRIBE_PATH);
    return null;
  };

  function worker(ctx: RequestContext): Response {
    if (ctx.req.method !== "GET" && ctx.req.method !== "HEAD") return methodNotAllowed(["GET"]);
    const code = clientScriptCode("notice-sw");
    if (!code) return text("Not found", "text/plain", { status: 404, cache: CACHE.noStore });
    // Browsers check a worker for updates on their own; a short cache keeps
    // a deploy's new worker from waiting a day.
    return new Response(code, {
      headers: {
        ...BASE_RESPONSE_HEADERS,
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      },
    });
  }

  async function change(ctx: RequestContext, subscribe: boolean): Promise<Response> {
    if (ctx.req.method !== "POST") return methodNotAllowed(["POST"]);
    const answer = (ok: boolean, status = 200) => json({ ok }, { status, headers: noStore });
    const scope = tenantScope(ctx.tenant);
    const pinned = tenantConfig(ctx.tenant);
    if (!pinned || !ctx.site.features.checkFlightPage || !fromOurPageInABrowser(ctx.req, ctx.url)) {
      return answer(false, 403);
    }
    const body = await boundedJson(ctx.req);
    const f = typeof body?.f === "string" ? body.f : "";
    const d = typeof body?.d === "string" ? body.d : "";
    const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
    const fn = body ? checkFlight(ctx, f, d) : null;
    const window = flightDateWindow(d);
    if (!fn || !window || window.daysOut > MAX_DAYS_OUT || window.daysOut < -1) {
      return answer(false, 400);
    }
    if (!subscribe) {
      if (store.unsubscribe(endpoint, pinned.code, fn, d)) countNotice(scope, "unsubscribed");
      return answer(true);
    }
    const keys = body?.keys as { p256dh?: unknown; auth?: unknown } | undefined;
    const o = typeof body?.o === "string" && /^[A-Z]{3}$/.test(body.o) ? body.o : null;
    const result = store.subscribe(
      {
        endpoint,
        keys: { p256dh: keys?.p256dh as string, auth: keys?.auth as string },
        airline: pinned.code,
        flightNumber: fn,
        depDate: d,
        origin: o,
      },
      Math.floor(Date.now() / 1000)
    );
    if (result === "stored") {
      countNotice(scope, "subscribed");
      return answer(true);
    }
    if (result === "full") {
      return json({ ok: false, limit: MAX_PER_ENDPOINT }, { status: 429, headers: noStore });
    }
    return answer(false, result === "off" ? 404 : 400);
  }
}
