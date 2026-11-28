import type { Database } from "bun:sqlite";
/**
 * The site's pages as a crawler that doesn't render, or a reader that ignores
 * layout, takes them: the markup with its tags dropped. Wherever two pieces
 * of text meet across an element boundary with no space, they run together
 * there ("72%0 being installedMainline narrowbody", "CRJ700Seats70",
 * "No flights scheduledN37502"), though the page draws them apart. Every
 * block of /fleet and each /fleet/{type} page, every host's homepage, and the
 * flight, route and tail pages they link are rendered, on a copy of the
 * snapshot given the data the snapshot lacks (the install pipeline, flights in
 * the air, filings), so none of them can regress unseen.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import { createApp } from "../src/server/app";
import { bodyOf, snapshotInMemory } from "./helpers";

/**
 * Each place where one text node ends and the next begins with only tags
 * between them, and the two would read as one word: a letter, digit, % or
 * closing bracket or full stop, then a letter or digit. A number followed by
 * its unit in lower case ("76ft") stays readable and is drawn joined on
 * screen too, so it passes.
 */
function joinedWords(html: string): string[] {
  const body = html
    .slice(html.indexOf("<body"))
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, "");
  const joins: string[] = [];
  let prev = "";
  let tagged = false;
  for (const part of body.split(/(<[^>]*>)/)) {
    if (part.startsWith("<")) {
      tagged = true;
      continue;
    }
    if (part === "") continue;
    if (
      tagged &&
      /[A-Za-z0-9%.)]$/.test(prev) &&
      /^[A-Za-z0-9(]/.test(part) &&
      !(/\d$/.test(prev) && /^[a-z]/.test(part))
    ) {
      joins.push(`${prev.slice(-24)}|${part.slice(0, 24)}`);
    }
    prev = part;
    tagged = false;
  }
  return joins;
}

/** The snapshot in memory, with every block's data. */
function fullFleetDb(): Database {
  const db = snapshotInMemory();
  const now = Math.floor(Date.now() / 1000);
  const today = new Date().toISOString().slice(0, 10);
  const tails = (airline: string, starlink: boolean, n: number) =>
    db
      .query(
        `SELECT tail_number FROM united_fleet WHERE airline = ? AND (verified_wifi = 'Starlink') = ?
         ORDER BY tail_number LIMIT ?`
      )
      .values(airline, starlink ? 1 : 0, n)
      .map((r) => String(r[0]));
  const progress = db.query(
    `INSERT OR REPLACE INTO fleet_progress (airline, segment, type_code, total, starlink_complete,
       in_mod, verification_needed, sheet_updated, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const [segment, type, total, complete, inMod, verif] of [
    ["express", "Totals", 488, 352, 0, 0],
    ["mainline_nb", "Totals", 906, 372, 30, 2],
    ["mainline_wb", "Totals", 247, 11, 4, 1],
    ["mainline_nb", "39M", 190, 62, 12, 1],
    ["mainline_wb", "77W", 22, 3, 4, 1],
  ] as const) {
    progress.run("UA", segment, type, total, complete, inMod, verif, today, now);
  }
  for (const [segment, type, total, complete] of [["mainline", "Totals", 240, 12]] as const) {
    progress.run("AS", segment, type, total, complete, 0, 0, today, now);
  }
  const states = ["in_mod", "verification_needed", "scheduled", "in_mod", "scheduled"];
  const unlit = tails("UA", false, states.length + 2);
  unlit.slice(0, states.length).forEach((tail, i) => {
    db.query(
      `INSERT OR REPLACE INTO fleet_progress_tails (airline, segment, type_code, tail, state,
         mod_location, sheet_updated, fetched_at) VALUES ('UA', ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      i < 3 ? "mainline_nb" : "mainline_wb",
      i < 3 ? "39M" : "77W",
      tail,
      states[i],
      i % 2 ? null : "LCQ",
      today,
      now
    );
    db.query(
      `INSERT INTO pipeline_events (airline, tail, type_code, segment, event, mod_location, observed_at)
       VALUES ('UA', ?, '39M', 'mainline_nb', 'entered_mod', 'LCQ', ?)`
    ).run(tail, now - 86400);
  });
  for (const tail of unlit.slice(states.length)) {
    db.query(
      `INSERT OR REPLACE INTO sheet_mod_notes (airline, tail_number, station, started, due_back,
         unsure, holds_until, read_at) VALUES ('UA', ?, 'MIA', ?, ?, 0, '2999-01-01', ?)`
    ).run(tail, today, "2999-01-01", now);
  }
  db.query(
    `INSERT OR REPLACE INTO fleet_anchors (airline, as_of_date, scope, metric, value, source_form,
       source_url, added_at) VALUES ('UA', '2025-12-31', 'Mainline fleet', 'mainline_fleet',
       '1050', '10-K', 'https://www.sec.gov/', ?)`
  ).run(now);
  tails("UA", true, 8).forEach((tail, i) => {
    db.query(
      `INSERT OR REPLACE INTO upcoming_flights (tail_number, flight_number, departure_airport,
         arrival_airport, departure_time, arrival_time, last_updated, airline)
       VALUES (?, ?, 'DEN', 'ORD', ?, ?, ?, 'UA')`
    ).run(tail, `UA${4100 + i}`, now - 1800 + i * 900, now + 3600 + i * 900, now);
    // Later legs give the homepage row every pill and its "+N" button.
    for (let leg = 1; leg < 7; leg++) {
      db.query(
        `INSERT OR REPLACE INTO upcoming_flights (tail_number, flight_number, departure_airport,
           arrival_airport, departure_time, arrival_time, last_updated, airline)
         VALUES (?, ?, 'ORD', 'DEN', ?, ?, ?, 'UA')`
      ).run(tail, `UA${4200 + i * 10 + leg}`, now + leg * 14400, now + leg * 14400 + 9000, now);
    }
  });
  return db;
}

let app: ReturnType<typeof createApp>;
beforeAll(() => {
  app = createApp(fullFleetDb());
});

/** The same-host pages a body links whose path matches. */
function linked(html: string, path: RegExp): string[] {
  return [
    ...new Set(
      [...html.matchAll(/href="(\/[^"#?]*)"/g)].map((m) => m[1]).filter((p) => path.test(p))
    ),
  ];
}

async function expectApart(host: string, path: string, status = 200) {
  const res = await bodyOf(app, path, host);
  expect(res.status, path).toBe(status);
  expect(joinedWords(res.text), path).toEqual([]);
  return res.text;
}

const isoDay = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

describe("fleet pages read as plain text with every word apart", () => {
  test("the rule sees a join across tags and passes a spaced or inline one", () => {
    expect(joinedWords("<body><dt>Seats</dt><dd>70</dd>")).toEqual(["Seats|70"]);
    expect(joinedWords("<body><li>72%</li><li>0 being installed</li>")).toHaveLength(1);
    expect(joinedWords("<body><a>N14530</a><a>N24505</a>")).toHaveLength(1);
    expect(joinedWords("<body><dt>Seats</dt> <dd>70</dd>")).toEqual([]);
    expect(joinedWords("<body><dd>76<span>ft</span></dd>")).toEqual([]);
    expect(joinedWords("<body><p>a · <b>b</b></p><script>x<y</script>")).toEqual([]);
  });

  for (const key of ["united", "alaska"] as const) {
    const host = SITES[key].canonicalHost;

    test(`${host}/fleet`, async () => {
      const { status, text } = await bodyOf(app, "/fleet", host);
      expect(status).toBe(200);
      for (const block of ["Starlink by aircraft type", "Install pace", "Every aircraft"]) {
        expect(text).toContain(block);
      }
      if (key === "united") {
        for (const block of [
          "In the air now",
          "Install pipeline",
          "Queued for install",
          "Last 14 days",
          "Reported in SEC filings",
          "Tail registry",
          'class="spec-card',
        ]) {
          expect(text).toContain(block);
        }
      } else {
        expect(text).toContain("Install progress, per");
      }
      expect(joinedWords(text)).toEqual([]);
    });

    test(`${host}/fleet/{type}, every type page it links`, async () => {
      const { text: fleet } = await bodyOf(app, "/fleet", host);
      const slugs = [
        ...new Set([...fleet.matchAll(/href="\/fleet\/([a-z0-9-]+)"/g)].map((m) => m[1])),
      ];
      expect(slugs.length).toBeGreaterThan(0);
      for (const slug of slugs) {
        const { status, text } = await bodyOf(app, `/fleet/${slug}`, host);
        expect(status, slug).toBe(200);
        expect(joinedWords(text), slug).toEqual([]);
      }
    });
  }
});

describe("home, flight, route and tail pages read as plain text with every word apart", () => {
  for (const site of Object.values(SITES)) {
    const host = site.canonicalHost;

    test(`${host}/`, async () => {
      const text = await expectApart(host, "/");
      if (site.features.checkFlightPage) expect(text).toContain("Does your flight have Starlink?");
      if (site.scope === "UA") {
        for (const block of [
          'id="aircraft-search"',
          "flight-pill",
          "expand-flights",
          "Upcoming flights (local times)",
          "Starlink departures by airport",
          "Popular routes",
          "Popular flights",
          "More questions",
        ]) {
          expect(text).toContain(block);
        }
      }
    });

    if (site.features.checkFlightPage) {
      test(`${host}/check-flight, and each flight page the site links`, async () => {
        const home = await expectApart(host, "/");
        const generic = await expectApart(host, "/check-flight");
        const flights = linked(`${home}${generic}`, /^\/check-flight\/[A-Z0-9]+$/);
        expect(flights.length).toBeGreaterThan(0);
        for (const path of flights) await expectApart(host, path);
        // A dated answer: today's assigned aircraft, and odds further out.
        for (const day of [0, 5]) await expectApart(host, `${flights[0]}/${isoDay(day)}`);
        await expectApart(host, "/check-flight/ZZ12", 404);
      });
    }

    if (site.features.routePlannerPage) {
      test(`${host}/route-planner, and each route it links`, async () => {
        const planner = await expectApart(host, "/route-planner");
        expect(planner).toContain('id="route-form"');
        const routes = linked(planner, /^\/route-planner\/[A-Z]{3}\/[A-Z]{3}$/);
        expect(routes.length).toBeGreaterThan(0);
        for (const path of routes) await expectApart(host, path);
      });
    }

    if (site.features.tailPages) {
      test(`${host}/fleet/{tail}, each tail the homepage links`, async () => {
        const home = await expectApart(host, "/");
        const tails = linked(home, /^\/fleet\/N[A-Z0-9]+$/);
        expect(tails.length).toBeGreaterThan(0);
        for (const path of tails) await expectApart(host, path);
      });
    }
  }
});
