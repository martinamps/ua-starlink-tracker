import { AIRLINES } from "../registry";
import { rolloutTargets } from "../targets";

/**
 * The airline's cited whole-fleet target, the same entry /install-rate charts,
 * so the homepage and the rate page can never name two finish dates.
 */
export function fleetTargetSentence(code: string, name: string): string {
  const target = rolloutTargets(code).find((t) => t.fractionOfTracked === 1);
  if (!target) return "";
  const year = target.deadline.slice(0, 4);
  const excl = AIRLINES[code]?.programExclusions;
  if (excl?.reason === "not_in_programme") {
    const types = excl.families.join(" and ");
    return `${name} plans to finish the rollout by the end of ${year}. The ${types}s are not expected to be part of it.`;
  }
  return `${name} plans to equip every plane by the end of ${year}.`;
}
