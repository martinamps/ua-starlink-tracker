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

import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { buildFlightLookupVariants, stripFlightNumberZeros } from "../src/airlines/flight-number";
import { AIRLINES, SITES, siteForAirline } from "../src/airlines/registry";
import { deriveTailClaim, tailClaimHeadline, tailVerdict } from "../src/components/tail-page";
import {
  TAIL_URL_RE,
  flightNumberHasData,
  getSitemapTails,
  getTailPageRecord,
  getTailVerificationTimeline,
} from "../src/database/database";
import type { TailVerificationEvent } from "../src/database/database";
import { FLEET_TAILS_PAGE_SIZE, createApp, parseTailPath } from "../src/server/app";
import { addFleet, addFlight, makeSyntheticDb, openSnapshot, req } from "./helpers";

let app: ReturnType<typeof createApp>;
let db: ReturnType<typeof openSnapshot>;

beforeAll(() => {
  db = openSnapshot();
  app = createApp(db);
});

const UA = SITES.united.canonicalHost;
const get = (path: string, host = UA) =>
  app.dispatch(req(path, host, { headers: { Accept: "text/html" } }));

const NOINDEX = '<meta name="robots" content="noindex, follow"';

/** A tail the snapshot actually backs, so the test survives data drift. */
function someTail(airline = "UA", where = "1=1"): string {
  const row = db
    .query(`SELECT tail_number FROM united_fleet WHERE airline = ? AND ${where} LIMIT 1`)
    .get(airline) as { tail_number: string } | null;
  if (!row) throw new Error(`snapshot has no ${airline} tail (${where}) — run bun run test:setup`);
  return row.tail_number;
}

/** A tail whose settled status the newest publishable check agrees with, for
 * the given tier. Picking by derived tier (not by a status column) keeps these
 * tests off whichever tails happen to be mid-disagreement in the snapshot. */
function tailWithTier(tier: string, airline = "UA"): string {
  const rows = db
    .query("SELECT tail_number FROM united_fleet WHERE airline = ? ORDER BY tail_number")
    .all(airline) as { tail_number: string }[];
  for (const { tail_number } of rows) {
    const record = getTailPageRecord(db, tail_number, airline);
    if (!record) continue;
    const claim = deriveTailClaim(record, getTailVerificationTimeline(db, tail_number, airline));
    if (claim.tier === tier && !claim.contestedAt) return tail_number;
  }
  throw new Error(`snapshot has no ${airline} tail at tier ${tier} — run bun run test:setup`);
}

function addLog(
  sdb: Database,
  tail: string,
  opts: {
    source?: string;
    hasStarlink?: number;
    wifi?: string;
    checkedAt: number;
    tailConfirmed?: number | null;
    airline?: string;
  }
): void {
  const {
    source = "united",
    hasStarlink = 1,
    wifi = "Starlink",
    tailConfirmed = 1,
    airline = "UA",
  } = opts;
  sdb
    .query(
      `INSERT INTO starlink_verification_log
       (tail_number, source, checked_at, has_starlink, wifi_provider, error, tail_confirmed, airline)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`
    )
    .run(tail, source, opts.checkedAt, hasStarlink, wifi, tailConfirmed, airline);
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
        `${tail} — (Starlink verified|Starlink installed|no Starlink yet|WiFi status unknown|re-verifying Starlink status)`
      )
    );
    expect(body).toContain("Verification history");
  });

  test("a negative tail is a first-class page saying 'no Starlink yet', dated", async () => {
    const tail = tailWithTier("no_starlink");
    const res = await get(`/tail/${tail}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`${tail} — no Starlink yet`);
    expect(body).toContain("does not have Starlink yet");
    // The negative tier dates its claim like every other tier — a bare
    // present-tense "installed today" silently ages into a lie.
    const record = getTailPageRecord(db, tail, "UA");
    if (record?.verified_at) {
      const settled = new Date(record.verified_at * 1000).toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      });
      expect(body).toContain(`as of ${settled}`);
      expect(body).not.toContain("is installed today");
    }
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

  // The linked corpus is thousands of distinct flight numbers and grows with
  // the data, so one GET per link outruns the page-class rate limiter and the
  // test starts failing on volume rather than on a broken link. What actually
  // decides whether a permalink resolves is checked in-process on every link —
  // canonical marketing spelling (anything else 301s) and the handler's own
  // existence gate (no rows behind it degrades to the generic noindex page) —
  // and HTTP is dispatched only for a fixed, data-independent sample.
  test("every /check-flight link on tail pages resolves (marketing numbers only)", async () => {
    const seen = new Set<string>();
    for (const t of getSitemapTails(db, "UA")) {
      const body = await (await get(`/tail/${t.tail}`)).text();
      for (const m of body.matchAll(/href="\/check-flight\/([^"]+)"/g)) seen.add(m[1]);
    }
    const linked = [...seen].sort();
    expect(linked.length).toBeGreaterThan(0);

    for (const fn of linked) {
      expect(fn, "non-marketing flight number linked").toMatch(/^UA\d+$/);
      expect(stripFlightNumberZeros(fn), `non-canonical spelling linked: ${fn}`).toBe(fn);
      expect(
        flightNumberHasData(db, buildFlightLookupVariants(AIRLINES.UA, fn), "UA"),
        `/check-flight/${fn} has no data behind it`
      ).toBe(true);
    }

    // Fixed stride plus both ends: deterministic, no randomness, and bounded
    // at ~HTTP_PROBES requests however large the corpus gets.
    const HTTP_PROBES = 24;
    const stride = Math.ceil(linked.length / HTTP_PROBES);
    const probes = new Set<string>([linked[0], linked[linked.length - 1]]);
    for (let i = 0; i < linked.length; i += stride) probes.add(linked[i]);
    for (const fn of probes) {
      expect((await get(`/check-flight/${fn}`)).status, `/check-flight/${fn}`).toBe(200);
    }
  }, 60_000);
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

  // A type-derived backend (alaska-json, qatar-fltstatus) only ever sees the
  // equipment assigned to a flight. Letting one date a "verified in service"
  // claim invents provenance — the wrong-yes class OBSERVED_WIFI_SOURCES exists
  // to prevent on the write path.
  test("confirmed with only type-derived rows → installed, never verified", () => {
    for (const source of ["alaska", "qatar"]) {
      const claim = deriveTailClaim(
        { starlink_status: "confirmed", verified_wifi: "Starlink", verified_at: 42 },
        [event({ source })]
      );
      expect(claim, source).toEqual({ tier: "installed", settledAt: 42 });
    }
  });

  // The timeline is printed directly under the headline, so the headline has
  // to answer to its newest row — consensus can lag a flip by weeks.
  test("newest observation outranks older ones, never the reverse", () => {
    const stalePositive = event({ last_checked_at: 1_700_000_000, day: "2023-11-14" });
    const freshNegative = event({
      has_starlink: 0,
      wifi_provider: "Viasat",
      last_checked_at: 1_770_000_000,
      day: "2026-02-02",
    });
    const claim = deriveTailClaim(
      { starlink_status: "confirmed", verified_wifi: "Starlink", verified_at: 5 },
      [freshNegative, stalePositive]
    );
    expect(claim).toEqual({ tier: "installed", settledAt: 5, contestedAt: 1_770_000_000 });
  });

  test("a fresh Starlink observation over a settled negative abstains, not asserts", () => {
    const claim = deriveTailClaim(
      { starlink_status: "negative", verified_wifi: "Viasat", verified_at: 5 },
      [event({ last_checked_at: 1_770_000_000 })]
    );
    expect(claim).toEqual({ tier: "unknown", contestedAt: 1_770_000_000 });
  });

  test("a contested claim never publishes an affirmative headline", () => {
    for (const record of [
      { starlink_status: "confirmed", verified_wifi: "Starlink", verified_at: 5 },
      { starlink_status: "negative", verified_wifi: "Viasat", verified_at: 5 },
    ]) {
      const claim = deriveTailClaim(record, [
        event({ has_starlink: record.starlink_status === "confirmed" ? 0 : 1 }),
      ]);
      expect(claim.contestedAt).toBeGreaterThan(0);
      expect(tailClaimHeadline(claim)).toBe("re-verifying Starlink status");
      expect(tailVerdict(claim, "N1UA", "United Airlines", "B737")).toContain("re-verifying");
    }
  });
});

describe("evidence the page is allowed to publish", () => {
  // computeWifiConsensus refuses to settle on tail_confirmed IS NULL rows —
  // "legacy is the contaminated set". A page captioned "the evidence behind the
  // status above" must not show what the status itself ignored.
  test("the timeline drops unconfirmed legacy rows", () => {
    const sdb = makeSyntheticDb();
    addFleet(sdb, "N900UA", "confirmed", { verifiedWifi: "Starlink" });
    addLog(sdb, "N900UA", { checkedAt: 1_770_000_000, tailConfirmed: null });
    addLog(sdb, "N900UA", { checkedAt: 1_760_000_000, tailConfirmed: 1 });
    const timeline = getTailVerificationTimeline(sdb, "N900UA", "UA");
    expect(timeline).toHaveLength(1);
    expect(timeline[0].last_checked_at).toBe(1_760_000_000);
    sdb.close();
  });

  test("a legacy-only tail cannot date a 'verified in service' claim", async () => {
    const sdb = makeSyntheticDb();
    addFleet(sdb, "N901UA", "confirmed", { verifiedWifi: "Starlink", verifiedAt: 1_700_000_000 });
    addLog(sdb, "N901UA", { checkedAt: 1_770_000_000, tailConfirmed: null });
    const sapp = createApp(sdb);
    const body = await (
      await sapp.dispatch(req("/tail/N901UA", UA, { headers: { Accept: "text/html" } }))
    ).text();
    expect(body).toContain("N901UA — Starlink installed");
    expect(body).not.toContain("last verified in service");
    sdb.close();
  });

  test("a type-derived row is captioned as fleet data, not an in-service check", async () => {
    const sdb = makeSyntheticDb();
    addFleet(sdb, "N902AK", "confirmed", { airline: "AS", verifiedWifi: "Starlink" });
    addLog(sdb, "N902AK", { source: "alaska", checkedAt: 1_770_000_000, airline: "AS" });
    const sapp = createApp(sdb);
    const host = siteForAirline("AS")?.canonicalHost as string;
    const body = await (
      await sapp.dispatch(req("/tail/N902AK", host, { headers: { Accept: "text/html" } }))
    ).text();
    expect(body).toContain("N902AK — Starlink installed");
    expect(body).not.toContain("Starlink verified");
    expect(body).not.toContain("last verified in service");
    expect(body).toContain("Starlink per fleet data");
    expect(body).toContain("alaskaair.com equipment type");
    sdb.close();
  });
});

describe("the tail URL family is bounded by evidence, not by roster membership", () => {
  test("a roster row with nothing to say serves 200 but noindex, and is unadvertised", async () => {
    const sdb = makeSyntheticDb();
    addFleet(sdb, "N903UA", "unknown", { verifiedWifi: null, verifiedAt: null });
    const sapp = createApp(sdb);
    const res = await sapp.dispatch(req("/tail/N903UA", UA, { headers: { Accept: "text/html" } }));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(NOINDEX);
    expect(body).toContain("No verification checks on record");
    expect(getSitemapTails(sdb, "UA").map((t) => t.tail)).not.toContain("N903UA");
    sdb.close();
  });

  test("one real fact is enough to earn the index back", async () => {
    const sdb = makeSyntheticDb();
    addFleet(sdb, "N904UA", "unknown", { verifiedWifi: null, verifiedAt: null });
    addFlight(sdb, "N904UA", "UA100", "ORD", Math.floor(Date.now() / 1000) + 7200);
    const sapp = createApp(sdb);
    const body = await (
      await sapp.dispatch(req("/tail/N904UA", UA, { headers: { Accept: "text/html" } }))
    ).text();
    expect(body).not.toContain(NOINDEX);
    expect(getSitemapTails(sdb, "UA").map((t) => t.tail)).toContain("N904UA");
    sdb.close();
  });

  // The sitemap and the page share one predicate; this pins that they can never
  // drift apart on real data.
  test("advertised ⇔ indexable, across the snapshot roster", async () => {
    const advertised = new Set(getSitemapTails(db, "UA").map((t) => t.tail));
    const roster = (
      db
        .query("SELECT tail_number FROM united_fleet WHERE airline = 'UA' ORDER BY tail_number")
        .all() as { tail_number: string }[]
    ).map((r) => r.tail_number);
    expect(roster.length).toBeGreaterThan(0);
    for (const tail of roster.slice(0, 40)) {
      const body = await (await get(`/tail/${tail}`)).text();
      expect(!body.includes(NOINDEX), tail).toBe(advertised.has(tail));
    }
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

  // Without tail pages the hangar floor is still navigation: each cell jumps to
  // that tail's registry row (carrying ?page= when pagination moved it there),
  // and the row still carries the id + :target highlight to land on.
  test("hub hangar cells jump into the registry instead of going inert", async () => {
    const body = await (await get("/fleet", SITES.airline.canonicalHost)).text();
    const jumps = [...body.matchAll(/href="(\/fleet(?:\?page=\d+)?)#t-([A-Z0-9-]+)"/g)];
    expect(jumps.length).toBeGreaterThan(0);
    expect(body).toContain(".tail-sl:target");
    for (const [, target, tail] of jumps.slice(0, 15)) {
      // The row lives on the page the cell points at, with the matching id.
      const page = await (await get(target, SITES.airline.canonicalHost)).text();
      expect(page, `${tail} missing from ${target}`).toContain(`id="t-${tail}"`);
      expect(page, `${tail} not findable by ⌘F on ${target}`).toContain(`>${tail}</span>`);
    }
  });

  // ⌘F only ever finds what is on the page, so the copy must describe the
  // slice, not the fleet.
  test("the registry's find-your-tail promise is scoped to the rendered slice", async () => {
    const sdb = makeSyntheticDb();
    for (let i = 0; i <= FLEET_TAILS_PAGE_SIZE; i++) {
      addFleet(sdb, `N${String(i).padStart(3, "0")}UA`, "negative", { verifiedWifi: "Viasat" });
    }
    const sapp = createApp(sdb);
    const page1 = await (
      await sapp.dispatch(req("/fleet", UA, { headers: { Accept: "text/html" } }))
    ).text();
    const total = FLEET_TAILS_PAGE_SIZE + 1;
    expect(page1).not.toContain(`All ${total} tails`);
    expect(page1).toContain(`Tails 1–${FLEET_TAILS_PAGE_SIZE} of ${total}`);
    // The overflow tail is genuinely absent from page 1's text, as the copy says.
    const overflow = `N${String(FLEET_TAILS_PAGE_SIZE).padStart(3, "0")}UA`;
    expect(page1).not.toContain(`>${overflow}</span>`);
    expect(page1).toContain('href="/fleet?page=2"');
    sdb.close();
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
