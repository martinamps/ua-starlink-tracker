// CIDR matching, geofeed parsing, and the passenger-probe trust model
// (server records its own IP/geofeed verdict, never trusts client claims).

import { describe, expect, test } from "bun:test";
import { replaceStarlinkPrefixes } from "../src/database/database";
import { parseGeofeed, runGeofeedSync } from "../src/scripts/starlink-geofeed";
import {
  PROBE_SNIPPET,
  StarlinkIpDetector,
  handlePassengerProbe,
} from "../src/server/passenger-detect";
import { PrefixSet, dedupePrefix, ipToBigint, parseCidr } from "../src/utils/ip-prefix";
import { makeSyntheticDb } from "./helpers";

// The two prefixes observed live on UA2019 / N73275 (2026-06-13).
const UA2019_V4 = "74.244.242.0/24";
const UA2019_V6 = "2605:59ca:8010::/45";
const ONBOARD_IP_V4 = "74.244.242.158";
const ONBOARD_IP_V6 = "2605:59ca:8015:b40:f410:c136:b5cc:9db0";

const FEED = `# RFC 8805 — geofeed
${UA2019_V4},US,US-IL,Chicago,
${UA2019_V6},US,US-IL,Chicago,
9.246.0.0/24,FR,FR-IDF,Paris,
2a0d:3340::/32,DE,,Frankfurt,
not-a-cidr,XX,,,
`;

describe("ip-prefix", () => {
  test("v4 + v6 round-trip and CIDR bounds", () => {
    expect(ipToBigint("74.244.242.158")?.value).toBe(0x4af4f29en);
    expect(ipToBigint("::1")?.value).toBe(1n);
    expect(ipToBigint("999.0.0.1")).toBeNull();
    expect(ipToBigint("2605::1::2")).toBeNull();
    const p = parseCidr(UA2019_V6)!;
    expect(p.v6).toBe(true);
    expect(p.hi - p.lo).toBe((1n << 83n) - 1n);
  });

  test("malformed input returns null instead of throwing", () => {
    // attacker-set XFF must never RangeError
    expect(ipToBigint("::1:2:3:4:5:6:7:8:9")).toBeNull();
    expect(ipToBigint("1:2:3:4:5:6:7:8:9")).toBeNull();
    // empty/zero mask is rejected, not match-everything
    expect(parseCidr("1.2.3.4/")).toBeNull();
    expect(parseCidr("1.2.3.4/0")).toBeNull();
    expect(parseCidr("2001::/0")).toBeNull();
    expect(parseCidr("1.2.3.4/33")).toBeNull();
  });

  test("PrefixSet matches inside, rejects outside, coalesces overlaps", () => {
    const set = new PrefixSet(parseGeofeed(FEED));
    expect(set.contains(ONBOARD_IP_V4)).toBe(true);
    expect(set.contains(ONBOARD_IP_V6)).toBe(true);
    expect(set.contains("8.8.8.8")).toBe(false);
    expect(set.contains("2605:59ca:8020::1")).toBe(false);
    expect(set.contains("garbage")).toBe(false);
    // a nested /24 must not shadow its enclosing /16
    const nested = new PrefixSet([parseCidr("10.0.0.0/16")!, parseCidr("10.0.5.0/24")!]);
    expect(nested.contains("10.0.6.1")).toBe(true);
    expect(nested.contains("10.1.0.1")).toBe(false);
    // /56 dedupe key collapses one plane's clients to a single bucket.
    expect(dedupePrefix(ONBOARD_IP_V6)).toBe(dedupePrefix("2605:59ca:8015:b40::abcd"));
  });
});

describe("geofeed sync", () => {
  test("stores parsed prefixes; refuses to blank the table on a thin body", async () => {
    const db = makeSyntheticDb();
    const big = Array.from({ length: 200 }, (_, i) => `10.${i >> 8}.${i & 255}.0/24,,,,`).join(
      "\n"
    );
    const ok = await runGeofeedSync(db, async () => `${FEED}\n${big}`);
    expect(ok.outcome).toBe("success");
    expect(ok.prefixes).toBeGreaterThan(200);

    const detector = new StarlinkIpDetector(db);
    expect(detector.match(ONBOARD_IP_V4)).toBe(true);

    // A short body (CDN error page, partial fetch) keeps yesterday's table.
    const thin = await runGeofeedSync(db, async () => "9.0.0.0/24,,,\n");
    expect(thin.outcome).toBe("error");
    expect(detector.match(ONBOARD_IP_V4)).toBe(true);
  });
});

describe("passenger-probe trust model", () => {
  function seeded() {
    const db = makeSyntheticDb();
    replaceStarlinkPrefixes(db, parseGeofeed(FEED));
    return { db, detect: new StarlinkIpDetector(db) };
  }

  test("records server-seen IP/geofeed verdict and normalizes claims", () => {
    const { db, detect } = seeded();
    const result = handlePassengerProbe(db, ONBOARD_IP_V4, detect.match(ONBOARD_IP_V4), "Mozilla", {
      source: "probe",
      outcome: "onboard_api",
      claimed_flight: "UAL2019",
      claimed_tail: "n73275",
      claimed_date: "2026-06-13",
    });
    expect(result).toBe("stored");
    const row = db.query("SELECT * FROM passenger_reports").get() as Record<string, unknown>;
    expect(row.in_geofeed).toBe(1);
    expect(row.claimed_flight).toBe("UA2019");
    expect(row.claimed_tail).toBe("N73275");
    expect(row.ip).toBe(ONBOARD_IP_V4);
  });

  test("off-geofeed forged report is stored with in_geofeed=0", () => {
    const { db, detect } = seeded();
    handlePassengerProbe(db, "8.8.8.8", detect.match("8.8.8.8"), "curl", {
      outcome: "onboard_api",
      claimed_flight: "UA2019",
      claimed_tail: "N73275",
    });
    const row = db
      .query("SELECT in_geofeed, airborne_match FROM passenger_reports")
      .get() as Record<string, unknown>;
    expect(row.in_geofeed).toBe(0);
    expect(row.airborne_match).toBe(0);
  });

  test("dedupes by /56 prefix + tail within the window", () => {
    const { db } = seeded();
    const body = { source: "probe", outcome: "onboard_api", claimed_tail: "N73275" };
    handlePassengerProbe(db, ONBOARD_IP_V6, true, null, body);
    const dup = handlePassengerProbe(db, "2605:59ca:8015:b40::1", true, null, body);
    expect(dup).toBe("duplicate");
    expect(db.query("SELECT COUNT(*) AS n FROM passenger_reports").get()).toEqual({ n: 1 });
  });

  test("rejects malformed claims by clamping to null, not erroring", () => {
    const { db } = seeded();
    handlePassengerProbe(db, ONBOARD_IP_V4, true, null, {
      outcome: "Made; DROP--",
      claimed_flight: "<script>alert(1)</script>",
      claimed_tail: "DROP TABLE",
      claimed_date: "yesterday",
    });
    const row = db.query("SELECT * FROM passenger_reports").get() as Record<string, unknown>;
    expect(row.claimed_flight).toBeNull();
    expect(row.claimed_tail).toBeNull();
    expect(row.claimed_date).toBeNull();
    expect(row.outcome).toBe("other");
  });

  test("probe snippet beacons to /api/passenger-probe and the CSP-allowed origin", () => {
    expect(PROBE_SNIPPET).toContain("/api/passenger-probe");
    expect(PROBE_SNIPPET).toContain("onboard.united.com");
  });
});
