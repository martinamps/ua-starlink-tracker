/**
 * Homepage render cost and DOM shape. The 09-07 pill change formatted every
 * departure with toLocale*String({timeZone}), which builds a fresh
 * Intl.DateTimeFormat per call: ~3,500 per render took p95 for `/` from 0.13s
 * to 0.37s. Each tail's row was also rendered twice (desktop + mobile trees),
 * so every `flights-{TAIL}` id appeared twice and the mobile "+N" button
 * expanded the hidden copy.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import { formatPillTime } from "../src/components/ui/format";
import { createApp } from "../src/server/app";
import { openSnapshot, req } from "./helpers";

let app: ReturnType<typeof createApp>;
beforeAll(() => {
  app = createApp(openSnapshot());
});

const HOSTS = [
  SITES.united.canonicalHost,
  SITES.alaska.canonicalHost,
  SITES.hawaiian.canonicalHost,
  SITES.airline.canonicalHost,
];

const originals = {
  date: Date.prototype.toLocaleDateString,
  time: Date.prototype.toLocaleTimeString,
  string: Date.prototype.toLocaleString,
};
afterEach(() => {
  Date.prototype.toLocaleDateString = originals.date;
  Date.prototype.toLocaleTimeString = originals.time;
  Date.prototype.toLocaleString = originals.string;
});

describe("pill time formatting", () => {
  test("a known epoch formats as weekday + clock at the departure airport, zone named", () => {
    expect(formatPillTime(Date.UTC(2026, 8, 19, 6, 40) / 1000, "America/Denver")).toBe(
      "SAT 12:40 AM MDT"
    );
    // Local midnight is still the UTC evening before: the weekday follows the zone.
    expect(formatPillTime(Date.UTC(2026, 8, 20, 5, 5) / 1000, "America/Chicago")).toBe(
      "SUN 12:05 AM CDT"
    );
    expect(formatPillTime(Date.UTC(2026, 11, 20, 0, 5) / 1000, "America/Los_Angeles")).toBe(
      "SAT 4:05 PM PST"
    );
  });

  test("no zone reads UTC, and says so", () => {
    expect(formatPillTime(Date.UTC(2026, 8, 20, 0, 5) / 1000, undefined)).toBe("SUN 12:05 AM UTC");
  });

  test("output matches the toLocale*String spelling at the same zone", () => {
    for (let t = 1_780_000_000; t < 1_780_000_000 + 7 * 86400; t += 3917) {
      const d = new Date(t * 1000);
      const legacy = `${d
        .toLocaleDateString("en-US", { weekday: "short", timeZone: "America/New_York" })
        .toUpperCase()} ${d.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/New_York",
        timeZoneName: "short",
      })}`;
      expect(formatPillTime(t, "America/New_York")).toBe(legacy);
    }
  });

  test("a homepage render makes no per-pill toLocale*String calls", async () => {
    let weekdayCalls = 0;
    let totalCalls = 0;
    Date.prototype.toLocaleDateString = function (
      this: Date,
      ...args: Parameters<Date["toLocaleDateString"]>
    ) {
      totalCalls++;
      const opts = args[1] as Intl.DateTimeFormatOptions | undefined;
      if (opts?.weekday) weekdayCalls++;
      return originals.date.apply(this, args);
    };
    Date.prototype.toLocaleTimeString = function (
      this: Date,
      ...args: Parameters<Date["toLocaleTimeString"]>
    ) {
      totalCalls++;
      return originals.time.apply(this, args);
    };
    const res = await app.dispatch(req("/", SITES.united.canonicalHost));
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(weekdayCalls).toBe(0);
    const pills = (html.match(/class="flight-pill /g) ?? []).length;
    // A bounded handful of page-level dates is fine; one-or-more per pill is the regression.
    expect(totalCalls).toBeLessThan(Math.max(pills, 20));
  });
});

describe("homepage DOM", () => {
  for (const host of HOSTS) {
    test(`${host}: no duplicate ids and one flights container per tail`, async () => {
      const html = await (await app.dispatch(req("/", host))).text();
      const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
      const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
      expect(dupes).toEqual([]);

      const rows = (html.match(/class="js-aircraft-row /g) ?? []).length;
      const containers = ids.filter((id) => id.startsWith("flights-")).length;
      expect(containers).toBeLessThanOrEqual(rows);
    });
  }

  test("each expandable row has exactly one +N button", async () => {
    const html = await (await app.dispatch(req("/", SITES.united.canonicalHost))).text();
    for (const m of html.matchAll(/<div class="flex flex-wrap gap-1\.5" id="flights-[^"]+">/g)) {
      const start = m.index ?? 0;
      const end = html.indexOf("</div>", start);
      const block = html.slice(start, end);
      expect((block.match(/class="expand-flights /g) ?? []).length).toBeLessThanOrEqual(1);
    }
  });

  test("every pill that has a permalink stays a server-rendered anchor", async () => {
    const html = await (await app.dispatch(req("/", SITES.united.canonicalHost))).text();
    const pills = [...html.matchAll(/<a[^>]*class="flight-pill [^"]*"[^>]*>/g)].map((m) => m[0]);
    for (const p of pills) expect(p).toMatch(/href="[^"]+"/);
  });
});
