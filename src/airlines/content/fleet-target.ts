import { rolloutTargets } from "../targets";

/**
 * "United plans to equip its entire fleet by the end of 2027." from the
 * airline's cited whole-fleet target, the same entry /install-rate charts,
 * so the homepage and the rate page can never name two finish dates.
 */
export function fleetTargetSentence(code: string, name: string): string {
  const target = rolloutTargets(code).find((t) => t.fractionOfTracked === 1);
  if (!target) return "";
  return `${name} plans to equip its entire fleet by the end of ${target.deadline.slice(0, 4)}.`;
}
