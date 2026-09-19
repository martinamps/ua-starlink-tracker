/**
 * One URL per page. /check-flight/{fn} used to answer 200 for any junk suffix
 * and a trailing slash, an unbounded duplicate URL space; the bare tool pages
 * answered 200 on their trailing-slash spelling too.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import { createReaderFactory } from "../src/database/reader";
import { createApp } from "../src/server/app";
import { openSnapshot, req } from "./helpers";

const UA = SITES.united.canonicalHost;
let app: ReturnType<typeof createApp>;
let realFlight = "";

beforeAll(() => {
  const db = openSnapshot();
  app = createApp(db);
  realFlight = createReaderFactory(db)("UA").getSitemapFlights()[0]?.flight_number ?? "UA1126";
});

async function location(path: string): Promise<{ status: number; location: string | null }> {
  const res = await app.dispatch(req(path, UA, { headers: { Accept: "text/html" } }));
  return { status: res.status, location: res.headers.get("location") };
}

describe("/check-flight permalink canonicalization", () => {
  test("trailing slash 301s to the slashless permalink", async () => {
    expect(await location("/check-flight/UA1126/")).toEqual({
      status: 301,
      location: `https://${UA}/check-flight/UA1126`,
    });
  });

  test("a junk suffix 301s to the permalink", async () => {
    expect(await location("/check-flight/UA1126/foo/bar")).toEqual({
      status: 301,
      location: `https://${UA}/check-flight/UA1126`,
    });
  });

  test("an impossible date is dropped rather than kept", async () => {
    expect(await location("/check-flight/UA1126/2027-02-30")).toEqual({
      status: 301,
      location: `https://${UA}/check-flight/UA1126`,
    });
  });

  test("a dated URL with a trailing slash keeps its date", async () => {
    expect(await location("/check-flight/UA1126/2027-01-01/")).toEqual({
      status: 301,
      location: `https://${UA}/check-flight/UA1126/2027-01-01`,
    });
  });

  test("the query string survives the redirect", async () => {
    const { status, location: loc } = await location("/check-flight/ua1126?utm_source=x");
    expect(status).toBe(301);
    expect(loc).toBe(`https://${UA}/check-flight/UA1126?utm_source=x`);
  });

  test("canonical dated and undated URLs still render 200", async () => {
    expect((await location(`/check-flight/${realFlight}`)).status).toBe(200);
    expect((await location(`/check-flight/${realFlight}/2027-01-01`)).status).toBe(200);
    expect((await location("/check-flight/UA1126/2027-01-01")).status).toBe(200);
  });
});

describe("bare tool pages", () => {
  test("/check-flight/ and /route-planner/ 301 to the slashless path", async () => {
    expect(await location("/check-flight/")).toEqual({
      status: 301,
      location: `https://${UA}/check-flight`,
    });
    expect(await location("/route-planner/")).toEqual({
      status: 301,
      location: `https://${UA}/route-planner`,
    });
  });

  test("the slashless paths render 200", async () => {
    expect((await location("/check-flight")).status).toBe(200);
    expect((await location("/route-planner")).status).toBe(200);
  });
});

describe("apple-touch-icon aliases", () => {
  for (const path of [
    "/apple-touch-icon.png",
    "/apple-touch-icon-precomposed.png",
    "/apple-touch-icon-120x120.png",
    "/apple-touch-icon-152x152-precomposed.png",
  ]) {
    test(`${path} serves the tenant's 180px icon`, async () => {
      const res = await app.dispatch(req(path, UA));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
    });
  }

  test("unrelated png paths are not swallowed", async () => {
    const res = await app.dispatch(req("/apple-touch-icon-big.png", UA));
    expect(res.status).toBe(404);
  });
});
