/**
 * Per-tail evidence permalinks at /tail/{registration}.
 *
 * Two invariants carried over from the route-permalink work: the URL space is
 * bounded by real data (unknown registrations 404, sitemap and page share one
 * existence test), and every claim is a claim-ladder tier — verified (dated
 * observation) > installed per fleet data > no Starlink yet > unknown — never
 * a bare boolean. Negatives are first-class pages ("N12345 — no Starlink
 * yet"): the query demand is the same either way.
 *
 * Shapes over values: tails are picked from whatever the snapshot holds.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { SITES, siteForAirline } from "../src/airlines/registry";
import { deriveTailClaim } from "../src/components/tail-page";
import { TAIL_URL_RE, getSitemapTails, getTailPageRecord } from "../src/database/database";
import type { TailVerificationEvent } from "../src/database/database";
import { FLEET_TAILS_PAGE_SIZE, createApp, parseTailPath } from "../src/server/app";
import { addFleet, makeSyntheticDb, openSnapshot, req } from "./helpers";

let app: ReturnType<typeof createApp>;
let db: ReturnType<typeof openSnapshot>;

beforeAll(() => {
  db = openSnapshot();
  app = createApp(db);
});

const UA = SITES.united.canonicalHost;
const get = (path: string, host = UA) =>
  app.dispatch(req(path, host, { headers: { Accept: "text/html" } }));

/** A tail the snapshot actually backs, so the test survives data drift. */
function someTail(airline = "UA", where = "1=1"): string {
  const row = db
    .query(`SELECT tail_number FROM united_fleet WHERE airline = ? AND ${where} LIMIT 1`)
    .get(airline) as { tail_number: string } | null;
  if (!row) throw new Error(`snapshot has no ${airline} tail (${where}) — run bun run test:setup`);
  return row.tail_number;
}

describe("parseTailPath", () => {
  test("accepts registrations, case-insensitively, and canonicalizes", () => {
    expect(parseTailPath("/tail/N47280")).toEqual({ raw: "N47280", tail: "N47280" });
    expect(parseTailPath("/tail/n47280")).toEqual({ raw: "n47280", tail: "N47280" });
    expect(parseTailPath("/tail/N47280/")).toEqual({ raw: "N47280", tail: "N47280" });
    expect(parseTailPath("/tail/a7-bbb")).toEqual({ raw: "a7-bbb", tail: "A7-BBB" });
  });

  test("rejects everything that would open an unbounded URL space", () => {
    for (const path of [
      "/tail/",
      "/tail/N47280/extra",
      "/tail/N4 7280",
      "/tail/%ZZ",
      "/tail/N!",
      "/tail/x",
      "/tail/--",
      "/tail/N-",
      "/tail/AAAAAAAAAAAAAAAAAAAA",
    ]) {
      expect(parseTailPath(path), path).toBeNull();
    }
  });
});

describe("/tail/{registration}", () => {
  test("a roster-backed tail renders its own page, self-canonical", async () => {
    const tail = someTail();
    const res = await get(`/tail/${tail}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`<link rel="canonical" href="https://${UA}/tail/${tail}"`);
    // Claim-ladder headline, never a bare boolean.
    expect(body).toMatch(
      new RegExp(
        `${tail} — (Starlink verified|Starlink installed|no Starlink yet|WiFi status unknown)`
      )
    );
    expect(body).toContain("Verification history");
  });

  test("a negative tail is a first-class page saying 'no Starlink yet'", async () => {
    const tail = someTail("UA", "starlink_status = 'negative'");
    const res = await get(`/tail/${tail}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`${tail} — no Starlink yet`);
    expect(body).toContain("does not have Starlink yet");
  });

  test("lowercase and trailing-slash spellings 301 to the canonical form", async () => {
    const tail = someTail();
    for (const variant of [`/tail/${tail.toLowerCase()}`, `/tail/${tail}/`]) {
      const res = await get(variant);
      expect(res.status, variant).toBe(301);
      expect(res.headers.get("location")).toBe(`https://${UA}/tail/${tail}`);
    }
  });

  test("unknown and malformed registrations 404", async () => {
    // Shape-valid but absent from the roster: derive one that can't collide.
    const absent = "N0XX";
    expect(getTailPageRecord(db, absent, "UA")).toBeNull();
    // (No dot-dot probe: WHATWG URL parsing normalizes "/tail/.." — encoded
    // or not — to "/" before dispatch, so it can never reach this handler.)
    for (const path of [`/tail/${absent}`, "/tail/hello%20world", "/tail/N4%21"]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
    }
  });

  test("another airline's registration 404s on this host (isolation)", async () => {
    const haTail = someTail("HA");
    expect((await get(`/tail/${haTail}`)).status).toBe(404);
    const haSite = siteForAirline("HA");
    expect(haSite).not.toBeNull();
    expect((await get(`/tail/${haTail}`, haSite?.canonicalHost)).status).toBe(200);
  });

  test("tail pages are tenant-only — the hub 404s, bare /tail 301s to /fleet", async () => {
    const tail = someTail();
    expect((await get(`/tail/${tail}`, SITES.airline.canonicalHost)).status).toBe(404);
    const bare = await get("/tail");
    expect(bare.status).toBe(301);
    expect(bare.headers.get("location")).toBe(`https://${UA}/fleet`);
    expect((await get("/tail", SITES.airline.canonicalHost)).status).toBe(404);
  });

  test("non-GET is 405", async () => {
    const tail = someTail();
    const res = await app.dispatch(req(`/tail/${tail}`, UA, { method: "POST" }));
    expect(res.status).toBe(405);
  });

  test("every /check-flight link on tail pages resolves (marketing numbers only)", async () => {
    const seen = new Set<string>();
    for (const t of getSitemapTails(db, "UA")) {
      const body = await (await get(`/tail/${t.tail}`)).text();
      for (const m of body.matchAll(/href="\/check-flight\/([^"]+)"/g)) seen.add(m[1]);
    }
    for (const fn of seen) {
      expect(fn, "non-marketing flight number linked").toMatch(/^UA\d+$/);
      expect((await get(`/check-flight/${fn}`)).status, `/check-flight/${fn}`).toBe(200);
    }
  });
});

describe("sitemap agrees with the pages", () => {
  test("tail entries are advertised and every advertised tail resolves 200", async () => {
    const body = await (await app.dispatch(req("/sitemap.xml", UA))).text();
    const advertised = [...body.matchAll(/<loc>[^<]*\/tail\/([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(advertised.length).toBe(getSitemapTails(db, "UA").length);
    expect(advertised.length).toBeGreaterThan(0);
    for (const tail of advertised.slice(0, 20)) {
      expect(TAIL_URL_RE.test(tail), tail).toBe(true);
      expect(getTailPageRecord(db, tail, "UA"), tail).not.toBeNull();
      expect((await get(`/tail/${tail}`)).status, `/tail/${tail}`).toBe(200);
    }
  });

  test("no tail entry stamps request time as lastmod", async () => {
    const body = await (await app.dispatch(req("/sitemap.xml", UA))).text();
    const now = Date.now();
    for (const m of body.matchAll(
      /<loc>[^<]*\/tail\/[^<]+<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g
    )) {
      expect(Date.parse(m[1])).toBeLessThanOrEqual(now);
    }
  });

  test("the hub sitemap advertises no tail pages", async () => {
    const body = await (
      await app.dispatch(req("/sitemap.xml", SITES.airline.canonicalHost))
    ).text();
    expect(body).not.toContain("/tail/");
  });
});

describe("getSitemapTails", () => {
  test("emits only URL-shaped tails with sane lastmod, whole roster included", () => {
    const tails = getSitemapTails(db, "UA");
    const nowSec = Math.floor(Date.now() / 1000);
    for (const t of tails) {
      expect(t.tail).toMatch(TAIL_URL_RE);
      expect(t.last_touched).toBeGreaterThanOrEqual(0);
      expect(t.last_touched).toBeLessThanOrEqual(nowSec);
    }
    // Negatives are advertised too — the honest "no" is the product.
    const negative = someTail("UA", "starlink_status = 'negative'");
    expect(tails.some((t) => t.tail === negative)).toBe(true);
  });

  test("is empty for an airline with no rows", () => {
    expect(getSitemapTails(db, "NOPE")).toEqual([]);
  });
});

describe("deriveTailClaim (claim ladder)", () => {
  const event = (over: Partial<TailVerificationEvent>): TailVerificationEvent => ({
    day: "2026-03-01",
    source: "united",
    has_starlink: 1,
    wifi_provider: "Starlink",
    flight_number: null,
    checks: 1,
    last_checked_at: 1770000000,
    ...over,
  });

  test("confirmed + in-service observation → verified, dated by the observation", () => {
    const claim = deriveTailClaim(
      { starlink_status: "confirmed", verified_wifi: "Starlink", verified_at: 1 },
      [event({})]
    );
    expect(claim).toEqual({ tier: "verified", observedAt: 1770000000 });
  });

  test("confirmed with only spreadsheet rows → installed per fleet data, never verified", () => {
    const claim = deriveTailClaim(
      { starlink_status: "confirmed", verified_wifi: "Starlink", verified_at: 42 },
      [event({ source: "spreadsheet" })]
    );
    expect(claim).toEqual({ tier: "installed", settledAt: 42 });
  });

  test("negative with a named provider → no_starlink carrying the provider", () => {
    const claim = deriveTailClaim(
      { starlink_status: "negative", verified_wifi: "Viasat", verified_at: 7 },
      []
    );
    expect(claim).toEqual({ tier: "no_starlink", provider: "Viasat", settledAt: 7 });
  });

  test("unknown status with no evidence → honest abstention", () => {
    const claim = deriveTailClaim(
      { starlink_status: "unknown", verified_wifi: null, verified_at: null },
      []
    );
    expect(claim).toEqual({ tier: "unknown" });
  });
});

describe("/fleet as crawl hub", () => {
  test("the fleet page links into the tail corpus", async () => {
    const body = await (await get("/fleet")).text();
    const links = [...new Set([...body.matchAll(/href="\/tail\/([^"]+)"/g)].map((m) => m[1]))];
    expect(links.length).toBeGreaterThan(0);
    for (const tail of links.slice(0, 15)) {
      expect(TAIL_URL_RE.test(tail), tail).toBe(true);
      expect((await get(`/tail/${tail}`)).status, `/tail/${tail}`).toBe(200);
    }
  });

  test("every roster tail is linked from /fleet page 1 (hangar-floor cells)", async () => {
    const body = await (await get("/fleet")).text();
    for (const t of getSitemapTails(db, "UA")) {
      expect(body, `missing /tail/${t.tail}`).toContain(`href="/tail/${t.tail}"`);
    }
  });

  test("the hub fleet page has no tail links (pages 404 there)", async () => {
    const body = await (await get("/fleet", SITES.airline.canonicalHost)).text();
    expect(body).not.toContain('href="/tail/');
  });

  test("?page beyond the data 404s, ?page=1 canonicalizes, garbage 404s", async () => {
    expect((await get("/fleet?page=9999")).status).toBe(404);
    expect((await get("/fleet?page=abc")).status).toBe(404);
    expect((await get("/fleet?page=0")).status).toBe(404);
    const p1 = await get("/fleet?page=1");
    expect(p1.status).toBe(301);
    expect(p1.headers.get("location")).toBe(`https://${UA}/fleet`);
  });

  test("server-side pagination: continuation pages carry their slice, noindex-follow", async () => {
    const sdb = makeSyntheticDb();
    // One more than a full page so page 2 exists with exactly one row.
    for (let i = 0; i <= FLEET_TAILS_PAGE_SIZE; i++) {
      addFleet(sdb, `N${String(i).padStart(3, "0")}UA`, i % 2 ? "confirmed" : "negative", {
        verifiedWifi: i % 2 ? "Starlink" : "Viasat",
      });
    }
    const sapp = createApp(sdb);
    const sget = (path: string) =>
      sapp.dispatch(req(path, UA, { headers: { Accept: "text/html" } }));

    const page1 = await (await sget("/fleet")).text();
    expect(page1).toContain(`href="/fleet?page=2"`);
    // Page 1 carries the first slice, not the overflow tail.
    expect(page1).toContain('href="/tail/N000UA"');

    const res2 = await sget("/fleet?page=2");
    expect(res2.status).toBe(200);
    const page2 = await res2.text();
    expect(page2).toContain('<meta name="robots" content="noindex, follow"');
    expect(page2).toContain(`<link rel="canonical" href="https://${UA}/fleet?page=2"`);
    // The overflow tail lives on page 2 and links out.
    expect(page2).toContain(`href="/tail/N${String(FLEET_TAILS_PAGE_SIZE).padStart(3, "0")}UA"`);
    expect(page2).toContain('href="/fleet"');

    expect((await sget("/fleet?page=3")).status).toBe(404);
    sdb.close();
  });
});
