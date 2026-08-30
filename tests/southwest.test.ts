/**
 * Southwest (WN) tenant: fleet-odds mode pins.
 *
 * The design constraint under test: Southwest settles tail assignments ~1h
 * before departure, so NO advance per-flight answer is honest — check-flight
 * surfaces must answer fleet odds (equipped count over the roster) and must
 * never consult schedule rows or FR24 assignments, even when one exists.
 * Shape-not-values: counts come from the snapshot seeds and are asserted
 * structurally except where the value is registry/seed-pinned by construction.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { AIRLINES, SITES } from "../src/airlines/registry";
import {
  SOUTHWEST_EQUIPPED_TAILS,
  validateSouthwestEquipped,
} from "../src/airlines/southwest-equipped";
import { setAssignmentFetcher } from "../src/api/flight-verdict";
import { applySouthwestEquipped } from "../src/scripts/seed-southwest";
import { createApp } from "../src/server/app";
import {
  addFleet,
  addFlight,
  addPlane,
  bodyOf,
  jsonOf,
  makeSyntheticDb,
  openSnapshot,
} from "./helpers";

const WN_HOST = SITES.southwest.canonicalHost;

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  app = createApp(openSnapshot());
});

// ─────────────────────────────────────────────────────────────────────────────
// Curated equipped-tails log — the source of truth's own contract
// ─────────────────────────────────────────────────────────────────────────────

describe("southwest-equipped curated log", () => {
  test("log is valid per its own contract", () => {
    expect(validateSouthwestEquipped()).toEqual([]);
    expect(SOUTHWEST_EQUIPPED_TAILS.length).toBeGreaterThan(0);
  });

  test("every record: WN tail pattern, ISO evidenced date, evidence note", () => {
    for (const r of SOUTHWEST_EQUIPPED_TAILS) {
      expect(AIRLINES.WN.tailPattern.test(r.tail), r.tail).toBe(true);
      expect(r.equippedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.evidence.length).toBeGreaterThan(10);
      expect(r.provider.length).toBeGreaterThan(0);
    }
  });

  test("validator rejects a junk append (the future discovery job's gate)", () => {
    const bad = [
      {
        tail: "12345",
        aircraftType: "",
        provider: "Starlink" as const,
        equippedOn: "yesterday",
        evidence: "",
      },
    ];
    expect(validateSouthwestEquipped(bad).length).toBeGreaterThanOrEqual(3);
  });

  test("applySouthwestEquipped writes per-tail observed evidence, idempotently", () => {
    const db = makeSyntheticDb();
    applySouthwestEquipped(db);
    applySouthwestEquipped(db); // idempotent — second run must not duplicate

    const first = SOUTHWEST_EQUIPPED_TAILS[0];
    const fleet = db
      .query(
        "SELECT starlink_status, verified_wifi, airline, fleet FROM united_fleet WHERE tail_number = ?"
      )
      .all(first.tail) as Array<{
      starlink_status: string;
      verified_wifi: string;
      airline: string;
      fleet: string;
    }>;
    expect(fleet.length).toBe(1);
    expect(fleet[0].starlink_status).toBe("confirmed");
    expect(fleet[0].verified_wifi).toBe(first.provider);
    expect(fleet[0].airline).toBe("WN");
    expect(fleet[0].fleet).toBe("mainline");

    // verified_at is the record's evidenced date too, not the run date: the
    // fleet page renders "<n>d ago" off it, and stamping the run date made a
    // months-old news report read as checked today.
    const stamped = db
      .query("SELECT verified_at FROM united_fleet WHERE tail_number = ?")
      .get(first.tail) as { verified_at: number };
    expect(stamped.verified_at).toBe(
      Math.floor(Date.parse(`${first.equippedOn}T00:00:00Z`) / 1000)
    );

    // DateFound is the record's evidenced date, never the run date — the
    // install-pace surfaces depend on that.
    const planes = db
      .query("SELECT DateFound, sheet_gid, airline FROM starlink_planes WHERE TailNumber = ?")
      .all(first.tail) as Array<{ DateFound: string; sheet_gid: string; airline: string }>;
    expect(planes.length).toBe(1);
    expect(planes[0].DateFound).toBe(first.equippedOn);
    expect(planes[0].sheet_gid).toBe("wn_curated");
    expect(planes[0].airline).toBe("WN");
    db.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fleet-odds mode: the late-assignment gate
// ─────────────────────────────────────────────────────────────────────────────

describe("WN check-flight answers fleet odds, never assignments", () => {
  test("a scheduled equipped tail does NOT produce a verified yes, and FR24 is never consulted", async () => {
    // Without the gate this is the exact setup that returns hasStarlink:true
    // ("scheduled", verified) on every other tenant.
    const db = makeSyntheticDb();
    addPlane(db, "N8543Z", "Starlink", { airline: "WN", aircraft: "Boeing 737-800" });
    addFleet(db, "N8543Z", "confirmed", {
      airline: "WN",
      aircraftType: "Boeing 737-800",
      verifiedWifi: "Starlink",
    });
    const nowSec = Math.floor(Date.now() / 1000);
    addFlight(db, "N8543Z", "WN123", "DAL", nowSec + 3600, {
      arrivalAirport: "HOU",
      airline: "WN",
    });
    const sapp = createApp(db);

    const calls: string[] = [];
    setAssignmentFetcher(async (fn) => {
      calls.push(fn);
      return [];
    });
    try {
      const today = new Date().toISOString().slice(0, 10);
      const d = await jsonOf(sapp, `/api/check-flight?flight_number=WN123&date=${today}`, WN_HOST);
      expect(d.hasStarlink).toBeNull();
      expect(d.confidence).toBe("type");
      expect(d.flights).toEqual([]);
      expect(d.message).toContain("hour before departure");
      expect(calls, "WN scope must never run FR24 reverse lookups").toEqual([]);
    } finally {
      setAssignmentFetcher(null);
      db.close();
    }
  });

  test("the permalink renders no forward-looking per-departure verdict either", async () => {
    // Same setup as above — an equipped tail scheduled inside the 48h window —
    // which on every other tenant renders "Upcoming WN410 departures · N8543Z
    // · ✓ Starlink". Publishing that above the fold while the API on the same
    // host refuses a per-flight answer is the contradiction under test.
    const db = makeSyntheticDb();
    addPlane(db, "N8543Z", "Starlink", { airline: "WN", aircraft: "Boeing 737-800" });
    addFleet(db, "N8543Z", "confirmed", {
      airline: "WN",
      aircraftType: "Boeing 737-800",
      verifiedWifi: "Starlink",
    });
    addFlight(db, "N8543Z", "WN410", "DAL", Math.floor(Date.now() / 1000) + 3 * 3600, {
      arrivalAirport: "HOU",
      airline: "WN",
    });
    const sapp = createApp(db);
    try {
      const { status, text } = await bodyOf(sapp, "/check-flight/WN410", WN_HOST);
      expect(status).toBe(200);
      // React SSR splits adjacent text expressions with comments.
      const body = text.replace(/<!--.*?-->/g, "");
      expect(body).not.toContain("Upcoming WN410 departures");
      expect(body).not.toContain("✓ Starlink");
      expect(body).toContain("fleet odds");
    } finally {
      db.close();
    }
  });

  test("snapshot WN410: honest fleet-odds shape with the seeded penetration", async () => {
    const d = await jsonOf(app, "/api/check-flight?flight_number=WN410&date=2026-03-22", WN_HOST);
    expect(d.hasStarlink).toBeNull();
    expect(d.confidence).toBe("type");
    expect(d.flights).toEqual([]);
    expect(typeof d.prediction?.probability).toBe("number");
    expect(d.prediction.probability).toBeGreaterThan(0);
    expect(d.prediction.probability).toBeLessThan(1);
    // "N of M ... equipped" — the quotable fleet-odds clause.
    expect(d.message).toMatch(/\d+ of \d+ .* aircraft equipped/);
    expect(d.message).toContain("hour before departure");
    expect(d.message).not.toContain("United");
  });

  test("at real-launch penetration the odds never round down to a '~0%' verdict", async () => {
    // 1 equipped of ~800 is the shape the real roster lands in the moment the
    // FR24 seed runs. A rounded percentage reads as a verdict on the user's
    // flight instead of the rollout's current edge — the same hazard the
    // per-flight meta copy already guards.
    const db = makeSyntheticDb();
    addPlane(db, "N8543Z", "Starlink", { airline: "WN", aircraft: "Boeing 737-800" });
    const ins = db.query(
      `INSERT INTO united_fleet (tail_number, aircraft_type, fleet, first_seen_source, first_seen_at, last_seen_at, starlink_status, verified_wifi, verified_at, airline)
       VALUES (?, 'Boeing 737-800', 'mainline', 'test', 1, 1, ?, ?, 1, 'WN')`
    );
    ins.run("N8543Z", "confirmed", "Starlink");
    for (let i = 0; i < 799; i++) ins.run(`N8${String(i).padStart(3, "0")}W`, "unknown", null);
    const sapp = createApp(db);
    try {
      const d = await jsonOf(sapp, "/api/predict-flight?flight_number=410", WN_HOST);
      expect(d.probability).toBeGreaterThan(0);
      expect(d.probability).toBeLessThan(0.01);
      expect(d.message).not.toContain("~0%");
      // The raw fraction leads instead, so the number a reader quotes is real.
      expect(d.message).toMatch(/1 of 800 .* aircraft equipped/);
    } finally {
      db.close();
    }
  });

  test("/api/predict-flight mirrors the registry answer (no model fingerprints)", async () => {
    const d = await jsonOf(app, "/api/predict-flight?flight_number=410", WN_HOST);
    expect(d.flight_number).toBe("WN410");
    expect(typeof d.probability).toBe("number");
    expect(d.confidence).toBe("type");
    expect(d.method).toBeUndefined();
    expect(d.n_observations).toBeUndefined();
    expect(d.message).toContain("737");
  });

  test("/api/plan-route answers fleet odds with the late-assignment caveat", async () => {
    const d = await jsonOf(app, "/api/plan-route?origin=DAL&destination=HOU", WN_HOST);
    expect(d.itineraries).toEqual([]);
    expect(d.message).toMatch(/\d+ of \d+ equipped/);
    expect(d.message).toContain("hour before departure");
  });

  test("foreign-prefix numbers are refused on the WN host (404, no cross-brand copy)", async () => {
    for (const fn of ["UA1", "AS118", "HA9999", "QR9999"]) {
      const { status, text } = await bodyOf(
        app,
        `/api/check-flight?flight_number=${fn}&date=2026-03-22`,
        WN_HOST
      );
      expect(status, fn).toBe(404);
      expect(text).toContain("not tracked");
      expect(text).not.toMatch(/United|Hawaiian|Alaska|Qatar/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pages: the honesty is rendered, not just wired
// ─────────────────────────────────────────────────────────────────────────────

describe("WN pages carry the fleet-odds story", () => {
  test("homepage: dated stat sentence (methodology-linked) + equipped tail + commitment", async () => {
    const { status, text } = await bodyOf(app, "/", WN_HOST);
    expect(status).toBe(200);
    expect(text).toContain('id="starlink-stat"');
    const stat = text.slice(text.indexOf('id="starlink-stat"'));
    expect(stat.slice(0, stat.indexOf("</p>"))).toContain('href="/methodology"');
    expect(text).toContain("N8543Z");
    expect(text).toContain("300+");
    expect(text).toContain("Rapid Rewards");
  });

  test("check-flight page never promises an assigned-aircraft answer", async () => {
    const bare = await bodyOf(app, "/check-flight", WN_HOST);
    expect(bare.status).toBe(200);
    expect(bare.text).toContain("fleet odds");
    expect(bare.text).not.toContain("12,000+ past flights");

    // Permalink for a flight with data renders the same honesty.
    const perma = await bodyOf(app, "/check-flight/WN410", WN_HOST);
    expect(perma.status).toBe(200);
    expect(perma.text).toContain("fleet odds");
  });

  test("indexable meta never promises an assignment window WN doesn't have", async () => {
    // These are the SERP snippets; the sitemap advertises every one of them.
    const description = (html: string) =>
      html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "";
    const sitemap = await bodyOf(app, "/sitemap.xml", WN_HOST);
    const paths = [...sitemap.text.matchAll(/<loc>https:\/\/[^/]+([^<]*)<\/loc>/g)].map(
      (m) => m[1] || "/"
    );
    expect(paths.length).toBeGreaterThan(3);
    for (const path of paths) {
      const { status, text } = await bodyOf(app, path, WN_HOST);
      expect(status, `${path} is advertised in the sitemap`).toBe(200);
      const d = description(text);
      expect(d, `${path} meta`).not.toMatch(/assignments publish|two days/i);
      expect(d, `${path} meta`).not.toContain("firm answer");
      expect(d, `${path} meta`).not.toContain("direct verification");
    }
  });

  test("route planner ranks on fleet odds, never on flight-number history", async () => {
    const { status, text } = await bodyOf(app, "/route-planner", WN_HOST);
    expect(status).toBe(200);
    expect(text).toContain("hour before departure");
    expect(text).toContain("fleet-wide odds");
    // United's copy: WN has no flight-number history to rank on, and there is
    // no day on which checking again buys a firmer answer.
    expect(text).not.toContain("We track historical aircraft assignments");
    expect(text).not.toContain("1-2 days before departure");
  });

  test("fleet page renders the WN roster with per-tail provider coloring", async () => {
    const { status, text } = await bodyOf(app, "/fleet", WN_HOST);
    expect(status).toBe(200);
    expect(text).toContain("N8543Z");
    expect(text).not.toMatch(/United Airlines|Hawaiian Airlines|Alaska Airlines|Qatar Airways/);
  });

  test("methodology page documents the curated evidence log", async () => {
    const { status, text } = await bodyOf(app, "/methodology", WN_HOST);
    expect(status).toBe(200);
    expect(text).toContain("Curated per-tail evidence log");
    expect(text).toContain("hour before departure");
  });

  test("methodology page claims only the machinery WN actually runs", async () => {
    const { text } = await bodyOf(app, "/methodology", WN_HOST);
    // United's ladder and its consensus pass describe a verifier WN has none of.
    expect(text).not.toContain("on the airline's own systems");
    expect(text).not.toContain("queued for direct verification");
    expect(text).not.toContain("hourly consensus pass");
    // ...and the evidence log the page cites as its basis is actually rendered,
    // with a link a reader can follow.
    for (const r of SOUTHWEST_EQUIPPED_TAILS) {
      expect(text).toContain(r.tail);
      expect(text).toContain(r.equippedOn);
      if (r.evidenceUrl) expect(text).toContain(r.evidenceUrl);
    }
  });

  test("homepage stat attribution names the evidence WN has, not verification", async () => {
    const { text } = await bodyOf(app, "/", WN_HOST);
    const stat = text.slice(text.indexOf('id="starlink-stat"'));
    const sentence = stat.slice(0, stat.indexOf("</p>")).replace(/<!--.*?-->/g, "");
    expect(sentence).not.toContain("verification data");
    expect(sentence).toContain("evidence log");
  });

  test("llms.txt tells agents the honest pricing and assignment facts", async () => {
    const { status, text } = await bodyOf(app, "/llms.txt", WN_HOST);
    expect(status).toBe(200);
    expect(text).toContain("Rapid Rewards");
    expect(text).toContain("hour before departure");
    expect(text).toContain("starlink-stat");
    expect(text).toContain("/methodology");
    expect(text).not.toContain("United");
  });

  test("llms.txt never contradicts itself about advance per-flight answers", async () => {
    const { text } = await bodyOf(app, "/llms.txt", WN_HOST);
    expect(text).toContain("No advance answer is honest");
    // The self-contradiction that shipped: a "live answer" per-flight link two
    // paragraphs above the refusal.
    expect(text).not.toContain("shows the live answer");
    expect(text).not.toMatch(/live Starlink status/);
    expect(text).not.toMatch(/check-flight\/WN\d/);
  });
});
