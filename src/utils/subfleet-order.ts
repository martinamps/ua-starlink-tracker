/**
 * Sub-fleet install order as a hint for which tail to check first.
 *
 * United fits a type's jets roughly in fleet-number order, so a sheet-listed
 * tail we don't count, sitting among counted neighbours, is the likeliest to
 * read Starlink next. It says where to look, never what is there: N718EV
 * scored highest of all on a finished CRJ-550 run and likely has no Starlink.
 */

export interface SheetOrderRow {
  tail: string;
  /** Sheet tab and the row's type code: one sub-fleet's numbering. */
  group: string;
  fleetNumber: number;
  /** The sheet's Wi-Fi cell says Starlink. */
  listed: boolean;
}

const NEIGHBOURS = 6;
/** Fewer counted neighbours than this and the order says nothing. */
const MIN_COUNTED_NEIGHBOURS = 4;

/**
 * Tail → score in (0, 1] for listed, uncounted tails worth checking first.
 * Half the score is the share of the six nearest-numbered siblings we count,
 * half the unbroken run of counted jets just below (capped at six).
 */
export function subfleetOrderScores(
  rows: SheetOrderRow[],
  counted: ReadonlySet<string>,
  skip: ReadonlySet<string> = new Set()
): Map<string, number> {
  const groups = new Map<string, SheetOrderRow[]>();
  for (const r of rows) {
    if (!Number.isFinite(r.fleetNumber)) continue;
    const g = groups.get(r.group);
    if (g) g.push(r);
    else groups.set(r.group, [r]);
  }
  const scores = new Map<string, number>();
  for (const group of groups.values()) {
    group.sort((a, b) => a.fleetNumber - b.fleetNumber);
    group.forEach((row, i) => {
      if (!row.listed || counted.has(row.tail) || skip.has(row.tail)) return;
      const siblings = group.filter((s) => s.tail !== row.tail);
      // A sub-fleet whose other jets are all counted has no order left to read.
      if (siblings.every((s) => counted.has(s.tail))) return;
      const nearest = [...siblings]
        .sort(
          (a, b) =>
            Math.abs(a.fleetNumber - row.fleetNumber) - Math.abs(b.fleetNumber - row.fleetNumber) ||
            a.fleetNumber - b.fleetNumber
        )
        .slice(0, NEIGHBOURS);
      const near = nearest.filter((s) => counted.has(s.tail)).length;
      if (nearest.length < NEIGHBOURS || near < MIN_COUNTED_NEIGHBOURS) return;
      let run = 0;
      for (let j = i - 1; j >= 0 && run < NEIGHBOURS && counted.has(group[j].tail); j--) run++;
      scores.set(row.tail, (near + run) / (2 * NEIGHBOURS));
    });
  }
  return scores;
}
