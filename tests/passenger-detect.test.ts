// CIDR matching, geofeed parsing, the passenger-probe trust model (server
// records its own geofeed verdict, never trusts client claims), and the
// contract between the banner's privacy sentence and what a report stores.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SITES } from "../src/airlines/registry";
import { PassengerBanner } from "../src/components/passenger-banner";
import { expirePassengerDedupeKeys, replaceStarlinkPrefixes } from "../src/database/database";
import { COUNTERS, metrics, normalizeAirborneMatch } from "../src/observability";
import { parseGeofeed, runGeofeedSync } from "../src/scripts/starlink-geofeed";
import { createApp } from "../src/server/app";
import {
  DEDUPE_KEY_PREFIX,
  PROBE_SNIPPET,
  StarlinkIpDetector,
  handlePassengerProbe,
} from "../src/server/passenger-detect";
import {
  DEDUPE_KEY_MAX_LIFE_SEC,
  DEDUPE_KEY_SWEEP_INTERVAL_SEC,
  DEDUPE_WINDOW_SEC,
  PASSENGER_REPORT_COLUMNS,
  PASSENGER_REPORT_PRIVACY_NOTE,
} from "../src/server/passenger-report-fields";
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

  test("records server-seen geofeed verdict and normalizes claims", () => {
    const { db, detect } = seeded();
    const result = handlePassengerProbe(db, ONBOARD_IP_V4, detect.match(ONBOARD_IP_V4), {
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
    expect(row.ip).toBe("");
  });

  test("off-geofeed forged report is stored with in_geofeed=0", () => {
    const { db, detect } = seeded();
    handlePassengerProbe(db, "8.8.8.8", detect.match("8.8.8.8"), {
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

  test("the counter carries the stored airborne match as a closed tag", () => {
    const { db } = seeded();
    const now = Math.floor(Date.now() / 1000);
    db.query(
      `INSERT INTO upcoming_flights (tail_number, flight_number, departure_airport, arrival_airport, departure_time, arrival_time, last_updated, airline)
       VALUES ('N73275', 'UA2019', 'ORD', 'DEN', ?, ?, ?, 'UA')`
    ).run(now - 3600, now + 3600, now);
    const seen: Array<Record<string, string | number | boolean> | undefined> = [];
    const original = metrics.increment;
    metrics.increment = (name, tags) => {
      if (name === COUNTERS.PASSENGER_PROBE) seen.push(tags);
    };
    try {
      const manual = { source: "manual", outcome: "manual_report" };
      handlePassengerProbe(db, ONBOARD_IP_V4, true, { ...manual, claimed_flight: "UA2019" });
      handlePassengerProbe(db, ONBOARD_IP_V4, true, { ...manual, claimed_flight: "UA1" });
      handlePassengerProbe(db, ONBOARD_IP_V4, true, { source: "probe", outcome: "timeout" });
      handlePassengerProbe(db, ONBOARD_IP_V4, true, { ...manual, claimed_flight: "<b>" });
      // Outside Starlink's range the stored flag is 0, and the tag follows it.
      handlePassengerProbe(db, "8.8.8.8", false, { ...manual, claimed_flight: "UA2019" });
    } finally {
      metrics.increment = original;
    }
    expect(seen.map((t) => t?.airborne_match)).toEqual(["yes", "no", "none", "none", "no"]);
    expect(seen.every((t) => typeof t?.airline === "string")).toBe(true);
    const stored = db
      .query(
        "SELECT airborne_match FROM passenger_reports WHERE claimed_flight = 'UA2019' ORDER BY id"
      )
      .all() as Array<{ airborne_match: number }>;
    expect(stored[0].airborne_match).toBe(1);
    for (const hostile of [undefined, null, "", "UA2019\n,env:prod"]) {
      for (const matched of [true, false]) {
        expect(["yes", "no", "none"]).toContain(normalizeAirborneMatch(hostile, matched));
      }
    }
  });

  test("dedupes by /56 prefix + source + tail; auto-probe never swallows manual", () => {
    const { db } = seeded();
    const probe = { source: "probe", outcome: "onboard_unreachable" };
    handlePassengerProbe(db, ONBOARD_IP_V6, true, probe);
    expect(handlePassengerProbe(db, "2605:59ca:8015:b40::1", true, probe)).toBe("duplicate");
    // The page-load probe row must NOT dedupe out a manual banner submission
    // seconds later (both have claimed_tail=null but different source).
    const manual = handlePassengerProbe(db, ONBOARD_IP_V6, true, {
      source: "manual",
      outcome: "manual_report",
      claimed_flight: "UA2019",
    });
    expect(manual).toBe("stored");
    expect(db.query("SELECT source FROM passenger_reports ORDER BY id").all()).toEqual([
      { source: "probe" },
      { source: "manual" },
    ]);
  });

  test("rejects malformed claims by clamping to null, not erroring", () => {
    const { db } = seeded();
    handlePassengerProbe(db, ONBOARD_IP_V4, true, {
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

// The banner tells a reporting visitor what we keep. These tests are the tie
// between that sentence and the row: change one without the other and they fail.
describe("banner privacy sentence matches what a report stores", () => {
  const UA_HOST = "unitedstarlinktracker.com";
  const USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0) Safari/605.1.15";
  const ROUTER_ID = "router-0123456789";
  type Row = Record<string, unknown>;

  /** The banner's own request, plus the identifying extras a browser or a
   * forged client could add, sent through the real route. */
  async function report(ip: string): Promise<{ row: Row; db: ReturnType<typeof makeSyntheticDb> }> {
    const db = makeSyntheticDb();
    replaceStarlinkPrefixes(db, parseGeofeed(FEED));
    const res = await createApp(db).dispatch(
      new Request(`https://${UA_HOST}/api/passenger-probe`, {
        method: "POST",
        headers: { host: UA_HOST, "cf-connecting-ip": ip, "user-agent": USER_AGENT },
        body: JSON.stringify({
          source: "manual",
          outcome: "manual_report",
          claimed_flight: "UA2019",
          router_id: ROUTER_ID,
        }),
      })
    );
    expect(res.status).toBe(202);
    const rows = db.query("SELECT * FROM passenger_reports").all() as Row[];
    expect(rows).toHaveLength(1);
    return { row: rows[0], db };
  }

  const columnsOf = (kind: string) =>
    Object.entries(PASSENGER_REPORT_COLUMNS)
      .filter(([, use]) => use.kind === kind)
      .map(([name]) => name);

  test("every column of the table is classified, so a new one cannot be added silently", () => {
    const db = makeSyntheticDb();
    const actual = (db.query("PRAGMA table_info(passenger_reports)").all() as { name: string }[])
      .map((c) => c.name)
      .sort();
    expect(actual).toEqual(Object.keys(PASSENGER_REPORT_COLUMNS).sort());
  });

  test("the banner shows the sentence, and the sentence names every disclosed column", () => {
    const html = renderToStaticMarkup(PassengerBanner({ site: SITES.united }));
    const text = html.replaceAll("&#x27;", "'");
    expect(text).toContain(PASSENGER_REPORT_PRIVACY_NOTE);
    for (const use of Object.values(PASSENGER_REPORT_COLUMNS)) {
      if (use.kind === "disclosed") expect(PASSENGER_REPORT_PRIVACY_NOTE).toContain(use.says);
      if (use.kind === "derived") {
        for (const from of use.from) expect(PASSENGER_REPORT_COLUMNS[from].kind).toBe("disclosed");
      }
    }
  });

  for (const ip of [ONBOARD_IP_V4, ONBOARD_IP_V6]) {
    test(`a report from ${ip.includes(":") ? "IPv6" : "IPv4"} stores what the sentence names and nothing else`, async () => {
      const { row } = await report(ip);

      for (const col of columnsOf("blank")) {
        expect([col, row[col] ?? ""]).toEqual([col, ""]);
      }
      expect(row.source).toBe("manual");
      expect(row.outcome).toBe("manual_report");
      expect(row.claimed_flight).toBe("UA2019");
      expect(row.in_geofeed).toBe(1);
      expect(typeof row.reported_at).toBe("number");
      expect([0, 1]).toContain(row.airborne_match as number);

      // The dedupe key is a keyed hash: no part of the row reads back as the
      // address, its readable prefix, the browser or the router.
      expect(row.ip_prefix).toMatch(/^h:[0-9a-f]{32}$/);
      const stored = JSON.stringify(row);
      for (const secret of [ip, dedupePrefix(ip)!, USER_AGENT, "Mozilla", ROUTER_ID]) {
        expect(stored).not.toContain(secret);
      }
    });
  }

  test("the scrambled network code still blocks a repeat, then is erased on time", async () => {
    const { row, db } = await report(ONBOARD_IP_V4);
    const body = { source: "manual", outcome: "manual_report", claimed_flight: "UA2019" };
    // Another seat on the same plane shares the /24, so it is one report.
    expect(handlePassengerProbe(db, "74.244.242.7", true, body)).toBe("duplicate");

    const at = row.reported_at as number;
    expect(expirePassengerDedupeKeys(db, DEDUPE_WINDOW_SEC, at + DEDUPE_WINDOW_SEC - 1)).toBe(0);
    expect(expirePassengerDedupeKeys(db, DEDUPE_WINDOW_SEC, at + DEDUPE_WINDOW_SEC)).toBe(1);
    const after = db.query("SELECT * FROM passenger_reports").get() as Row;
    expect(after).toEqual({ ...row, ip_prefix: "" });

    // "Within a day" is the sentence's promise: the window plus the longest
    // wait for the sweep (server.ts) has to fit inside it.
    expect(PASSENGER_REPORT_PRIVACY_NOTE).toContain("erase it within a day");
    expect(DEDUPE_KEY_MAX_LIFE_SEC).toBe(24 * 3600);
    expect(DEDUPE_WINDOW_SEC + DEDUPE_KEY_SWEEP_INTERVAL_SEC).toBeLessThanOrEqual(
      DEDUPE_KEY_MAX_LIFE_SEC
    );
  });

  test("the sweep leaves rows from before this change exactly as they were", () => {
    const db = makeSyntheticDb();
    db.query(
      `INSERT INTO passenger_reports
         (reported_at, ip, ip_prefix, in_geofeed, source, outcome, ua_hash)
       VALUES (1, ?, ?, 1, 'probe', 'onboard_reachable', 'abcdef0123456789')`
    ).run(ONBOARD_IP_V4, dedupePrefix(ONBOARD_IP_V4));
    const before = db.query("SELECT * FROM passenger_reports").all();
    expect(expirePassengerDedupeKeys(db, DEDUPE_WINDOW_SEC)).toBe(0);
    expect(db.query("SELECT * FROM passenger_reports").all()).toEqual(before);
    expect(DEDUPE_KEY_PREFIX).toBe("h:");
  });
});
