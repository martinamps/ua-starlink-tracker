/**
 * The /routes network map: every equipped route in the live window, drawn
 * from the same rows the page's tables count, on a coastline served once from
 * /static. Seeded on a fresh database so each count is one the test wrote.
 */

import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import {
  CHOOSER_MAX,
  FINGER_RADIUS_PX,
  HUB_CLEAR_PX,
  HUB_SHARE,
  airportsUnderTap,
  clearHub,
  fingerRadius,
  tapIsOurs,
} from "../src/client/routes-map-pick";
import { buildRouteNetwork } from "../src/components/routes-map/network";
import { getRouteNetworkRows } from "../src/database/database";
import { createApp } from "../src/server/app";
import { MAP_HEIGHT, MAP_WIDTH, onMap, projectToMap } from "../src/utils/map-projection";
import { addFlight, addIndexingHistory, addPlane, bodyOf, makeFreshDb, sectionOf } from "./helpers";

const UA = SITES.united.canonicalHost;
const HOUR = 3600;
const now = Math.floor(Date.now() / 1000);

let db: Database;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  db = makeFreshDb();
  addPlane(db, "N1VER", "Starlink");
  addPlane(db, "N2VER", "Starlink");
  addFlight(db, "N1VER", "UA1", "DEN", now + HOUR, { arrivalAirport: "ORD" });
  addFlight(db, "N1VER", "UA2", "ORD", now + 4 * HOUR, { arrivalAirport: "DEN" });
  addFlight(db, "N2VER", "UA3", "SFO", now + 2 * HOUR, { arrivalAirport: "HNL" });
  addFlight(db, "N2VER", "UA4", "SFO", now + 6 * HOUR, { arrivalAirport: "EWR" });
  // Not a Starlink plane: never on the map.
  addFlight(db, "N9NONE", "UA9", "IAH", now + HOUR, { arrivalAirport: "MCO" });
  // Flown history, so each departing airport's page indexes and is linked.
  for (const code of ["DEN", "ORD", "SFO"]) addIndexingHistory(db, "N1VER", code, "IAH", now);
  app = createApp(db);
});

describe("projection", () => {
  test("the frame holds the mainland hubs and leaves Hawaii and Guam off", () => {
    for (const [lat, lon] of [
      [41.98, -87.9], // ORD
      [37.62, -122.38], // SFO
      [29.98, -95.34], // IAH
      [40.69, -74.17], // EWR
      [4.7, -74.15], // BOG
    ])
      expect(onMap(projectToMap(lat, lon))).toBe(true);
    expect(onMap(projectToMap(21.32, -157.92))).toBe(false);
    expect(onMap(projectToMap(13.48, 144.8))).toBe(false);
    expect(MAP_HEIGHT).toBeGreaterThan(0);
    expect(MAP_HEIGHT).toBeLessThan(MAP_WIDTH);
  });
});

describe("buildRouteNetwork", () => {
  test("one arc per pair, both directions summed; off-map ends listed, not drawn", () => {
    const net = buildRouteNetwork(getRouteNetworkRows(db, "UA", now).rows);
    expect(net.totalDepartures).toBe(4);
    expect(net.drawnDepartures).toBe(3);
    expect(net.arcs.map((a) => [a.key, a.departures])).toEqual([
      ["EWR-SFO", 1],
      ["DEN-ORD", 2],
    ]);
    expect(net.offMap).toEqual([{ code: "HNL", flights: 1, departs: false }]);
    // SFO's dot counts its departure to Hawaii too.
    expect(net.airports.find((a) => a.code === "SFO")?.departures).toBe(2);
    expect(net.airports.find((a) => a.code === "EWR")?.departures).toBe(0);
    expect(net.airports.some((a) => a.code === "IAH")).toBe(false);
    for (const a of net.arcs) expect(a.d).toMatch(/^M-?\d+ -?\d+Q-?\d+ -?\d+ -?\d+ -?\d+$/);
  });

  test("an airport with no coordinates is neither drawn nor listed", () => {
    const net = buildRouteNetwork([
      { origin: "ORD", destination: "ZZZ", departures: 3, flight_numbers: 1, next_departure: now },
    ]);
    expect(net.arcs).toEqual([]);
    expect(net.offMap).toEqual([]);
    expect(net.totalDepartures).toBe(3);
    expect(net.drawnDepartures).toBe(0);
  });
});

describe("/routes", () => {
  test("draws the map, links departing airports, and lists what lies beyond", async () => {
    const { status, text } = await bodyOf(app, "/routes", UA);
    expect(status).toBe(200);
    const map = sectionOf(text, "The Starlink network");
    expect(map).toContain("2 routes between 4 airports");
    expect(map).toContain('href="/routes/DEN"');
    expect(map).toContain('href="/routes/SFO"');
    // EWR has arrivals only here, so no page to link.
    expect(map).not.toContain('href="/routes/EWR"');
    expect(map).toContain("75% of 4 departures are on this map");
    expect(map).toContain("HNL");
    // One script, its own: which airport a tap opens on phones.
    expect(map.match(/<script[^>]*>/g)).toEqual([
      expect.stringMatching(/^<script src="\/static\/routes-map\.[a-z0-9]+\.js" defer="">$/),
    ]);
  });

  test("the phone tap script is served, and its chooser ships closed and empty", async () => {
    const { text } = await bodyOf(app, "/routes", UA);
    const map = sectionOf(text, "The Starlink network");
    const src = map.match(/\/static\/routes-map\.[a-z0-9]+\.js/)?.[0] ?? "";
    const r = await app.dispatch(new Request(`http://x${src}`, { headers: { Host: UA } }));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/javascript");
    expect(r.headers.get("cache-control")).toContain("immutable");
    // The hooks the script looks for; without any one it does nothing.
    for (const hook of [
      "js-map ",
      "js-map-ring",
      "js-map-chooser ",
      "js-map-chooser-list",
      "js-map-chooser-more",
      "js-map-chooser-close",
      "js-map-chooser-all",
      "js-map-list",
    ])
      expect(map).toContain(hook);
    const chooser = map.slice(map.indexOf("<dialog"), map.indexOf("</dialog>"));
    expect(chooser).toMatch(/^<dialog class="js-map-chooser [^"]*" aria-label="[^"]+">/);
    // A phone held sideways is wider than sm: the chooser and the list stay
    // reachable there for a finger, and the list folds away only for a mouse.
    expect(chooser).not.toContain("sm:hidden");
    expect(map).toMatch(/<details class="js-map-list [^"]*sm:pointer-fine:hidden/);
    expect(chooser).not.toContain(" open");
    expect(chooser).not.toContain("<a ");
    expect(chooser).toContain("See all 3 airports");
  });

  test("airport links reach screen readers and have phone-sized tap targets", async () => {
    const { text } = await bodyOf(app, "/routes", UA);
    const map = sectionOf(text, "The Starlink network");
    // role="img" would hide every link inside the picture.
    expect(map).not.toContain('role="img"');
    expect(map).toMatch(/<a href="\/routes\/SFO" aria-label="SFO: 2 Starlink departures"/);
    // The tap script weighs a hub by the count the label states.
    expect(map).toMatch(/<a href="\/routes\/SFO" [^>]*data-departures="2"/);
    // Busiest first: focus order follows the labels.
    expect(map.indexOf('href="/routes/SFO"')).toBeLessThan(map.indexOf('href="/routes/ORD"'));
    // The tap circle on phones: 41 map units is 12 px on a 300 px wide map.
    const sfo = map.slice(map.indexOf('href="/routes/SFO"'));
    const phoneR = Number(sfo.match(/r="([\d.]+)"[^>]*class="sm:hidden"/)?.[1]);
    expect(phoneR).toBeGreaterThanOrEqual(27);
    expect(phoneR).toBeLessThanOrEqual(41);
    // Every linked airport is also one tap away in the phone list.
    const list = map.slice(map.indexOf("<details"), map.indexOf("</details>"));
    expect(list).toContain("All 3 airports on the map");
    for (const code of ["DEN", "ORD", "SFO"]) expect(list).toContain(`href="/routes/${code}"`);
    expect(list).not.toContain('href="/routes/EWR"');
  });

  test("the coastline is a year-cached SVG under /static", async () => {
    const { text } = await bodyOf(app, "/routes", UA);
    const href = text.match(/\/static\/routes-map\.[a-z0-9]+\.svg/)?.[0];
    expect(href).toBeDefined();
    const r = await app.dispatch(new Request(`http://x${href}`, { headers: { Host: UA } }));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("image/svg+xml");
    expect(r.headers.get("cache-control")).toContain("immutable");
    expect(await r.text()).toStartWith("<svg");
  });
});

describe("tapIsOurs", () => {
  test("a finger or pen is caught at every width, a mouse only on narrow screens", () => {
    for (const wide of [false, true]) {
      expect(tapIsOurs(wide, "touch")).toBe(true);
      expect(tapIsOurs(wide, "pen")).toBe(true);
    }
    expect(tapIsOurs(false, "mouse")).toBe(true);
    expect(tapIsOurs(false, null)).toBe(true);
    expect(tapIsOurs(true, "mouse")).toBe(false);
    expect(tapIsOurs(true, null)).toBe(false);
  });
});

describe("airportsUnderTap", () => {
  const dots = [
    { code: "IAD", x: 100, y: 100 },
    { code: "DCA", x: 104, y: 101 },
    { code: "BWI", x: 106, y: 96 },
    { code: "EWR", x: 124, y: 80 },
    { code: "DEN", x: 10, y: 100 },
  ];
  const codes = (x: number, y: number) => airportsUnderTap(dots, x, y).map((d) => d.code);

  test("every dot under the fingertip, nearest first", () => {
    expect(codes(100, 100)).toEqual(["IAD", "DCA", "BWI"]);
    expect(codes(105, 99)).toEqual(["DCA", "BWI", "IAD"]);
  });

  test("a dot alone under the finger is the only answer, out to the finger's edge", () => {
    expect(codes(10, 100)).toEqual(["DEN"]);
    expect(codes(10 + FINGER_RADIUS_PX, 100)).toEqual(["DEN"]);
    expect(codes(10, 100 - FINGER_RADIUS_PX - 1)).toEqual([]);
    expect(codes(50, 50)).toEqual([]);
  });

  test("a tap never resolves to one airport while another is as near", () => {
    // Each sampled tap within a finger of IAD: IAD is offered, never dropped
    // for a single neighbour.
    for (let dx = -FINGER_RADIUS_PX; dx <= FINGER_RADIUS_PX; dx += 3)
      for (let dy = -FINGER_RADIUS_PX; dy <= FINGER_RADIUS_PX; dy += 3) {
        if (Math.hypot(dx, dy) > FINGER_RADIUS_PX) continue;
        const near = codes(100 + dx, 100 + dy);
        expect(near).toContain("IAD");
        if (near.length === 1) expect(near).toEqual(["IAD"]);
      }
    expect(CHOOSER_MAX).toBeGreaterThanOrEqual(3);
  });
});

describe("fingerRadius", () => {
  test("pinched in, the fingertip covers less of the map", () => {
    expect(fingerRadius(1)).toBe(FINGER_RADIUS_PX);
    expect(fingerRadius(3)).toBe(FINGER_RADIUS_PX / 3);
    // A layout narrower than the screen reports a scale under 1: the
    // fingertip never grows past its own size.
    expect(fingerRadius(0.5)).toBe(FINGER_RADIUS_PX);
  });

  test("zoomed far enough, a tap on Dulles opens Dulles alone", () => {
    // Dulles, Reagan and Baltimore as an upright phone draws them, in page px.
    const dc = [
      { code: "IAD", x: 100, y: 100 },
      { code: "DCA", x: 104, y: 101 },
      { code: "BWI", x: 106, y: 96 },
    ];
    expect(airportsUnderTap(dc, 100, 100).map((d) => d.code)).toEqual(["IAD", "DCA", "BWI"]);
    expect(airportsUnderTap(dc, 100, 100, fingerRadius(5)).map((d) => d.code)).toEqual(["IAD"]);
  });
});

/**
 * Hit-tests the rendered SVG the way a browser does: of the circles that take
 * input at that width, the last one painted under the point wins. Dense hubs
 * from the real map, where a quieter neighbour's dot covers a hub's centre.
 */
describe("clearHub", () => {
  // Chicago as a tablet draws it: O'Hare's dot, Milwaukee 10 px north.
  const ord = { code: "ORD", x: 100, y: 100, departures: 627, radius: 8.6 };
  const mke = { code: "MKE", x: 100, y: 90, departures: 18, radius: 2.5 };
  const sbn = { code: "SBN", x: 111, y: 104, departures: 8, radius: 2 };
  const hub = (dots: (typeof ord)[], x: number, y: number) =>
    clearHub(airportsUnderTap(dots, x, y), x, y)?.code ?? null;

  test("a finger on a far busier hub's dot opens it", () => {
    expect(hub([ord, mke, sbn], 100, 100)).toBe("ORD");
    expect(hub([ord, mke, sbn], 100, 101)).toBe("ORD");
  });

  test("it asks when the finger is off the hub's dot or near another", () => {
    expect(hub([ord, mke, sbn], 100, 90)).toBeNull();
    expect(hub([ord, mke, sbn], 100, 96)).toBeNull();
    expect(hub([ord, mke, sbn], 100, 110)).toBeNull();
  });

  test("it asks when the rest under the finger are not far quieter", () => {
    expect(hub([{ ...ord, departures: 100 }, mke, sbn], 100, 100)).toBeNull();
    expect(hub([{ ...ord, departures: 260 }, mke, sbn], 100, 100)).toBe("ORD");
  });

  test("a hub alone needs no ruling, and a dot inside the hub's keeps the chooser", () => {
    expect(clearHub(airportsUnderTap([ord], 100, 100), 100, 100)).toBeNull();
    const sjc = { code: "SJC", x: 104, y: 101, departures: 2, radius: 2 };
    expect(hub([ord, sjc], 100, 100)).toBeNull();
    // Pinched in, the clearance shrinks with the fingertip.
    expect(clearHub([ord, { ...mke, y: 96 }], 100, 100, HUB_CLEAR_PX / 3)?.code).toBe("ORD");
    expect(HUB_SHARE).toBeGreaterThanOrEqual(5);
    expect(HUB_CLEAR_PX).toBeGreaterThanOrEqual(6);
  });
});

describe("/routes map clicks", () => {
  const DENSE: [string, number][] = [
    ["ORD", 14],
    ["MDW", 1],
    ["EWR", 12],
    ["LGA", 3],
    ["JFK", 2],
    ["DEN", 11],
    ["LAX", 10],
    ["BUR", 2],
    ["SNA", 1],
    ["LGB", 1],
    ["IAD", 9],
    ["DCA", 4],
    ["BWI", 1],
    ["SFO", 8],
    ["OAK", 1],
    ["SJC", 2],
    ["FLL", 6],
    ["MIA", 2],
    ["PBI", 1],
  ];
  let dense: ReturnType<typeof createApp>;

  beforeAll(() => {
    const d = makeFreshDb();
    addPlane(d, "N3VER", "Starlink");
    let n = 100;
    for (const [code, departures] of DENSE)
      for (let i = 0; i < departures; i++)
        addFlight(d, "N3VER", `UA${n++}`, code, now + HOUR + n * 60, {
          arrivalAirport: code === "DEN" ? "ORD" : "DEN",
        });
    for (const [code] of DENSE) addIndexingHistory(d, "N3VER", code, "IAH", now);
    // Arrivals only: drawn, but no page to open.
    addFlight(d, "N3VER", `UA${n++}`, "DEN", now + 2 * HOUR, { arrivalAirport: "HPN" });
    dense = createApp(d);
  });

  type Circle = {
    href: string | null;
    x: number;
    y: number;
    r: number;
    phone: boolean;
    wide: boolean;
  };

  function circlesOf(svg: string): Circle[] {
    const out: Circle[] = [];
    let href: string | null = null;
    let linkTakesTaps = true;
    for (const tag of svg.match(/<a [^>]*>|<\/a>|<circle [^>]*>/g) ?? []) {
      if (tag.startsWith("</a")) href = null;
      else if (tag.startsWith("<a ")) {
        href = tag.match(/href="\/routes\/([A-Z]{3})"/)?.[1] ?? null;
        linkTakesTaps = !tag.includes("pointer-events-none");
      } else {
        const num = (k: string) => Number(tag.match(new RegExp(` ${k}="([-\\d.]+)"`))?.[1]);
        const cls = tag.match(/class="([^"]*)"/)?.[1] ?? "";
        const live = !tag.includes('pointer-events="none"');
        out.push({
          href,
          x: num("cx"),
          y: num("cy"),
          r: num("r"),
          phone: live && (href === null || linkTakesTaps) && !/(^| )hidden( |$)/.test(cls),
          wide: live && !cls.split(" ").includes("sm:hidden"),
        });
      }
    }
    return out;
  }

  const hitAt = (cs: Circle[], x: number, y: number, mode: "phone" | "wide") =>
    cs.findLast((c) => c[mode] && Math.hypot(c.x - x, c.y - y) <= c.r);

  test("a click on the centre of every airport's dot opens that airport, at every width", async () => {
    const { text } = await bodyOf(dense, "/routes", UA);
    const map = sectionOf(text, "The Starlink network");
    const cs = circlesOf(map.slice(map.indexOf("<svg"), map.indexOf("</svg>")));
    // Each link's dot is its last circle; it takes no clicks itself.
    const dots = cs.filter((c, i) => c.href && cs[i + 1]?.href !== c.href);
    expect(dots.map((d) => d.href).sort()).toEqual(DENSE.map(([c]) => c).sort());
    for (const d of dots) {
      expect(d.phone || d.wide).toBe(false);
      // Wide screens: every airport, hubs and their close neighbours alike.
      expect(`${d.href} -> ${hitAt(cs, d.x, d.y, "wide")?.href}`).toBe(`${d.href} -> ${d.href}`);
      // Phones: an airport either takes the tap itself or takes no taps.
      const tap = hitAt(cs, d.x, d.y, "phone");
      if (cs.some((c) => c.href === d.href && c.phone))
        expect(`${d.href} -> ${tap?.href}`).toBe(`${d.href} -> ${d.href}`);
    }
    // On a phone-wide map (about 324 px), Dulles shares a fingertip with its
    // neighbours, so the script must ask rather than open; Denver stands alone.
    const px = (d: Circle) => ({ code: d.href ?? "", x: d.x * 0.324, y: d.y * 0.324 });
    const phoneDots = dots.map(px);
    const under = (code: string) => {
      const at = phoneDots.find((d) => d.code === code);
      return airportsUnderTap(phoneDots, at?.x ?? Number.NaN, at?.y ?? Number.NaN).map(
        (d) => d.code
      );
    };
    expect(under("IAD").slice(0, 2)).toEqual(["IAD", "DCA"]);
    expect(under("LGA")).toContain("EWR");
    expect(under("BUR")).toContain("LAX");
    expect(under("DEN")).toEqual(["DEN"]);
    // The hubs whose centres a neighbour once took, and the busiest, take phone taps.
    for (const hub of ["ORD", "EWR", "DEN", "LAX", "SFO"])
      expect(cs.some((c) => c.href === hub && c.phone)).toBe(true);
  });
});
