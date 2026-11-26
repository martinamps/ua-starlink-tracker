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
