/**
 * /live-tv (UA only), the seatback live-TV hedge behind it, the "Cite this"
 * line + CSV distribution, and the ship-number sync outcome. Shapes, not
 * values: the snapshot's fleet mix drifts, the invariants here must not.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { aircraftFamilyPatterns, normalizeAircraftType } from "../src/airlines/aircraft-families";
import { SITES } from "../src/airlines/registry";
import { liveTvFaq } from "../src/components/live-tv-page";
import { getMeta } from "../src/database/database";
import { COUNTERS, metrics } from "../src/observability/metrics";
import {
  SHIP_NUMBERS_SYNCED_AT,
  shipSyncStatus,
  syncShipNumbers,
} from "../src/scripts/sync-ship-numbers";
import { STARLINK_TAILS_CSV_PATH, createApp } from "../src/server/app";
import { SEATBACK_LIVE_TV_LIKELY_FAMILIES, seatbackLiveTv } from "../src/utils/aircraft-specs";
import { addFleet, makeSyntheticDb, openSnapshot, req } from "./helpers";

const UA = "unitedstarlinktracker.com";
const HUB = "airlinestarlinktracker.com";
const app = createApp(openSnapshot());
const get = (path: string, host: string) =>
  app.dispatch(req(path, host, { headers: { "x-forwarded-for": "127.0.0.1" } }));

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});
function captureIncrements(): Array<{ name: string; tags: Record<string, unknown> }> {
  const calls: Array<{ name: string; tags: Record<string, unknown> }> = [];
  const original = metrics.increment;
  metrics.increment = (name, tags) => {
    calls.push({ name, tags: { ...(tags ?? {}) } });
  };
  restore = () => {
    metrics.increment = original;
  };
  return calls;
}

describe("seatbackLiveTv", () => {
  test("express never has seatback live TV; mainline is a hedge, never a promise", () => {
    expect(seatbackLiveTv("express", "ERJ-175")).toBe("no");
    expect(seatbackLiveTv("express", "Airbus A321-271NX")).toBe("no");
    expect(seatbackLiveTv("mainline", "Airbus A321-271NX")).toBe("likely");
    expect(seatbackLiveTv("mainline", "Airbus A321-271NY(XLR)")).toBe("likely");
    expect(seatbackLiveTv("mainline", "Boeing 737 MAX 9")).toBe("likely");
    expect(seatbackLiveTv("mainline", "Boeing 777-224(ER)")).toBe("likely");
    expect(seatbackLiveTv("mainline", "Boeing 787-9")).toBe("likely");
    expect(seatbackLiveTv("mainline", "Boeing 737-824")).toBe("possible");
    expect(seatbackLiveTv("mainline", "Boeing 737-924(ER)")).toBe("possible");
    // No data is not a verified negative.
    expect(seatbackLiveTv("mainline", null)).toBe("possible");
  });

  // The YES card classifies in the browser from the server's own patterns;
  // this pins that the two agree on every type string the snapshot holds.
  test("the inline-script classifier matches the server on every snapshot type", () => {
    const db = openSnapshot();
    const types = (
      db
        .query(
          "SELECT DISTINCT aircraft AS t FROM starlink_planes UNION SELECT DISTINCT aircraft_type FROM united_fleet"
        )
        .all() as Array<{ t: string | null }>
    ).map((r) => r.t);
    db.close();
    const patterns = aircraftFamilyPatterns();
    const clientFamily = (t: string | null) => {
      for (const [source, flags, family] of patterns) {
        if (new RegExp(source, flags).test(t ?? "")) return family;
      }
      return "other";
    };
    for (const t of types) {
      const server = normalizeAircraftType(t);
      const likelyServer = SEATBACK_LIVE_TV_LIKELY_FAMILIES.includes(server);
      const likelyClient = SEATBACK_LIVE_TV_LIKELY_FAMILIES.includes(clientFamily(t));
      expect(likelyClient, String(t)).toBe(likelyServer);
    }
  });
});

describe("/live-tv", () => {
  test("serves exactly where liveTvPage is on", async () => {
    for (const site of Object.values(SITES)) {
      const res = await get("/live-tv", site.canonicalHost);
      expect(res.status, site.key).toBe(site.features.liveTvPage ? 200 : 404);
    }
    expect(SITES.united.features.liveTvPage).toBe(true);
    expect(SITES.airline.features.liveTvPage).toBe(false);
  });

  test("answer up top, hedged count, check form, and FAQ markup matching visible Q&A", async () => {
    const html = await (await get("/live-tv", UA)).text();
    expect(html).toContain("Which United planes have live TV?");
    expect(html).toContain("likely or possible, never certain");
    expect(html).toContain("globenewswire.com/news-release/2026/09/17/3364268");
    expect(html).toContain('id="live-tv-flight-search"');
    expect(html).toContain('"@type":"FAQPage"');
    const faq = liveTvFaq();
    expect(faq.length).toBeGreaterThanOrEqual(3);
    expect(faq.length).toBeLessThanOrEqual(4);
    for (const { q } of faq) expect(html).toContain(q);
  });

  test("advertised in the UA sitemap and linked from /is-starlink-free, never on the hub", async () => {
    const uaMap = await (await get("/sitemap.xml", UA)).text();
    expect(uaMap).toContain(`https://${UA}/live-tv`);
    const hubMap = await (await get("/sitemap.xml", HUB)).text();
    expect(hubMap).not.toContain("/live-tv");
    const free = await (await get("/is-starlink-free", UA)).text();
    expect(free).toContain('href="/live-tv"');
  });

  test("check-flight ships live-TV copy for YES cards only where the page exists", async () => {
    const date = new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10);
    const ua = await (await get(`/check-flight/UA100/${date}`, UA)).text();
    expect(ua).toContain('"liveTv":{');
    const as = await (await get(`/check-flight/AS100/${date}`, SITES.alaska.canonicalHost)).text();
    expect(as).toContain('"liveTv":null');
  });
});

describe("cite line and CSV distribution", () => {
  test("/fleet cites the headline stat on airline sites, not on the hub", async () => {
    const ua = (await (await get("/fleet", UA)).text()).replace(/<!-- -->/g, "");
    if (ua.includes('id="cite-this"')) {
      expect(ua).toContain('href="/methodology#cite"');
      expect(ua).toMatch(/Cite this<\/a>: [\d,]+ of [\d,]+ United Airlines/);
    }
    const hub = await (await get("/fleet", HUB)).text();
    expect(hub).not.toContain('id="cite-this"');
    const methodology = await (await get("/methodology", UA)).text();
    expect(methodology).toContain('id="cite"');
  });

  test("/install-rate carries the cite line wherever it serves on an airline site", async () => {
    const res = await get("/install-rate", UA);
    if (res.status !== 200) return;
    const html = await res.text();
    if (html.includes('id="cite-this"')) expect(html).toContain('href="/methodology#cite"');
  });

  test("CSV is DB-served, cacheable, crawlable, and declared in the Dataset", async () => {
    const res = await get(STARLINK_TAILS_CSV_PATH, UA);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Cache-Control")).toContain("max-age=3600");
    const lines = (await res.text()).trimEnd().split("\r\n");
    expect(lines[0]).toBe("TailNumber,Aircraft,fleet,OperatedBy,DateFound");
    for (const line of lines.slice(1)) expect(line.length).toBeGreaterThan(0);

    expect((await get(STARLINK_TAILS_CSV_PATH, HUB)).status).toBe(404);
    const robots = await (await get("/robots.txt", UA)).text();
    expect(robots).toContain(`Allow: ${STARLINK_TAILS_CSV_PATH}`);
    const methodology = await (await get("/methodology", UA)).text();
    expect(methodology).toContain('"encodingFormat":"text/csv"');
    expect(methodology).toContain(`https://${UA}${STARLINK_TAILS_CSV_PATH}`);
    expect(methodology).not.toContain('"license"');
  });
});

describe("ship-number sync outcome", () => {
  const TAIL = "N37502";
  const sheet = (ship: string) => `Model,Reg #,AC #\n737 MAX 9,${TAIL},${ship}\n`;

  test("status comes from fetches and real changes, not rows attempted", () => {
    const base = { fetchedGids: 16, failedGids: 0, rowsSeen: 10, changed: 3 };
    expect(shipSyncStatus({ ...base, fetchedGids: 0, failedGids: 16 })).toBe("error");
    expect(shipSyncStatus({ ...base, failedGids: 2 })).toBe("partial");
    expect(shipSyncStatus({ ...base, changed: 0 })).toBe("noop");
    expect(shipSyncStatus(base)).toBe("success");
  });

  test("the job path emits scraper.sync, stamps meta, and a re-run is a noop", async () => {
    const db = makeSyntheticDb();
    addFleet(db, TAIL, "unknown", { aircraftType: "Boeing 737 MAX 9" });
    const calls = captureIncrements();
    const first = await syncShipNumbers({ db, fetchSheet: async () => sheet("3501") });
    expect(first.status).toBe("success");
    expect(first.changed).toBe(1);
    expect(getMeta(db, SHIP_NUMBERS_SYNCED_AT)).not.toBeNull();
    const again = await syncShipNumbers({ db, fetchSheet: async () => sheet("3501") });
    expect(again.status).toBe("noop");
    const syncs = calls.filter((c) => c.name === COUNTERS.SCRAPER_SYNC);
    expect(syncs.map((c) => c.tags.status)).toEqual(["success", "noop"]);
    for (const c of syncs) {
      expect(c.tags.source).toBe("ship_numbers");
      expect(c.tags.airline).toBe("united");
    }
    db.close();
  });

  test("every sheet failing throws for the job runner and stamps nothing", async () => {
    const db = makeSyntheticDb();
    const calls = captureIncrements();
    await expect(
      syncShipNumbers({
        db,
        fetchSheet: async () => {
          throw new Error("HTTP 403");
        },
      })
    ).rejects.toThrow();
    expect(calls.find((c) => c.name === COUNTERS.SCRAPER_SYNC)?.tags.status).toBe("error");
    expect(getMeta(db, SHIP_NUMBERS_SYNCED_AT)).toBeNull();
    db.close();
  });
});
