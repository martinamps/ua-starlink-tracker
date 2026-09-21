/**
 * ICAO → IATA for US and Canadian codes (KEWR → EWR, CYVR → YVR); anything
 * else passes through uppercased. Dependency-free so browser bundles use it.
 * Mexican ICAO codes are not stripped: MMUN is CUN, not MUN.
 */
export function toIata(code: string | null | undefined): string {
  const c = String(code ?? "").toUpperCase();
  return c.length === 4 && (c[0] === "K" || c[0] === "C") ? c.slice(1) : c;
}
