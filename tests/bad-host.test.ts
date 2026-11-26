/**
 * A Host header that is not a host answers 400, never 500.
 *
 * The app picks its site by Host, so the header is a stranger's text. Bun
 * builds req.url from it and hands dispatch a bare path when it cannot, and
 * the URL parse there threw outside the last-resort catch: a raw 500, with a
 * stack in development. Real sockets on purpose: a Request built in a test
 * always carries a parseable URL, so only the wire reproduces it.
 *
 * A well-formed Host that names no site of ours is a different answer (421)
 * and must stay one.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import net from "node:net";
import { SITES } from "../src/airlines/registry";
import { COUNTERS, metrics } from "../src/observability/metrics";
import { createApp } from "../src/server/app";
import { makeFreshDb } from "./helpers";

const UA = SITES.united.canonicalHost;
const PICTURE = "/static/share/tail/N17529.png";
const PATHS = ["/", PICTURE, "/api/check-flight?flight_number=UA1&date=2026-11-25", "/feed.xml"];

let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: createApp(makeFreshDb()).dispatch });
});
afterAll(() => server.stop(true));

interface Wire {
  status: number;
  head: string;
  body: string;
}

/** One request with the Host line written byte for byte (null: no Host line). */
function send(host: string | null, path: string, method = "GET"): Promise<Wire> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.connect(server.port as number, "127.0.0.1", () => {
      const hostLine = host === null ? "" : `Host: ${host}\r\n`;
      socket.write(
        Buffer.from(`${method} ${path} HTTP/1.1\r\n${hostLine}Connection: close\r\n\r\n`, "latin1")
      );
    });
    socket.setTimeout(5000, () => socket.destroy(new Error(`timeout: ${JSON.stringify(host)}`)));
    socket.on("data", (d) => chunks.push(d));
    socket.on("error", reject);
    socket.on("close", () => {
      const raw = Buffer.concat(chunks).toString("latin1");
      const [head, ...rest] = raw.split("\r\n\r\n");
      resolve({ status: Number(head.split(" ")[1]), head, body: rest.join("\r\n\r\n") });
    });
  });
}

// Each is refused by the URL parser, so none can name a site.
const MALFORMED: Array<[string, string]> = [
  ["empty", ""],
  ["only a space", " "],
  ["a slash", "a/b"],
  ["a slash after our own name", `${UA}/x`],
  ["markup", 'a"><script>alert(1)</script>'],
  ["an unclosed bracket", "[::1"],
  ["a stray closing bracket", "a]b"],
  ["brackets around no address", "[zz]"],
  ["a bad percent escape", "a%zz"],
  ["an escaped space", "a%20b"],
  ["a port that is not a number", "x.com:abc"],
  ["our own name, port not a number", `${UA}:abc`],
  ["our own name, port out of range", `${UA}:99999`],
  ["our own name, signed port", `${UA}:+80`],
  ["our own name, port with a space", `${UA}: 80`],
  ["a negative port", "a.b:-1"],
  ["port 65536", "a.b:65536"],
  ["a full-width port", "a.b:１２"],
  ["a port and no name", ":80"],
  ["an out-of-range port and no name", ":99999"],
  ["two colons", "a:b:c"],
  ["a question mark", "a?b"],
  ["a fragment", "a#b"],
  ["a user", "u@x.com"],
  ["a backslash", "a\\b"],
  ["a space inside", "a b"],
  ["a tab inside", "a\tb"],
  ["a DEL byte", "a\x7fb"],
  ["a control byte", "a\x01b"],
  ["a NUL byte", "a\x00b"],
  ["a pipe", "a|b"],
  ["a caret", "a^b"],
  ["braces", "a{b}"],
  ["a backtick", "a`b"],
  ["angle brackets", "a<b>"],
  ["raw non-ASCII", "bücher.example"],
  ["an impossible IPv4", "999.999.999.999"],
  ["very long, with a space", `${"x".repeat(4000)} ${"y".repeat(4000)}`],
];

describe("a malformed Host", () => {
  test.each(MALFORMED)("%s: 400 on every path", async (_name, host) => {
    for (const path of PATHS) {
      const res = await send(host, path);
      expect(res.status, `${JSON.stringify(host)} ${path}`).toBe(400);
      // Nothing typed comes back, and no error page or stack.
      expect(res.body).not.toContain("script");
      expect(res.body).not.toContain("<");
      expect(res.body).not.toMatch(/TypeError|Invalid URL|\bat \S+ \(|app\.ts/);
    }
  });

  test("the 400 is plain text, uncacheable, and carries the baseline headers", async () => {
    for (const path of ["/", PICTURE]) {
      const res = await send("x.com:abc", path);
      expect(res.status).toBe(400);
      expect(res.body).toBe("Bad Request");
      expect(res.head).toMatch(/^content-type: text\/plain/im);
      expect(res.head).toMatch(/^cache-control: no-store\r?$/im);
      expect(res.head).toMatch(/^x-content-type-options: nosniff/im);
      expect(res.head).toMatch(/^vary: .*host/im);
    }
  });

  test.each(["HEAD", "POST", "OPTIONS", "DELETE"])("%s is a 400 too", async (method) => {
    expect((await send("a/b", "/", method)).status).toBe(400);
    expect((await send("a/b", "/mcp", method)).status).toBe(400);
  });

  test("no Host line at all is refused before the app", async () => {
    expect((await send(null, "/")).status).toBe(400);
  });

  test("is counted once, with bounded tags and nothing typed", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const original = metrics.increment;
    metrics.increment = ((name: string, tags: Record<string, unknown>) => {
      if (name === COUNTERS.HTTP_BAD_HOST) seen.push(tags);
    }) as typeof metrics.increment;
    try {
      await send('evil"><x>:abc', "/secret-path?q=1");
      await send(UA, "/robots.txt");
    } finally {
      metrics.increment = original;
    }
    expect(seen).toEqual([{ method: "GET", airline: "unknown" }]);
  });
});

describe("a well-formed Host keeps today's answer", () => {
  // What a health check or the proxy sends: a site's name, bare or with a
  // port, or the container's own address.
  test.each([
    UA,
    UA.toUpperCase(),
    `${UA}:443`,
    `${UA}:`,
    SITES.airline.canonicalHost,
    "localhost",
    "localhost:3000",
    "127.0.0.1:3000",
    "0.0.0.0:3000",
  ])("%s serves", async (host) => {
    expect((await send(host, "/")).status).toBe(200);
    expect((await send(host, "/robots.txt")).status).toBe(200);
  });

  test("an alias still redirects to its canonical host", async () => {
    const res = await send(`www.${UA}`, "/fleet");
    expect(res.status).toBe(301);
    expect(res.head).toMatch(
      new RegExp(`^location: https://${UA.replaceAll(".", "\\.")}/fleet`, "im")
    );
  });

  // Odd, but each parses as a host: not ours, so 421, never 400 and never 500.
  test.each([
    "evil.example",
    "evil.example:8080",
    `${UA}.`,
    `${UA}.evil.example`,
    `evil-${UA}`,
    "xn--bcher-kva.example",
    "[::1]",
    "[::1]:3000",
    "10.0.0.1",
    "1.2.3",
    "a!b",
    "a_b",
    "a..b",
    "a,b",
    "a'b",
    "a%41b",
    ".",
    "-",
    "a.b:0",
    "a.b:65535",
    "a.b:080",
    `${"x".repeat(300)}.example`,
    `${"x".repeat(60)}.`.repeat(100),
  ])("%s is a 421", async (host) => {
    for (const path of ["/", PICTURE]) {
      const res = await send(host, path);
      expect(res.status, `${host.slice(0, 60)} ${path}`).toBe(421);
      expect(res.body).toBe("Misdirected Request");
    }
  });

  test("an unknown host still gets the neutral favicon and manifest", async () => {
    expect((await send("evil.example", "/site.webmanifest")).status).toBe(200);
  });
});
