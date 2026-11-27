import { airportCityWithCode, routePairLabel } from "../../utils/airport-names";
import { Panel } from "../layout";
import { zonedDeparture } from "../ui/format";
import { Pill, type Tone } from "../ui/tone";
import type { PlaneSwap } from "./types";

const CHANGE_PILL: Record<"gained" | "lost", { tone: Tone; label: string }> = {
  gained: { tone: "success", label: "Starlink gained" },
  lost: { tone: "danger", label: "Starlink lost" },
};

/** Every comparison is between the first plane and the current one, as the pill's.
 * The answer card already carries the page's one "can be swapped" caveat. */
function sameLine(swap: PlaneSwap): string | null {
  if (swap.change !== "same") return null;
  return swap.toStarlink
    ? `Both ${swap.from} and ${swap.to} have Starlink.`
    : `Neither ${swap.from} nor ${swap.to} has Starlink.`;
}

/** "N1 first" or "N1 first, then N2" / "N1 first, then N2 and N3". */
function sequence(swap: PlaneSwap): string {
  const { from, between } = swap;
  if (between.length === 0) return `${from} first`;
  const rest =
    between.length === 1
      ? between[0]
      : `${between.slice(0, -1).join(", ")} and ${between[between.length - 1]}`;
  return `${from} first, then ${rest}`;
}

/** "This departure", or on a flight of several legs the leg the swap was on:
 * "The Chicago (ORD) to Denver (DEN) leg". */
function subject(swap: PlaneSwap): string {
  const { leg } = swap;
  if (!leg) return "This departure";
  return leg.arr
    ? `The ${routePairLabel(leg.dep, leg.arr)} leg`
    : `The leg from ${airportCityWithCode(leg.dep)}`;
}

/** One short note over the answer: the aircraft our log saw change on this departure. */
export function PlaneSwapNote({ swap }: { swap: PlaneSwap }) {
  const pill = swap.change === "gained" || swap.change === "lost" ? CHANGE_PILL[swap.change] : null;
  const same = sameLine(swap);
  return (
    <Panel pad="sm" id="plane-swap" className="mb-3 text-sm">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-secondary">
        <span className="font-semibold text-primary">Plane changed</span>
        {pill && <Pill tone={pill.tone}>{pill.label}</Pill>}
      </p>
      <p className="mt-1 text-secondary text-pretty">
        {`${subject(swap)} had ${sequence(swap)}. We first saw ${swap.to} on it ${zonedDeparture(swap.seenAt, swap.zone).full}.`}
        {same ? ` ${same}` : ""}
      </p>
    </Panel>
  );
}
