/**
 * What the public surfaces SAY about a prediction's evidence.
 *
 * Every one of these is a copy bug that shipped: "0 observations" presented as
 * the fleet average when the number came from the flight's own aircraft types,
 * and a bare count printed beside a "low confidence" label the count appears to
 * contradict. Both are checked as properties of the copy — no data snapshot
 * involved, so they hold whatever the model happens to predict today.
 */
import { describe, expect, test } from "bun:test";
import { evidenceTag } from "../src/api/mcp-server";
import { normalizePredictionMethod } from "../src/observability/metrics";
import { predictionSentence } from "../src/server/app";

const pred = (method: string, n_observations: number, confidence: string) => ({
  method,
  n_observations,
  confidence,
});

const EVERY_METHOD = [
  "flight_history_smoothed",
  "type_mix_prior",
  "fleet_prior_express",
  "fleet_prior_mainline",
  "fleet_prior_unknown",
  "confirmed_assignment",
];

describe("prediction copy names its evidence", () => {
  test("a type-mix answer is never called the fleet average", () => {
    // n_observations is 0 for both, which is exactly why the count can't be
    // what decides the wording.
    const mix = pred("type_mix_prior", 0, "low");
    expect(evidenceTag(mix)).toContain("aircraft types");
    expect(evidenceTag(mix)).not.toContain("fleet install rate");
    expect(predictionSentence(mix, 12)).toContain("aircraft types");

    const cold = pred("fleet_prior_express", 0, "low");
    expect(evidenceTag(cold)).toContain("fleet install rate");
    expect(predictionSentence(cold, 12)).toContain("fleet-wide");
  });

  test("no surface prints a bare count beside a contradicting label", () => {
    // "low" next to a real sample only happens once decay has retired it, so
    // the copy has to say that rather than quote the count as a frequency.
    for (const n of [2, 5, 17]) {
      const stale = pred("flight_history_smoothed", n, "low");
      expect(evidenceTag(stale)).not.toContain("low confidence");
      expect(evidenceTag(stale)).toContain("old");
      expect(predictionSentence(stale, 98)).not.toContain("of recent departures");
      expect(predictionSentence(stale, 98)).toContain("old enough");
    }
  });

  test("a live sample still reports its own count", () => {
    const live = pred("flight_history_smoothed", 17, "high");
    expect(evidenceTag(live)).toContain("17 obs");
    expect(predictionSentence(live, 98)).toContain("17 observation");
  });

  test("a confirmed assignment is named as one, not as its history count", () => {
    // n_observations on a confirmed leg is the flight's real history, which is
    // usually 0 — printing it renders "0 obs" beside a 95% bar.
    expect(evidenceTag(pred("confirmed_assignment", 0, "high"))).toContain("assignment");
  });

  test("every method maps to a bounded metric tag", () => {
    const tags = new Set(EVERY_METHOD.map(normalizePredictionMethod));
    expect([...tags].sort()).toEqual(["assignment", "fleet_prior", "flight_history", "type_mix"]);
    // Unknown input must bucket rather than widen the tag's cardinality.
    expect(normalizePredictionMethod("something_new")).toBe("flight_history");
    expect(normalizePredictionMethod(null)).toBe("unknown");
  });

  test("the type-mix class is distinguishable from history on the metric", () => {
    // The REST and MCP emit sites share this mapping; if either grew its own,
    // a type-mix prediction would be counted as if it had history behind it.
    expect(normalizePredictionMethod("type_mix_prior")).not.toBe(
      normalizePredictionMethod("flight_history_smoothed")
    );
  });
});
