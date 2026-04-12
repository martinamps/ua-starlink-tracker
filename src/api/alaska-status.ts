/**
 * Alaska Airlines flight-status `__data.json` client.
 *
 * `https://www.alaskaair.com/status/{flight}/{YYYY-MM-DD}/__data.json` is a
 * SvelteKit-serialized SSR data payload. It serves both Alaska and Hawaiian
 * (post-merger) flights — `isHawaiian` distinguishes. Plain HTTP, no auth,
 * /status/ is robots-allowed.
 *
 * The Hawaiian wifi label on the rendered page is template-derived from
 * `isHawaiian` + `equipmentType` (not a backend field), so this endpoint is a
 * tail/type oracle, not an independent per-tail wifi source. See
 * ops/hawaiian-sourcing.md.
 *
 * fetchAlaskaFlightStatus is consumed by the alaska-json verifier (next slice);
 * shipped here so the client and the seed-hawaiian type map land together.
 */

import { COUNTERS, DISTRIBUTIONS, metrics, normalizeAirlineTag } from "../observability";
import { error as logError, warn } from "../utils/logger";

export interface AlaskaFlightStatus {
  flightNumber: string;
  tailNumber: string | null;
  carrierCode: string | null;
  equipmentType: string | null;
  equipmentName: string | null;
  operatingAirlineCode: string | null;
  isHawaiian: boolean;
  codeshares: { marketingAirlineCode: string; marketingFlightNumber: string }[];
}

const UA_HEADER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

type SvelteKitData = {
  type: "data";
  nodes: ({ type: "data"; data: unknown[] } | null)[];
};

/** SvelteKit's `devalue` flat encoding: index 0 is the root object whose
 * values are indices into the same array; -1 = undefined. */
function hydrate(data: unknown[], idx: number): unknown {
  if (idx === -1) return undefined;
  const v = data[idx];
  if (Array.isArray(v)) return v.map((i) => hydrate(data, i as number));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, i] of Object.entries(v as Record<string, number>)) {
      out[k] = hydrate(data, i);
    }
    return out;
  }
  return v;
}

export async function fetchAlaskaFlightStatus(
  flightNumber: number | string,
  dateISO: string,
  airline: string
): Promise<AlaskaFlightStatus | null> {
  const url = `https://www.alaskaair.com/status/${flightNumber}/${dateISO}/__data.json`;
  const start = Date.now();
  const airlineTag = normalizeAirlineTag(airline);
  let status = "error";
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA_HEADER, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      status = res.status === 429 ? "rate_limited" : "error";
      warn(`alaska-status ${flightNumber}/${dateISO} → HTTP ${res.status}`);
      return null;
    }
    const body = (await res.json()) as SvelteKitData;
    // SvelteKit emits root→leaf; the page node (with `flights`) is last.
    const node = [...(body.nodes ?? [])].reverse().find((n) => n?.type === "data");
    if (!node?.data) {
      status = "parse_error";
      return null;
    }
    const root = hydrate(node.data, 0) as {
      flightNumber?: string;
      flights?: Record<string, unknown>[];
    };
    const f = root.flights?.[0];
    if (!f) {
      status = "success";
      return null;
    }
    status = "success";
    return {
      flightNumber: String(root.flightNumber ?? flightNumber),
      tailNumber: (f.tailNumber as string) ?? null,
      carrierCode: (f.carrierCode as string) ?? null,
      equipmentType: (f.equipmentType as string) ?? null,
      equipmentName: (f.equipmentName as string) ?? null,
      operatingAirlineCode: (f.operatingAirlineCode as string) ?? null,
      isHawaiian: f.isHawaiian === true,
      codeshares: ((f.codeshares as AlaskaFlightStatus["codeshares"]) ?? []).filter(
        (c) => c?.marketingAirlineCode
      ),
    };
  } catch (err) {
    logError(`alaska-status ${flightNumber}/${dateISO} failed`, err);
    return null;
  } finally {
    const duration = Date.now() - start;
    const tags = { vendor: "alaska", type: "status", status, airline: airlineTag };
    metrics.increment(COUNTERS.VENDOR_REQUEST, tags);
    metrics.distribution(DISTRIBUTIONS.VENDOR_DURATION_MS, duration, tags);
  }
}

export type HawaiianWifi = "Starlink" | "None" | "pending";

/**
 * Hawaiian's rollout is type-deterministic and complete (Sep 2024) for the
 * Airbus fleet. This encodes the same rule alaskaair.com hardcodes in its
 * status page bundle.
 */
export function hawaiianTypeToStarlink(equipmentType: string | null | undefined): HawaiianWifi {
  if (!equipmentType) return "None";
  const t = equipmentType.toUpperCase();
  if (/\bA330|^A332\b/.test(t)) return "Starlink";
  if (/\bA321[-\s]?2\d{2}N|\bA321\s?NEO|^A21N\b/.test(t)) return "Starlink";
  if (/\b787|^B789\b/.test(t)) return "pending";
  if (/\b717|^B712\b/.test(t)) return "None";
  return "None";
}
