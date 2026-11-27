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
