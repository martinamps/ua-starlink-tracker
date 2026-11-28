/**
 * The newest row (highest last_updated; the first one on a tie) of each
 * departure. A swap writes a second row for the same departure on the new
 * tail, and the old tail's row stays until that tail is read again, so a
 * departure is answered from its newest row alone. The flight check and the
 * planner's confirmed tier both read a day this way, so they agree on a swap.
 */
export function newestPerDeparture<T extends { departure_time: number; last_updated: number }>(
  rows: readonly T[],
  key: (r: T) => string | number = (r) => r.departure_time
): T[] {
  const newest = new Map<string | number, T>();
  for (const r of rows) {
    const k = key(r);
    const held = newest.get(k);
    if (!held || r.last_updated > held.last_updated) newest.set(k, r);
  }
  return [...newest.values()];
}
