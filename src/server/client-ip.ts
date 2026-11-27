import { PrefixSet, parseCidr } from "../utils/ip-prefix";

/**
 * The caller's address. Cloudflare sets cf-connecting-ip and refuses a request
 * that brings its own, so it goes first; x-forwarded-for is caller-settable and
 * only counts when Cloudflare is not in front (local runs, direct hits).
 */
export function clientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

/** What Bun.serve hands fetch() beside the request: who is on the other end of the socket. */
export interface SocketPeer {
  requestIP(req: Request): { address: string } | null;
}

/**
 * A local caller goes unmetered. The header alone can't say so: a request
 * that reaches the server without Cloudflare writes its own cf-connecting-ip.
 * So when there is a socket, its peer must be loopback too. In-process
 * dispatch (tests, IndexNow) has no socket and goes by the header.
 */
export function isLocalCaller(ip: string, req: Request, server?: SocketPeer): boolean {
  if (!LOOPBACK.has(ip)) return false;
  if (!server) return true;
  const peer = server.requestIP(req)?.address;
  return peer !== undefined && LOOPBACK.has(peer);
}

// Cloudflare's published edge ranges (cloudflare.com/ips-v4 and /ips-v6, read
// 27 Nov 2026). Only a hop from one of these can have been through Cloudflare.
const CLOUDFLARE_RANGES = new PrefixSet(
  [
    "173.245.48.0/20",
    "103.21.244.0/22",
    "103.22.200.0/22",
    "103.31.4.0/22",
    "141.101.64.0/18",
    "108.162.192.0/18",
    "190.93.240.0/20",
    "188.114.96.0/20",
    "197.234.240.0/22",
    "198.41.128.0/17",
    "162.158.0.0/15",
    "104.16.0.0/13",
    "104.24.0.0/14",
    "172.64.0.0/13",
    "131.0.72.0/22",
    "2400:cb00::/32",
    "2606:4700::/32",
    "2803:f800::/32",
    "2405:b500::/32",
    "2405:8100::/32",
    "2a06:98c0::/29",
    "2c0f:f248::/32",
  ].flatMap((cidr) => parseCidr(cidr) ?? [])
);

// Where our own reverse proxy (Coolify's) connects from: loopback and the
// private ranges a container network uses.
const PRIVATE_RANGES = new PrefixSet(
  ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "::1/128", "fc00::/7"].flatMap(
    (cidr) => parseCidr(cidr) ?? []
  )
);

function bareAddress(addr: string): string {
  return addr.startsWith("::ffff:") && addr.includes(".") ? addr.slice(7) : addr;
}

/**
 * Did this request reach us through Cloudflare? Any header can be written by
 * a caller who skips Cloudflare and hits the origin, so this reads the one hop
 * nobody upstream can choose: the address that handed the request to our
 * proxy. The proxy writes it as the last x-forwarded-for entry (a proxy
 * appends the peer it saw, or replaces the header with it); with no proxy in
 * front, the socket peer is that hop itself. In-process dispatch (tests) has
 * no socket and goes by the header.
 */
export function cameThroughCloudflare(req: Request, server?: SocketPeer): boolean {
  const peer = server ? server.requestIP(req)?.address : undefined;
  if (server && peer === undefined) return false;
  if (peer !== undefined) {
    const p = bareAddress(peer);
    if (CLOUDFLARE_RANGES.contains(p)) return true;
    if (!PRIVATE_RANGES.contains(p)) return false;
  }
  const hop = req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  return hop ? CLOUDFLARE_RANGES.contains(bareAddress(hop)) : false;
}
