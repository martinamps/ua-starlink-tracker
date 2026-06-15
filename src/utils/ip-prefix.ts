/**
 * CIDR prefix set with O(log n) containment lookup. v4 and v6 are both held as
 * bigint [lo, hi] ranges so a single binary search covers both. Built once from
 * the daily Starlink geofeed (~4k rows) and queried per HTML request.
 */

export interface ParsedPrefix {
  cidr: string;
  lo: bigint;
  hi: bigint;
  v6: boolean;
}

function parseV4(addr: string): bigint | null {
  const m = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  let n = 0n;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i]);
    if (octet > 255) return null;
    n = (n << 8n) | BigInt(octet);
  }
  return n;
}

function parseV6(addr: string): bigint | null {
  // Strip a trailing zone index (fe80::1%en0); reject embedded-v4 forms.
  const a = addr.replace(/%.+$/, "");
  if (!/^[0-9a-fA-F:]+$/.test(a) || a.includes(":::")) return null;
  const split = a.split("::");
  if (split.length > 2) return null;
  const head = split[0] === "" ? [] : split[0].split(":");
  const tail = split.length === 2 ? (split[1] === "" ? [] : split[1].split(":")) : [];
  const fill = 8 - head.length - tail.length;
  if (split.length === 2 ? fill < 0 : head.length !== 8) return null;
  const groups = split.length === 2 ? [...head, ...Array(fill).fill("0"), ...tail] : head;
  let n = 0n;
  for (const g of groups) {
    if (g.length === 0 || g.length > 4) return null;
    const v = Number.parseInt(g, 16);
    if (Number.isNaN(v)) return null;
    n = (n << 16n) | BigInt(v);
  }
  return n;
}

export function ipToBigint(addr: string): { value: bigint; v6: boolean } | null {
  if (addr.includes(":")) {
    const v = parseV6(addr);
    return v === null ? null : { value: v, v6: true };
  }
  const v = parseV4(addr);
  return v === null ? null : { value: v, v6: false };
}

export function parseCidr(cidr: string): ParsedPrefix | null {
  const m = cidr.match(/^(.+)\/(\d{1,3})$/);
  if (!m) return null;
  const ip = ipToBigint(m[1]);
  const bits = Number(m[2]);
  if (!ip) return null;
  const total = ip.v6 ? 128 : 32;
  // /0 is a valid CIDR but never a sane geofeed entry — fail closed.
  if (bits < 1 || bits > total) return null;
  const hostBits = BigInt(total - bits);
  const lo = (ip.value >> hostBits) << hostBits;
  const hi = lo | ((1n << hostBits) - 1n);
  return { cidr, lo, hi, v6: ip.v6 };
}

export class PrefixSet {
  private readonly v4: ParsedPrefix[];
  private readonly v6: ParsedPrefix[];

  constructor(prefixes: readonly ParsedPrefix[]) {
    const sort = (a: ParsedPrefix, b: ParsedPrefix) => (a.lo < b.lo ? -1 : a.lo > b.lo ? 1 : 0);
    // Coalesce overlapping/nested ranges so the binary search's "largest lo ≤ ip"
    // invariant is total — RFC 8805 permits overlaps and a nested /24 would
    // otherwise shadow its enclosing /16 for everything past the /24's hi.
    const coalesce = (sorted: ParsedPrefix[]): ParsedPrefix[] => {
      const out: ParsedPrefix[] = [];
      for (const p of sorted) {
        const prev = out.at(-1);
        if (prev && p.lo <= prev.hi + 1n) {
          if (p.hi > prev.hi) prev.hi = p.hi;
        } else {
          out.push({ ...p });
        }
      }
      return out;
    };
    this.v4 = coalesce(prefixes.filter((p) => !p.v6).sort(sort));
    this.v6 = coalesce(prefixes.filter((p) => p.v6).sort(sort));
  }

  get size(): number {
    return this.v4.length + this.v6.length;
  }

  contains(addr: string): boolean {
    const ip = ipToBigint(addr);
    if (!ip) return false;
    const ranges = ip.v6 ? this.v6 : this.v4;
    // Largest lo <= ip.value, then check hi. Ranges are pre-coalesced so this
    // single check is total.
    let lo = 0;
    let hi = ranges.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ranges[mid].lo <= ip.value) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found >= 0 && ip.value <= ranges[found].hi;
  }
}

/** Aggregation prefix the report-dedupe key uses (a plane's clients share it).
 * Opaque key, not a real CIDR string — don't parse it back. */
export function dedupePrefix(addr: string): string | null {
  const ip = ipToBigint(addr);
  if (!ip) return null;
  const hostBits = ip.v6 ? 72n : 8n;
  return `${ip.v6 ? "v6" : "v4"}:${(ip.value >> hostBits).toString(16)}`;
}
