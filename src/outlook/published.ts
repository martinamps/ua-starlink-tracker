/**
 * Dates an airline published for one aircraft family, beside the fleet-wide
 * targets in src/airlines/targets.ts. Same sourcing rule: a statement read in
 * full, with the day it was made. A family with no entry here falls back to
 * the airline's fleet-wide target only.
 */

import { rolloutTargets } from "../airlines/targets";
import { FLEET, type PublishedTarget } from "./pace";

const UA_WIDEBODY_2026_06_22 = {
  title: "United press release, first Starlink widebody (PR Newswire)",
  url: "https://www.prnewswire.com/news-releases/united-accelerates-starlink-wi-fi-rollout-with-first-widebody-transatlantic-flight-302806746.html",
};

const FAMILY_TARGETS: Record<
  string,
  ReadonlyArray<{ families: readonly string[]; target: PublishedTarget }>
> = {
  UA: [
    {
      // "The entire widebody fleet is expected to have it by the following
      // summer" (release of 2026-06-22). Summer is read to its last day.
      families: ["B767", "B777", "B787"],
      target: {
        label: "Entire widebody fleet equipped by summer 2027",
        deadline: "2027-09-22",
        statedOn: "2026-06-22",
        says: "its entire widebody fleet by summer 2027",
        source: UA_WIDEBODY_2026_06_22,
      },
    },
  ],
};

/**
 * The airline's published dates that apply to `family` (FLEET for the whole
 * airline). "Every aircraft" applies to each type and the fleet; a count
 * ("more than 880") only to the fleet. A share of a fleet that isn't our
 * roster (Alaska's half of the merged fleet) is left out, not resolved here.
 */
export function publishedTargets(airline: string, family: string): PublishedTarget[] {
  const out: PublishedTarget[] = (FAMILY_TARGETS[airline] ?? [])
    .filter((e) => e.families.includes(family))
    .map((e) => e.target);
  for (const t of rolloutTargets(airline)) {
    const base = { label: t.label, deadline: t.deadline, statedOn: t.statedOn, source: t.source };
    // Only a year-end deadline has a plain reading to put in the airline's mouth.
    const yearEnd = t.deadline.match(/^(\d{4})-12-31$/)?.[1];
    if (t.fractionOfTracked === 1 && !t.fractionSpans && !t.statedFleet)
      out.push(yearEnd ? { ...base, says: `every aircraft by the end of ${yearEnd}` } : base);
    else if (family === FLEET && t.count !== undefined) out.push({ ...base, count: t.count });
  }
  return out;
}
