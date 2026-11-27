import { Panel } from "../layout";
import { zonedDeparture } from "../ui/format";
import { Pill, type Tone } from "../ui/tone";
import type { PlaneSwap } from "./types";

const CHANGE_PILL: Record<"gained" | "lost", { tone: Tone; label: string }> = {
  gained: { tone: "success", label: "Starlink gained" },
  lost: { tone: "danger", label: "Starlink lost" },
};

/** The answer card already carries the page's one "can be swapped" caveat. */
function sameLine(swap: PlaneSwap): string | null {
  if (swap.change !== "same") return null;
  return swap.toStarlink ? "Both planes have Starlink." : "Neither plane has Starlink.";
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
        {`This departure had ${swap.from} first. We first saw ${swap.to} on it ${zonedDeparture(swap.seenAt, swap.zone).full}.`}
        {same ? ` ${same}` : ""}
      </p>
    </Panel>
  );
}
