/**
 * Log-noise pass 2: the verifier family was 36.5% of all log volume after #81.
 *
 * Two behaviors pinned here:
 *  - The verified_wifi transition line is change-gated: a settle that writes
 *    the value already on file logs at debug; an actual transition logs info.
 *  - The rate limiter's early return emits HTTP_REQUEST (status 429). It used
 *    to bypass the count-every-request emit entirely — one incident fired 357
 *    rate-limit responses and zero appeared in the request metric.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { metrics } from "../src/observability/metrics";
import { type UnitedVerdict, applyUnitedObservation } from "../src/scripts/united-verdict";
import { createApp } from "../src/server/app";
import { addFleet, addPlane, makeSyntheticDb, openSnapshot, req } from "./helpers";

const starlinkVerdict = (tail: string): UnitedVerdict => ({
  expectedTail: tail,
  resolvedTail: tail,
  category: "starlink",
  tailMismatch: false,
  tailUnknown: false,
  untrustedNonStarlink: false,
  trusted: true,
  wifiProvider: "Starlink",
  observation: { has_starlink: true, wifi_provider: "Starlink", tail_confirmed: 1, error: null },
  swapCapture: null,
});

describe("verified_wifi transition logging is change-gated", () => {
  test("first settle (a transition) logs info; re-confirmations log debug", () => {
    const db = makeSyntheticDb();
    // The settle writes starlink_planes.verified_wifi, so the tail must exist
    // there; united_fleet rides along for the discovery-priority path.
    addPlane(db, "N777UA", null);
    addFleet(db, "N777UA", null, { verifiedWifi: null });
    const infoLines: string[] = [];
    const debugLines: string[] = [];
    const log = {
      info: (m: string) => infoLines.push(m),
      warn: () => {},
      debug: (m: string) => debugLines.push(m),
    };

    for (let i = 0; i < 3; i++) {
      applyUnitedObservation(db, starlinkVerdict("N777UA"), {
        flightNumber: "UA100",
        aircraftType: "B737-900",
        log,
      });
    }

    const transitions = infoLines.filter((m) => m.includes("verified_wifi →"));
    const reconfirms = debugLines.filter((m) => m.includes("verified_wifi →"));
    // Call 1 cannot settle (consensus needs 2 recent obs); call 2 is the real
    // transition (null → Starlink); call 3 re-writes the value already on file.
    expect(transitions.length).toBe(1);
    expect(reconfirms.length).toBe(1);
    db.close();
  });
});

describe("rate-limited responses are counted", () => {
  let app: ReturnType<typeof createApp>;
  beforeAll(() => {
    app = createApp(openSnapshot());
  });

  test("a 429 emits HTTP_REQUEST with status_code 429 and a real route tag", async () => {
    const calls: Array<{ name: string; tags: Record<string, unknown> }> = [];
    const original = metrics.increment;
    metrics.increment = (name, tags) => {
      calls.push({ name, tags: (tags ?? {}) as Record<string, unknown> });
      original(name, tags);
    };
    try {
      // Dedicated source IP so the flood cannot poison other tests' buckets.
      const headers = { "cf-connecting-ip": "203.0.113.99" };
      let sawLimit = false;
      for (let i = 0; i < 130 && !sawLimit; i++) {
        const res = await app.dispatch(req("/api/data", "unitedstarlinktracker.com", { headers }));
        sawLimit = res.status === 429;
      }
      expect(sawLimit).toBe(true);
      const limited = calls.filter((c) => c.name === "http.request" && c.tags.status_code === 429);
      expect(limited.length).toBeGreaterThan(0);
      expect(limited[0].tags.route).toBe("/api/data");
      expect(String(limited[0].tags.route)).not.toContain("*");
    } finally {
      metrics.increment = original;
    }
  });
});
