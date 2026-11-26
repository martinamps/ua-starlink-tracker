/**
 * Source health: the stored last-success / last-failure record per outside
 * source, its gauges, and the one-notice-per-outage alarm. Time and the Slack
 * call are injected; nothing here touches the network.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enabledAirlines } from "../src/airlines/registry";
import { setMeta } from "../src/database/database";
import { createReaderFactory } from "../src/database/reader";
import {
  SOURCES,
  type SourceId,
  capToQuietSources,
  checkSourceHealth,
  failureKindOf,
  readSourceState,
  recordSourceFailure,
  recordSourceSuccess,
  recordSyncOutcome,
  watchedSources,
} from "../src/database/source-health";
import { COUNTERS, GAUGES, metrics } from "../src/observability/metrics";
import { runSheetScrape } from "../src/scripts/sheet-scrape";
import { syncShipNumbers } from "../src/scripts/sync-ship-numbers";
import {
  applyUnitedObservation,
  classifyCheckResult,
  logUnitedCheckFailure,
} from "../src/scripts/united-verdict";
import type { FleetStats } from "../src/types";
import type { fetchAllSheets } from "../src/utils/utils";
import { addFleet, addPlane, makeFreshDb, makeSyntheticDb, openFileDb } from "./helpers";

const HOUR = 3600 * 1000;
const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);

const savedWebhook = process.env.SLACK_WEBHOOK_URL;
const savedFetch = globalThis.fetch;
afterEach(() => {
  if (savedWebhook === undefined) Reflect.deleteProperty(process.env, "SLACK_WEBHOOK_URL");
  else process.env.SLACK_WEBHOOK_URL = savedWebhook;
  globalThis.fetch = savedFetch;
});

function withWebhook(): void {
  process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.invalid/test";
}
function withoutWebhook(): void {
  Reflect.deleteProperty(process.env, "SLACK_WEBHOOK_URL");
}

/** Records every notice; `deliver` decides whether Slack "accepted" it. */
function recorder(deliver: () => boolean = () => true) {
  const sent: string[] = [];
  return {
    sent,
    notify: async (text: string) => {
      sent.push(text);
      return deliver();
    },
  };
}

/** Notices about one source: the checker walks every watched source, and the
 * others in a bare test database go quiet on the same clock. */
const about = (sent: string[], id: SourceId) => sent.filter((t) => t.includes(`\`${id}\``));

function captureMetrics() {
  const increments: Array<{ name: string; tags: Record<string, string | number> }> = [];
  const gauges: Array<{ name: string; value: number; tags: Record<string, string | number> }> = [];
  const original = { increment: metrics.increment, gauge: metrics.gauge };
  metrics.increment = (name, tags) => {
    increments.push({ name, tags: tags ?? {} });
  };
  metrics.gauge = (name, value, tags) => {
    gauges.push({ name, value, tags: tags ?? {} });
  };
  return {
    increments,
    gauges,
    restore: () => {
      metrics.increment = original.increment;
      metrics.gauge = original.gauge;
    },
  };
}

describe("the stored record", () => {
  test("a success resets the clock and the failure streak", async () => {
    const db = makeFreshDb();
    recordSourceSuccess(db, "sheet_scrape", "UA", T0);
    recordSourceFailure(db, "sheet_scrape", "UA", "refused", T0 + HOUR);
    recordSourceFailure(db, "sheet_scrape", "UA", "refused", T0 + 2 * HOUR);

    const failing = readSourceState(db, "sheet_scrape", "UA");
    expect(failing?.lastSuccessAt).toBe(T0);
    expect(failing?.lastFailureAt).toBe(T0 + 2 * HOUR);
    expect(failing?.lastFailureKind).toBe("refused");
    expect(failing?.failuresSinceSuccess).toBe(2);

    const before = await checkSourceHealth(db, { now: T0 + 5 * HOUR, notify: recorder().notify });
    expect(before.find((r) => r.id === "sheet_scrape")?.hoursSinceSuccess).toBeCloseTo(5, 5);

    recordSourceSuccess(db, "sheet_scrape", "UA", T0 + 5 * HOUR);
    const healed = readSourceState(db, "sheet_scrape", "UA");
    expect(healed?.lastSuccessAt).toBe(T0 + 5 * HOUR);
    expect(healed?.failuresSinceSuccess).toBe(0);
    // The last failure stays on record: it is history, not the current state.
    expect(healed?.lastFailureKind).toBe("refused");

    const after = await checkSourceHealth(db, { now: T0 + 5 * HOUR, notify: recorder().notify });
    expect(after.find((r) => r.id === "sheet_scrape")?.hoursSinceSuccess).toBe(0);
    db.close();
  });

  test("a failure counts in telemetry with its kind; a success does not", () => {
    const db = makeFreshDb();
    const m = captureMetrics();
    try {
      recordSourceSuccess(db, "qatar_schedule", "QR", T0);
      recordSourceFailure(db, "qatar_schedule", "QR", "empty", T0 + HOUR);
      recordSourceFailure(db, "flight_schedule", "ALL", "blocked", T0 + HOUR);
    } finally {
      m.restore();
    }
    expect(m.increments).toEqual([
      {
        name: COUNTERS.SOURCE_FAILURE,
        tags: { source: "qatar_schedule", kind: "empty", airline: "qatar" },
      },
      {
        name: COUNTERS.SOURCE_FAILURE,
        tags: { source: "flight_schedule", kind: "blocked", airline: "all" },
      },
    ]);
    db.close();
  });

  test("a restart keeps the state, the open alarm included", async () => {
    const path = join(tmpdir(), `source-health-${process.pid}-${Date.now()}.sqlite`);
    try {
      withWebhook();
      let db = openFileDb(path);
      recordSourceSuccess(db, "sheet_scrape", "UA", T0);
      recordSourceFailure(db, "sheet_scrape", "UA", "refused", T0 + HOUR);
      const first = recorder();
      await checkSourceHealth(db, { now: T0 + 7 * HOUR, notify: first.notify });
      expect(about(first.sent, "sheet_scrape").length).toBe(1);
      db.close();

      db = openFileDb(path);
      const state = readSourceState(db, "sheet_scrape", "UA");
      expect(state?.lastSuccessAt).toBe(T0);
      expect(state?.lastFailureKind).toBe("refused");
      expect(state?.quietSince).toBe(T0);
      expect(state?.alarmSent).toBe(true);

      // Same outage, new process: the clock did not restart and nobody is
      // told twice.
      const second = recorder();
      const rows = await checkSourceHealth(db, { now: T0 + 8 * HOUR, notify: second.notify });
      expect(rows.find((r) => r.id === "sheet_scrape")?.hoursSinceSuccess).toBeCloseTo(8, 5);
      expect(about(second.sent, "sheet_scrape")).toEqual([]);
      db.close();
    } finally {
      rmSync(path, { force: true });
    }
  });

  test("a source that never reported still ages across a restart", async () => {
    const path = join(tmpdir(), `source-health-first-${process.pid}-${Date.now()}.sqlite`);
    try {
      withWebhook();
      let db = openFileDb(path);
      await checkSourceHealth(db, { now: T0, notify: recorder().notify });
      db.close();

      db = openFileDb(path);
      const r = recorder();
      await checkSourceHealth(db, { now: T0 + 7 * HOUR, notify: r.notify });
      const notice = about(r.sent, "sheet_scrape");
      expect(notice.length).toBe(1);
      expect(notice[0]).toContain("No good read since watching began");
      db.close();
    } finally {
      rmSync(path, { force: true });
    }
  });
});

describe("the alarm", () => {
  test("a quiet source alarms once, however many checks see it", async () => {
    withWebhook();
    const db = makeFreshDb();
    recordSourceSuccess(db, "sheet_scrape", "UA", T0);
    const r = recorder();

    await checkSourceHealth(db, { now: T0 + 5.9 * HOUR, notify: r.notify });
    expect(about(r.sent, "sheet_scrape")).toEqual([]);

    for (let h = 7; h <= 30; h++) {
      recordSourceFailure(db, "sheet_scrape", "UA", "refused", T0 + h * HOUR);
      await checkSourceHealth(db, { now: T0 + h * HOUR + 60_000, notify: r.notify });
    }
    const notices = about(r.sent, "sheet_scrape");
    expect(notices.length).toBe(1);
    expect(notices[0]).toContain("Data source quiet");
    expect(notices[0]).toContain("Community sheet scrape");
    expect(notices[0]).toContain("`refused`");
    db.close();
  });

  test("a recovery sends one all-clear and re-arms the alarm", async () => {
    withWebhook();
    const db = makeFreshDb();
    recordSourceSuccess(db, "sheet_scrape", "UA", T0);
    const r = recorder();
    await checkSourceHealth(db, { now: T0 + 7 * HOUR, notify: r.notify });

    recordSourceSuccess(db, "sheet_scrape", "UA", T0 + 9 * HOUR);
    await checkSourceHealth(db, { now: T0 + 9 * HOUR + 60_000, notify: r.notify });
    await checkSourceHealth(db, { now: T0 + 10 * HOUR, notify: r.notify });

    const notices = about(r.sent, "sheet_scrape");
    expect(notices.length).toBe(2);
    expect(notices[1]).toContain("Data source back");
    expect(notices[1]).toContain("9.0 hours quiet");
    const state = readSourceState(db, "sheet_scrape", "UA");
    expect(state?.quietSince).toBeNull();
    expect(state?.alarmSent).toBe(false);

    // A second outage is a second alarm.
    await checkSourceHealth(db, { now: T0 + 16 * HOUR, notify: r.notify });
    expect(about(r.sent, "sheet_scrape").length).toBe(3);
    db.close();
  });

  test("with the webhook unset no notice goes out, and none is owed on recovery", async () => {
    withoutWebhook();
    const db = makeFreshDb();
    let posts = 0;
    globalThis.fetch = (async () => {
      posts++;
      return new Response("ok");
    }) as unknown as typeof fetch;
    recordSourceSuccess(db, "sheet_scrape", "UA", T0);

    // Default notifier: the real Slack path, which must stay silent.
    const rows = await checkSourceHealth(db, { now: T0 + 7 * HOUR });
    expect(posts).toBe(0);
    // The outage is still tracked, so telemetry and the log carry it.
    expect(rows.find((r) => r.id === "sheet_scrape")?.quiet).toBe(true);
    expect(readSourceState(db, "sheet_scrape", "UA")?.quietSince).toBe(T0);
    expect(readSourceState(db, "sheet_scrape", "UA")?.alarmSent).toBe(false);

    const r = recorder();
    await checkSourceHealth(db, { now: T0 + 8 * HOUR, notify: r.notify });
    recordSourceSuccess(db, "sheet_scrape", "UA", T0 + 9 * HOUR);
    await checkSourceHealth(db, { now: T0 + 9 * HOUR + 60_000, notify: r.notify });
    expect(r.sent).toEqual([]);
    expect(posts).toBe(0);
    expect(readSourceState(db, "sheet_scrape", "UA")?.quietSince).toBeNull();
    db.close();
  });

  test("a notice Slack did not take is retried, then sent once", async () => {
    withWebhook();
    const db = makeFreshDb();
    recordSourceSuccess(db, "sheet_scrape", "UA", T0);
    let up = false;
    const r = recorder(() => up);

    await checkSourceHealth(db, { now: T0 + 7 * HOUR, notify: r.notify });
    expect(readSourceState(db, "sheet_scrape", "UA")?.alarmSent).toBe(false);
    up = true;
    await checkSourceHealth(db, { now: T0 + 7.1 * HOUR, notify: r.notify });
    await checkSourceHealth(db, { now: T0 + 7.2 * HOUR, notify: r.notify });
    // One failed attempt, one delivered, then silence.
    expect(about(r.sent, "sheet_scrape").length).toBe(2);
    expect(readSourceState(db, "sheet_scrape", "UA")?.alarmSent).toBe(true);
    db.close();
  });

  test("a report landing while a notice is in flight is kept", async () => {
    withWebhook();
    const db = makeFreshDb();
    recordSourceSuccess(db, "sheet_scrape", "UA", T0);
    const notify = async (text: string) => {
      if (text.includes("`sheet_scrape`")) {
        recordSourceFailure(db, "sheet_scrape", "UA", "error", T0 + 7 * HOUR);
      }
      return true;
    };
    await checkSourceHealth(db, { now: T0 + 7 * HOUR, notify });
    const state = readSourceState(db, "sheet_scrape", "UA");
    expect(state?.lastFailureKind).toBe("error");
    expect(state?.alarmSent).toBe(true);
    db.close();
  });
});

describe("telemetry", () => {
  test("each watched source emits hours since success and a quiet flag", async () => {
    withoutWebhook();
    const db = makeFreshDb();
    recordSourceSuccess(db, "sheet_scrape", "UA", T0);
    recordSourceSuccess(db, "qatar_schedule", "QR", T0 + 6 * HOUR);
    const m = captureMetrics();
    try {
      await checkSourceHealth(db, { now: T0 + 7 * HOUR });
    } finally {
      m.restore();
    }
    const gauge = (name: string, source: string) =>
      m.gauges.find((g) => g.name === name && g.tags.source === source);
    expect(gauge(GAUGES.SOURCE_HOURS_SINCE_SUCCESS, "sheet_scrape")?.value).toBeCloseTo(7, 5);
    expect(gauge(GAUGES.SOURCE_QUIET, "sheet_scrape")?.value).toBe(1);
    expect(gauge(GAUGES.SOURCE_HOURS_SINCE_SUCCESS, "qatar_schedule")?.value).toBeCloseTo(1, 5);
    expect(gauge(GAUGES.SOURCE_QUIET, "qatar_schedule")?.value).toBe(0);
    expect(gauge(GAUGES.SOURCE_QUIET, "qatar_schedule")?.tags.airline).toBe("qatar");
    // One pair of gauges per watched source, each with an airline tag.
    const watched = watchedSources(db);
    expect(m.gauges.length).toBe(watched.length * 2);
    for (const g of m.gauges) expect(g.tags.airline).not.toBe("unmapped");
    db.close();
  });
});

describe("what is watched", () => {
  test("every source has a threshold above its own schedule and a scope rule", () => {
    for (const [id, def] of Object.entries(SOURCES)) {
      expect(def.quietAfterHours, id).toBeGreaterThan(1);
      expect(def.label.length, id).toBeGreaterThan(3);
      expect(Array.isArray(def.scopes()), id).toBe(true);
    }
  });

  test("airline-scoped sources follow the registry", () => {
    const db = makeFreshDb();
    const watched = watchedSources(db).map((w) => `${w.id}/${w.scope}`);
    const withRoster = enabledAirlines().filter((a) => a.fr24Slug);
    for (const a of withRoster) expect(watched).toContain(`fleet_roster/${a.code}`);
    for (const a of enabledAirlines().filter((x) => x.verifierBackend === "alaska-json")) {
      expect(watched).toContain(`alaska_site/${a.code}`);
    }
    expect(watched).toContain("sheet_scrape/UA");
    expect(watched).toContain("united_site/UA");
    expect(watched).toContain("flight_schedule/ALL");
    db.close();
  });

  test("the ADS-B sweep's clock comes from its own table, empty sweeps excluded", async () => {
    withoutWebhook();
    const db = makeFreshDb();
    const sweep = (atMs: number, observed: number) =>
      db
        .query(
          `INSERT INTO adsb_sweeps (swept_at, provider, requests, latency_ms, tails_queried,
             observed, airborne, matched, mismatched, no_assignment, no_callsign)
           VALUES (?, 'test', 1, 250, 425, ?, 0, 0, 0, 0, 0)`
        )
        .run(Math.floor(atMs / 1000), observed);
    const adsb = async (now: number) =>
      (await checkSourceHealth(db, { now })).find((r) => r.id === "adsb");

    sweep(T0, 40);
    expect((await adsb(T0 + HOUR))?.hoursSinceSuccess).toBeCloseTo(1, 5);
    // Sweeps that keep running but see no aircraft do not move the clock.
    sweep(T0 + 2 * HOUR, 0);
    sweep(T0 + 4 * HOUR, 0);
    const quiet = await adsb(T0 + 4 * HOUR);
    expect(quiet?.hoursSinceSuccess).toBeCloseTo(4, 5);
    expect(quiet?.quiet).toBe(true);
    sweep(T0 + 5 * HOUR, 12);
    expect((await adsb(T0 + 5 * HOUR))?.quiet).toBe(false);
    db.close();
  });

  test("a flag-gated source is watched only once it has reported", async () => {
    withWebhook();
    const db = makeFreshDb();
    const ids = () => watchedSources(db).map((w) => w.id);
    expect(ids()).not.toContain("starlink_geofeed");
    expect(ids()).not.toContain("fleet_progress_tails");

    const r = recorder();
    await checkSourceHealth(db, { now: T0 + 100 * 24 * HOUR, notify: r.notify });
    expect(about(r.sent, "starlink_geofeed")).toEqual([]);

    recordSyncOutcome(db, "starlink_geofeed", "ALL", "error", T0);
    expect(ids()).toContain("starlink_geofeed");
    db.close();
  });
});

describe("a page's last-updated date", () => {
  const stamp = new Date(T0 + 20 * HOUR).toISOString();

  test("is the owner's stamp while nothing behind the page is quiet", async () => {
    withoutWebhook();
    const db = makeFreshDb();
    setMeta(db, "lastUpdated", stamp, "UA");
    recordSourceSuccess(db, "united_site", "UA", T0);
    // Old, but not past its threshold: an ordinary gap must not move the date.
    await checkSourceHealth(db, { now: T0 + 5 * HOUR });
    expect(capToQuietSources(db, "UA", stamp)).toBe(stamp);
    expect(createReaderFactory(db)("UA").getLastUpdatedRaw()).toBe(stamp);
    expect(capToQuietSources(db, "UA", null)).toBeNull();
    db.close();
  });

  test("is held back to a quiet source's last good read, and released on recovery", async () => {
    withoutWebhook();
    const db = makeFreshDb();
    setMeta(db, "lastUpdated", stamp, "UA");
    setMeta(db, "lastUpdated", stamp, "QR");
    recordSourceSuccess(db, "united_site", "UA", T0);
    for (const id of ["sheet_scrape", "flight_schedule", "fleet_roster"] as const) {
      recordSourceSuccess(db, id, id === "flight_schedule" ? "ALL" : "UA", T0 + 20 * HOUR);
    }
    recordSourceSuccess(db, "fleet_roster", "QR", T0 + 20 * HOUR);
    recordSourceSuccess(db, "qatar_schedule", "QR", T0 + 20 * HOUR);
    await checkSourceHealth(db, { now: T0 + 20 * HOUR });

    const held = new Date(T0).toISOString();
    const reader = createReaderFactory(db);
    expect(reader("UA").getLastUpdatedRaw()).toBe(held);
    expect(reader("UA").getLastUpdated()).toBe(held);
    // united.com sits behind United's pages only.
    expect(reader("QR").getLastUpdatedRaw()).toBe(stamp);

    recordSourceSuccess(db, "united_site", "UA", T0 + 21 * HOUR);
    await checkSourceHealth(db, { now: T0 + 21 * HOUR });
    expect(reader("UA").getLastUpdatedRaw()).toBe(stamp);
    db.close();
  });

  test("a quiet source shared by every airline holds every airline's date", async () => {
    withoutWebhook();
    const db = makeFreshDb();
    setMeta(db, "lastUpdated", stamp, "QR");
    recordSourceSuccess(db, "flight_schedule", "ALL", T0);
    await checkSourceHealth(db, { now: T0 + 20 * HOUR });
    expect(capToQuietSources(db, "QR", stamp)).toBe(new Date(T0).toISOString());
    db.close();
  });

  test("a source that only feeds telemetry never moves it", async () => {
    withoutWebhook();
    const db = makeFreshDb();
    recordSourceSuccess(db, "adsb", "UA", T0);
    recordSourceSuccess(db, "united_site", "UA", T0 + 20 * HOUR);
    recordSourceSuccess(db, "sheet_scrape", "UA", T0 + 20 * HOUR);
    recordSourceSuccess(db, "flight_schedule", "ALL", T0 + 20 * HOUR);
    recordSourceSuccess(db, "fleet_roster", "UA", T0 + 20 * HOUR);
    await checkSourceHealth(db, { now: T0 + 20 * HOUR });
    expect(readSourceState(db, "adsb", "UA")?.quietSince).toBe(T0);
    expect(capToQuietSources(db, "UA", stamp)).toBe(stamp);
    db.close();
  });
});

describe("an answer with nothing in it is a failure", () => {
  const STATS: FleetStats = {
    express: { total: 100, starlink: 30, unverified: 0, percentage: 30 },
    mainline: { total: 100, starlink: 30, unverified: 0, percentage: 30 },
  };

  test("sheet scrape: a page that parses to zero tails is refused, and alarms", async () => {
    withWebhook();
    const db = makeSyntheticDb();
    const blockedPage = (async () => ({
      totalAircraftCount: 900,
      starlinkAircraft: [],
      fleetStats: STATS,
    })) as unknown as typeof fetchAllSheets;

    const started = Date.now();
    const result = await runSheetScrape(db, blockedPage);
    expect(result.outcome).toBe("refused");
    const state = readSourceState(db, "sheet_scrape", "UA");
    expect(state?.lastSuccessAt).toBeNull();
    expect(state?.lastFailureKind).toBe("refused");

    const r = recorder();
    await checkSourceHealth(db, { now: started + 7 * HOUR, notify: r.notify });
    const notice = about(r.sent, "sheet_scrape");
    expect(notice.length).toBe(1);
    expect(notice[0]).toContain("`refused`");
    db.close();
  });

  test("sheet scrape: a thrown fetch is a failure with its kind", async () => {
    const db = makeSyntheticDb();
    const down = (async () => {
      throw new Error("HTTP 403 from sheets");
    }) as unknown as typeof fetchAllSheets;
    await runSheetScrape(db, down);
    expect(readSourceState(db, "sheet_scrape", "UA")?.lastFailureKind).toBe("blocked");
    db.close();
  });

  test("united.com: a page with no provider on it is empty; a reading is a success", () => {
    const db = makeSyntheticDb();
    addPlane(db, "N777UA", null);
    addFleet(db, "N777UA", null, { verifiedWifi: null });
    const noMap = new Map<string, string>();
    const page = (wifiProvider: string | null, error: string | null = null) =>
      classifyCheckResult(
        {
          hasStarlink: wifiProvider === "Starlink",
          wifiProvider,
          tailNumber: "N777UA",
          shipNumber: null,
          aircraftType: "737-900",
          providerSource: null,
          error,
        } as unknown as Parameters<typeof classifyCheckResult>[0],
        "N777UA",
        noMap
      );
    const opts = { flightNumber: "UA100", aircraftType: "737-900" };

    applyUnitedObservation(db, page(null), opts);
    expect(readSourceState(db, "united_site", "UA")?.lastFailureKind).toBe("empty");
    expect(readSourceState(db, "united_site", "UA")?.lastSuccessAt).toBeNull();

    applyUnitedObservation(db, page(null, "wifi section not found"), opts);
    expect(readSourceState(db, "united_site", "UA")?.lastFailureKind).toBe("error");

    logUnitedCheckFailure(db, "N777UA", "Timeout after 90s", opts);
    expect(readSourceState(db, "united_site", "UA")?.lastFailureKind).toBe("timeout");
    expect(readSourceState(db, "united_site", "UA")?.failuresSinceSuccess).toBe(3);

    // Viasat is as good an answer as Starlink: the site is talking to us.
    applyUnitedObservation(db, page("Viasat"), opts);
    const state = readSourceState(db, "united_site", "UA");
    expect(state?.lastSuccessAt).not.toBeNull();
    expect(state?.failuresSinceSuccess).toBe(0);
    db.close();
  });

  test("ship numbers: tabs that load with no ship rows are empty, not a quiet no-op", async () => {
    const db = makeSyntheticDb();
    addFleet(db, "N37513", "unknown", { aircraftType: "Boeing 737 MAX 9" });
    await syncShipNumbers({ db, fetchSheet: async () => "<html>Sign in</html>" });
    expect(readSourceState(db, "ship_numbers", "UA")?.lastFailureKind).toBe("empty");
    expect(readSourceState(db, "ship_numbers", "UA")?.lastSuccessAt).toBeNull();

    const sheet = "Model,Reg #,AC #\n737 MAX 9,N37513,3501\n";
    await syncShipNumbers({ db, fetchSheet: async () => sheet });
    await syncShipNumbers({ db, fetchSheet: async () => sheet });
    // The second run changed nothing ("noop") and is still a good read.
    const state = readSourceState(db, "ship_numbers", "UA");
    expect(state?.lastSuccessAt).not.toBeNull();
    expect(state?.failuresSinceSuccess).toBe(0);
    db.close();
  });

  test("outcomes that say nothing about the source leave the record alone", () => {
    const db = makeFreshDb();
    for (const outcome of ["noop", "skipped", "abandoned"]) {
      recordSyncOutcome(db, "bts", "UA", outcome, T0);
    }
    expect(readSourceState(db, "bts", "UA")).toBeNull();
    recordSyncOutcome(db, "bts", "UA", "partial", T0);
    expect(readSourceState(db, "bts", "UA")?.lastFailureKind).toBe("partial");
    db.close();
  });

  test("thrown errors bucket into a closed set of kinds", () => {
    expect(failureKindOf(new Error("HTTP 429"))).toBe("blocked");
    expect(failureKindOf(new Error("Cloudflare challenge"))).toBe("blocked");
    expect(failureKindOf("Timeout after 90s")).toBe("timeout");
    expect(failureKindOf(new Error("Unexpected token <"))).toBe("error");
  });
});
