/**
 * At most one log line per key per interval, so a burst of identical events
 * (a client hammering one route) costs one line plus a suppressed count, not
 * one line per event. Keys must come from bounded tag values: the map holds
 * one entry per distinct key.
 */
export function createLogThrottle(intervalMs: number) {
  const slots = new Map<string, { next: number; suppressed: number }>();
  /** Events suppressed under `key` since its last line, or null to stay quiet. */
  return (key: string, now: number): number | null => {
    const slot = slots.get(key);
    if (slot && now < slot.next) {
      slot.suppressed++;
      return null;
    }
    slots.set(key, { next: now + intervalMs, suppressed: 0 });
    return slot?.suppressed ?? 0;
  };
}
