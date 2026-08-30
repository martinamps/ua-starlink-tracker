/**
 * /healthz — host-agnostic ops probe. Uptime checks hit the bare IP or
 * localhost, so it must answer before tenancy (no 421), report DB
 * reachability + key-table write recency + scheduler liveness, and never be
 * advertised where crawlers look (robots disallow, absent from sitemaps).
 */

import { describe, expect, test } from "bun:test";
import { createApp } from "../src/server/app";
import { type JobClock, schedulerStatus, startJob } from "../src/utils/job-runner";
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
    const { body } = await health(UA);
    expect(body.scheduler.jobs).toBeGreaterThan(0);
    expect(body.scheduler.lastTickAgeSec).toBeLessThan(60);
    expect(body.scheduler.staleJobs).toEqual([]);
    job.stop();
  });

  test("a registered job that never ticks still counts — jobs:0 must mean 'none started'", () => {
    // The wedge the probe exists for: JOBS_ENABLED, timers never fire. Counting
    // only ticked jobs made this indistinguishable from DISABLE_JOBS=1.
    const never: JobClock = {
      now: () => Date.now(),
      setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
      setTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
      clearInterval: () => {},
      clearTimeout: () => {},
    };
    const job = startJob({
      name: "t_healthz_never_ticks",
      intervalMs: 22_500,
      run: () => {},
      clock: never,
    });
    expect(schedulerStatus().jobs).toBeGreaterThan(0);
    // Measured from registration, so silence ages on its own budget instead of
    // hiding behind a sibling job's heartbeat.
    const later = Date.now() + 3_600_000;
    expect(schedulerStatus(later).staleJobs).toContain("t_healthz_never_ticks");
    job.stop();
    expect(schedulerStatus(later).staleJobs).not.toContain("t_healthz_never_ticks");
  });

  test("a job wedged mid-run goes stale even while its timer keeps firing", async () => {
    // The stuck escape restarts runs on schedule, so a tick-entry heartbeat
    // stays fresh forever on a job whose body never returns. Only run *end*
    // separates the two.
    let release: (() => void) | undefined;
    const hang = new Promise<void>((resolve) => {
      release = resolve;
    });
    const never: JobClock = {
      now: () => Date.now(),
      setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
      setTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
      clearInterval: () => {},
      clearTimeout: () => {},
    };
    const job = startJob({
      name: "t_healthz_wedged",
      intervalMs: 22_500,
      run: () => hang,
      clock: never,
    });
    job.tick();
    await Promise.resolve();

    const later = Date.now() + 3_600_000;
    const sched = schedulerStatus(later);
    expect(sched.lastTickAt).not.toBeNull(); // the run started…
    expect(sched.staleJobs).toContain("t_healthz_wedged"); // …and never finished

    release?.();
    await hang;
    expect(schedulerStatus().staleJobs).not.toContain("t_healthz_wedged");
    job.stop();
  });

  test("a stale job degrades the probe to 503", async () => {
    const never: JobClock = {
      now: () => Date.now(),
      setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
      setTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
      clearInterval: () => {},
      clearTimeout: () => {},
    };
    const job = startJob({
      name: "t_healthz_stale",
      intervalMs: 22_500,
      run: () => {},
      clock: never,
    });
    const realNow = Date.now;
    Date.now = () => realNow() + 3_600_000;
    try {
      const { status, body } = await health(UA);
      expect(status).toBe(503);
      expect(body.status).toBe("degraded");
      expect(body.scheduler.staleJobs).toContain("t_healthz_stale");
    } finally {
      Date.now = realNow;
      job.stop();
    }
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
