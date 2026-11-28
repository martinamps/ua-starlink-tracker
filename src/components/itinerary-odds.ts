/**
 * A planner leg's odds as its own flight page gives them. A leg on a plane
 * that is assigned and verified reads "Yes" on that page, so here it counts as
 * certain too, and an option's headline is read from the legs as shown. The
 * planner's own figures (joint_probability, expected_starlink_hours) keep the
 * measured swap allowance, and its ranking reads those. No JSX: the planner's
 * browser bundle imports it.
 */

interface OddsLeg {
  probability: number;
  confirmed?: boolean;
}

export const shownLegProbability = (leg: OddsLeg): number => (leg.confirmed ? 1 : leg.probability);

export const allConfirmed = (legs: readonly OddsLeg[]): boolean =>
  legs.length > 0 && legs.every((l) => l.confirmed === true);

/** Every leg on Starlink, from the legs as shown. */
export const shownJoint = (legs: readonly OddsLeg[]): number =>
  legs.reduce((p, l) => p * shownLegProbability(l), 1);

/** At least one leg on Starlink, from the legs as shown. */
export const shownAtLeastOne = (legs: readonly OddsLeg[]): number =>
  1 - legs.reduce((p, l) => p * (1 - shownLegProbability(l)), 1);
