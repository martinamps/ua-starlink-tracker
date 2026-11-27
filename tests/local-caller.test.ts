/**
 * The local exemption from the per-address limit needs a loopback socket, not
 * just a header that says 127.0.0.1: a request that skips Cloudflare writes
 * its own cf-connecting-ip.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import { setupTables } from "../src/database/database";
import { API_RATE_LIMIT, createApp } from "../src/server/app";
import { type SocketPeer, isLocalCaller } from "../src/server/client-ip";
import { req } from "./helpers";

const peer = (address: string): SocketPeer => ({ requestIP: () => ({ address }) });
const r = () => new Request("https://x.test/");

describe("isLocalCaller", () => {
  test("a local header from a loopback socket is local", () => {
    expect(isLocalCaller("127.0.0.1", r(), peer("127.0.0.1"))).toBe(true);
    expect(isLocalCaller("::1", r(), peer("::1"))).toBe(true);
    expect(isLocalCaller("127.0.0.1", r(), peer("::ffff:127.0.0.1"))).toBe(true);
  });

  test("a local header from any other socket is not", () => {
    expect(isLocalCaller("127.0.0.1", r(), peer("203.0.113.9"))).toBe(false);
    expect(isLocalCaller("::1", r(), { requestIP: () => null })).toBe(false);
  });

  test("a loopback socket does not make a real client's address local", () => {
    expect(isLocalCaller("198.51.100.1", r(), peer("127.0.0.1"))).toBe(false);
  });

  test("in-process dispatch, with no socket, goes by the header", () => {
    expect(isLocalCaller("127.0.0.1", r())).toBe(true);
    expect(isLocalCaller("198.51.100.1", r())).toBe(false);
  });
});

describe("rate limit with a spoofed local address", () => {
  const host = SITES.united.canonicalHost;
  const statuses = async (server: SocketPeer) => {
    const db = new Database(":memory:");
    setupTables(db);
    const app = createApp(db);
    const out: number[] = [];
    for (let i = 0; i <= API_RATE_LIMIT; i++) {
      const res = await app.dispatch(
        req("/api/fleet-summary", host, { headers: { "cf-connecting-ip": "127.0.0.1" } }),
        server
      );
      out.push(res.status);
    }
    return out;
  };

  test("is metered when the socket is not loopback", async () => {
    expect((await statuses(peer("203.0.113.9"))).at(-1)).toBe(429);
  });

  test("stays unmetered from a loopback socket", async () => {
    expect(await statuses(peer("127.0.0.1"))).not.toContain(429);
  });
});
