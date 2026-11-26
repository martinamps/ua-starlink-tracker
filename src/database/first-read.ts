/**
 * Counting a tail on our first Starlink read, when the community sheet itself
 * lists it. Pure: the decision is a function of the tail's stored reads and
 * whether the sheet lists it, so a backtest can replay it.
 *
 * The ordinary rule (settleConsensus) wants two reads on a tail with no other
 * history and three in a row after reads of another provider. A retrofit
 * therefore sat uncounted for about a day after united.com first showed
 * Starlink on it. Over 30 days of our own reads (27 Oct to 26 Nov 2026) every
 * one of the 24 sheet-listed tails whose first Starlink read we then counted
 * was right, and no Starlink read on any of 727 tails was followed by a read
 * of another provider. Two sources that do not copy each other have to agree:
 * the sheet alone never counts a tail (thirteen listings in those 30 days
 * never read Starlink), and one read of ours alone does not either.
 *
 * The shape it accepts is a retrofit's and nothing else: every Starlink read
 * in the window is newer than every read of another provider. A tail that has
 * read Starlink, then something else, then Starlink again is left to the
 * ordinary rule, so a count that was taken back is never made twice on single
 * reads.
 *
 * It settles nothing. The verdict stays null: the listing keeps no
 * verified_wifi and the roster is not marked confirmed, so the tail renders
 * as listed, not verified, and nothing that protects an established tail
 * from a stray read is earned by one read.
 */

export interface FirstReadObservation {
  has_starlink: number;
  wifi_provider: string;
}

export type FirstReadRule = "first_read" | "first_read_taken_back";

export interface FirstReadDecision {
  rule: FirstReadRule;
  /** null while the count stands; the provider read when it is taken back. */
  verdict: string | null;
  /** Starlink reads in the newest run. */
  starlinkReads: number;
  reason: string;
}

/**
 * @param obs the tail's clean, tail-confirmed reads in the trailing window,
 *   newest first, as the ordinary rule receives them.
 * @param sheetLists the sheet's own row lists the tail with Starlink as of a
 *   current import. Never a row our discovery or a type rule wrote.
 * @param ordinaryVerdict what the ordinary rule says of `obs`, after the hold
 *   on established tails.
 * @param ordinary the ordinary rule itself, to ask what it said before the
 *   newest read.
 * @returns null where the ordinary rule stands.
 */
export function firstReadDecision<O extends FirstReadObservation>(
  obs: readonly O[],
  sheetLists: boolean,
  ordinaryVerdict: string | null,
  ordinary: (obs: O[]) => { verdict: string | null }
): FirstReadDecision | null {
  if (!sheetLists || obs.length === 0 || ordinaryVerdict === "Starlink") return null;

  const run = starlinkRun(obs);
  if (run > 0) {
    if (obs.slice(run).some((o) => o.has_starlink === 1)) return null;
    return {
      rule: "first_read",
      verdict: null,
      starlinkReads: run,
      reason: `sheet lists the tail and our newest ${run === 1 ? "read is" : `${run} reads are`} Starlink, none older: counted, the next read confirms it or takes it back`,
    };
  }

  // The newest read names another provider. Where the ordinary rule already
  // calls the tail by that provider, it stands; where it is undecided, the
  // read still has to take a first-read count back, or the sheet's row alone
  // would keep the tail counted against our newest read.
  if (ordinaryVerdict !== null) return null;
  const before = obs.slice(1);
  const runBefore = starlinkRun(before);
  if (runBefore === 0) return null;
  if (before.slice(runBefore).some((o) => o.has_starlink === 1)) return null;
  // A tail the ordinary rule had settled on its own keeps that rule's
  // tolerance of one stray read.
  if (ordinary([...before]).verdict === "Starlink") return null;
  return {
    rule: "first_read_taken_back",
    verdict: obs[0].wifi_provider,
    starlinkReads: runBefore,
    reason: `the read after ${runBefore === 1 ? "a first Starlink read" : `${runBefore} Starlink reads`} named ${obs[0].wifi_provider}: first-read count taken back`,
  };
}

function starlinkRun(obs: readonly FirstReadObservation[]): number {
  let n = 0;
  while (n < obs.length && obs[n].has_starlink === 1) n++;
  return n;
}

/**
 * How a first-read count is told to a reader, until our checks settle it. It
 * names both sources and the day of the read, and promises nothing beyond the
 * next check.
 */
export function firstReadNote(readAtSec: number, site = "united.com"): string {
  const day = new Date(readAtSec * 1000).toISOString().slice(0, 10);
  return `Counted on two sources: the community fleet sheet lists this aircraft with Starlink, and our check of ${site} read Starlink on ${day}. Our checks have not settled it yet; the next one confirms it or takes it back.`;
}

/** What the feed says of a tail whose first-read count was taken back. */
export function firstReadTakenBackNote(takenBackAtSec: number, site = "united.com"): string {
  const day = new Date(takenBackAtSec * 1000).toISOString().slice(0, 10);
  return `Correction (${day}): we counted this aircraft on one ${site} check that read Starlink. A later check read another provider, so it is no longer counted.`;
}
