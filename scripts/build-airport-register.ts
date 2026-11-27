/**
 * Writes src/utils/airport-register-data.ts: the bundled register that
 * answers for an airport code the hand tables lack (see airport-register.ts).
 *
 *   bun scripts/build-airport-register.ts \
 *     --airports <OurAirports airports.csv> --countries <OurAirports countries.csv> \
 *     --mwgg <mwgg/Airports airports.json> --tz-lookup <@photostructure/tz-lookup tz.js> \
 *     --fetched YYYY-MM-DD --mwgg-commit <sha> --tz-lookup-version <x.y.z>
 *
 * The register downloads are read as data: the CSV and JSON are parsed, never
 * evaluated. tz-lookup is a program (CC0, no dependencies); it runs here, on
 * the machine that builds the file, and nothing of it is bundled. None of
 * the three is a dependency of the site.
 *
 * An airport gets a row only when all of this holds, so a row is never a
 * guess. A code that fails any of it stays out, and the site treats it as it
 * treats any unknown code:
 *  - OurAirports lists it as a small, medium or large airport with scheduled
 *    service, with a municipality (the name we print);
 *  - mwgg lists the same IATA code within COORD_AGREE_KM of that point;
 *  - the zone mwgg gives and the zone tz-lookup finds at OurAirports' point
 *    keep the same clock on every date sampled, and this runtime knows the
 *    zone. OurAirports has no zone column, so two independent sources must
 *    agree before a zone is printed.
 */
import { parseArgs } from "node:util";

const COORD_AGREE_KM = 10;
const CITY_MAX = 30;
const AIRPORT_NAME_MAX = 24;
const TYPE_RANK: Record<string, number> = { large_airport: 3, medium_airport: 2, small_airport: 1 };
// Filed as the United States, as the hand table files them (airport-geo.ts).
const US_TERRITORIES = new Set(["PR", "VI", "GU", "MP", "AS"]);

const { values: args } = parseArgs({
  options: {
    airports: { type: "string" },
    countries: { type: "string" },
    mwgg: { type: "string" },
    "tz-lookup": { type: "string" },
    fetched: { type: "string" },
    "mwgg-commit": { type: "string" },
    "tz-lookup-version": { type: "string" },
    out: { type: "string", default: "src/utils/airport-register-data.ts" },
    "left-out": { type: "string" },
  },
});
for (const k of ["airports", "countries", "mwgg", "tz-lookup", "fetched"] as const) {
  if (!args[k]) throw new Error(`--${k} is required`);
}

/** RFC 4180: quoted fields, doubled quotes, newlines inside quotes. */
function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field || row.length) rows.push([...row, field]);
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** "San José (Alajuela)" -> "San José"; "Cincinnati / Covington" -> "Cincinnati". */
const firstName = (s: string) =>
  s
    .split(/[/(,;]/)[0]
    .replace(/\s+/g, " ")
    .trim();

const GENERIC = new Set(
  "international intl airport regional municipal aerodrome airfield aeropuerto aeroporto aeroport internacional".split(
    " "
  )
);

/** "Chengdu Tianfu International Airport" in Chengdu -> "Tianfu". */
function airportOwnName(name: string, city: string): string {
  const drop = new Set([...fold(city).split(" "), ...GENERIC]);
  const kept = (words: string[]) => words.filter((w) => fold(w) && !drop.has(fold(w)));
  // "Stockholm-Arlanda Airport" in Stockholm -> "Arlanda".
  return kept(firstName(name).split(/\s+/))
    .map((w) => kept(w.split("-")).join("-"))
    .filter(Boolean)
    .join(" ");
}

const SAMPLES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].flatMap((m) =>
  [2026, 2027].map((y) => Date.UTC(y, m, 15, 12))
);
const clockCache = new Map<string, string | null>();
/** The zone's offset on each sampled date, or null when this runtime lacks the zone. */
function clock(zone: string): string | null {
  if (!clockCache.has(zone)) {
    let out: string | null = null;
    try {
      const f = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" });
      out = SAMPLES.map((t) => f.format(t).split(", ")[1]).join("|");
    } catch {}
    clockCache.set(zone, out);
  }
  return clockCache.get(zone) ?? null;
}

function km(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const r = Math.PI / 180;
  const h =
    Math.sin(((bLat - aLat) * r) / 2) ** 2 +
    Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(((bLon - aLon) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

const tzLookup = (await import(String(args["tz-lookup"]))).default as (
  lat: number,
  lon: number
) => string;
const countryName = new Map(
  parseCsv(await Bun.file(String(args.countries)).text()).map((c) => [c.code, firstName(c.name)])
);
const mwgg = new Map<string, { lat: number; lon: number; tz: string }>();
const mwggTwice = new Set<string>();
for (const a of Object.values(JSON.parse(await Bun.file(String(args.mwgg)).text())) as Array<
  Record<string, unknown>
>) {
  const iata = typeof a.iata === "string" ? a.iata : "";
  if (!/^[A-Z]{3}$/.test(iata)) continue;
  if (mwgg.has(iata)) mwggTwice.add(iata);
  mwgg.set(iata, { lat: Number(a.lat), lon: Number(a.lon), tz: String(a.tz ?? "") });
}

interface Row {
  code: string;
  city: string;
  airport: string;
  name: string;
  lat: number;
  lon: number;
  country: string;
  zone: string;
  rank: number;
}
const rows: Row[] = [];
const left: Record<string, string[]> = {};
const leave = (why: string, code: string) => {
  left[why] ??= [];
  left[why].push(code);
};
const seen = new Set<string>();
for (const a of parseCsv(await Bun.file(String(args.airports)).text())) {
  const code = a.iata_code;
  if (!/^[A-Z]{3}$/.test(code)) continue;
  const rank = TYPE_RANK[a.type];
  if (!rank || a.scheduled_service !== "yes") continue;
  if (seen.has(code)) throw new Error(`OurAirports lists ${code} twice`);
  seen.add(code);
  const lat = Number(a.latitude_deg);
  const lon = Number(a.longitude_deg);
  const city = firstName(a.municipality);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    leave("no point", code);
    continue;
  }
  if (!city || city.length > CITY_MAX || !/^[\p{L}\p{M}\d .'’-]+$/u.test(city)) {
    leave("no printable municipality", code);
    continue;
  }
  if (!/^[A-Z]{2}$/.test(a.iso_country)) {
    leave("no country", code);
    continue;
  }
  const second = mwgg.get(code);
  if (!second || mwggTwice.has(code)) {
    leave("not in the second register", code);
    continue;
  }
  if (!(km(lat, lon, second.lat, second.lon) <= COORD_AGREE_KM)) {
    leave("the two registers place it apart", code);
    continue;
  }
  const secondClock = clock(second.tz);
  if (!secondClock || secondClock !== clock(tzLookup(lat, lon))) {
    leave("zone sources disagree", code);
    continue;
  }
  rows.push({
    code,
    city,
    airport: "",
    name: a.name,
    lat,
    lon,
    country: US_TERRITORIES.has(a.iso_country) ? "US" : a.iso_country,
    zone: second.tz,
    rank,
  });
}

// Names. One city, several airports in a country: each carries its own name.
// One name, several countries: the largest airport's country keeps the bare
// name, the others carry their country.
const byCity = new Map<string, Row[]>();
for (const r of rows) byCity.set(fold(r.city), [...(byCity.get(fold(r.city)) ?? []), r]);
for (const group of byCity.values()) {
  if (group.length === 1) continue;
  const byCountry = new Map<string, Row[]>();
  for (const r of group) byCountry.set(r.country, [...(byCountry.get(r.country) ?? []), r]);
  for (const same of byCountry.values()) {
    if (same.length === 1) continue;
    for (const r of same) {
      const own = airportOwnName(r.name, r.city);
      if (own && own.length <= AIRPORT_NAME_MAX && own !== r.code) r.airport = own;
    }
  }
  if (byCountry.size === 1) continue;
  const top = (list: Row[]) => Math.max(...list.map((r) => r.rank));
  const best = Math.max(...[...byCountry.values()].map(top));
  const leaders = [...byCountry.values()].filter((list) => top(list) === best);
  for (const [country, list] of byCountry) {
    if (leaders.length === 1 && leaders[0] === list) continue;
    const suffix = countryName.get(country);
    if (suffix) for (const r of list) r.city = `${r.city}, ${suffix}`;
  }
}

rows.sort((a, b) => (a.code < b.code ? -1 : 1));
const q = (s: string) => JSON.stringify(s);
const body = rows
  .map(
    (r) =>
      `  ${r.code}: [${q(r.city)}, ${q(r.airport)}, ${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}, ${q(r.country)}, ${q(r.zone)}],`
  )
  .join("\n");
const commit = args["mwgg-commit"] ? `, commit\n *    ${args["mwgg-commit"]}` : "";
const version = args["tz-lookup-version"] ? ` ${args["tz-lookup-version"]}` : "";
const out = `/**
 * Written by scripts/build-airport-register.ts; a row is not edited here. To
 * correct an airport, place it in the hand tables (airport-names.ts,
 * airport-tz.ts, airport-geo.ts), where an entry always wins over this file.
 *
 * IATA -> [city, the airport's own name or "", latitude, longitude, ISO
 * country, IANA zone] for ${rows.length} airports with scheduled service.
 *
 * Sources, all fetched ${args.fetched}:
 *  - Code, municipality, airport name, point and country: OurAirports,
 *    airports.csv and countries.csv (https://ourairports.com/data/), public
 *    domain.
 *  - Zone: mwgg/Airports, airports.json (https://github.com/mwgg/Airports${commit}),
 *    MIT licence, Copyright (c) 2014 mwgg. A row is kept only where that
 *    file lists the same code within ${COORD_AGREE_KM} km and its zone keeps the same clock
 *    as the zone @photostructure/tz-lookup${version} (CC0) finds at
 *    OurAirports' point. tz-lookup ran when this file was built, and is not
 *    part of the site.
 *
 * The MIT licence asks that its notice travel with what it covers:
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a
 *   copy of this software and associated documentation files (the
 *   "Software"), to deal in the Software without restriction, including
 *   without limitation the rights to use, copy, modify, merge, publish,
 *   distribute, sublicense, and/or sell copies of the Software, and to permit
 *   persons to whom the Software is furnished to do so, subject to the
 *   following conditions: The above copyright notice and this permission
 *   notice shall be included in all copies or substantial portions of the
 *   Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 *   EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 *   MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
 *   NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 *   DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 *   OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
 *   USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

export type RegisterRow = readonly [
  city: string,
  airport: string,
  lat: number,
  lon: number,
  country: string,
  zone: string,
];

// biome-ignore format: one airport per line keeps the table diffable
export const AIRPORT_REGISTER: Record<string, RegisterRow> = {
${body}
};
`;
await Bun.write(String(args.out), out);
console.log(`${rows.length} airports written to ${args.out}`);
for (const [why, codes] of Object.entries(left)) console.log(`left out, ${why}: ${codes.length}`);
if (args["left-out"]) await Bun.write(args["left-out"], JSON.stringify(left));
