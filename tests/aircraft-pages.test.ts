/**
 * /aircraft/{family} — per-family rollout pages. The URL space is bounded by
 * the family vocabulary present in the tenant's fleet data; these tests pin
 * that the index, the per-family gate, and the sitemap all derive from the
 * same list, so an advertised page can never 404 and an unknown one always
 * does.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import {
  FAMILY_DISPLAY,
  familySlug,
  normalizeAircraftType,
} from "../src/airlines/aircraft-families";
import { SITES } from "../src/airlines/registry";
import { getFleetPageData } from "../src/database/database";
import { createApp } from "../src/server/app";
import { openSnapshot, req } from "./helpers";

let app: ReturnType<typeof createApp>;
let db: ReturnType<typeof openSnapshot>;

beforeAll(() => {
  db = openSnapshot();
  app = createApp(db);
});

const UA = SITES.united.canonicalHost;
const get = (path: string, host = UA) =>
  app.dispatch(req(path, host, { headers: { Accept: "text/html" } }));

function uaFamilies() {
  const fams = getFleetPageData(db, ["UA"]).families.filter((f) => f.family !== "unknown");
  if (fams.length === 0) throw new Error("snapshot has no UA fleet families — run test:setup");
  return fams;
}

describe("FAMILY_DISPLAY vocabulary", () => {
  test("every family the normalizer can emit has display copy", () => {
    // Sample real-world inputs across the matcher's whole output range.
    const inputs = [
      "Boeing 737-924(ER)",
      "737 MAX 8",
      "737-9 MAX",
      "737 MAX 10",
      "Boeing 737-724",
      "Boeing 737-824",
      "Boeing 717-22A",
      "Boeing 747-8F",
      "Boeing 747-400",
      "Boeing 757-224",
      "Boeing 767-322(ER)",
      "Boeing 777-F",
      "Boeing 777-222",
      "Boeing 787-9",
      "Airbus A319-131",
      "Airbus A320-232",
      "Airbus A321-271NX",
      "Airbus A330-243",
      "Airbus A350-941",
      "Airbus A380-861",
      "Embraer E175LR",
      "ERJ-145XR",
      "CRJ-200",
      "CRJ-550",
      "Mitsubishi CRJ-701ER",
    ];
    for (const raw of inputs) {
      const fam = normalizeAircraftType(raw);
      expect(fam, raw).not.toBe("other");
      expect(FAMILY_DISPLAY[fam], `no display copy for ${fam} (${raw})`).toBeDefined();
    }
  });

  test("slugs are unique, lowercase, and URL-safe", () => {
    const slugs = Object.keys(FAMILY_DISPLAY).map(familySlug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(s).toMatch(/^[a-z0-9-]+$/);
  });
});

describe("/aircraft", () => {
  test("index renders and links every data-backed family, nothing else", async () => {
    const res = await get("/aircraft");
    expect(res.status).toBe(200);
    const body = await res.text();
    const linked = [...body.matchAll(/href="\/aircraft\/([a-z0-9-]+)"/g)].map((m) => m[1]).sort();
    const expected = uaFamilies()
      .map((f) => familySlug(f.family))
      .sort();
    expect(linked).toEqual(expected);
  });

  test("a data-backed family renders its own page with tail links", async () => {
    const fam = uaFamilies()[0];
    const slug = familySlug(fam.family);
    const res = await get(`/aircraft/${slug}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`<link rel="canonical" href="https://${UA}/aircraft/${slug}"`);
    // Family pages are the crawl path into the per-tail corpus (parallel
    // branch): every tail in the family gets a /tail/{registration} link.
    const tailLinks = [...body.matchAll(/href="\/tail\/([A-Z0-9-]+)"/g)].map((m) => m[1]);
    expect(tailLinks.length).toBe(fam.tails.length);
  });

  test("unknown families and junk 404 — bounded URL space", async () => {
    for (const path of [
      "/aircraft/zzz",
      "/aircraft/b737-max11",
      "/aircraft/unknown",
      "/aircraft/concorde",
    ]) {
      expect((await get(path)).status, path).toBe(404);
    }
  });

  test("one indexable URL per family: case variants and the bare prefix redirect", async () => {
    const slug = familySlug(uaFamilies()[0].family);
    const res = await get(`/aircraft/${slug.toUpperCase()}`);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`https://${UA}/aircraft/${slug}`);

    const bare = await get("/aircraft/");
    expect(bare.status).toBe(301);
    expect(bare.headers.get("location")).toBe(`https://${UA}/aircraft`);
  });

  test("sitemap advertises exactly the family pages that resolve", async () => {
    const body = await (await app.dispatch(req("/sitemap.xml", UA))).text();
    const advertised = [...body.matchAll(/<loc>[^<]*\/aircraft\/([a-z0-9-]+)<\/loc>/g)].map(
      (m) => m[1]
    );
    expect(advertised.sort()).toEqual(
      uaFamilies()
        .map((f) => familySlug(f.family))
        .sort()
    );
    for (const slug of advertised) {
      expect((await get(`/aircraft/${slug}`)).status, slug).toBe(200);
    }
  });

  test("feature-gated: the hub 404s", async () => {
    expect((await get("/aircraft", SITES.airline.canonicalHost)).status).toBe(404);
    expect((await get("/aircraft/e175", SITES.airline.canonicalHost)).status).toBe(404);
  });
});
