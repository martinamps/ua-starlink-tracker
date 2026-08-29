/**
 * /healthz — host-agnostic ops probe. Uptime checks hit the bare IP or
 * localhost, so it must answer before tenancy (no 421), report DB
 * reachability + key-table write recency + scheduler liveness, and never be
 * advertised where crawlers look (robots disallow, absent from sitemaps).
 */

import { describe, expect, test } from "bun:test";
import { createApp } from "../src/server/app";
import { startJob } from "../src/utils/job-runner";
import { openSnapshot, req } from "./helpers";

const app = createApp(openSnapshot());

const UA = "unitedstarlinktracker.com";
const HUB = "airlinestarlinktracker.com";

async function health(host: string, init?: RequestInit) {
  const r = await app.dispatch(req("/healthz", host, init));
  return { status: r.status, body: await r.json() };
}

describe("/healthz", () => {
  test("answers on an unrecognized Host — never 421", async () => {
    const { status, body } = await health("10.0.0.1");
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
  });

  test("shape: db, per-table write recency, scheduler, uptime", async () => {
    const { body } = await health(UA);
    expect(body.db.ok).toBe(true);
    // Snapshot has rows in both tables → numeric ages (null only when empty).
    expect(typeof body.lastWriteAgeSec.starlink_verification_log).toBe("number");
    expect(typeof body.lastWriteAgeSec.upcoming_flights).toBe("number");
    expect(typeof body.scheduler.jobs).toBe("number");
    expect(
      body.scheduler.lastTickAgeSec === null || typeof body.scheduler.lastTickAgeSec === "number"
    ).toBe(true);
    expect(typeof body.uptimeSec).toBe("number");
  });

  test("scheduler section reflects job ticks", async () => {
    // startJob registers with the module-level heartbeat this process shares.
    const job = startJob({ name: "t_healthz_probe", intervalMs: 3_600_000, run: () => {} });
    await job.tick();
    job.stop();
    const { body } = await health(UA);
    expect(body.scheduler.jobs).toBeGreaterThan(0);
    expect(body.scheduler.lastTickAgeSec).toBeLessThan(60);
  });

  test("non-GET → 405", async () => {
    const { status } = await health(UA, { method: "POST" });
    expect(status).toBe(405);
  });

  test("not cacheable", async () => {
    const r = await app.dispatch(req("/healthz", UA));
    expect(r.headers.get("Cache-Control")).toBe("no-store");
  });

  test("disallowed in robots.txt on every kind of host", async () => {
    for (const host of [UA, HUB]) {
      const r = await app.dispatch(req("/robots.txt", host));
      expect(await r.text()).toContain("Disallow: /healthz");
    }
  });

  test("never advertised in the sitemap", async () => {
    for (const host of [UA, HUB]) {
      const r = await app.dispatch(req("/sitemap.xml", host));
      expect(await r.text()).not.toContain("healthz");
    }
  });
});
