/**
 * Is this request really a search engine's crawler? The page limiter would
 * otherwise 429 Googlebot or Bingbot during a deep crawl of the check-flight
 * corpus. A user agent is free to claim anything, so a claim only counts once
 * the IP's reverse DNS lands in the engine's domain and that name resolves
 * back to the same IP (the check Google and Bing document). Cloudflare's
 * verified-bot flag would be cheaper, but on this plan it is a rule field,
 * not a header the origin receives.
 *
 * Answers are cached per IP, and only IPs whose UA claims a crawler and that
 * have already hit the limit ever get looked up.
 */
import { lookup, reverse } from "node:dns/promises";
import { unixNow } from "../database/sql/windows";
import { classifyUserAgent } from "../observability/metrics";

const CRAWLER_DOMAINS: Record<string, readonly string[]> = {
  googlebot: ["googlebot.com", "google.com"],
  bingbot: ["search.msn.com"],
};

const VERIFIED_TTL_SEC = 24 * 3600;
const REJECTED_TTL_SEC = 3600;
const MAX_ENTRIES = 10_000;
const DNS_TIMEOUT_MS = 2000;

export interface CrawlerDns {
  reverse(ip: string): Promise<string[]>;
  lookup(host: string): Promise<string[]>;
}

const systemDns: CrawlerDns = {
  reverse,
  lookup: async (host) => (await lookup(host, { all: true })).map((a) => a.address),
};

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("dns timeout")), ms)),
  ]);
}

const inDomain = (host: string, domains: readonly string[]) => {
  const h = host.toLowerCase().replace(/\.$/, "");
  return domains.some((d) => h.endsWith(`.${d}`));
};

/** Returns the crawler a request verifiably is ("googlebot" | "bingbot"), or null. */
export function createCrawlerVerifier(dns: CrawlerDns = systemDns) {
  const cache = new Map<string, { crawler: string | null; at: number }>();
  const pending = new Map<string, Promise<string | null>>();

  async function check(ip: string, crawler: string): Promise<string | null> {
    const domains = CRAWLER_DOMAINS[crawler];
    try {
      const hosts = (await withTimeout(dns.reverse(ip), DNS_TIMEOUT_MS)).filter((h) =>
        inDomain(h, domains)
      );
      for (const host of hosts) {
        const addrs = await withTimeout(dns.lookup(host), DNS_TIMEOUT_MS);
        if (addrs.some((a) => a.toLowerCase() === ip.toLowerCase())) return crawler;
      }
    } catch {
      // NXDOMAIN, SERVFAIL or a timeout: unverified.
    }
    return null;
  }

  return async function verifiedCrawler(
    ip: string,
    userAgent: string | null,
    nowSec = unixNow()
  ): Promise<string | null> {
    const claimed = classifyUserAgent(userAgent);
    if (!CRAWLER_DOMAINS[claimed]) return null;
    const key = `${claimed}:${ip}`;
    const hit = cache.get(key);
    if (hit) {
      const ttl = hit.crawler ? VERIFIED_TTL_SEC : REJECTED_TTL_SEC;
      if (nowSec - hit.at < ttl) return hit.crawler;
    }
    let p = pending.get(key);
    if (!p) {
      p = check(ip, claimed).then((crawler) => {
        if (cache.size >= MAX_ENTRIES) cache.clear();
        cache.set(key, { crawler, at: nowSec });
        pending.delete(key);
        return crawler;
      });
      pending.set(key, p);
    }
    return p;
  };
}
