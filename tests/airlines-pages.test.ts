/**
 * Hub /airlines surfaces + cross-site footer links. Coverage derives from the
 * registry (every airline, every live site) — shapes only, no value pins.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import {
  AIRLINES,
  SITES,
  airlineSlug,
  publicAirlines,
  siteForAirline,
} from "../src/airlines/registry";
import { createApp } from "../src/server/app";
import { openSnapshot, req } from "./helpers";

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  app = createApp(openSnapshot());
});

const hub = SITES.airline;
const get = (path: string, host: string) =>
  app.dispatch(req(path, host, { headers: { Accept: "text/html" } }));

// The /airlines population is the hub homepage's: publicInHub only. Anything
// else (QR today) must be invisible — no card, no detail page, no sitemap row.
const hiddenAirlines = () => Object.values(AIRLINES).filter((a) => !publicAirlines().includes(a));

describe("hub /airlines index", () => {
  test("serves on the hub and lists every public airline, never a hidden one", async () => {
    const res = await get("/airlines", hub.canonicalHost);
    expect(res.status).toBe(200);
    const body = await res.text();
    for (const cfg of publicAirlines()) {
      expect(body, `index missing ${cfg.name}`).toContain(cfg.name);
      expect(body, `index missing link to ${airlineSlug(cfg)}`).toContain(
        `/airlines/${airlineSlug(cfg)}`
      );
    }
    for (const cfg of hiddenAirlines()) {
      expect(body, `index leaks ${cfg.name}`).not.toContain(cfg.name);
      expect(body, `index links hidden ${airlineSlug(cfg)}`).not.toContain(
        `/airlines/${airlineSlug(cfg)}`
      );
    }
  });

  test("404s on every airline-scoped site", async () => {
    for (const site of Object.values(SITES).filter((s) => s.scope !== "ALL")) {
      const res = await get("/airlines", site.canonicalHost);
      expect(res.status, site.key).toBe(404);
    }
  });
});

describe("hub /airlines/{slug} detail pages", () => {
  test("every public airline serves, funneling to its live tracker where one exists", async () => {
    for (const cfg of publicAirlines()) {
      const res = await get(`/airlines/${airlineSlug(cfg)}`, hub.canonicalHost);
      expect(res.status, cfg.code).toBe(200);
      const body = await res.text();
      expect(body, cfg.code).toContain(cfg.name);
      expect(body, cfg.code).toContain(cfg.rollout.statusLabel);
      const liveHost = siteForAirline(cfg.code, true)?.canonicalHost;
      if (liveHost) {
        expect(body, `${cfg.code} page missing tracker CTA`).toContain(liveHost);
      }
    }
  });

  test("IATA and case variants 301 to the canonical slug", async () => {
    for (const cfg of publicAirlines()) {
      for (const variant of [cfg.iata.toLowerCase(), airlineSlug(cfg).toUpperCase()]) {
        const res = await get(`/airlines/${variant}`, hub.canonicalHost);
        expect(res.status, variant).toBe(301);
        expect(res.headers.get("Location"), variant).toBe(
          `https://${hub.canonicalHost}/airlines/${airlineSlug(cfg)}`
        );
      }
    }
  });

  test("unknown airline 404s — no invented content", async () => {
    const res = await get("/airlines/delta", hub.canonicalHost);
    expect(res.status).toBe(404);
  });

  test("hidden (publicInHub false) airlines 404 like unknown ones", async () => {
    for (const cfg of hiddenAirlines()) {
      for (const seg of [airlineSlug(cfg), cfg.iata.toLowerCase()]) {
        const res = await get(`/airlines/${seg}`, hub.canonicalHost);
        expect(res.status, seg).toBe(404);
      }
    }
  });
});

describe("sitemaps", () => {
  test("hub sitemap advertises the index and every public airline page, no hidden ones", async () => {
    const res = await get("/sitemap.xml", hub.canonicalHost);
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain(`<loc>https://${hub.canonicalHost}/airlines</loc>`);
    for (const cfg of publicAirlines()) {
      expect(xml, cfg.code).toContain(
        `<loc>https://${hub.canonicalHost}/airlines/${airlineSlug(cfg)}</loc>`
      );
    }
    for (const cfg of hiddenAirlines()) {
      expect(xml, cfg.code).not.toContain(`/airlines/${airlineSlug(cfg)}`);
    }
  });

  test("airline-site sitemaps do not advertise /airlines", async () => {
    for (const site of Object.values(SITES).filter((s) => s.scope !== "ALL")) {
      const res = await get("/sitemap.xml", site.canonicalHost);
      expect(res.status, site.key).toBe(200);
      expect(await res.text(), site.key).not.toContain("/airlines");
    }
  });
});

describe("cross-site footer links", () => {
  test("every live site's homepage links its live sisters and the hub /airlines page", async () => {
    for (const site of Object.values(SITES).filter((s) => s.live)) {
      const res = await get("/", site.canonicalHost);
      expect(res.status, site.key).toBe(200);
      const body = await res.text();
      expect(body, `${site.key} missing cross-site block`).toContain("data-cross-site-links");
      for (const other of Object.values(SITES).filter(
        (s) => s.live && s.scope !== "ALL" && s.key !== site.key
      )) {
        expect(body, `${site.key} missing link to ${other.key}`).toContain(
          `https://${other.canonicalHost}/`
        );
      }
      const airlinesHref =
        site.scope === "ALL" ? "/airlines" : `https://${SITES.airline.canonicalHost}/airlines`;
      expect(body, `${site.key} missing all-airlines link`).toContain(airlinesHref);
    }
  });
});
