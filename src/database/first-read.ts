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
 *
 * A count ends in one of three ways and no other: the ordinary rule settles
 * the tail Starlink; a later read names another provider; the sheet drops
 * the row. A read of "no Wi-Fi" does none of them: united.com shows it on
 * jets that carry Starlink (database.ts DISCOUNT_UNITED_NONE_AFTER_STARLINK:
 * every one of 34 runs of three or more such reads after a Starlink read
 * went back to Starlink), so the settle drops it before this rule sees it,
 * and the count stands, unconfirmed, until a read names a provider.
 */

/**
 * How old our newest Starlink read may be for a count to be made on it. The
 * 30 days this rule was tested on are all tails the sheet listed at the time
 * of the read: the two sources spoke of the jet in the same days. A read from
 * weeks before the listing is not that case (one was counted at 26 days old
 * before this limit). Three days is the follow-up our own schedule gives a
 * lone Starlink read three daily turns to make (AWAITING_SETTLE_RECHECK_HOURS
 * in database.ts), so a read older than that is one we failed to follow up:
 * the jet did not fly, or the reads failed. Past it nothing is lost but
 * time: the ordinary rule still counts the tail on its next reads. A count
 * already standing has no such limit; it was made on a fresh read.
 */
export const FIRST_READ_MAX_AGE_SECS = 72 * 3600;

export interface FirstReadObservation {
  has_starlink: number;
  wifi_provider: string;
}

/** Why a first-read count was taken back; a reader is told which. */
export type FirstReadTakeBackReason = "other_provider" | "sheet_delisted";

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
 * @param sheetLists the sheet's own row lists the tail with Starlink, as of a
 *   current import or, for a count already standing, the last good one (a
 *   stale import makes no count and ends none). Never a row our discovery or
 *   a type rule wrote.
 * @param ordinaryVerdict what the ordinary rule says of `obs`, after the hold
 *   on established tails.
 * @param ordinary the ordinary rule itself, to ask what it said before the
 *   newest read.
 * @param newestReadAgeSecs how old the newest read is, for a count not yet
 *   made; null for one already standing, or a replay with no clock.
 * @returns null where the ordinary rule stands.
 */
export function firstReadDecision<O extends FirstReadObservation>(
  obs: readonly O[],
  sheetLists: boolean,
  ordinaryVerdict: string | null,
  ordinary: (obs: O[]) => { verdict: string | null },
  newestReadAgeSecs: number | null = null
): FirstReadDecision | null {
  if (!sheetLists || obs.length === 0 || ordinaryVerdict === "Starlink") return null;

  const run = starlinkRun(obs);
  if (run > 0) {
    if (obs.slice(run).some((o) => o.has_starlink === 1)) return null;
    if (newestReadAgeSecs !== null && newestReadAgeSecs > FIRST_READ_MAX_AGE_SECS) return null;
    return {
      rule: "first_read",
      verdict: null,
      starlinkReads: run,
      reason: `sheet lists the tail and our newest ${run === 1 ? "read is" : `${run} reads are`} Starlink, none older: counted until a read names another provider or the sheet drops the row`,
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
 * names both sources and the day of the read, and promises only what the
 * code does: the two ways the count is taken back. It names no "next check",
 * since a read of "no Wi-Fi" neither confirms nor ends it, and after older
 * reads of another provider it takes three Starlink reads to settle.
 */
export function firstReadNote(readAtSec: number, site = "united.com"): string {
  const day = new Date(readAtSec * 1000).toISOString().slice(0, 10);
  return `Counted on two sources: the community fleet sheet lists this aircraft with Starlink, and our check of ${site} read Starlink on ${day}. Our checks have not settled it yet: if a later check names another provider, or the sheet drops the listing, the count is taken back.`;
}

/**
 * What the feed and the install log say of a tail whose first-read count was
 * taken back, worded by why it was. A row stamped before the reason was
 * stored says only that it was taken back.
 */
export function firstReadTakenBackNote(
  takenBackAtSec: number,
  reason: FirstReadTakeBackReason | null | undefined,
  site = "united.com"
): string {
  const day = new Date(takenBackAtSec * 1000).toISOString().slice(0, 10);
  const why =
    reason === "other_provider"
      ? "A later check read another provider, so the count was taken back."
      : reason === "sheet_delisted"
        ? "The community fleet sheet then dropped its listing before our checks settled it, so the count was taken back."
        : "The count was taken back before our checks settled it.";
  return `Correction (${day}): we counted this aircraft on one ${site} check that read Starlink. ${why}`;
}
