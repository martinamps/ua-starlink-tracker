import { describe, expect, test } from "bun:test";
import { createApp } from "../src/server/app";
import { addFleet, addPlane, makeSyntheticDb, req } from "./helpers";

const TENANTS = ["unitedstarlinktracker.com", "alaskastarlinktracker.com"];

describe("homepage carries no NEW badges", () => {
  const db = makeSyntheticDb();
  addPlane(db, "N100UA", "Starlink");
  addFleet(db, "N100UA", "confirmed", { verifiedWifi: "Starlink" });
  const app = createApp(db);

  for (const host of TENANTS) {
    test(host, async () => {
      const res = await app.dispatch(req("/", host));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('href="/fleet"');
      expect(html).not.toMatch(/>\s*NEW\s*</);
    });
  }
});
