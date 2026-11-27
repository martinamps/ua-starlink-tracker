/**
 * Starlink Probability Predictor
 *
 * Given a flight_number (and optionally route/date), estimate the probability
 * that the scheduled aircraft will have Starlink WiFi.
 *
 * Model (aircraft-type-aware): Starlink is a property of the AIRFRAME and the
 * rollout goes type-by-type, so both subfleets are bimodal mixtures a single
 * express/mainline prior cannot represent (E175/CRJ-550 ~100% vs ERJ-145/
 * CRJ-200 0%; 737NG/A321neo ~20-25% vs 787/777/767/757/MAX 0%). For each
 * flight number:
 *   1. Relabel its historical tail assignments by each tail's CURRENT status
 *      ("does the tail this flight draws have Starlink NOW"), recency-decayed.
 *      "Did it have Starlink when it flew" goes stale mid-retrofit and made
 *      the model predict ~3% on routes that were actually ~20%.
 *   2. Smooth toward the type-mix prior: sum over the aircraft types this
 *      flight has drawn of P(type|flight) * penetration(type).
 * A scope with no census roster falls back to the flight-history + subfleet
 * prior model; `--backtest` / `--cv` below measure both against a holdout.
 *
 * CLI:
 *   bun run src/scripts/starlink-predictor.ts --backtest           # Evaluate accuracy
 *   bun run src/scripts/starlink-predictor.ts --predict=UA4680     # Get probability
 *   bun run src/scripts/starlink-predictor.ts --cv                 # Cross-validate
 */

import { Database } from "bun:sqlite";
import { aircraftName, normalizeAircraftType } from "../airlines/aircraft-families";
import {
  buildAirlineFlightNumberVariants,
  ensureAirlinePrefix,
  inferSubfleet,
  slotFlightKey,
} from "../airlines/flight-number";
import {
  AIRLINES,
  type AirlineConfig,
  COMMUNITY_SOURCE_UPDATED_META,
  GUIDE_MARK_TTL_DAYS,
  type SubfleetDef,
  type WifiPhase,
  airlineHomeUrl,
  isGuideStale,
  programTypeOf,
  publicAirlines,
  siteForAirline,
  uiAccent,
  wifiPhaseFamilies,
} from "../airlines/registry";
import { formatFactDate } from "../airlines/rollout-facts";
import { type StatementAnswer, statementAnswer } from "../airlines/statement-rule";
import {
  approxShare,
  bandLabel,
  capitalize,
  zonedClock,
  zonedMinutes,
  zonedWeekday,
} from "../components/ui/format";
import type { AdsbFlightDraw } from "../database/adsb-flight-draws";
import type { AirlineTypeCount } from "../database/airline-count";
import type {
  FleetRosterEntry,
  GuideMark,
  VerificationObservation as Observation,
  SubfleetPenetration,
  TypeProgress,
} from "../database/database";
import { type ScopedReader, aggregatePenetration, createReaderFactory } from "../database/reader";
import type { RouteFlightLeg } from "../database/route-flights";
import {
  AIRPORT_COORDS,
  airportDistanceMiles,
  detourBoundMiles,
  hubAllowedForTrip,
} from "../utils/airport-geo";
import { airportWithCode } from "../utils/airport-names";
import {
  airportTimezone,
  flightDateWindow,
  localDateISO,
  matchesLocalDate,
  zonedWallTimeSec,
} from "../utils/airport-tz";
import { plainTypeName } from "../utils/outside-text";
import { memo, perOwner } from "../utils/ttl-cache";
import {
  LEG_MIN_DRAWS,
  LEG_WEIGHTING,
  type LegDraw,
  type LegTrend,
  type LegWeighting,
  drawWeight,
  legEstimate,
  legTrend,
} from "./leg-estimate";

// The prediction model is trained exclusively on United verification
// observations — its fleet split and priors are UA-bound by design.
const UA_CFG = AIRLINES.UA;
const uaSubfleet = (fn: string) => inferSubfleet(UA_CFG, fn) as "express" | "mainline" | "unknown";
const uaPrefix = (fn: string) => ensureAirlinePrefix(UA_CFG, fn);

// ============================================================================
// Types
// ============================================================================

type PredictionMethod =
  | "flight_history_smoothed"
  | "fleet_prior_express"
  | "fleet_prior_mainline"
  | "fleet_prior_unknown"
  /** Priced from a confirmed same-day assignment, discounted by the swap rate —
   * not from history or a prior. Route-planner legs only. Additive: these legs
   * previously omitted `method` entirely, so no consumer can be relying on it. */
  | "confirmed_assignment";

interface Prediction {
  flight_number: string;
  probability: number;
  confidence: "high" | "medium" | "low";
  method: PredictionMethod;
  n_observations: number;
  /** Draws no older than RECENT_OBSERVATION_DAYS — n_observations is all-time. */
  n_recent_observations: number;
}

/**
 * Bayesian smoothing (Laplace-style): blend the empirical rate with a prior.
 * With few observations trust the prior; with many, trust the data.
 */
function smoothedRate(
  nStarlink: number,
  nTotal: number,
  prior: number,
  priorStrength: number
): number {
  return (nStarlink + prior * priorStrength) / (nTotal + priorStrength);
}

interface ModelConfig {
  priorStrength: number; // "pseudo-observations" of the smoothing prior (α in Laplace)

  // Smoothing priors: for flights WITH history in the log, smooth toward the
  // log-conditional rate (~77% for express — because the log over-samples
  // Starlink-suspected planes).
  expressSmoothingPrior: number;
  mainlineSmoothingPrior: number;

  // Cold-start priors: for flights WITH NO history. "Not in the log after 12k
  // checks" is itself a negative signal (verifier only checks Starlink-
  // suspected tails): mainline uses the fleet rate as an upper bound, express
  // a constant measured on ADS-B traffic (EXPRESS_COLD_PRIOR_FALLBACK).
  expressColdPrior: number;
  mainlineColdPrior: number;
}

const DEFAULT_CONFIG: ModelConfig = {
  priorStrength: 3, // α=3 found optimal via Brier sweep (marginally beats α=2)
  expressSmoothingPrior: 0.768,
  mainlineSmoothingPrior: 0.004,
  expressColdPrior: 0.15,
  mainlineColdPrior: 0.02,
};

/**
 * Express cold start. A flight number missing from the verification log is
 * structurally an ERJ-145/CRJ-200 flight: the verifier only logs Starlink-
 * suspected tails, and those families are 0% Starlink. On the Aug-29 ADS-B
 * snapshot such flights had Starlink 12.8% of the time, while any blend with
 * the log-conditional rate served ~79%.
 */
const EXPRESS_COLD_PRIOR_FALLBACK = 0.15;

// How fast the flight-number -> tail-draw distribution goes stale. Swept over
// 5/10/20/30/40d half-lives in the rolling backtest; 30d is the Brier optimum.
const ASSIGNMENT_HALF_LIFE_DAYS = 30;

type Confidence = "high" | "medium" | "low";

const confidenceFor = (n: number): Confidence => (n >= 5 ? "high" : n >= 2 ? "medium" : "low");

/** The smallest raw sample each tier admits — what the published label is
 * promising, and the count the age rules are asked about. */
const TIER_MIN_DRAWS: Record<Confidence, number> = { low: 1, medium: 2, high: 5 };

/**
 * Below this share of the smoothed posterior a flight's own history has
 * stopped moving the number: the estimate is (s + α·prior)/(w + α), so once
 * the decayed weight `w` is worth under 5% of that denominator what ships is
 * the family prior wearing a flight number. Expressed against α rather than
 * hardcoded so it tracks a priorStrength re-sweep.
 */
const DEAD_EVIDENCE_SHARE = 0.05;
const deadEvidenceWeight = (priorStrength: number) =>
  (priorStrength * DEAD_EVIDENCE_SHARE) / (1 - DEAD_EVIDENCE_SHARE);

/** One half-life: past it each draw is worth under half a fresh one, which is
 * the point where the label should hedge rather than vouch for the sample. */
const STALE_DECAY = 0.5;

/**
 * Confidence for the decayed model, as a function of the count printed beside
 * it and the AGE of the evidence — never of `count × age`.
 *
 * 1. The count sets the tier — the same tiering the label has always meant.
 * 2. Staleness costs at most one tier. A sample whose draws are each worth
 *    under half a fresh one is hedged to "medium"; it never drops to "low"
 *    while its evidence still moves the number, because "17 observations (low
 *    confidence)" reads as a bug and made the Chrome extension suppress a 98%
 *    call at the point of booking.
 * 3. Dead evidence is dead, asked of the tier's minimum sample rather than the
 *    whole n, so a large stale sample that still moves the number stays medium.
 */
function decayedConfidence(
  decayedWeight: number,
  rawCount: number,
  priorStrength: number
): Confidence {
  const raw = confidenceFor(rawCount);
  if (raw === "low") return "low";
  const freshness = decayedWeight / rawCount;
  if (freshness * TIER_MIN_DRAWS[raw] < deadEvidenceWeight(priorStrength)) return "low";
  return freshness < STALE_DECAY ? "medium" : raw;
}

/** Subfleet cold-start install rate: all we know with no usable history. */
function coldPrior(flightNumber: string, config: ModelConfig): number {
  const fleet = uaSubfleet(flightNumber);
  return fleet === "express"
    ? config.expressColdPrior
    : fleet === "mainline"
      ? config.mainlineColdPrior
      : (config.expressColdPrior + config.mainlineColdPrior) / 2;
}

function coldPrediction(flightNumber: string, config: ModelConfig): Prediction {
  return {
    flight_number: flightNumber,
    probability: coldPrior(flightNumber, config),
    confidence: "low",
    method: `fleet_prior_${uaSubfleet(flightNumber)}` as PredictionMethod,
    n_observations: 0,
    n_recent_observations: 0,
  };
}

/**
 * ADS-B tail draws in the per-flight history (PREDICTOR_ADSB_DRAWS=off opts
 * out). The verification log only holds departures the verifier chose to
 * check, which over-samples Starlink tails: mixed mainline flights read 50-65%
 * when the tails they actually draw are 0-13%. The backtest behind the default
 * is `--backtest --windows=`, scored on ADS-B departures.
 */
const ADSB_DRAWS_DEFAULT: "on" | "off" = "on";
export const adsbDrawsEnabled = (): boolean =>
  (process.env.PREDICTOR_ADSB_DRAWS ?? ADSB_DRAWS_DEFAULT) !== "off";

/** A logged check this close to an ADS-B departure is the same departure. */
const ADSB_LOG_DEDUP_SEC = 12 * 3600;
/** With this many unbiased draws, the log's selection bias costs more than its
 * extra sample is worth, so its draws count half. */
const ADSB_DOMINANT_DRAWS = 5;
const LOG_WEIGHT_UNDER_ADSB = 0.5;
const ADSB_DRAW_WINDOW_DAYS = 90;
export const RECENT_OBSERVATION_DAYS = 30;

type FlightEvidence = {
  mix: Map<string, number>;
  s: number;
  n: number;
  raw: number;
  adsbN: number;
  recent: number;
};

type KeptDraw = { t: number; type: string; starlink: number };

/**
 * The type-aware predictor (see the file header). Returns null when the
 * roster is empty, so the caller falls back to the legacy model.
 *
 * `adsbDraws` null is the log-only model. For a flight with ADS-B draws, its
 * log draws also enter the family mix decayed, the way s/n decay: at full
 * weight a January 737-800 draw kept setting the family prior long after the
 * route moved to MAX metal. Only then — decaying the mix of a log-only flight
 * measured worse (ADS-B Brier 0.1280 -> 0.1329 at T=Aug15).
 */
function buildTypeAwarePredict(
  trainObs: Observation[],
  config: ModelConfig,
  roster: FleetRosterEntry[],
  adsbDraws: readonly AdsbFlightDraw[] | null = null
): ((flightNumber: string) => Prediction) | null {
  if (roster.length === 0) return null;

  // Newest observation per tail = its point-in-time status; anchoring the
  // decay there keeps backtests honest with no extra plumbing.
  let anchor = 0;
  const tailLatest = new Map<string, { at: number; starlink: number }>();
  for (const obs of trainObs) {
    if (obs.checked_at > anchor) anchor = obs.checked_at;
    if (!obs.tail_number) continue;
    const cur = tailLatest.get(obs.tail_number);
    if (!cur || obs.checked_at >= cur.at) {
      tailLatest.set(obs.tail_number, { at: obs.checked_at, starlink: obs.has_starlink });
    }
  }

  // Types collapse to families so spelling variants of one airframe share a
  // bucket; the roster's verified_wifi (derived from these same log rows, so
  // never fresher) only covers tails the training window never observed.
  const tails = new Map<string, { type: string; starlink: number }>();
  for (const r of roster) {
    tails.set(r.tail_number, {
      type: normalizeAircraftType(r.aircraft_type),
      starlink: tailLatest.get(r.tail_number)?.starlink ?? (r.verified_wifi === "Starlink" ? 1 : 0),
    });
  }

  // Penetration per family, over the whole roster.
  const typePen = new Map<string, { s: number; n: number }>();
  for (const t of tails.values()) {
    const agg = typePen.get(t.type) ?? { s: 0, n: 0 };
    agg.s += t.starlink;
    agg.n += 1;
    typePen.set(t.type, agg);
  }

  // ADS-B runs ahead of the log, so a draw newer than the anchor counts as
  // fresh — never as more than one draw.
  const decay = (t: number) => 0.5 ** (Math.max(0, anchor - t) / 86400 / ASSIGNMENT_HALF_LIFE_DAYS);
  const recentSince = anchor - RECENT_OBSERVATION_DAYS * 86400;
  const adsbByFlight = keptAdsbDraws(trainObs, tails, adsbDraws ?? []);

  const flights = new Map<string, FlightEvidence>();
  const evidenceFor = (flightNumber: string): FlightEvidence => {
    let f = flights.get(flightNumber);
    if (!f) {
      f = { mix: new Map(), s: 0, n: 0, raw: 0, adsbN: 0, recent: 0 };
      flights.set(flightNumber, f);
    }
    return f;
  };

  // Per flight number: the family mix of its tail draws, plus the
  // recency-weighted draws whose tail carries Starlink NOW.
  for (const obs of trainObs) {
    // A tail missing from the roster still has a known current status from
    // the log — only its family is unknown, so it just doesn't feed the mix.
    const tail = tails.get(obs.tail_number);
    const starlink = tail?.starlink ?? tailLatest.get(obs.tail_number)?.starlink;
    if (starlink === undefined) continue;
    const f = evidenceFor(obs.flight_number);
    const adsbCount = adsbByFlight.get(obs.flight_number)?.length ?? 0;
    const w =
      decay(obs.checked_at) * (adsbCount >= ADSB_DOMINANT_DRAWS ? LOG_WEIGHT_UNDER_ADSB : 1);
    if (tail) f.mix.set(tail.type, (f.mix.get(tail.type) ?? 0) + (adsbCount > 0 ? w : 1));
    f.s += starlink * w;
    f.n += w;
    f.raw += 1;
    if (obs.checked_at >= recentSince) f.recent += 1;
  }

  for (const [flightNumber, draws] of adsbByFlight) {
    const f = evidenceFor(flightNumber);
    for (const d of draws) {
      const w = decay(d.t);
      f.mix.set(d.type, (f.mix.get(d.type) ?? 0) + w);
      f.s += d.starlink * w;
      f.n += w;
      f.adsbN += 1;
      if (d.t >= recentSince) f.recent += 1;
    }
  }

  // Everything is determined at build time, so predict is a lookup.
  // Confidence reflects the DECAYED evidence weight: six draws from months
  // ago back the number far less than six from this week.
  const predictions = new Map<string, Prediction>();
  for (const [flightNumber, f] of flights) {
    let prior = coldPrior(flightNumber, config);
    let mixWeight = 0;
    let mixStarlink = 0;
    for (const [type, weight] of f.mix) {
      const pen = typePen.get(type);
      mixWeight += weight;
      mixStarlink += weight * (pen ? pen.s / pen.n : 0);
    }
    if (mixWeight > 0) prior = mixStarlink / mixWeight;
    const draws = f.raw + f.adsbN;
    predictions.set(flightNumber, {
      flight_number: flightNumber,
      probability: smoothedRate(f.s, f.n, prior, config.priorStrength),
      confidence: decayedConfidence(f.n, draws, config.priorStrength),
      method: "flight_history_smoothed",
      n_observations: draws,
      n_recent_observations: f.recent,
    });
  }

  return (flightNumber: string): Prediction =>
    predictions.get(flightNumber) ?? coldPrediction(flightNumber, config);
}

/**
 * ADS-B draws the model may count, per flight number. The roster filter is
 * load-bearing: SkyWest, Republic and Air Wisconsin fly the same callsign
 * numbers for Delta, American and Alaska, and only a United tail makes
 * SKW5xxx mean UA5xxx. A draw the log already holds is dropped so one
 * departure is never counted twice.
 */
function keptAdsbDraws(
  trainObs: readonly Observation[],
  tails: ReadonlyMap<string, { type: string; starlink: number }>,
  adsbDraws: readonly AdsbFlightDraw[]
): Map<string, KeptDraw[]> {
  const kept = new Map<string, KeptDraw[]>();
  if (adsbDraws.length === 0) return kept;
  const logTimes = new Map<string, number[]>();
  for (const obs of trainObs) {
    const key = `${obs.flight_number}|${obs.tail_number}`;
    const list = logTimes.get(key);
    if (list) list.push(obs.checked_at);
    else logTimes.set(key, [obs.checked_at]);
  }
  for (const d of adsbDraws) {
    const tail = tails.get(d.tail_number);
    if (!tail) continue;
    const logged = logTimes.get(`${d.flight_number}|${d.tail_number}`);
    const alreadyLogged = logged?.some(
      (t) => t >= d.first_seen - ADSB_LOG_DEDUP_SEC && t <= d.last_seen + ADSB_LOG_DEDUP_SEC
    );
    if (alreadyLogged) continue;
    const list = kept.get(d.flight_number);
    const draw = { t: d.first_seen, type: tail.type, starlink: tail.starlink };
    if (list) list.push(draw);
    else kept.set(d.flight_number, [draw]);
  }
  return kept;
}

/** The pre-roster model: per-flight-number rate smoothed toward a subfleet prior. */
function buildLegacyPredict(
  trainObs: Observation[],
  config: ModelConfig
): (flightNumber: string) => Prediction {
  const anchor = trainObs.reduce((m, o) => Math.max(m, o.checked_at), 0);
  const recentSince = anchor - RECENT_OBSERVATION_DAYS * 86400;
  const flightStats = new Map<string, { nStarlink: number; n: number; recent: number }>();
  for (const obs of trainObs) {
    const cur = flightStats.get(obs.flight_number) || { nStarlink: 0, n: 0, recent: 0 };
    cur.nStarlink += obs.has_starlink;
    cur.n += 1;
    if (obs.checked_at >= recentSince) cur.recent += 1;
    flightStats.set(obs.flight_number, cur);
  }

  return (flightNumber: string): Prediction => {
    const stats = flightStats.get(flightNumber);
    if (!stats || stats.n === 0) return coldPrediction(flightNumber, config);

    // Has history — smooth toward log-conditional rate (not fleet rate),
    // since the log is biased toward Starlink-suspected planes
    const fleet = uaSubfleet(flightNumber);
    const smoothPrior =
      fleet === "express"
        ? config.expressSmoothingPrior
        : fleet === "mainline"
          ? config.mainlineSmoothingPrior
          : (config.expressSmoothingPrior + config.mainlineSmoothingPrior) / 2;
    return {
      flight_number: flightNumber,
      probability: smoothedRate(stats.nStarlink, stats.n, smoothPrior, config.priorStrength),
      confidence: confidenceFor(stats.n),
      method: "flight_history_smoothed",
      n_observations: stats.n,
      n_recent_observations: stats.recent,
    };
  };
}

/**
 * Build a prediction model from training observations.
 * Returns a predict() function that takes a flight_number and returns probability.
 */
export function buildModel(
  trainObs: Observation[],
  config: ModelConfig = DEFAULT_CONFIG,
  roster: FleetRosterEntry[] = [],
  adsbDraws: readonly AdsbFlightDraw[] | null = null
) {
  const predict =
    buildTypeAwarePredict(trainObs, config, roster, adsbDraws) ??
    buildLegacyPredict(trainObs, config);
  return { predict };
}

// ============================================================================
// Evaluation
// ============================================================================

interface EvalResult {
  n: number;
  accuracy: number; // threshold=0.5
  brierScore: number; // lower is better, 0=perfect, 0.25=chance
  logLoss: number; // lower is better
  baseRateAccuracy: number; // accuracy if we just predict majority class
  calibration: Array<{ bucket: string; predicted: number; actual: number; n: number }>;
  byMethod: Array<{ method: string; n: number; accuracy: number; brier: number }>;
}

function evaluate(predictions: Array<{ pred: Prediction; actual: number }>): EvalResult {
  const n = predictions.length;
  if (n === 0) {
    return {
      n: 0,
      accuracy: 0,
      brierScore: 0,
      logLoss: 0,
      baseRateAccuracy: 0,
      calibration: [],
      byMethod: [],
    };
  }

  // Accuracy @ 0.5 threshold
  let correct = 0;
  let brierSum = 0;
  let logLossSum = 0;
  let actualPositives = 0;

  for (const { pred, actual } of predictions) {
    const p = pred.probability;
    if ((p >= 0.5 ? 1 : 0) === actual) correct++;
    brierSum += (p - actual) ** 2;
    // Clip for log loss stability
    const pc = Math.min(Math.max(p, 0.001), 0.999);
    logLossSum += actual === 1 ? -Math.log(pc) : -Math.log(1 - pc);
    if (actual === 1) actualPositives++;
  }

  const baseRate = actualPositives / n;
  // Base rate accuracy = always predict majority class
  const baseRateAccuracy = Math.max(baseRate, 1 - baseRate);

  // Calibration: bucket predictions, compare predicted vs actual rate
  const buckets = [
    [0, 0.1],
    [0.1, 0.3],
    [0.3, 0.5],
    [0.5, 0.7],
    [0.7, 0.9],
    [0.9, 1.01],
  ];
  const calibration = buckets.map(([lo, hi]) => {
    const inBucket = predictions.filter((p) => p.pred.probability >= lo && p.pred.probability < hi);
    if (inBucket.length === 0) {
      return { bucket: `[${lo.toFixed(1)},${hi.toFixed(1)})`, predicted: 0, actual: 0, n: 0 };
    }
    const avgPred = inBucket.reduce((s, p) => s + p.pred.probability, 0) / inBucket.length;
    const avgActual = inBucket.reduce((s, p) => s + p.actual, 0) / inBucket.length;
    return {
      bucket: `[${lo.toFixed(1)},${hi.toFixed(1)})`,
      predicted: avgPred,
      actual: avgActual,
      n: inBucket.length,
    };
  });

  // By method
  const methods = [...new Set(predictions.map((p) => p.pred.method))];
  const byMethod = methods.map((m) => {
    const subset = predictions.filter((p) => p.pred.method === m);
    const mCorrect = subset.filter((p) => (p.pred.probability >= 0.5 ? 1 : 0) === p.actual).length;
    const mBrier = subset.reduce((s, p) => s + (p.pred.probability - p.actual) ** 2, 0);
    return {
      method: m,
      n: subset.length,
      accuracy: mCorrect / subset.length,
      brier: mBrier / subset.length,
    };
  });

  return {
    n,
    accuracy: correct / n,
    brierScore: brierSum / n,
    logLoss: logLossSum / n,
    baseRateAccuracy,
    calibration,
    byMethod,
  };
}

// ============================================================================
// Data loading
// ============================================================================

/**
 * Fleet-penetration priors from getFleetStats() — same definition the UI shows,
 * so a user cross-checking a "low" prediction against the homepage % sees the
 * same number. meta.*Starlink is the raw sheet claim (includes verified
 * mismatches) and overcounts.
 */
export function loadFleetPriors(reader: ScopedReader): { express: number; mainline: number } {
  const stats = reader.getFleetStats();
  // Null = hub scope: no per-airline subfleet split exists. Use the
  // cross-airline penetration rate as both priors — a real aggregate, never
  // one airline's stats standing in for the hub's.
  if (stats === null) {
    const rate =
      aggregatePenetration(reader.getPerAirlineStats()).rate ?? DEFAULT_CONFIG.mainlineColdPrior;
    return { express: rate, mainline: rate };
  }
  return {
    express:
      stats.express.total > 0
        ? stats.express.starlink / stats.express.total
        : DEFAULT_CONFIG.expressColdPrior,
    mainline:
      stats.mainline.total > 0
        ? stats.mainline.starlink / stats.mainline.total
        : DEFAULT_CONFIG.mainlineColdPrior,
  };
}

// ============================================================================
// Backtest
// ============================================================================

export function backtest(
  dbPath: string,
  holdoutHours = 48,
  config: ModelConfig = DEFAULT_CONFIG
): EvalResult {
  const db = new Database(dbPath, { readonly: true });
  const reader = createReaderFactory(db)("UA");
  // Anchor to MAX(checked_at), not wall-clock — against frozen snapshots,
  // wall-clock would shrink or erase the holdout window.
  const allObs = reader.getVerificationObservations();
  const anchor =
    allObs.reduce((m, o) => Math.max(m, o.checked_at), 0) || Math.floor(Date.now() / 1000);
  const cutoff = anchor - holdoutHours * 3600;

  const trainObs = allObs.filter((o) => o.checked_at < cutoff);
  const testObs = allObs.filter((o) => o.checked_at >= cutoff);

  const roster = censusRoster(reader);
  const derivedConfig = deriveConfig(reader, trainObs, config, roster);
  const draws = reader.getAdsbFlightDraws(cutoff - ADSB_DRAW_WINDOW_DAYS * 86400);
  const { predict } = buildModel(
    trainObs,
    derivedConfig,
    roster,
    adsbDrawsEnabled() ? draws.filter((d) => d.first_seen < cutoff) : null
  );

  const predictions = testObs.map((obs) => ({
    pred: predict(obs.flight_number),
    actual: obs.has_starlink,
  }));
  const adsbTest = labelAdsbDraws(
    draws.filter((d) => d.first_seen >= cutoff),
    allObs
  );
  const adsbScored = adsbTest.labeled.map(({ draw, actual }) => ({
    pred: predict(draw.flight_number),
    actual,
    subfleet: uaSubfleet(draw.flight_number),
  }));

  db.close();

  const result = evaluate(predictions);

  console.log(`\n=== Backtest: holdout=${holdoutHours}h ===`);
  console.log(`Train: ${trainObs.length} obs | Test: ${testObs.length} obs`);
  // Zero observations used to print "Accuracy: 0.0%" and "Brier score: 0.0000",
  // which look like measurements. Fail loudly instead.
  if (testObs.length === 0 || trainObs.length === 0) {
    console.error(
      "\nNO DATA: the train or test split is empty — nothing was measured. " +
        "Point --db at a populated database.\n"
    );
    process.exit(2);
  }
  console.log(
    `Smoothing priors: express=${derivedConfig.expressSmoothingPrior.toFixed(3)}, mainline=${derivedConfig.mainlineSmoothingPrior.toFixed(3)}`
  );
  console.log(
    `Cold-start priors: express=${derivedConfig.expressColdPrior.toFixed(3)}, mainline=${derivedConfig.mainlineColdPrior.toFixed(3)}`
  );
  console.log(
    `\nAccuracy: ${(result.accuracy * 100).toFixed(1)}% (base rate: ${(result.baseRateAccuracy * 100).toFixed(1)}%)`
  );
  console.log(`Brier score: ${result.brierScore.toFixed(4)} (lower=better, 0.25=chance)`);
  console.log(`Log loss: ${result.logLoss.toFixed(4)}`);

  console.log("\nCalibration (predicted vs actual Starlink rate):");
  for (const c of result.calibration) {
    if (c.n > 0) {
      const bar = "█".repeat(Math.round(c.actual * 20));
      console.log(
        `  ${c.bucket} n=${String(c.n).padStart(4)} pred=${c.predicted.toFixed(3)} actual=${c.actual.toFixed(3)} ${bar}`
      );
    }
  }

  console.log("\nBy prediction method:");
  for (const m of result.byMethod) {
    console.log(
      `  ${m.method.padEnd(30)} n=${String(m.n).padStart(4)} acc=${(m.accuracy * 100).toFixed(1)}% brier=${m.brier.toFixed(4)}`
    );
  }

  console.log(
    `\nADS-B test set (the log is Starlink-biased; this is what flew), ADS-B draws ${adsbDrawsEnabled() ? "on" : "off"}, ${adsbTest.dropped} unlabeled dropped:`
  );
  if (adsbScored.length === 0) console.log("  none — no adsb_flight_draws after the cutoff");
  printWindowArm({
    arm: adsbDrawsEnabled() ? "adsb_draws" : "log_only",
    log: bySubfleet(
      testObs.map((o, i) => ({ ...predictions[i], subfleet: uaSubfleet(o.flight_number) }))
    ),
    adsb: bySubfleet(adsbScored),
    adsbCalibration: evaluate(adsbScored).calibration,
    adsbDropped: adsbTest.dropped,
  });

  return result;
}

// ============================================================================
// ADS-B test set
// ============================================================================
//
// The verification log is a biased test set: it holds the departures the
// verifier chose to check, ~65% Starlink against ~41% in real traffic, so it
// rewards models that over-predict and cannot see cold-prior changes at all.
// ADS-B departures sample what actually flew.

/** Labels may borrow a later check, but only a near one. */
const ADSB_LABEL_LOOKAHEAD_SEC = 7 * 86400;
const BADGE_THRESHOLD = 0.8;

type ScoredDraw = { pred: Prediction; actual: number; subfleet: string };

/**
 * Label each draw by its tail's latest clean check at or before departure,
 * else the earliest within ADSB_LABEL_LOOKAHEAD_SEC after, else drop it —
 * falling back to 0 would bias the set toward negatives.
 */
export function labelAdsbDraws(
  draws: readonly AdsbFlightDraw[],
  observations: readonly Observation[]
): { labeled: Array<{ draw: AdsbFlightDraw; actual: number }>; dropped: number } {
  const byTail = new Map<string, Array<{ at: number; starlink: number }>>();
  for (const o of observations) {
    if (!o.tail_number) continue;
    const list = byTail.get(o.tail_number) ?? [];
    list.push({ at: o.checked_at, starlink: o.has_starlink });
    byTail.set(o.tail_number, list);
  }
  for (const list of byTail.values()) list.sort((a, b) => a.at - b.at);

  const labeled: Array<{ draw: AdsbFlightDraw; actual: number }> = [];
  let dropped = 0;
  for (const draw of draws) {
    const checks = byTail.get(draw.tail_number);
    if (!checks) {
      dropped++;
      continue;
    }
    let lo = 0;
    let hi = checks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (checks[mid].at <= draw.first_seen) lo = mid + 1;
      else hi = mid;
    }
    const before = lo > 0 ? checks[lo - 1] : null;
    const after = lo < checks.length ? checks[lo] : null;
    const label =
      before ?? (after && after.at - draw.first_seen <= ADSB_LABEL_LOOKAHEAD_SEC ? after : null);
    if (!label) {
      dropped++;
      continue;
    }
    labeled.push({ draw, actual: label.starlink });
  }
  return { labeled, dropped };
}

function expectedCalibrationError(scored: ReadonlyArray<{ pred: Prediction; actual: number }>) {
  const bins = Array.from({ length: 10 }, () => ({ p: 0, y: 0, n: 0 }));
  for (const { pred, actual } of scored) {
    const b = bins[Math.min(9, Math.floor(pred.probability * 10))];
    b.p += pred.probability;
    b.y += actual;
    b.n += 1;
  }
  const n = scored.length;
  return n === 0 ? 0 : bins.reduce((e, b) => e + (b.n ? Math.abs(b.p - b.y) : 0), 0) / n;
}

/** The Chrome extension's badge rule: p ≥ 0.8 and a confidence it will show. */
function badgeStats(scored: readonly ScoredDraw[]) {
  let badged = 0;
  let badgedTrue = 0;
  let positives = 0;
  for (const { pred, actual } of scored) {
    positives += actual;
    if (pred.probability >= BADGE_THRESHOLD && pred.confidence !== "low") {
      badged++;
      badgedTrue += actual;
    }
  }
  return {
    badged,
    precision: badged ? badgedTrue / badged : 0,
    recall: positives ? badgedTrue / positives : 0,
  };
}

export interface SplitMetrics {
  n: number;
  baseRate: number;
  brier: number;
  logLoss: number;
  ece: number;
  badgePrecision: number;
  badgeRecall: number;
  badged: number;
}

function splitMetrics(scored: readonly ScoredDraw[]): SplitMetrics {
  const r = evaluate([...scored]);
  const b = badgeStats(scored);
  return {
    n: r.n,
    baseRate: r.n ? scored.reduce((s, x) => s + x.actual, 0) / r.n : 0,
    brier: r.brierScore,
    logLoss: r.logLoss,
    ece: expectedCalibrationError(scored),
    badgePrecision: b.precision,
    badgeRecall: b.recall,
    badged: b.badged,
  };
}

export interface WindowArmResult {
  arm: "log_only" | "adsb_draws";
  log: Record<"all" | "mainline" | "express", SplitMetrics>;
  adsb: Record<"all" | "mainline" | "express", SplitMetrics>;
  adsbCalibration: EvalResult["calibration"];
  adsbDropped: number;
}

const bySubfleet = (scored: readonly ScoredDraw[]) => ({
  all: splitMetrics(scored),
  mainline: splitMetrics(scored.filter((s) => s.subfleet === "mainline")),
  express: splitMetrics(scored.filter((s) => s.subfleet === "express")),
});

/**
 * Train strictly before `cutoff`, score the next `testDays` on both test
 * sets. `configOverride` lands after deriveConfig, so a caller can replay an
 * older prior against the same split.
 */
export function backtestWindow(
  reader: ScopedReader,
  cutoff: number,
  testDays: number,
  arm: WindowArmResult["arm"],
  configOverride: Partial<ModelConfig> = {}
): WindowArmResult {
  const testEnd = cutoff + testDays * 86400;
  const allObs = reader.getVerificationObservations();
  const trainObs = allObs.filter((o) => o.checked_at < cutoff);
  const allDraws = reader.getAdsbFlightDraws(cutoff - ADSB_DRAW_WINDOW_DAYS * 86400);
  const trainDraws = arm === "adsb_draws" ? allDraws.filter((d) => d.first_seen < cutoff) : null;
  const roster = censusRoster(reader);
  const config = { ...deriveConfig(reader, trainObs, DEFAULT_CONFIG, roster), ...configOverride };
  const { predict } = buildModel(trainObs, config, roster, trainDraws);

  const logScored = allObs
    .filter((o) => o.checked_at >= cutoff && o.checked_at < testEnd)
    .map((o) => ({
      pred: predict(o.flight_number),
      actual: o.has_starlink,
      subfleet: uaSubfleet(o.flight_number),
    }));
  const { labeled, dropped } = labelAdsbDraws(
    allDraws.filter((d) => d.first_seen >= cutoff && d.first_seen < testEnd),
    allObs
  );
  const adsbScored = labeled.map(({ draw, actual }) => ({
    pred: predict(draw.flight_number),
    actual,
    subfleet: uaSubfleet(draw.flight_number),
  }));
  return {
    arm,
    log: bySubfleet(logScored),
    adsb: bySubfleet(adsbScored),
    adsbCalibration: evaluate(adsbScored).calibration,
    adsbDropped: dropped,
  };
}

function printWindowArm(r: WindowArmResult) {
  const row = (set: string, split: string, m: SplitMetrics) =>
    console.log(
      `  ${r.arm.padEnd(10)} ${set.padEnd(4)} ${split.padEnd(8)} n=${String(m.n).padStart(6)} base=${m.baseRate.toFixed(3)} brier=${m.brier.toFixed(4)} logloss=${m.logLoss.toFixed(4)} ece=${m.ece.toFixed(4)} badge(p>=0.8,!low) n=${String(m.badged).padStart(5)} prec=${(m.badgePrecision * 100).toFixed(2)}% recall=${(m.badgeRecall * 100).toFixed(1)}%`
    );
  for (const split of ["all", "mainline", "express"] as const) row("adsb", split, r.adsb[split]);
  for (const split of ["all", "mainline", "express"] as const) row("log", split, r.log[split]);
  console.log(`  ${r.arm} ADS-B calibration (dropped unlabeled: ${r.adsbDropped}):`);
  for (const c of r.adsbCalibration) {
    if (c.n > 0) {
      console.log(
        `    ${c.bucket} n=${String(c.n).padStart(6)} pred=${c.predicted.toFixed(3)} actual=${c.actual.toFixed(3)}`
      );
    }
  }
}

/** Rolling-origin backtest over explicit cutoffs, both arms side by side. */
export function backtestWindows(
  dbPath: string,
  cutoffs: readonly number[],
  testDays = 7
): Array<{ cutoff: number; arms: WindowArmResult[] }> {
  const db = new Database(dbPath, { readonly: true });
  const reader = createReaderFactory(db)("UA");
  const out: Array<{ cutoff: number; arms: WindowArmResult[] }> = [];
  for (const cutoff of cutoffs) {
    console.log(
      `\n=== Window: train < ${new Date(cutoff * 1000).toISOString().slice(0, 10)}, test next ${testDays}d ===`
    );
    const arms = (["log_only", "adsb_draws"] as const).map((arm) =>
      backtestWindow(reader, cutoff, testDays, arm)
    );
    for (const a of arms) printWindowArm(a);
    out.push({ cutoff, arms });
  }
  db.close();
  return out;
}

/**
 * Derive a ModelConfig by computing log-conditional smoothing priors from
 * observations and loading cold-start priors from the meta table.
 * Shared by backtest() and buildProductionModel().
 */
function deriveConfig(
  reader: ScopedReader,
  trainObs: Observation[],
  base: ModelConfig = DEFAULT_CONFIG,
  roster: readonly FleetRosterEntry[] = []
): ModelConfig {
  // Derive smoothing priors from log-conditional rates. Exclude 5-digit flight
  // numbers (ferry/repositioning, ~3.5% of obs, all zero-Starlink) so they don't
  // poison the mainline prior — they're not revenue flights.
  const byFleet = { express: { s: 0, t: 0 }, mainline: { s: 0, t: 0 } };
  for (const obs of trainObs) {
    const numMatch = obs.flight_number.match(/(\d+)$/);
    if (numMatch && numMatch[1].length > 4) continue;
    const f = uaSubfleet(obs.flight_number);
    if (f === "express" || f === "mainline") {
      byFleet[f].s += obs.has_starlink;
      byFleet[f].t += 1;
    }
  }

  const logRate = {
    express:
      byFleet.express.t > 0 ? byFleet.express.s / byFleet.express.t : base.expressSmoothingPrior,
    mainline:
      byFleet.mainline.t > 0
        ? byFleet.mainline.s / byFleet.mainline.t
        : base.mainlineSmoothingPrior,
  };
  const fleetRate = loadFleetPriors(reader);

  return {
    ...base,
    // Express smoothing: log-conditional rate is correct (~0.76). The log
    // over-samples Starlink-suspected planes by design.
    expressSmoothingPrior: logRate.express,
    // Mainline smoothing: use the FLEET rate (~0.018) as a floor. The raw
    // log-conditional rate (~0.001) collapses predictions below the true install
    // rate because mainline planes entering the log were checked early (before
    // they had Starlink). Using fleetRate prevents "0.0005" predictions when
    // actual is "0.015". Backtested: ECE -30% with this change.
    mainlineSmoothingPrior: Math.max(logRate.mainline, fleetRate.mainline),
    // Express cold start: EXPRESS_COLD_PRIOR_FALLBACK was measured on the
    // census (type-aware) model's cold path. Without a census — the hub, or a
    // UA fleet table fleet-sync hasn't filled — the legacy model keeps its
    // blend of the fleet rate and the log-conditional rate.
    expressColdPrior:
      roster.length > 0
        ? EXPRESS_COLD_PRIOR_FALLBACK
        : 0.5 * fleetRate.express + 0.5 * logRate.express,
    mainlineColdPrior: fleetRate.mainline,
  };
}

// ============================================================================
// Cached model for production use (rebuilt at most hourly)
// ============================================================================

// Keyed by reader IDENTITY, not by scope: createReaderFactory hands out one
// frozen reader per (Database, scope), so this is still one model per scope in
// production (a single Database per process) while a reader over a different
// Database — a test fixture, a script's own handle — can never be served a
// model trained on someone else's rows. An hour matches the scrape cadence.
const modelMemo = perOwner<ScopedReader, ReturnType<typeof memo<ProductionModel>>>(() =>
  memo<ProductionModel>({ ttlSec: 3600, maxEntries: 1 })
);

/**
 * The type-aware model needs united_fleet to be a CENSUS, not a sample — a
 * partial roster gives biased per-type penetration. minFleetSanity is the same
 * completeness floor fleet-sync enforces on this table, so the two stay coupled.
 */
function censusRoster(reader: ScopedReader): FleetRosterEntry[] {
  if (reader.scope === "ALL") return [];
  const roster = reader.getFleetRoster();
  return roster.length >= AIRLINES[reader.scope].minFleetSanity ? roster : [];
}

type ProductionModel = { predict: (fn: string) => Prediction };

function buildProductionModel(reader: ScopedReader): ProductionModel {
  const trainObs = reader.getVerificationObservations();
  const roster = censusRoster(reader);
  const config = deriveConfig(reader, trainObs, DEFAULT_CONFIG, roster);
  const draws = adsbDrawsEnabled()
    ? reader.getAdsbFlightDraws(Math.floor(Date.now() / 1000) - ADSB_DRAW_WINDOW_DAYS * 86400)
    : null;
  return buildModel(trainObs, config, roster, draws);
}

/**
 * Predict Starlink probability for a flight number.
 * Caches the model per reader for an hour to avoid reloading 12k+ rows per call.
 */
export function predictFlight(reader: ScopedReader, flightNumber: string): Prediction {
  return modelMemo(reader)("model", () => buildProductionModel(reader)).predict(flightNumber);
}

// ============================================================================
// Route-based prediction
// ============================================================================

/** Common fields across all prediction output shapes. */
type BasePrediction = Pick<
  Prediction,
  "flight_number" | "probability" | "confidence" | "n_observations" | "method"
>;

export interface RouteFlightPrediction extends BasePrediction {
  route: string; // e.g. "SFO-BOI"
  route_observations: number; // times this flight seen on this specific route
}

export interface RoutePrediction {
  origin: string | null;
  destination: string | null;
  flights: RouteFlightPrediction[];
  coverage_note: string;
}

/**
 * Predict Starlink probability for all flight numbers observed on a route.
 *
 * IMPORTANT LIMITATION: upcoming_flights only contains flights operated by
 * tails in starlink_planes. Routes never flown by a Starlink-equipped plane
 * will return empty — which is itself a useful (negative) signal.
 *
 * Use origin alone ("flights from SFO"), destination alone ("flights to EWR"),
 * or both for a specific route.
 */
export function predictRoute(
  reader: ScopedReader,
  origin: string | null,
  destination: string | null
): RoutePrediction {
  const orig = origin?.toUpperCase().trim() || null;
  const dest = destination?.toUpperCase().trim() || null;

  if (!orig && !dest) {
    return {
      origin: orig,
      destination: dest,
      flights: [],
      coverage_note: "No origin or destination specified.",
    };
  }

  const routeFlights = reader.getRouteFlights(orig, dest);

  // Predict each (upcoming_flights stores SKW/OO/UAL/etc, predictor wants UA####)
  // De-dupe by normalized flight number, keeping highest route_obs
  const seen = new Map<string, RouteFlightPrediction>();
  for (const rf of routeFlights) {
    const normalized = uaPrefix(rf.flight_number);
    const existing = seen.get(normalized);
    if (existing && rf.route_obs <= existing.route_observations) continue;

    const pred = predictLegOrFlight(reader, normalized, rf.departure_airport, rf.arrival_airport);
    seen.set(normalized, {
      ...pred,
      route: `${rf.departure_airport}-${rf.arrival_airport}`,
      route_observations: rf.route_obs,
    });
  }

  const flights = [...seen.values()].sort((a, b) => b.probability - a.probability);

  const routeDesc = orig && dest ? `${orig}→${dest}` : orig ? `from ${orig}` : `to ${dest}`;
  const coverage_note =
    flights.length === 0
      ? `Route ${routeDesc} is UNOBSERVED — no Starlink-equipped aircraft has flown it in the observed history. Distinct from "0% observed": unobserved means no data. The fleet-prior baseline applies — mainline is materially lower than express; call get_fleet_stats for the current rates.`
      : `Found ${flights.length} flight number(s) ${routeDesc} operated by Starlink-equipped aircraft in our history. These probabilities reflect how often each flight number gets a Starlink plane assigned.`;

  return { origin: orig, destination: dest, flights, coverage_note };
}

// ============================================================================
// Route comparison (per-airline subfleet penetration on a nonstop)
// ============================================================================

export type RouteCompareKind =
  | "type_rule"
  | "observed_single"
  | "observed_mixed"
  | "inferred_absent"
  | "no_data";

/**
 * Per-subfleet penetration row. `synthetic` rows come from penetrationOverride
 * (tails counted under the operating carrier's roster) — they carry no
 * equipped/total, so printing counts on one is a type error, not a convention.
 */
export type SubfleetBreakdown = {
  key: string;
  label: string;
  hint?: string;
  pct: number;
} & ({ synthetic: true } | { synthetic: false; equipped: number; total: number });

export interface RouteCompareResult {
  airline: string;
  name: string;
  shortName: string;
  accentColor: string;
  /** uiAccent(brand) — for text and bars on the dark hub page. */
  accentText: string;
  canonicalHost: string;
  routePlannerBase: string | null;
  kind: RouteCompareKind;
  /** Point value (or midpoint of [lo,hi] for observed_mixed) — sort key only. */
  probability: number;
  lo?: number;
  hi?: number;
  breakdown: SubfleetBreakdown[];
  reason: string;
}

const fmt = (n: number) => n.toLocaleString("en-US");
const shortLabel = (s: string) => s.replace(/\s*Fleet$/i, "").trim();

function brand(cfg: AirlineConfig) {
  const site = siteForAirline(cfg.code, true);
  return {
    airline: cfg.code,
    name: cfg.name,
    shortName: cfg.shortName,
    accentColor: cfg.brand.accentColor,
    accentText: uiAccent(cfg.brand),
    canonicalHost: new URL(airlineHomeUrl(cfg.code)).host,
    // Path-style URL the per-airline route planner reads; null when that
    // tenant doesn't have a planner page (the chip hides).
    routePlannerBase: site?.features.routePlannerPage
      ? `https://${site.canonicalHost}/route-planner`
      : null,
  };
}

/** Join prose fragments with exactly one terminal period each. */
export function joinSentences(...parts: Array<string | null | undefined | false>): string {
  return parts
    .map((p) => (p || "").trim())
    .filter(Boolean)
    .map((p) => (/[.!?]$/.test(p) ? p : `${p}.`))
    .join(" ");
}

/**
 * Penetration with a sentinel-free shape: synthetic (penetrationOverride)
 * rows have no roster denominator — the tails fly on another carrier's metal
 * (e.g. AS800-999 on Hawaiian A330/A321neo), so equipped/total don't exist
 * and the type forbids printing them.
 */
export type ResolvedPenetration =
  | { synthetic: true; pct: number }
  | { synthetic: false; equipped: number; total: number; pct: number };

export function subfleetPenetration(
  pen: Map<string, SubfleetPenetration>,
  sf: SubfleetDef
): ResolvedPenetration | null {
  if (sf.penetrationOverride != null) {
    return { synthetic: true, pct: sf.penetrationOverride };
  }
  const p = pen.get(sf.key);
  return p ? { synthetic: false, ...p } : null;
}

// Below this many rostered tails, penetration is dominated by discovery bias:
// a roster fed only by the equipped-tail discovery pipeline is "100% equipped"
// by construction. Don't quote a number off it.
const MIN_PENETRATION_TOTAL = 5;

/**
 * Per-flight answer for carriers without a flight-history model
 * (cfg.flightHistoryModel === false). Registry-driven only — the UA-trained
 * predictor is never consulted. Phase-split carriers (families in both
 * confirmed and negative/rolling phases) get the split, never a blended
 * number; otherwise subfleet penetration; otherwise an honest no-model.
 */
export type CarrierPrediction =
  | { kind: "penetration"; sf: SubfleetDef; pen: ResolvedPenetration; aircraft?: AircraftBasis }
  | { kind: "type_split"; groups: { phase: WifiPhase; families: string[] }[] }
  | { kind: "no_model"; reason: string; aircraft?: AircraftBasis }
  // Community-source carriers (AF). Per programme type, never one blended
  // number: a flight number doesn't pin the type, and the types run from
  // "not started" to nearly done.
  // guideStale: the guide is past GUIDE_MARK_TTL_DAYS, so its non-Starlink
  // marks are history, not status (registry.ts has the policy).
  | {
      kind: "type_progress";
      types: TypeProgress[];
      guideUpdated: string | null;
      guideStale: boolean;
    }
  | {
      kind: "type_rate";
      type: TypeProgress;
      /** equipped/total; 0 for a retiring type; null when `ambiguous`. */
      share: number | null;
      /** A bare family the carrier splits (a plain "Boeing 777"): one row
       * per programme type, and no share. */
      ambiguous?: TypeProgress[];
      types: TypeProgress[];
      guideUpdated: string | null;
      guideStale: boolean;
    }
  // The two below come only from check-flight-core, which knows the
  // assigned tail; carrierPrediction never returns them.
  | {
      kind: "assigned_unconfirmed";
      tail: string;
      aircraftType: string | null;
      programLabel: string;
      /** null = the guide doesn't list this tail yet. */
      mark: GuideMark | null;
      guideUpdated: string | null;
      guideStale: boolean;
    }
  | { kind: "partner_operated"; tail: string }
  // An airline held by one dated statement of its own (cfg.statementRule):
  // the airline's word for the route asked about, never a share or odds.
  | { kind: "statement"; answer: StatementAnswer };

/** One aircraft our own data puts on a flight. */
export interface AircraftSighting {
  tail: string;
  aircraftType: string | null;
  /** Listed as equipped: the flight updater logs these on its own, so a log
   * holding them over-counts their type on the number. */
  equipped: boolean;
}

/**
 * Set on an answer the aircraft decided, where the flight number alone would
 * have said something else: the band's fixed answer withdrawn, or one type's
 * count in place of the band's blend.
 */
export interface AircraftBasis {
  /** "scheduled": the aircraft on the asked date. "logged": every departure
   * of the number the assignment log holds. */
  basis: "scheduled" | "logged";
  /** The one scheduled aircraft; null for a logged basis or several aircraft. */
  tail: string | null;
  aircraftType: string | null;
  /** The answer in prose, without the probability lead. */
  sentence: string;
  /** The airline's own dated count the answer rests on, if any. */
  count: QuotedCount | null;
}

/** A chart line as an answer quotes it: whose count, and of which aircraft. */
export type QuotedCount = AirlineTypeCount & {
  /** The airline's short name ("Alaska"). */
  airline: string;
  /** The type's short name ("787"). */
  aircraft: string;
};

export function typeShare(t: Pick<TypeProgress, "equipped" | "total" | "excluded">): number {
  return t.excluded || t.total === 0 ? 0 : t.equipped / t.total;
}

/** "Boeing 787-10" on a codeshare reaches AF's B787 key through the family
 * fallback, but AF flies only the 787-9, so that row says nothing about it. */
function namesUnflownVariant(cfg: AirlineConfig, aircraftType: string, key: string): boolean {
  const pinned = (cfg.programTypes ?? []).filter(([, k]) => k === key);
  return (
    pinned.length > 0 &&
    !pinned.some(([re]) => re.test(aircraftType)) &&
    /\d{3}-\d/.test(aircraftType)
  );
}

function communityPrediction(
  cfg: AirlineConfig,
  reader: ScopedReader,
  aircraftType: string | null | undefined,
  noModel: CarrierPrediction,
  nowMs: number
): CarrierPrediction {
  // Before the first guide sync every type would read "not started".
  const guideUpdated = reader.getMeta(COMMUNITY_SOURCE_UPDATED_META);
  const types = guideUpdated ? reader.getTypeProgress() : [];
  if (types.length === 0) return noModel;
  const guideStale = isGuideStale(guideUpdated, nowMs);
  if (aircraftType) {
    const { key } = programTypeOf(cfg, aircraftType);
    if (namesUnflownVariant(cfg, aircraftType, key))
      return { kind: "type_progress", types, guideUpdated, guideStale };
    const row = types.find((t) => t.key === key && t.total > 0);
    if (row) {
      return {
        kind: "type_rate",
        type: row,
        share: typeShare(row),
        types,
        guideUpdated,
        guideStale,
      };
    }
    const split = types.filter(
      (t) => !t.excluded && t.key !== key && normalizeAircraftType(t.label) === key
    );
    if (split.length > 1) {
      return {
        kind: "type_rate",
        type: {
          key,
          label: key.replace(/^B(?=\d)/, ""),
          equipped: 0,
          total: 0,
          notInGuide: 0,
          excluded: false,
        },
        share: null,
        ambiguous: split,
        types,
        guideUpdated,
        guideStale,
      };
    }
  }
  return { kind: "type_progress", types, guideUpdated, guideStale };
}

const PHASE_ORDER: readonly WifiPhase[] = ["confirmed", "rolling", "negative"];

/**
 * Phase groups when the carrier's family table spans BOTH confirmed and
 * negative/rolling: a flight number (or route, absent a route rule) doesn't
 * pin the family, so any single penetration number would blend "always yes"
 * types with "never" types (HA50 on an A330 ≠ a 717 interisland hop).
 * Null = no table, or the program is phase-uniform.
 */
function phaseSplit(cfg: AirlineConfig): { phase: WifiPhase; families: string[] }[] | null {
  const table = wifiPhaseFamilies(cfg.code);
  if (!table) return null;
  const byPhase = new Map<WifiPhase, string[]>();
  for (const [family, phase] of Object.entries(table)) {
    byPhase.set(phase, [...(byPhase.get(phase) ?? []), family]);
  }
  if (!byPhase.has("confirmed") || !(byPhase.has("negative") || byPhase.has("rolling"))) {
    return null;
  }
  return PHASE_ORDER.filter((p) => byPhase.has(p)).map((p) => ({
    phase: p,
    families: byPhase.get(p) as string[],
  }));
}

export function carrierPrediction(
  cfg: AirlineConfig,
  reader: ScopedReader,
  flightNumber: string,
  ctx: {
    aircraftType?: string | null;
    nowMs?: number;
    /** The aircraft our data puts on the asked date; absent on an undated ask. */
    scheduled?: readonly AircraftSighting[];
    /** The lookup named an aircraft for the asked date that we could not read. */
    unreadAircraft?: boolean;
    /** The traveller's own airports and date, for an airline answered by its
     * statement: only the route places such a flight. */
    route?: { origin?: string; destination?: string };
    date?: string;
  } = {}
): CarrierPrediction {
  // Reads nothing: no roster or schedule is held for such an airline.
  if (cfg.statementRule) {
    return {
      kind: "statement",
      answer: statementAnswer(
        { name: cfg.name, iata: cfg.iata, statementRule: cfg.statementRule },
        {
          ...ctx.route,
          aircraftType: ctx.aircraftType,
          date: ctx.date,
          today: new Date(ctx.nowMs ?? Date.now()).toISOString().slice(0, 10),
        }
      ),
    };
  }
  const noModel: CarrierPrediction = {
    kind: "no_model",
    reason: `No per-flight prediction model exists for ${cfg.name} — Starlink status is determined by aircraft type, not flight-number history. ${cfg.rollout.phaseNote}`,
  };
  // Defensive: a reader scoped to another airline (e.g. a hub caller that
  // skipped resolveCarrier) must never produce that airline's roster counts
  // as this carrier's answer.
  if (reader.scope !== cfg.code) return noModel;

  if (cfg.communitySource) {
    return communityPrediction(cfg, reader, ctx.aircraftType, noModel, ctx.nowMs ?? Date.now());
  }

  const groups = phaseSplit(cfg);
  if (groups) return { kind: "type_split", groups };

  const sf = cfg.subfleets.find((s) => s.match(flightNumber));
  // An aircraft we could not read may be any type. A fixed band's answer
  // presumes the band's own aircraft, so it is withdrawn; a blended band keeps
  // its blend, un-narrowed by whatever else was read beside it.
  if (sf?.families && ctx.unreadAircraft) {
    if (sf.penetrationOverride != null) return unreadAircraftAnswer(flightNumber, sf);
  } else if (sf?.families) {
    // The aircraft on the asked date, where we know it, speaks for that date;
    // the number's other departures speak only where we don't.
    const unlisted = (ctx.scheduled ?? []).filter((a) => !a.equipped);
    const scheduled = typedSightings(unlisted);
    // A tail we read, don't hold as equipped and can't type is not known to
    // be the band's aircraft, and a fixed band's answer presumes it is.
    if (sf.penetrationOverride != null && scheduled.length < unlisted.length) {
      const typed = new Set(scheduled.map((a) => a.tail));
      return untypedAircraftAnswer(
        flightNumber,
        sf,
        unlisted.filter((a) => !typed.has(a.tail)).map((a) => a.tail)
      );
    }
    const byAircraft =
      scheduled.length > 0
        ? aircraftAnswer(cfg, reader, flightNumber, sf, "scheduled", scheduled)
        : aircraftAnswer(
            cfg,
            reader,
            flightNumber,
            sf,
            "logged",
            typedSightings(loggedSightings(cfg, reader, flightNumber))
          );
    if (byAircraft) return byAircraft;
  }
  const pen = sf ? subfleetPenetration(reader.getSubfleetPenetration(), sf) : null;
  if (sf && pen && (pen.synthetic || pen.total >= MIN_PENETRATION_TOTAL)) {
    return { kind: "penetration", sf, pen };
  }
  return noModel;
}

/**
 * For an answer made from the number alone (the predict surfaces, which ask
 * no lookup): did the newest lookup of the flight leave an unread aircraft on
 * `date`, or with no date on any departure still ahead. Local dates run up to
 * a day behind UTC, so "still ahead" starts at yesterday's UTC date.
 */
export function storedUnreadAircraft(
  cfg: AirlineConfig,
  reader: ScopedReader,
  flightNumber: string,
  date: string | null,
  nowMs = Date.now()
): boolean {
  const variants = buildAirlineFlightNumberVariants(cfg, flightNumber);
  if (date) return reader.hasUnreadAircraft(variants, date);
  const from = new Date(nowMs - 86_400_000).toISOString().slice(0, 10);
  return reader.hasUnreadAircraft(variants, from, true);
}

function unreadAircraftAnswer(flightNumber: string, sf: SubfleetDef): CarrierPrediction {
  const hint = sf.flightNumberHint ? ` (${sf.flightNumberHint})` : "";
  const sentence = joinSentences(
    `An aircraft is scheduled on ${flightNumber}, but we could not read which one`,
    `Its number${hint} usually means ${bandLabel(sf.label)} aircraft, and we can't confirm this is one`,
    "Starlink depends on which aircraft flies yours"
  );
  return {
    kind: "no_model",
    reason: sentence,
    aircraft: { basis: "scheduled", tail: null, aircraftType: null, sentence, count: null },
  };
}

function untypedAircraftAnswer(
  flightNumber: string,
  sf: SubfleetDef,
  tails: readonly string[]
): CarrierPrediction {
  const hint = sf.flightNumberHint ? ` (${sf.flightNumberHint})` : "";
  const one = tails.length === 1;
  const sentence = joinSentences(
    `${flightNumber} is scheduled on ${tails.join(" and ")}, ${one ? "an aircraft" : "aircraft"} we don't hold as having Starlink and whose type we don't know`,
    `Its number${hint} usually means ${bandLabel(sf.label)} aircraft, and we can't confirm ${one ? "this is one" : "these are"}`,
    "Starlink depends on which aircraft flies yours"
  );
  return {
    kind: "no_model",
    reason: sentence,
    aircraft: {
      basis: "scheduled",
      tail: one ? tails[0] : null,
      aircraftType: null,
      sentence,
      count: null,
    },
  };
}

function loggedSightings(
  cfg: AirlineConfig,
  reader: ScopedReader,
  flightNumber: string
): AircraftSighting[] {
  return reader
    .getLoggedAircraft(buildAirlineFlightNumberVariants(cfg, flightNumber))
    .map((r) => ({ tail: r.tail_number, aircraftType: r.aircraft_type, equipped: r.equipped }));
}

type TypedSighting = AircraftSighting & { family: string };

/** A type string the normalizer can't place says nothing about the aircraft. */
function typedSightings(sightings: readonly AircraftSighting[]): TypedSighting[] {
  return sightings
    .map((a) => ({ ...a, family: normalizeAircraftType(a.aircraftType) }))
    .filter((a) => a.family !== "unknown" && a.family !== "other");
}

// The log holds departures still to come beside flown ones, and only some of
// its tails have a type we know; the wording claims neither more.
const KNOWN_DEPARTURES = "departures whose aircraft type we know";

// One logged departure on a type is a swap as easily as a habit.
const MIN_LOGGED_FOR_TYPE = 2;

const article = (label: string) => (/^[AE]/.test(label) ? "an" : "a");

function chartCountClause(cfg: AirlineConfig, c: AirlineTypeCount): string {
  const name = plural(aircraftName(c.family));
  const share =
    c.connected <= 0
      ? `none of its ${c.total} ${name}`
      : c.connected >= c.total
        ? `all ${c.total} of its ${name}`
        : `${c.connected} of its ${c.total} ${name}`;
  return `${cfg.shortName}'s own chart (${formatFactDate(c.asOf)}) counts ${share} as connected`;
}

/** The tails we name beside the chart's line, or null when we name none.
 * The chart can trail our list, so "of them" is said only when it doesn't. */
function namedClause(c: AirlineTypeCount, tail: string | null): string | null {
  if (c.named <= 0) return null;
  const name = plural(aircraftName(c.family));
  const said =
    c.named > c.connected
      ? `We name ${c.named} ${name} by tail, more than that chart counts`
      : `We name ${c.named} of them by tail`;
  return tail ? `${said}, and ${tail}` : said;
}

/** "not the Hawaiian-operated A330/A321neo aircraft its number (AS800-999) usually means". */
function overruledClause(sf: SubfleetDef): string {
  const hint = sf.flightNumberHint ? ` (${sf.flightNumberHint})` : "";
  return `not the ${bandLabel(sf.label)} aircraft its number${hint} usually means`;
}

/**
 * The answer for a flight whose aircraft we know, or null where the flight
 * number's own answer stands: no usable sighting, or every aircraft is one of
 * the band's types and no single type's count applies.
 *
 * The aircraft can withdraw a band's fixed answer and can narrow a blended
 * band to one type's count. It never grants a fixed yes the number did not
 * already give: a tail is a yes only by being listed, which is settled before
 * this is reached.
 */
function aircraftAnswer(
  cfg: AirlineConfig,
  reader: ScopedReader,
  flightNumber: string,
  sf: SubfleetDef,
  basis: AircraftBasis["basis"],
  typed: readonly TypedSighting[]
): CarrierPrediction | null {
  if (typed.length === 0) return null;
  const inBand = (family: string) => sf.families?.includes(family) ?? false;
  const fixed = sf.penetrationOverride != null;
  const strays = typed.filter((a) => !inBand(a.family));
  if (fixed ? strays.length === 0 : strays.length > 0) return null;

  const flown = (family: string) => typed.filter((a) => a.family === family).length;
  const families = [...new Set(typed.map((a) => a.family))].sort((a, b) => flown(b) - flown(a));
  const label = (family: string) =>
    aircraftName(typed.find((a) => a.family === family)?.aircraftType ?? family);
  const scheduled = basis === "scheduled";
  const one = typed.length === 1 && scheduled ? typed[0] : null;
  if (!fixed && families.length > 1) return null;
  const base = {
    basis,
    tail: one?.tail ?? null,
    aircraftType: plainTypeName(one?.aircraftType),
  };

  if (families.length > 1) {
    const tails = (f: string) => typed.filter((a) => a.family === f).map((a) => a.tail);
    const parts = families.map((f) =>
      scheduled ? `${tails(f).join(", ")} (${label(f)})` : `the ${label(f)} on ${flown(f)}`
    );
    const notes = families.flatMap((f) => familyClause(cfg, reader, f) ?? []);
    const sentence = joinSentences(
      scheduled
        ? `${flightNumber} is scheduled on more than one aircraft type: ${parts.join(" and ")}`
        : `${flightNumber} is on more than one aircraft type across the ${typed.length} ${KNOWN_DEPARTURES}: ${parts.join(" and ")}`,
      ...notes.map(capitalize),
      "Starlink depends on which aircraft flies yours"
    );
    return { kind: "no_model", reason: sentence, aircraft: { ...base, sentence, count: null } };
  }

  const family = families[0];
  const home = cfg.subfleets.find(
    (s) => s.penetrationOverride == null && s.families?.includes(family)
  );
  const aLabel = `${article(label(family))} ${label(family)}`;
  const who = one
    ? `scheduled on ${one.tail}, ${aLabel}`
    : scheduled
      ? `scheduled on ${typed.map((a) => a.tail).join(" and ")}, each ${aLabel}`
      : typed.length === 1
        ? `${aLabel} is on the one departure whose aircraft type we know`
        : `the ${label(family)} is on ${typed.length === 2 ? "both" : `all ${typed.length}`} ${KNOWN_DEPARTURES}`;
  const subject = strays.length > 0 ? `${who}, ${overruledClause(sf)}` : who;

  // A band of mixed types: the log can only narrow it on departures nobody
  // tracked for having Starlink, and on more than one of them.
  if (!fixed && !scheduled) {
    if (typed.length < MIN_LOGGED_FOR_TYPE || typed.some((a) => a.equipped)) return null;
  }

  const line = home ? reader.getAirlineTypeCount(family) : null;
  const count: QuotedCount | null = line
    ? { ...line, airline: cfg.shortName, aircraft: aircraftName(family) }
    : null;
  if (home && count) {
    const chart = chartCountClause(cfg, count);
    // The log leans toward the tails we name: the flight updater logs those on
    // its own, other tails only when someone looked the flight up. For a type
    // we name tails of, the answer turns on which tail flies, and the log
    // can't say how often a named one does. So no share is drawn from it: a
    // blended band keeps its own answer, a fixed band keeps no number.
    // A line the chart marks complete leaves nothing to depend on which tail
    // flies: it falls through to the complete-line answer below.
    if (!scheduled && count.named > 0 && !(fixed && count.connected >= count.total)) {
      if (!fixed) return null;
      const sentence = joinSentences(
        capitalize(subject),
        chart,
        namedClause(count, null),
        "Starlink depends on which aircraft flies yours"
      );
      return { kind: "no_model", reason: sentence, aircraft: { ...base, sentence, count } };
    }
    // A chart is the airline's count, never our yes for a flight: a line it
    // marks complete is quoted under its name and date, with no number a
    // client could badge.
    if (count.connected >= count.total) {
      const sentence = joinSentences(
        capitalize(subject),
        chart,
        `That is ${cfg.shortName}'s count, not ours: we have not confirmed ${one ? `${one.tail} ourselves` : "these aircraft tail by tail"}`
      );
      return { kind: "no_model", reason: sentence, aircraft: { ...base, sentence, count } };
    }
    // An aircraft we don't name can only be among the connected aircraft the
    // chart counts beyond the ones we do.
    const unnamed = count.total - count.named;
    const pct = unnamed > 0 ? Math.max(0, count.connected - count.named) / unnamed : 0;
    const named = scheduled
      ? namedClause(count, one ? `${one.tail} is not one` : "these are not among them")
      : null;
    const sentence = joinSentences(capitalize(subject), chart, named);
    return {
      kind: "penetration",
      sf: home,
      pen: { synthetic: false, equipped: count.connected, total: count.total, pct },
      aircraft: { ...base, sentence, count },
    };
  }
  if (!fixed) return null;

  // No chart to quote, but the reason the log draws no share still holds for
  // a type we name tails of: the answer turns on which tail flies, so the
  // home band's blend would say more than we know.
  const named = home && !scheduled ? reader.getNamedOfType(family) : 0;
  if (named > 0) {
    const sentence = joinSentences(
      capitalize(subject),
      `We name ${named} ${plural(aircraftName(family))} by tail`,
      "Starlink depends on which aircraft flies yours"
    );
    return { kind: "no_model", reason: sentence, aircraft: { ...base, sentence, count: null } };
  }

  const pen = home ? subfleetPenetration(reader.getSubfleetPenetration(), home) : null;
  if (home && pen && !pen.synthetic && pen.total >= MIN_PENETRATION_TOTAL) {
    const sentence = joinSentences(
      capitalize(subject),
      `${pen.equipped} of ${pen.total} ${bandLabel(home.label)} aircraft have Starlink`
    );
    return { kind: "penetration", sf: home, pen, aircraft: { ...base, sentence, count: null } };
  }
  const sentence = joinSentences(
    capitalize(subject),
    capitalize(familyClause(cfg, reader, family) ?? "we have no Starlink count for that aircraft")
  );
  return { kind: "no_model", reason: sentence, aircraft: { ...base, sentence, count: null } };
}

/** What we can say of one family on its own: its band's fixed answer, or the
 * airline's count for it. */
function familyClause(cfg: AirlineConfig, reader: ScopedReader, family: string): string | null {
  const band = cfg.subfleets.find(
    (s) => s.penetrationOverride != null && s.families?.includes(family)
  );
  if (band) {
    const name = `${bandLabel(band.label)} aircraft`;
    return (band.penetrationOverride ?? 0) >= 1
      ? `every ${name} has Starlink`
      : `${name} don't have Starlink`;
  }
  const count = reader.getAirlineTypeCount(family);
  return count ? chartCountClause(cfg, count) : null;
}

/** The answer names the aircraft scheduled on the asked date. */
export function namesScheduledAircraft(answer: CarrierPrediction): boolean {
  return (
    (answer.kind === "penetration" || answer.kind === "no_model") &&
    answer.aircraft?.basis === "scheduled"
  );
}

/** A named tail is a tail-level answer, not a per-type one; an airline's own
 * statement is neither. */
export function noModelConfidence(answer: CarrierPrediction): "tail" | "type" | "statement" {
  if (answer.kind === "statement") return "statement";
  return answer.kind === "assigned_unconfirmed" || answer.kind === "partner_operated"
    ? "tail"
    : "type";
}

/** One outcome/confidence mapping for registry-driven carrier answers — REST,
 * MCP, and verdictTelemetry all tag through here. */
export function carrierPredictionTelemetry(answer: CarrierPrediction | RouteCompareResult | null): {
  outcome: "predicted" | "no_data";
  confidence: "low" | "none";
} {
  // A statement that doesn't cover the flight is no answer for it.
  const informative =
    answer !== null &&
    answer.kind !== "no_model" &&
    !(answer.kind === "statement" && answer.answer.outcome !== "likely");
  return informative
    ? { outcome: "predicted", confidence: "low" }
    : { outcome: "no_data", confidence: "none" };
}

const PHASE_LABEL: Record<WifiPhase, string> = {
  confirmed: "Starlink (rollout complete)",
  rolling: "mid-installation",
  negative: "no Starlink",
};

function guideRef(cfg: AirlineConfig, guideUpdated: string | null) {
  return {
    label: cfg.communitySource?.label ?? "community fleet guide",
    date: guideUpdated ? formatFactDate(guideUpdated.slice(0, 10)) : null,
  };
}

/** What replaces an expired non-Starlink mark: the guide's age and the
 * airline's own dated fleet target. */
function staleGuideNote(cfg: AirlineConfig): string {
  const target = cfg.communitySource?.fleetTarget;
  const age = `That guide is over ${GUIDE_MARK_TTL_DAYS} days old and installs continue`;
  return target
    ? `${age}; ${target.text} (${target.source.label}, ${formatFactDate(target.asOf)})`
    : age;
}

const plural = (label: string) => (/\d$|[A-Z]$/.test(label) ? `${label}s` : label);

/** "At least: 777-300ER 34 of 43, …; not started on 787-9, …; A318/A330 retiring".
 * A stale guide can only say none were listed, not that none have started. */
function typeProgressSummary(types: readonly TypeProgress[], stale: boolean): string {
  const live = types.filter((t) => !t.excluded && t.total > 0);
  const done = live.filter((t) => t.equipped === t.total).map((t) => `${t.label} all ${t.total}`);
  const going = live
    .filter((t) => t.equipped > 0 && t.equipped < t.total)
    .map((t) => `${t.label} ${t.equipped} of ${t.total}`);
  const idle = live.filter((t) => t.equipped === 0).map((t) => t.label);
  const excluded = types.filter((t) => t.excluded);
  const excludedClause =
    excluded.length === 0
      ? null
      : excluded[0].exclusionReason === "not_in_programme"
        ? `${excluded.map((t) => t.label).join("/")} not in the programme`
        : `${excluded.map((t) => t.label).join("/")} retiring`;
  return [
    done.length + going.length > 0 ? `At least: ${[...done, ...going].join(", ")}` : null,
    idle.length > 0 ? `${stale ? "none listed on" : "not started on"} ${idle.join(", ")}` : null,
    excludedClause,
  ]
    .filter(Boolean)
    .join("; ");
}

function describeTypeRate(
  cfg: AirlineConfig,
  answer: Extract<CarrierPrediction, { kind: "type_rate" }>
): string {
  const g = guideRef(cfg, answer.guideUpdated);
  const cite = `(${g.label}${g.date ? `, updated ${g.date}` : ""})`;
  if (answer.ambiguous) {
    const rows = answer.ambiguous.map(
      (t) => `the ${t.label} (${t.equipped > 0 ? `${t.equipped} of ${t.total}` : "none yet"})`
    );
    return joinSentences(
      `${cfg.name} flies ${answer.ambiguous.length === 2 ? "two" : answer.ambiguous.length} ${answer.type.label} types: ${rows.join(" and ")}`,
      "Check the exact variant on your booking"
    );
  }
  const t = answer.type;
  const name = plural(t.label);
  if (t.excluded) {
    const note = cfg.programExclusions?.note;
    return joinSentences(
      `${cfg.name}'s ${name} are not in the Starlink programme${note ? ` — ${note.toLowerCase()}` : ""}`
    );
  }
  const stale = answer.guideStale ? staleGuideNote(cfg) : null;
  if (t.equipped === 0) {
    return joinSentences(
      answer.guideStale
        ? `No ${cfg.name} ${t.label} was listed with Starlink ${cite}`
        : `No ${cfg.name} ${t.label} is listed with Starlink yet ${cite}`,
      stale
    );
  }
  if (t.equipped === t.total) {
    return joinSentences(`All ${t.total} ${cfg.name} ${name} have Starlink ${cite}`);
  }
  return joinSentences(
    `At least ${t.equipped} of ${t.total} ${cfg.name} ${name} have Starlink ${cite}`,
    stale,
    "The aircraft is assigned about two days before departure"
  );
}

function describeAssigned(
  cfg: AirlineConfig,
  answer: Extract<CarrierPrediction, { kind: "assigned_unconfirmed" }>
): string {
  const on = `Scheduled on ${answer.tail}${answer.programLabel ? ` (${answer.programLabel})` : ""}`;
  const g = guideRef(cfg, answer.guideUpdated);
  const guide = `the ${g.label}${g.date ? ` updated ${g.date}` : ""}`;
  if (answer.mark === "starlink") {
    return joinSentences(`${on}; listed with Starlink in ${guide}, not yet verified`);
  }
  const stale = answer.guideStale ? staleGuideNote(cfg) : null;
  if (answer.mark === null) return joinSentences(`${on}; not yet listed in ${guide}`, stale);
  if (stale) return joinSentences(`${on}; not on the Starlink list in ${guide}`, stale);
  const has = answer.mark === "legacy" ? "it has legacy WiFi" : "no WiFi listed";
  return joinSentences(`${on}; not on the Starlink list in ${guide} — ${has}`);
}

/** One-sentence prose for a CarrierPrediction — keeps REST and MCP wording identical.
 * `date` marks a dated lookup, which must not be told to pick a date. */
export function describeCarrierPrediction(
  cfg: AirlineConfig,
  answer: CarrierPrediction,
  opts: { date?: string | null } = {}
): string {
  if (answer.kind === "no_model") return answer.reason;
  if (answer.kind === "statement") return answer.answer.sentence;
  if (answer.kind === "type_progress") {
    const g = guideRef(cfg, answer.guideUpdated);
    return joinSentences(
      `On ${cfg.name}-operated flights, Starlink depends on the aircraft type. ${typeProgressSummary(answer.types, answer.guideStale)}`,
      `Per-aircraft status from the ${g.label}${g.date ? ` (updated ${g.date})` : ""}`
    );
  }
  if (answer.kind === "type_rate") return describeTypeRate(cfg, answer);
  if (answer.kind === "assigned_unconfirmed") return describeAssigned(cfg, answer);
  if (answer.kind === "partner_operated") {
    return joinSentences(
      `Operated by another airline (${answer.tail}) — ${cfg.name} fleet data doesn't apply to this flight`
    );
  }
  if (answer.kind === "type_split") {
    const parts = answer.groups.map((g) => `${g.families.join("/")}: ${PHASE_LABEL[g.phase]}`);
    return joinSentences(
      `Starlink on ${cfg.name} is determined by aircraft type — ${parts.join("; ")}`,
      opts.date
        ? `No aircraft schedule is on file for this flight on ${opts.date} yet; aircraft are assigned about two days before departure`
        : "Check a specific flight and date to see which aircraft type is scheduled"
    );
  }
  const { sf, pen } = answer;
  // The fleet page's percent for the same counts: a share, rounded down.
  const lead = `${approxShare(pen.pct)} Starlink probability`;
  if (answer.aircraft) {
    const said = answer.aircraft.sentence;
    return `${lead}: ${said.charAt(0).toLowerCase()}${said.slice(1)}`;
  }
  // bandLabel drops the label's parentheses, so the hint is the only parenthetical.
  const band = `${bandLabel(sf.label)} aircraft${sf.flightNumberHint ? ` (${sf.flightNumberHint})` : ""}`;
  // A band that settles the answer gets no airline-wide rollout note: a
  // Hawaiian A330 flight has nothing to do with Alaska's 737s.
  if (pen.synthetic) {
    if (pen.pct >= 1) return joinSentences(`${lead}: every ${band} has Starlink`);
    if (pen.pct <= 0) return joinSentences(`${lead}: ${band} don't have Starlink`);
    return joinSentences(`${lead}: ${band}`);
  }
  return joinSentences(
    `${lead}: ${pen.equipped} of ${pen.total} ${band} have Starlink`,
    cfg.rollout.phaseNote
  );
}

/**
 * Per-subfleet install rates from the full roster — the breakdown block
 * compareRoute serves per airline and the hub /compare pages render directly.
 * Empty when the roster holds no penetration data for the carrier.
 */
export function subfleetBreakdown(cfg: AirlineConfig, reader: ScopedReader): SubfleetBreakdown[] {
  const penMap = reader.getSubfleetPenetration();
  if (penMap.size === 0) return [];
  return cfg.subfleets.map((sf) => {
    const p = subfleetPenetration(penMap, sf) ?? {
      synthetic: false as const,
      equipped: 0,
      total: 0,
      pct: 0,
    };
    return { key: sf.key, label: sf.label, hint: sf.flightNumberHint, ...p };
  });
}

/**
 * One airline's Starlink odds on a NONSTOP O-D pair.
 *
 * Reports the install rate across the subfleet(s) the carrier flies nonstop
 * on this route — equipped tails ÷ all tails in that subfleet, from the full
 * fleet roster. NOT a best-case-routing optimizer (the previous planItinerary
 * approach returned 97% for UA SFO-AUS via OMA, which nobody books).
 * Returns null when the roster has no penetration data for the carrier.
 */
export function compareRouteForAirline(
  cfg: AirlineConfig,
  reader: ScopedReader,
  origin: string,
  destination: string
): RouteCompareResult | null {
  const o = origin.toUpperCase().trim();
  const d = destination.toUpperCase().trim();
  // A community-source carrier's route doesn't pin the aircraft type any more
  // than its flight number does; any route number would be a blend.
  if (cfg.communitySource) {
    return {
      ...brand(cfg),
      kind: "no_data",
      probability: -1,
      breakdown: [],
      reason: "Depends on aircraft type",
    };
  }
  // flight_routes has no airline column, so the prefix glob would attribute
  // shared-regional rows (OO/SKW for SkyWest, ENY/PDT etc.) to UA. flight_routes
  // is written via ensureAirlinePrefix → marketing IATA, so iata+icao is enough.
  const prefixes = [cfg.iata, cfg.icao];

  // ---- 1. Type-deterministic carriers (HA today) ----
  if (cfg.routeTypeRule) {
    const rule = cfg.routeTypeRule(o, d);
    if (rule && reader.airlineServesAirports(prefixes, o, d)) {
      return {
        ...brand(cfg),
        kind: "type_rule",
        probability: rule.probability,
        breakdown: [],
        reason: rule.reason,
      };
    }
    // Symmetry: HA renders no_data on mainland-mainland instead of vanishing.
    return { ...brand(cfg), kind: "no_data", probability: -1, breakdown: [], reason: "" };
  }

  // ---- 2. Unbiased per-subfleet penetration from full roster ----
  const penArr = subfleetBreakdown(cfg, reader);
  if (penArr.length === 0) return null;
  const maxPct = Math.max(...penArr.map((p) => p.pct));
  const defOf = (key: string) => cfg.subfleets.find((s) => s.key === key);
  // A route-scoped subfleet (HA 717 interisland) is only credited where it is
  // observed — never as the "lowest sibling" of an unrelated route.
  const inferable = penArr.filter((p) => !defOf(p.key)?.routeScoped);
  const minSub = (inferable.length > 0 ? inferable : penArr).reduce((a, b) =>
    a.pct <= b.pct ? a : b
  );

  // ---- 3. Which subfleet(s) fly this nonstop? ----
  const fns = reader.getObservedDirectFlightNumbers(prefixes, o, d);
  const seen = new Set<string>();
  for (const fn of fns) {
    const sf = cfg.subfleets.find((s) => s.match(fn));
    if (sf) seen.add(sf.key);
  }

  let result: RouteCompareResult;
  if (seen.size === 1) {
    const sf = penArr.find((p) => seen.has(p.key))!;
    // We can prove the high-pen subfleet flies the route, but NOT that the
    // low-pen one doesn't (it's invisible to us). When the seen subfleet is
    // the high one and a low-pen (<50%) sibling exists, show the honest
    // range — otherwise SEA-ANC reads "AS 100%" when it's mostly 737s at 0%.
    const lowSibling = inferable.find((p) => p.key !== sf.key && p.pct < 0.5);
    if (sf.pct === maxPct && lowSibling) {
      const bd = [sf, lowSibling].sort((a, b) => b.pct - a.pct);
      result = {
        ...brand(cfg),
        kind: "observed_mixed",
        probability: (sf.pct + lowSibling.pct) / 2,
        lo: lowSibling.pct,
        hi: sf.pct,
        breakdown: bd,
        reason: "Depends on flight number",
      };
    } else {
      result = {
        ...brand(cfg),
        kind: "observed_single",
        probability: sf.pct,
        breakdown: [sf],
        reason: sf.synthetic
          ? `${shortLabel(sf.label)} on this route — ${defOf(sf.key)?.overrideReason ?? "Starlink-equipped fleet"}`
          : `${shortLabel(sf.label)} on this route — ${fmt(sf.equipped)} of ${fmt(sf.total)} equipped`,
      };
    }
  } else if (seen.size >= 2) {
    // Do NOT frequency-weight by observed FN count: the observation set is
    // Starlink-biased toward the high-penetration subfleet, so weighting
    // would systematically overstate. Show the honest range + the rule.
    const bd = penArr.filter((p) => seen.has(p.key)).sort((a, b) => b.pct - a.pct);
    const lo = Math.min(...bd.map((b) => b.pct));
    const hi = Math.max(...bd.map((b) => b.pct));
    result = {
      ...brand(cfg),
      kind: "observed_mixed",
      probability: (lo + hi) / 2,
      lo,
      hi,
      breakdown: bd,
      reason: "Depends on flight number",
    };
  } else if (
    // ---- 4. Unobserved nonstop ----
    // Gate A: airline must touch both airports (Starlink-biased; failure
    //   mode is omission, not a wrong number — covered by footer copy).
    // Gate B: max subfleet penetration ≥ 0.5. With ≥50% of a subfleet tracked
    //   over ~65 days, a daily nonstop on that subfleet would have appeared
    //   with P > 1 - 0.5^65 ≈ 1. Absence ⇒ that subfleet does not fly the route.
    reader.airlineServesAirports(prefixes, o, d) &&
    maxPct >= 0.5 &&
    // Both subfleets ≥50% would mean BOTH are ruled out by the same
    // absence argument — i.e. the airline doesn't fly the nonstop. no_data.
    minSub.pct < 0.5
  ) {
    result = {
      ...brand(cfg),
      kind: "inferred_absent",
      probability: minSub.pct,
      breakdown: [minSub],
      reason: minSub.synthetic
        ? `${shortLabel(minSub.label)} subfleet`
        : `${fmt(minSub.equipped)} of ${fmt(minSub.total)} aircraft equipped`,
    };
  } else {
    // Always render every public airline so the panel is symmetric — a
    // missing carrier reads as inconsistent ("why is AS shown but UA
    // isn't on the same route?"). no_data is honest about the gap.
    result = {
      ...brand(cfg),
      kind: "no_data",
      probability: -1,
      breakdown: [],
      reason: "No route data yet",
    };
  }

  // ---- 5. Invariant guard ----
  // No non-rule result may exceed this airline's best-equipped subfleet rate.
  // This is the bug class we're fixing (UA SFO-AUS at 97% > 64% express ceiling).
  const top = result.hi ?? result.probability;
  if (result.kind !== "no_data" && top > maxPct + 1e-6) {
    throw new Error(
      `compareRoute invariant: ${cfg.code} ${o}-${d} = ${top.toFixed(3)} > ceiling ${maxPct.toFixed(3)}`
    );
  }
  return result;
}

/** Per-airline Starlink odds for a NONSTOP O-D pair across all public carriers. Hub-only. */
export function compareRoute(
  getReader: (code: string) => ScopedReader,
  origin: string,
  destination: string
): RouteCompareResult[] {
  const out: RouteCompareResult[] = [];
  for (const cfg of publicAirlines()) {
    const r = compareRouteForAirline(cfg, getReader(cfg.code), origin, destination);
    if (r) out.push(r);
  }

  // Every-carrier-no_data ⇒ garbage route ⇒ empty (the panel's empty-state copy
  // covers it). If ANY carrier has data, keep the no_data rows for symmetry.
  if (out.every((r) => r.kind === "no_data")) return [];

  // Sort: confident kinds by upper bound desc; inferred_absent then no_data last.
  const rank = (r: RouteCompareResult) =>
    r.kind === "no_data" ? -1 : r.kind === "inferred_absent" ? 0 : 1;
  return out.sort((a, b) => rank(b) - rank(a) || (b.hi ?? b.probability) - (a.hi ?? a.probability));
}

/**
 * Route answer for carriers without a flight-history model. Unlike
 * compareRoute, the type rule answers WITHOUT the serves-this-route gate:
 * it encodes "IF this carrier flies o→d, the equipment class decides", which
 * is the right answer to a direct question even when our route observations
 * haven't seen the pair. Null = nothing better than "no model" to say.
 */
export function carrierRouteAnswer(
  cfg: AirlineConfig,
  reader: ScopedReader,
  origin: string,
  destination: string
): RouteCompareResult | null {
  const o = origin.toUpperCase().trim();
  const d = destination.toUpperCase().trim();
  if (cfg.routeTypeRule) {
    const rule = cfg.routeTypeRule(o, d);
    return rule
      ? {
          ...brand(cfg),
          kind: "type_rule",
          probability: rule.probability,
          breakdown: [],
          reason: rule.reason,
        }
      : null;
  }
  // A split-phase carrier without a route rule (QR): the route doesn't pin
  // the family either, so a roster-penetration number would be the same
  // dishonest blend the predict path refuses — say no-model instead.
  if (phaseSplit(cfg) || cfg.communitySource) return null;
  const r = compareRouteForAirline(cfg, reader, o, d);
  return r && r.kind !== "no_data" ? r : null;
}

// ============================================================================
// Itinerary planning (multi-stop graph search)
// ============================================================================

const MIN_LEG_PROBABILITY = 0.3;

// Probability for confirmed near-term Starlink assignments (same-day in
// upcoming_flights, verified-Starlink tail). Discount = observed aircraft-swap
// rate from our own verification log ('Aircraft mismatch' errors).
//
// Re-measured from verification.check{result:aircraft_mismatch} by fleet:
//   30d  express 381/4,233 = 9.00%   mainline 261/5,235 = 4.99%
//   90d  express 971/12,178 = 7.97%  mainline 760/13,685 = 5.56%
// Corroborated by adsb_shadow.observations at 8.4% overall.
//
// The old mainline value (0.65, from an assumed ~35% swap rate) was ~30 points
// too low and had the ordering backwards — mainline now swaps LESS than
// express. It sits between MIN_LEG_PROBABILITY and the 0.7 strong-direct gate,
// so it was materially changing which itineraries got shown.
const CONFIRMED_PROB = {
  express: 0.9, // 1 - ~9% observed swap rate
  mainline: 0.95, // 1 - ~5% observed swap rate
};

export type ItineraryLeg = BasePrediction & {
  route: string;
  duration_hours: number | null;
  // True if this leg comes from a confirmed near-term Starlink assignment in
  // upcoming_flights (not historical prediction). Render differently.
  confirmed?: boolean;
  // duration_hours was backfilled by routeHours() rather than observed on this flight.
  duration_estimated?: boolean;
  /** Usual local departure at the leg's origin ("8:15 AM"), when one is on record. */
  typical_departure?: string;
  /** Usual local arrival at the leg's destination, from the departure plus duration. */
  typical_arrival?: string;
  /** Origin-local date the leg flies on, given a searched date: a later leg can be the next day. */
  date?: string;
  /**
   * What the times rest on, in the route board's words: "usual" once the
   * flight was seen on USUAL_TIME_DAYS days, else its "next" scheduled
   * departure or the one "last_seen".
   */
  time_basis?: TimeBasis;
  /** Local days the flight was seen on this pair, the timed leg's evidence. */
  days_seen?: number;
  /** Seen flying on the weekday of `date`; absent undated or with nothing logged. */
  runs_on_date?: boolean;
};

export type TimeBasis = "usual" | "next" | "last_seen";

/** Logged days a departure time needs before the board or the planner calls it usual. */
export const USUAL_TIME_DAYS = 3;

export interface Itinerary {
  via: string[]; // connection hub(s) in order, empty for direct
  legs: ItineraryLeg[];
  joint_probability: number; // P(all legs have Starlink) = product of leg probs
  at_least_one_probability: number; // P(at least one leg has Starlink)
  coverage: "full" | "partial"; // "full"=all legs in Starlink graph, "partial"=positioning leg needed
  // Time-aware metrics — these are what users actually care about for trade-off decisions.
  // A "92% Starlink" 2-hour leg after a 5-hour no-Starlink leg is ~1.8h of Starlink out of 7h flying.
  total_flight_hours: number | null; // null if any leg duration unknown
  expected_starlink_hours: number | null; // Σ(leg_probability × leg_duration), null if any duration unknown
  // coverage_ratio = expected_starlink_hours / total_flight_hours. This is the
  // ranking metric: maximizing raw eSL hours pathologically prefers 10h 3-stop
  // routes over a 1h 92% direct. Coverage ratio treats them fairly.
  coverage_ratio: number | null;
  /**
   * "same_day": every leg has a usual time and each connection leaves at least
   * MIN_CONNECTION_MINUTES after the previous leg usually lands. "unknown": a
   * leg has no time on record (or is an any-flight positioning leg), so the
   * connection could not be checked.
   */
  schedule?: "same_day" | "unknown";
  /** Minutes on the ground at each stop, in order; null where unknown. */
  connection_minutes?: Array<number | null>;
  /** First usual departure to last usual arrival, layovers included; null if any part is unknown. */
  elapsed_hours?: number | null;
}

/** One flight number on one pair, before its odds are dated. */
interface EdgeOption {
  /** The number as stored, keying confirmed assignments. */
  stored: string;
  /** History-only prediction (flight_number is the UA spelling). */
  hist: BasePrediction;
  route: string;
  departure: string;
  arrival: string;
  duration_hours: number | null;
  /** Usual departure, minutes after local midnight at the origin; null when unknown. */
  minutes: number | null;
  /** Local days the flight was seen on the pair (logged, plus its scheduled one). */
  days: number;
  /** Weekdays ("Sat") of those days. */
  weekdays: ReadonlySet<string>;
  /** The scheduled departure the time is read from (unix); null when unknown. */
  newest: number | null;
}

/**
 * Every flight number on each pair, best odds first. A connection has to pick
 * the flight that leaves after the previous one lands, not the best number on
 * the pair; keeping one edge per pair is what showed itineraries whose second
 * flight had left before the first one landed.
 */
type RouteGraph = Map<string, Map<string, EdgeOption[]>>;

/**
 * Same-day assignments on VERIFIED-Starlink tails (verified_wifi = 'Starlink',
 * not NULL — spreadsheet-listed-but-unverified planes don't get the confirmed
 * tier), keyed flight|dep|arr. Only valid for a date our upcoming_flights
 * snapshot covers; outside it the map is simply empty.
 */
function confirmedEdgesOn(reader: ScopedReader, date: string): Map<string, "express" | "mainline"> {
  const out = new Map<string, "express" | "mainline">();
  const window = flightDateWindow(date);
  if (!window) return out;
  // Match rows on the departure airport's LOCAL date over the widened bounds,
  // same as check-flight core — a strict UTC day window drops verified evening
  // departures (SFO 6pm = 01:00Z next day) and seeds the wrong day's tail.
  for (const r of reader.getConfirmedStarlinkEdges(window.queryStart, window.queryEnd)) {
    if (!matchesLocalDate(date, r.departure_airport, r.departure_time, window.start, window.end)) {
      continue;
    }
    out.set(
      `${r.flight_number}|${r.departure_airport}|${r.arrival_airport}`,
      r.fleet === "mainline" ? "mainline" : "express"
    );
  }
  return out;
}

const nextIsoDate = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

const weekdayOf = (date: string) => zonedWeekday(Date.parse(`${date}T12:00:00Z`) / 1000, "UTC");

// The log holds a week; its grouped scan runs some tens of ms at United's size,
// and a usual time or a weekday doesn't move within minutes.
const sightingMemo = perOwner<ScopedReader, ReturnType<typeof memo<Map<string, Set<string>>>>>(() =>
  memo<Map<string, Set<string>>>({ ttlSec: 600, maxEntries: 1 })
);

/** Logged local days per flight|dep|arr, the flight keyed as departure slots key it. */
function sightingDays(reader: ScopedReader): Map<string, Set<string>> {
  return sightingMemo(reader)("days", () => loadSightingDays(reader));
}

function loadSightingDays(reader: ScopedReader): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const r of reader.getRouteGraphSightings()) {
    const key = `${slotFlightKey(r.flight_number, reader.scope) ?? r.flight_number}|${r.departure_airport}|${r.arrival_airport}`;
    const days = out.get(key);
    if (days) days.add(r.dep_date);
    else out.set(key, new Set([r.dep_date]));
  }
  return out;
}

/**
 * Build the Starlink route adjacency graph: for each airport, every flight
 * number to each reachable destination that clears the odds floor on some day
 * the trip can fly.
 *
 * Probability comes from TWO sources, in priority order:
 *  1. CONFIRMED assignment: if the flight is on a verified-Starlink tail on
 *     the day the leg flies, in our current upcoming_flights snapshot.
 *  2. Historical prediction: predictFlight() from the verification log.
 *
 * Without (1), a flight like UA1358 ORD→MIA (0% history, but literally on a
 * Starlink plane tomorrow) gets filtered out and the planner says "no path."
 * Without a searched date, (1) is skipped: today's tail assignment has no
 * bearing on an undated trip.
 */
function buildRouteGraph(
  reader: ScopedReader,
  minLegProb: number,
  confirmedOn: (date: string) => Map<string, "express" | "mainline">,
  searchedDate: string | null
): RouteGraph {
  const rows = reader.getRouteGraphEdges();
  const logged = sightingDays(reader);
  // A later leg can fly the day after the searched one (a red-eye, a late
  // connection), so a flight confirmed on either day is worth keeping.
  const seedDays = searchedDate ? [searchedDate, nextIsoDate(searchedDate)] : [];

  const graph: RouteGraph = new Map();
  for (const r of rows) {
    const dep = r.departure_airport;
    const arr = r.arrival_airport;
    // A row whose origin equals its destination is bad upstream data; letting
    // it into the graph is what let the planner emit self-loop legs.
    if (!dep || !arr || dep === arr) continue;
    const key = `${r.flight_number}|${dep}|${arr}`;
    const hist = predictLegOrFlight(reader, uaPrefix(r.flight_number), dep, arr);
    const confirmedSomeDay = seedDays.some((d) => confirmedOn(d).has(key));
    if (hist.probability < minLegProb && !confirmedSomeDay) continue;

    const zone = airportTimezone(dep);
    const days = new Set(
      logged.get(`${slotFlightKey(r.flight_number, reader.scope) ?? r.flight_number}|${dep}|${arr}`)
    );
    if (zone && r.departure_time) days.add(localDateISO(r.departure_time, zone));
    const option: EdgeOption = {
      stored: r.flight_number,
      hist,
      route: `${dep}-${arr}`,
      departure: dep,
      arrival: arr,
      duration_hours: r.avg_duration_sec > 0 ? r.avg_duration_sec / 3600 : null,
      minutes: zone && r.departure_time ? zonedMinutes(r.departure_time, zone) : null,
      days: days.size,
      weekdays: new Set([...days].map(weekdayOf)),
      newest: r.departure_time,
    };
    if (!graph.has(dep)) graph.set(dep, new Map());
    const edges = graph.get(dep)!;
    const list = edges.get(arr);
    if (list) list.push(option);
    else edges.set(arr, [option]);
  }
  for (const edges of graph.values()) {
    for (const list of edges.values()) {
      list.sort((a, b) => b.hist.probability - a.hist.probability);
    }
  }
  return graph;
}

/**
 * The option's odds on the day it flies: the MAX of its history and the
 * swap-adjusted confirmed tier (a flight with 100% history shouldn't drop to
 * 90% just because it's also in the snapshot). Null when below the floor.
 */
function datedLeg(
  option: EdgeOption,
  date: string | null,
  confirmedOn: (date: string) => Map<string, "express" | "mainline">,
  minLegProb: number
): ItineraryLeg | null {
  const fleet = date
    ? confirmedOn(date).get(`${option.stored}|${option.departure}|${option.arrival}`)
    : undefined;
  const confirmedP = fleet ? CONFIRMED_PROB[fleet] : 0;
  const pred: BasePrediction =
    fleet && option.hist.probability < confirmedP
      ? {
          flight_number: option.hist.flight_number,
          probability: confirmedP,
          confidence: "high",
          method: "confirmed_assignment",
          n_observations: 1,
        }
      : option.hist;
  if (pred.probability < minLegProb) return null;
  return {
    ...pred,
    route: option.route,
    duration_hours: option.duration_hours,
    confirmed: fleet !== undefined,
  };
}

function computeItinerary(legs: ItineraryLeg[], coverage: "full" | "partial"): Itinerary {
  const joint = legs.reduce((p, l) => p * l.probability, 1);
  const atLeastOne = 1 - legs.reduce((p, l) => p * (1 - l.probability), 1);
  const via = legs.slice(0, -1).map((l) => l.route.split("-")[1]);

  const allDurationsKnown = legs.every((l) => l.duration_hours !== null);
  const totalHours = allDurationsKnown
    ? legs.reduce((s, l) => s + (l.duration_hours as number), 0)
    : null;
  const expectedStarlinkHours = allDurationsKnown
    ? legs.reduce((s, l) => s + l.probability * (l.duration_hours as number), 0)
    : null;
  const coverageRatio =
    totalHours !== null && expectedStarlinkHours !== null && totalHours > 0
      ? expectedStarlinkHours / totalHours
      : null;

  return {
    via,
    legs,
    joint_probability: joint,
    at_least_one_probability: atLeastOne,
    coverage,
    total_flight_hours: totalHours,
    expected_starlink_hours: expectedStarlinkHours,
    coverage_ratio: coverageRatio,
  };
}

/**
 * A leg we have no Starlink data for, priced at the scope's live mainline
 * penetration (loadFleetPriors). No default on purpose: the fallback constant
 * (0.02) is ~10x below the live rate and silently priced every partial
 * itinerary's positioning leg while callers passed nothing.
 */
function makePositioningLeg(route: string, probability: number): ItineraryLeg {
  return {
    flight_number: "(any)",
    route,
    probability,
    confidence: "low",
    method: "fleet_prior_mainline",
    n_observations: 0,
    duration_hours: null,
  };
}

/**
 * Find the best Starlink-maximizing itineraries from origin to destination.
 *
 * Multi-stop graph search over edges where a Starlink plane has flown or is
 * currently confirmed. Ranked by COVERAGE RATIO (expected Starlink hours /
 * total hours) — not raw hours, which would pathologically prefer 10-hour
 * 3-stops over 1-hour 92% directs.
 *
 * Guarantees: a direct flight in the graph is ALWAYS returned as option #1.
 * Partial-coverage baselines (positioning + Starlink leg in either direction)
 * are included when no strong direct exists.
 *
 * Every connection is gated on a geographic detour bound (airport-geo). The
 * coverage-ratio ranking is blind to geography and happily proposed OGG->SFO
 * via San Antonio; when no on-the-way routing exists, nothing IS the answer.
 *
 * A connection is offered only when every airport on it has coordinates, so
 * the bound was computed rather than skipped. The flight feed hands us a new
 * code days before anyone places it, and the gates used to pass what they
 * could not check: DEN->EWR and EWR->LHR were offered by way of St. Kitts,
 * with "?" for the hours. A trip that itself starts or ends at such a code
 * keeps its nonstops, which need no geography.
 */
export function planItinerary(
  reader: ScopedReader,
  origin: string,
  destination: string,
  options: PlanOptions = {}
): Itinerary[] {
  return planRoute(reader, origin, destination, options).itineraries;
}

export interface PlanOptions {
  maxItineraries?: number;
  minLegProbability?: number;
  maxStops?: number;
  targetDateUnix?: number;
  /** Time budget + 2-stop gain rule; defaults to ENFORCE_ITINERARY_TIME_BUDGET. */
  enforceTimeBudget?: boolean;
}

/**
 * Why a plan came back empty, so a page can say so instead of showing nothing:
 * "over_budget" — connections exist but all take too long against the nonstop;
 * "no_same_day" — Starlink flights reach `hubs`, but none flies on within
 * MAX_CONNECTION_HOURS of landing; "no_route" — no Starlink legs join the pair;
 * "unplaced_airport" — the trip starts or ends at `airports`, which have no
 * coordinates yet, so no connection can be held to the detour bound and no
 * nonstop with Starlink odds flies the pair.
 */
export type EmptyPlanReason =
  | { kind: "over_budget"; budget_hours: number; nonstop_hours: number | null }
  | { kind: "no_same_day"; hubs: string[] }
  | { kind: "no_route"; max_stops: number }
  | { kind: "unplaced_airport"; airports: string[] };

/** Has coordinates, so the detour bound and the country gate can weigh it. */
const isPlaced = (code: string): boolean => AIRPORT_COORDS[code] !== undefined;

/**
 * The ends of a trip that have no coordinates yet. A trip with any gets its
 * nonstops and no connection, so an answer built on the planner must say that
 * connections went unchecked, never that none exists.
 */
export function unplacedTripEnds(origin: string, destination: string): string[] {
  return [origin, destination].map((code) => code.toUpperCase().trim()).filter((c) => !isPlaced(c));
}

/**
 * Why a trip with an unplaced end lists no connection, for an answer that
 * would otherwise read as "none exists": ORD to St. Kitts by way of Newark is
 * a real routing the planner leaves out, not one it failed to find.
 */
export function unplacedTripNote(airports: string[]): string {
  const names = airports.map(airportWithCode).join(" and ");
  return `connections were not checked, because ${names} ${airports.length === 1 ? "is" : "are"} not in our airport tables yet and none can be held to how far out of the way it goes. One may exist; only nonstops are covered here`;
}

/** planItinerary, with the reason when nothing is offered. */
export function planRoute(
  reader: ScopedReader,
  origin: string,
  destination: string,
  options: PlanOptions = {}
): { itineraries: Itinerary[]; empty: EmptyPlanReason | null } {
  const orig = origin.toUpperCase().trim();
  const dest = destination.toUpperCase().trim();
  const maxStopsAsked = Math.min(options.maxStops ?? 2, 3);
  if (orig === dest)
    return { itineraries: [], empty: { kind: "no_route", max_stops: maxStopsAsked } };

  const enforceBudget = options.enforceTimeBudget ?? ENFORCE_ITINERARY_TIME_BUDGET;
  const maxItineraries = options.maxItineraries ?? 10;
  const minLegProb = options.minLegProbability ?? MIN_LEG_PROBABILITY;
  const nowSec = Math.floor(Date.now() / 1000);

  // An airport without coordinates can't be held to the detour bound or the
  // domestic-hub gate, so it is never a hub, and a trip that starts or ends
  // at one is answered with its nonstops alone.
  const unplaced = unplacedTripEnds(orig, dest);
  const maxStops = unplaced.length === 0 ? maxStopsAsked : 0;

  // Detour gate. With every airport of a connection placed, neither the bound
  // nor a path total is ever null where a connection is weighed; the null
  // branches below serve the nonstop of an unplaced trip.
  const directMiles = airportDistanceMiles(orig, dest);
  const bound = directMiles !== null ? detourBoundMiles(directMiles) : null;
  const pathMiles = (flown: number | null, from: string, to: string): number | null => {
    const leg = airportDistanceMiles(from, to);
    return flown === null || leg === null ? null : flown + leg;
  };
  // A*-admissible: flown + straight-line remainder never understates the
  // finished path, so exceeding the bound here can't drop a valid option.
  const exceedsBound = (flown: number | null, at: string): boolean => {
    if (bound === null || flown === null) return false;
    const remaining = airportDistanceMiles(at, dest);
    return remaining !== null && flown + remaining > bound;
  };

  // targetDateUnix is noon UTC of the traveler's date (flightDateWindow.mid),
  // so its UTC date IS the queried date.
  const searchedDate =
    options.targetDateUnix !== undefined
      ? new Date(options.targetDateUnix * 1000).toISOString().slice(0, 10)
      : null;
  const confirmedMemo = new Map<string, Map<string, "express" | "mainline">>();
  const confirmedOn = (date: string) => {
    let m = confirmedMemo.get(date);
    if (!m) {
      m = confirmedEdgesOn(reader, date);
      confirmedMemo.set(date, m);
    }
    return m;
  };
  const graph = buildRouteGraph(reader, minLegProb, confirmedOn, searchedDate);
  // Usual times are clock times; an undated search lays them on today.
  const clockDate = searchedDate ?? new Date().toISOString().slice(0, 10);
  const itineraries: Itinerary[] = [];
  const positioningPrior = loadFleetPriors(reader).mainline;

  const hoursMemo = new Map<string, number | null>();
  const withDuration = (leg: ItineraryLeg): ItineraryLeg => {
    if (leg.duration_hours !== null) return leg;
    const [a, b] = leg.route.split("-");
    const key = `${a}-${b}`;
    if (!hoursMemo.has(key)) hoursMemo.set(key, baselineHours(reader, a, b));
    const h = hoursMemo.get(key) ?? null;
    return h === null ? leg : { ...leg, duration_hours: h, duration_estimated: true };
  };
  const build = (legs: ItineraryLeg[], coverage: "full" | "partial") =>
    computeItinerary(legs.map(withDuration), coverage);
  const baseline = routeBaseline(reader, orig, dest);
  const hasNonstop = baseline !== null && baseline.duration_source !== "great_circle";
  // A sparse history (charter, diversion, seasonal or new route) is a nonstop
  // that may not run: its budget holds while some connection fits it, and
  // yields to the fastest connection instead of emptying the result.
  const firmNonstop =
    baseline !== null &&
    (baseline.duration_source === "schedule" || baseline.duration_source === "route_history");
  // Without a United nonstop every option connects, so the great-circle
  // estimate is unreachable; measure against the fastest connection instead.
  let budgetHours: number | null = hasNonstop ? itineraryHourBudget(baseline.duration_hours) : null;
  const budgetFromFastest = (options: Itinerary[]) => {
    const timed = options.filter((it) => it.total_flight_hours !== null).map(elapsedHours);
    if (timed.length > 0) budgetHours = itineraryHourBudget(Math.min(...timed));
  };
  const withinBudget = (it: Itinerary): boolean =>
    !enforceBudget ||
    it.via.length === 0 ||
    budgetHours === null ||
    it.total_flight_hours === null ||
    fitsHourBudget(it, budgetHours);
  const hubAllowed = (hub: string) => isPlaced(hub) && hubAllowedForTrip(orig, dest, hub);

  const legHours = (leg: ItineraryLeg): number | null => withDuration(leg).duration_hours;

  /**
   * Lay an option on the clock. The first leg leaves at its usual time on the
   * searched day; a later one at its first usual departure at least
   * MIN_CONNECTION_MINUTES after the previous leg lands, and no more than
   * MAX_CONNECTION_HOURS after: past that the trip waits overnight, which
   * nobody booking a connection means. Null when the option can't connect.
   */
  const schedule = (
    option: EdgeOption,
    landed: number | null
  ): { depart: number; arrive: number | null; date: string } | null => {
    const zone = airportTimezone(option.departure);
    if (!zone || option.minutes === null) return null;
    let depart: number;
    if (landed === null) {
      depart = zonedWallTimeSec(clockDate, option.minutes, zone);
    } else {
      const ready = landed + MIN_CONNECTION_MINUTES * 60;
      const day = localDateISO(ready, zone);
      depart = zonedWallTimeSec(day, option.minutes, zone);
      if (depart < ready) depart = zonedWallTimeSec(nextIsoDate(day), option.minutes, zone);
      if (depart - landed > MAX_CONNECTION_HOURS * 3600) return null;
    }
    const date = localDateISO(depart, zone);
    const probe = datedLeg(option, searchedDate ? date : null, confirmedOn, minLegProb);
    const hours = probe ? legHours(probe) : null;
    return { depart, arrive: hours === null ? null : depart + hours * 3600, date };
  };

  const timedLeg = (
    leg: ItineraryLeg,
    option: EdgeOption,
    slot: { depart: number; arrive: number | null; date: string } | null
  ): ItineraryLeg => {
    if (!slot) return leg;
    const [from, to] = leg.route.split("-");
    const toZone = airportTimezone(to);
    const basis: TimeBasis =
      option.days >= USUAL_TIME_DAYS
        ? "usual"
        : option.newest !== null && option.newest > nowSec
          ? "next"
          : "last_seen";
    return {
      ...leg,
      typical_departure: zonedClock(slot.depart, airportTimezone(from)),
      ...(slot.arrive !== null && toZone
        ? { typical_arrival: zonedClock(slot.arrive, toZone) }
        : {}),
      ...(searchedDate ? { date: slot.date } : {}),
      time_basis: basis,
      days_seen: option.days,
      ...(searchedDate && option.days > 0
        ? { runs_on_date: option.weekdays.has(weekdayOf(slot.date)) }
        : {}),
    };
  };

  /**
   * The legs a state can take to `next`. From the origin, every flight number
   * (the trip can start at any hour). After a timed leg, the best odds among
   * flights that connect; failing that, the best untimed flight, marked
   * unchecked; failing that, none: the pair has no same-day connection.
   * After an untimed leg, the best odds as before, unchecked.
   */
  type Step = {
    leg: ItineraryLeg;
    slot: { depart: number; arrive: number | null; date: string } | null;
  };
  const stepsTo = (options: EdgeOption[], state: SearchState): Step[] => {
    const first = state.legs.length === 0;
    if (first || state.landed !== null) {
      const timed: Step[] = [];
      for (const option of options) {
        const slot = schedule(option, state.landed);
        if (!slot) continue;
        const leg = datedLeg(option, searchedDate ? slot.date : null, confirmedOn, minLegProb);
        if (leg) timed.push({ leg: timedLeg(leg, option, slot), slot });
      }
      if (!first && timed.length > 0) {
        // A flight seen on the leg's weekday beats better odds on one that
        // may not run that day.
        timed.sort(
          (a, b) =>
            offWeekday(a.leg) - offWeekday(b.leg) ||
            b.leg.probability - a.leg.probability ||
            a.slot!.depart - b.slot!.depart
        );
        return [timed[0]];
      }
      const untimed = options
        .filter((o) => o.minutes === null || !airportTimezone(o.departure))
        .map((o) => datedLeg(o, searchedDate, confirmedOn, minLegProb))
        .filter((l): l is ItineraryLeg => l !== null);
      if (first) return [...timed, ...untimed.map((leg) => ({ leg, slot: null }))];
      return untimed.length > 0 ? [{ leg: untimed[0], slot: null }] : [];
    }
    for (const option of options) {
      const leg = datedLeg(option, searchedDate, confirmedOn, minLegProb);
      if (leg) return [{ leg, slot: null }];
    }
    return [];
  };

  // --- BFS up to maxStops+1 legs ---
  type SearchState = {
    airport: string;
    legs: ItineraryLeg[];
    joint: number;
    flown: number | null;
    /** Usual landing of the last leg (unix); null when unknown or before the first leg. */
    landed: number | null;
    departed: number | null;
    waits: Array<number | null>;
    /** Every leg so far has a usual time and connects. */
    timed: boolean;
  };
  let frontier: SearchState[] = [
    {
      airport: orig,
      legs: [],
      joint: 1,
      flown: 0,
      landed: null,
      departed: null,
      waits: [],
      timed: true,
    },
  ];
  // Every timing of a path (one per first-leg flight), until the budget is
  // known: the best odds can sit on a timing whose layover runs over it.
  const variantsByPath = new Map<string, Itinerary[]>();
  // Hubs a timed leg reached whose flights on to the destination all leave
  // too early or too late: the reason when no connection is left.
  const missedHubs = new Set<string>();
  // A connection that is known to work beats better odds on one that may not;
  // a nonstop has nothing to connect, so its best odds win.
  const better = (a: Itinerary, b: Itinerary): boolean => {
    if (a.via.length > 0 && a.schedule !== b.schedule) return a.schedule === "same_day";
    const offA = a.legs.reduce((n, l) => n + offWeekday(l), 0);
    const offB = b.legs.reduce((n, l) => n + offWeekday(l), 0);
    if (offA !== offB) return offA < offB;
    if (Math.abs(a.joint_probability - b.joint_probability) > 1e-9) {
      return a.joint_probability > b.joint_probability;
    }
    return (
      (a.elapsed_hours ?? Number.POSITIVE_INFINITY) < (b.elapsed_hours ?? Number.POSITIVE_INFINITY)
    );
  };

  for (let depth = 0; depth <= maxStops; depth++) {
    const nextFrontier: SearchState[] = [];
    for (const state of frontier) {
      const edges = graph.get(state.airport);
      if (!edges) continue;

      for (const [nextAirport, options] of edges.entries()) {
        if (nextAirport === orig) continue;
        if (state.legs.some((l) => l.route.split("-")[1] === nextAirport)) continue;
        if (nextAirport !== dest && !hubAllowed(nextAirport)) continue;

        const flown = pathMiles(state.flown, state.airport, nextAirport);
        if (exceedsBound(flown, nextAirport)) continue;

        const steps = stepsTo(options, state);
        if (steps.length === 0 && nextAirport === dest && state.landed !== null) {
          missedHubs.add(state.airport);
        }
        for (const { leg, slot } of steps) {
          const first = state.legs.length === 0;
          const next: SearchState = {
            airport: nextAirport,
            legs: [...state.legs, leg],
            joint: state.joint * leg.probability,
            flown,
            landed: slot?.arrive ?? null,
            departed: first ? (slot?.depart ?? null) : state.departed,
            waits: first
              ? []
              : [
                  ...state.waits,
                  slot && state.landed !== null
                    ? Math.round((slot.depart - state.landed) / 60)
                    : null,
                ],
            timed: state.timed && slot !== null && slot.arrive !== null,
          };

          if (nextAirport === dest) {
            const pathKey = next.legs.map((l) => l.route).join("|");
            const it: Itinerary = {
              ...build(next.legs, "full"),
              schedule: next.timed ? "same_day" : "unknown",
              connection_minutes: next.waits,
              elapsed_hours:
                next.timed && next.departed !== null && next.landed !== null
                  ? (next.landed - next.departed) / 3600
                  : null,
            };
            const held = variantsByPath.get(pathKey);
            if (held) held.push(it);
            else variantsByPath.set(pathKey, [it]);
          } else if (depth < maxStops) {
            nextFrontier.push(next);
          }
        }
      }
    }
    nextFrontier.sort((a, b) => b.joint - a.joint);
    frontier = nextFrontier.slice(0, FRONTIER_LIMIT);
  }
  const connections = [...variantsByPath.values()].flat().filter((it) => it.via.length > 0);
  if (!hasNonstop || (!firmNonstop && !connections.some(withinBudget))) {
    budgetFromFastest(connections);
  }
  const fulls = [...variantsByPath.values()].map((variants) => {
    const fitting = variants.filter(withinBudget);
    const pool = fitting.length > 0 ? fitting : variants;
    return pool.reduce((best, it) => (better(it, best) ? it : best));
  });
  itineraries.push(...fulls.filter(withinBudget));

  // --- Partial-coverage baselines (both directions) ---
  // Only when maxStops > 0 (respect user's "direct only" intent) and when
  // we don't already have a strong direct (≥70% joint) — extra options
  // are noise when a 92% direct exists.
  const directIt = fulls.find((it) => it.via.length === 0);
  let overBudget = connections.some((it) => !withinBudget(it));
  const showPartials = maxStops > 0 && (!directIt || directIt.joint_probability < 0.7);

  if (showPartials) {
    const partialLimit = itineraries.length === 0 ? maxItineraries : 3;
    type PartialCandidate = { starlinkLeg: ItineraryLeg; hub: string; direction: "in" | "out" };
    const candidates: PartialCandidate[] = [];

    // A partial synthesizes orig->hub->dest, so the hub must be on the way AND
    // its "(any)" positioning leg must be a route the carrier actually flies
    // (null = no census for this scope = can't validate = never rejects).
    const hubOnPath = (hub: string) => !exceedsBound(pathMiles(0, orig, hub), hub);
    const served = reader.getServedRoutePairs();
    const isServed = (a: string, b: string) => served === null || served.has(`${a}-${b}`);

    // Direction "in": (any) orig→hub, then Starlink hub→dest
    // A positioning leg is "any flight", so its connection can't be checked;
    // the Starlink leg is its pair's best odds on the searched day, as before.
    const bestOn = (options: EdgeOption[] | undefined): ItineraryLeg | null => {
      for (const option of options ?? []) {
        const leg = datedLeg(option, searchedDate, confirmedOn, minLegProb);
        if (leg) return timedLeg(leg, option, schedule(option, null));
      }
      return null;
    };
    for (const [hub, edges] of graph.entries()) {
      const leg = bestOn(edges.get(dest));
      // hub === dest as well as hub === orig: without the former the planner
      // emitted a MIA-MIA self-loop leg ("fly ORD->MIA, then fly MIA->MIA").
      if (!leg || leg.probability < minLegProb || hub === orig || hub === dest) continue;
      if (!hubOnPath(hub) || !isServed(orig, hub) || !hubAllowed(hub)) continue;
      if (fulls.some((it) => it.via.length === 1 && it.via[0] === hub)) continue;
      candidates.push({ starlinkLeg: leg, hub, direction: "in" });
    }
    // Direction "out": Starlink orig→hub, then (any) hub→dest
    const outEdges = graph.get(orig);
    if (outEdges) {
      for (const [hub, options] of outEdges.entries()) {
        const leg = bestOn(options);
        if (hub === dest || !leg || leg.probability < minLegProb) continue;
        if (!hubOnPath(hub) || !isServed(hub, dest) || !hubAllowed(hub)) continue;
        if (fulls.some((it) => it.via.length === 1 && it.via[0] === hub)) continue;
        candidates.push({ starlinkLeg: leg, hub, direction: "out" });
      }
    }

    // Prefer longer Starlink legs (more hours) at similar probability
    candidates.sort((a, b) => {
      const aH = (a.starlinkLeg.duration_hours ?? 0) * a.starlinkLeg.probability;
      const bH = (b.starlinkLeg.duration_hours ?? 0) * b.starlinkLeg.probability;
      return bH - aH;
    });

    const partials = candidates.map(
      (c): Itinerary => ({
        ...build(
          c.direction === "in"
            ? [makePositioningLeg(`${orig}-${c.hub}`, positioningPrior), c.starlinkLeg]
            : [c.starlinkLeg, makePositioningLeg(`${c.hub}-${dest}`, positioningPrior)],
          "partial"
        ),
        schedule: "unknown",
        connection_minutes: [null],
        elapsed_hours: null,
      })
    );
    const partialsEmptied = itineraries.length === 0 && !partials.some(withinBudget);
    if (!firmNonstop && (budgetHours === null || partialsEmptied)) budgetFromFastest(partials);
    itineraries.push(...partials.filter(withinBudget).slice(0, partialLimit));
    if (partials.some((it) => !withinBudget(it))) overBudget = true;
  }

  // A 2-stop has to buy real Starlink time over the simpler options (the
  // nonstop baseline included, when one has been seen), not just a marginally better ratio.
  const simplerBest = Math.max(
    hasNonstop ? baseline.expected_starlink_hours : 0,
    ...itineraries.filter((it) => it.via.length <= 1).map((it) => it.expected_starlink_hours ?? 0)
  );
  const worthTheStops = (it: Itinerary) =>
    it.via.length < 2 ||
    (it.expected_starlink_hours ?? 0) >= simplerBest + MULTI_STOP_MIN_GAIN_HOURS;
  const kept = enforceBudget ? itineraries.filter(worthTheStops) : itineraries;

  // --- Ranking ---
  // Primary: COVERAGE RATIO (eSL / totalH) minus a per-stop penalty. The ratio
  // treats a 1h 92% direct and a 10h 90% multi-stop as equal quality; the
  // penalty keeps a 96% 2-stop from outranking a 94% 1-stop that is hours shorter.
  // Tiebreaks: fewer legs, then more expected Starlink hours.
  const score = (it: Itinerary) =>
    it.coverage_ratio === null ? null : it.coverage_ratio - STOP_PENALTY * it.via.length;
  kept.sort((a, b) => {
    if (a.coverage !== b.coverage) return a.coverage === "full" ? -1 : 1;

    const aR = score(a);
    const bR = score(b);
    if (aR !== null && bR !== null) {
      if (Math.abs(bR - aR) > 0.02) return bR - aR;
    } else if (aR !== null) return -1;
    else if (bR !== null) return 1;

    if (a.legs.length !== b.legs.length) return a.legs.length - b.legs.length;

    const aE = a.expected_starlink_hours ?? 0;
    const bE = b.expected_starlink_hours ?? 0;
    return bE - aE;
  });

  // Guarantee: direct flight (if in graph) is always in results, regardless of
  // ratio rank. It's what users expect as the "baseline" option.
  const fullSorted = kept.filter((it) => it.coverage === "full");
  const partialSorted = kept.filter((it) => it.coverage === "partial");
  const direct = fullSorted.find((it) => it.via.length === 0);
  const nonDirect = fullSorted.filter((it) => it.via.length > 0);

  const fullKept = direct
    ? [direct, ...nonDirect.slice(0, maxItineraries - 1)]
    : nonDirect.slice(0, maxItineraries);

  const result = [...fullKept, ...partialSorted.slice(0, 3)];
  if (result.length > 0) return { itineraries: result, empty: null };
  const empty: EmptyPlanReason =
    unplaced.length > 0 && maxStopsAsked > 0
      ? { kind: "unplaced_airport", airports: unplaced }
      : overBudget && budgetHours !== null
        ? {
            kind: "over_budget",
            budget_hours: budgetHours,
            nonstop_hours: hasNonstop ? baseline.duration_hours : null,
          }
        : missedHubs.size > 0
          ? { kind: "no_same_day", hubs: [...missedHubs].sort() }
          : { kind: "no_route", max_stops: maxStops };
  return { itineraries: [], empty };
}

/** The page's and the MCP tool's sentence for an empty plan. */
export function emptyPlanMessage(why: EmptyPlanReason, destination: string): string {
  const hours = (h: number) => `${h.toFixed(1)} hours`;
  switch (why.kind) {
    case "over_budget":
      return why.nonstop_hours !== null
        ? `Every connection with Starlink odds takes far longer than the ${hours(why.nonstop_hours)} nonstop (over ${hours(why.budget_hours)} of flying and stops, or a long wait), so none is listed. The nonstop is the quicker trip.`
        : `Every connection with Starlink odds runs over ${hours(why.budget_hours)} of flying and stops, or waits long between flights, so none is listed.`;
    case "no_same_day":
      return `Flights with Starlink odds reach ${why.hubs.join(", ")}, but none flies on to ${destination} between 1 and ${MAX_CONNECTION_HOURS} hours after landing, so there is no same-day connection.`;
    case "no_route": {
      const odds = `Starlink odds of ${Math.round(MIN_LEG_PROBABILITY * 100)}% or more`;
      return why.max_stops === 0
        ? `No nonstop with ${odds} flies between these airports.`
        : `No flights with ${odds} connect these airports within ${why.max_stops} stop${why.max_stops === 1 ? "" : "s"}.`;
    }
    case "unplaced_airport": {
      const odds = `Starlink odds of ${Math.round(MIN_LEG_PROBABILITY * 100)}% or more`;
      return `${why.airports.join(" and ")} ${why.airports.length === 1 ? "is" : "are"} not in our airport tables yet, so a connection can't be checked for how far out of the way it goes and none is listed. No nonstop with ${odds} flies between these airports.`;
    }
  }
}

/** 1 when a leg was logged, but never on the weekday it would fly. */
const offWeekday = (leg: ItineraryLeg): number => (leg.runs_on_date === false ? 1 : 0);

/**
 * Time budget for connections relative to the nonstop. Ratio-only ranking
 * recommended SFO→EWR as 9–10h 2-stops (via Halifax, Nantucket) against a
 * 5.7h nonstop, and IAH→CLE at 2x the trip time. Flip to false to restore
 * pure coverage-ratio ranking with no time/stop gates.
 */
export const ENFORCE_ITINERARY_TIME_BUDGET = true;
const BUDGET_FACTOR = 1.5;
const BUDGET_SLACK_HOURS = 2.5;
// Minimum connection time per stop when the legs' times are unknown;
// total_flight_hours is airborne time only.
const LAYOVER_HOURS = 1.0;
// How far past the budget a timed connection's real waits may take it, a stop.
const WAIT_SLACK_HOURS = 2;
// A connection must leave this long after the previous leg usually lands.
// Times are usual ones, not today's schedule, so this is United's domestic
// minimum (~45 min at its hubs) with room for a late first leg.
const MIN_CONNECTION_MINUTES = 60;
// Longer than this on the ground is an overnight stay, not a connection.
const MAX_CONNECTION_HOURS = 6;
// Search states kept per depth; the first leg now branches on every flight
// number, so the cap is wider than the one state per pair it once held.
const FRONTIER_LIMIT = 600;
const MULTI_STOP_MIN_GAIN_HOURS = 1.0;
const STOP_PENALTY = 0.04;
// Block-time estimate when no flight has been observed on a pair: cruise at
// ~480 mph plus taxi/climb overhead.
const CRUISE_MPH = 480;
const BLOCK_OVERHEAD_HOURS = 0.5;
// flight_routes also records charters, diversions and ferry hops (UA3302
// BGR-IND, UA3898 LGA-MCO: 2 sightings each), but real seasonal, long-haul
// and new nonstops look just as thin (UA2624 EWR-SMF: 7 over 15 days, UA506
// FCO-SFO: 8). Below this a pair is "sparse_history": still a nonstop, but
// one whose budget may yield to the fastest connection.
const MIN_NONSTOP_SIGHTINGS = 10;

/** Max elapsed hours (flying + layovers) an itinerary may take, given the nonstop's duration. */
export function itineraryHourBudget(baselineHours: number): number {
  return Math.max(BUDGET_FACTOR * baselineHours, baselineHours + BUDGET_SLACK_HOURS);
}

/** Door to door at the legs' usual times; else flying time plus a minimum connection per stop. */
export function elapsedHours(it: Itinerary): number {
  if (typeof it.elapsed_hours === "number") return it.elapsed_hours;
  return flyingWithStops(it);
}

const flyingWithStops = (it: Itinerary) =>
  (it.total_flight_hours ?? 0) + LAYOVER_HOURS * it.via.length;

/**
 * One yardstick for every connection: flying time plus LAYOVER_HOURS a stop
 * within the budget, timed or not. Counting a timed connection's real wait
 * against a budget that an untimed one meets with a flat hour dropped good
 * flyable trips for unchecked ones (MSY-SFO via IAH at 64%, 2h 46m to
 * connect, for a 35% DEN one). The real wait is capped apart: door to door
 * may run WAIT_SLACK_HOURS a stop past the budget, no more.
 */
export function fitsHourBudget(it: Itinerary, budgetHours: number): boolean {
  if (flyingWithStops(it) > budgetHours + 1e-9) return false;
  if (typeof it.elapsed_hours !== "number") return true;
  return it.elapsed_hours <= budgetHours + WAIT_SLACK_HOURS * it.via.length + 1e-9;
}

/**
 * Nonstop block time between two airports: an observed direct flight, else
 * the flight_routes history for the pair, else great-circle / cruise speed.
 * Null only when neither the data nor the coordinate table knows the pair.
 */
export function baselineHours(
  reader: ScopedReader,
  origin: string,
  destination: string
): number | null {
  return routeHours(reader, origin, destination)?.hours ?? null;
}

type DurationSource = "schedule" | "route_history" | "sparse_history" | "great_circle";

function routeHours(
  reader: ScopedReader,
  origin: string,
  destination: string
): { hours: number; source: DurationSource } | null {
  const edge = reader.getDirectRouteEdge(origin, destination);
  if (edge && edge.dur_sec > 0) return { hours: edge.dur_sec / 3600, source: "schedule" };
  // getRouteFlightNumbers is single-airline only; the hub reader throws on it.
  if (reader.scope !== "ALL") {
    const { flightNumbers, durationSec } = reader.getRouteFlightNumbers(origin, destination);
    const sightings = flightNumbers.reduce((n, f) => n + f.times, 0);
    const source = sightings >= MIN_NONSTOP_SIGHTINGS ? "route_history" : "sparse_history";
    if (durationSec && durationSec > 0) return { hours: durationSec / 3600, source };
    const estimate = greatCircleHours(origin, destination);
    if (flightNumbers.length > 0 && estimate !== null) {
      return { hours: estimate, source: "sparse_history" };
    }
  }
  const estimate = greatCircleHours(origin, destination);
  return estimate === null ? null : { hours: estimate, source: "great_circle" };
}

function greatCircleHours(origin: string, destination: string): number | null {
  const miles = airportDistanceMiles(origin, destination);
  return miles === null ? null : miles / CRUISE_MPH + BLOCK_OVERHEAD_HOURS;
}

export interface RouteBaseline {
  route: string;
  /** Observed nonstop flight number, when one exists in the schedule snapshot. */
  flight_number: string | null;
  probability: number;
  duration_hours: number;
  /**
   * "great_circle" = no United nonstop has ever been observed on the pair; the
   * duration is a distance estimate. "sparse_history" = a nonstop has been
   * seen only occasionally and may not operate on a given date.
   */
  duration_source: DurationSource;
  expected_starlink_hours: number;
}

/** The nonstop a connection has to beat. Null when the pair has no known duration. */
export function routeBaseline(
  reader: ScopedReader,
  origin: string,
  destination: string
): RouteBaseline | null {
  const o = origin.toUpperCase().trim();
  const d = destination.toUpperCase().trim();
  const duration = routeHours(reader, o, d);
  if (duration === null) return null;
  const edge = reader.getDirectRouteEdge(o, d);
  const flightNumber = edge ? uaPrefix(edge.flight_number) : null;
  const probability = flightNumber
    ? predictLegOrFlight(reader, flightNumber, o, d).probability
    : mainlineFleetRate(reader);
  return {
    route: `${o}-${d}`,
    flight_number: flightNumber,
    probability,
    duration_hours: duration.hours,
    duration_source: duration.source,
    expected_starlink_hours: probability * duration.hours,
  };
}

// Unobserved nonstops are almost always mainline; the live mainline install
// rate, not the 0.02 fallback constant (7.8x low against ~0.157). The hub has
// no subfleet split, so it gets the cross-airline aggregate from the priors.
function mainlineFleetRate(reader: ScopedReader): number {
  return loadFleetPriors(reader).mainline;
}

// ============================================================================
// Per-leg prediction
// ============================================================================

/** An ADS-B sighting this close to a leg's scheduled departure (time of day) is that leg. */
const ADSB_LEG_MATCH_SEC = 2 * 3600;
const LEG_DUPLICATE_SEC = 12 * 3600;
/** A landed sighting shorter than this share of a leg's block time flew another leg. */
const ADSB_MIN_AIRBORNE_SHARE = 0.6;
/** Unseen this long, a sighting has landed and its airborne time is final. */
const ADSB_LANDED_SEC = 30 * 60;

export interface LegPrediction extends Prediction {
  /** "leg_history" when the leg's own draws carry the number, else the share of its types. */
  basis: "leg_history" | "leg_type_share";
  /** Aircraft it drew on this leg, most frequent first (display names). */
  aircraft: string[];
  /** Effective sample size of the recency-weighted draws. */
  n_effective: number;
  /** The last two weeks running well above or below the window. */
  trend: LegTrend;
}

interface LegFleet {
  tails: Map<string, { family: string; type: string; equipped: boolean }>;
  familyShare: Map<string, number>;
}

/** Roster tails with their family and equipped status (the one equipped
 * definition), and each family's equipped share. Rebuilt at most hourly. */
interface LegIndex {
  legs: Map<string, RouteFlightLeg[]>;
  adsb: Map<string, AdsbFlightDraw[]>;
  /** Answers already priced from this build, so every surface reads one number. */
  answers: Map<string, LegPrediction | null>;
  draws: Map<string, LegDraw[] | null>;
}

/** Every logged leg and ADS-B draw, by flight number, so the planner can price
 * thousands of edges without a query each. Rebuilt at most every 15 minutes;
 * the board, scoped check-flight and the planner all read the same build. */
const legIndexMemo = perOwner<ScopedReader, ReturnType<typeof memo<LegIndex>>>(() =>
  memo<LegIndex>({ ttlSec: 900, maxEntries: 1 })
);

function legIndex(reader: ScopedReader): LegIndex {
  return legIndexMemo(reader)("index", () => {
    const legs = new Map<string, RouteFlightLeg[]>();
    for (const l of reader.getAllFlightLegs()) {
      const list = legs.get(l.flight_number);
      if (list) list.push(l);
      else legs.set(l.flight_number, [l]);
    }
    const adsb = new Map<string, AdsbFlightDraw[]>();
    if (adsbDrawsEnabled()) {
      const since = Math.floor(Date.now() / 1000) - ADSB_DRAW_WINDOW_DAYS * 86400;
      for (const d of reader.getAdsbFlightDraws(since)) {
        const list = adsb.get(d.flight_number);
        if (list) list.push(d);
        else adsb.set(d.flight_number, [d]);
      }
    }
    return { legs, adsb, answers: new Map(), draws: new Map() };
  });
}

const legFleetMemo = perOwner<ScopedReader, ReturnType<typeof memo<LegFleet>>>(() =>
  memo<LegFleet>({ ttlSec: 3600, maxEntries: 1 })
);

function legFleet(reader: ScopedReader): LegFleet {
  return legFleetMemo(reader)("fleet", () => {
    const equipped = new Set(reader.getStarlinkPlanes().map((p) => p.TailNumber));
    const tails = new Map<string, { family: string; type: string; equipped: boolean }>();
    const agg = new Map<string, { s: number; n: number }>();
    for (const r of reader.getFleetRoster()) {
      const family = normalizeAircraftType(r.aircraft_type);
      const on = equipped.has(r.tail_number);
      tails.set(r.tail_number, { family, type: r.aircraft_type, equipped: on });
      const a = agg.get(family) ?? { s: 0, n: 0 };
      a.s += on ? 1 : 0;
      a.n += 1;
      agg.set(family, a);
    }
    const familyShare = new Map([...agg].map(([f, a]) => [f, a.s / a.n] as const));
    return { tails, familyShare };
  });
}

const secOfDay = (t: number) => ((t % 86400) + 86400) % 86400;
const clockDistance = (a: number, b: number) => {
  const d = Math.abs(a - b);
  return Math.min(d, 86400 - d);
};

/**
 * Starlink odds for one leg of a flight number. The number's history mixes
 * its legs (UA1922 flies a 757 SFO-ORD and an A321neo ORD-IAD), so this keeps
 * only draws on the asked pair: logged departures there, plus ADS-B sightings
 * whose time of day matches that leg's schedule and no other leg's. With
 * enough draws the leg's own rate, weighted toward recent ones and smoothed
 * toward its types' share (leg-estimate.ts); with fewer, the share itself.
 * Null when the leg was never logged.
 */
export function predictLeg(
  reader: ScopedReader,
  flightNumber: string,
  origin: string,
  destination: string,
  nowSec = Math.floor(Date.now() / 1000)
): LegPrediction | null {
  if (reader.scope === "ALL") return null;
  const index = legIndex(reader);
  const key = `${flightNumber}|${origin}|${destination}`;
  const cached = index.answers.get(key);
  if (cached !== undefined) return cached;
  const answer = computeLeg(reader, flightNumber, origin, destination, nowSec);
  index.answers.set(key, answer);
  return answer;
}

type PairOf = { departure_airport: string; arrival_airport: string };
const pairOf = (l: PairOf) => `${l.departure_airport}-${l.arrival_airport}`;

/** An ADS-B departure matched to one leg. `exact`: final, the only leg its
 * clock and airborne time fit, so it may stand in for that departure's log row. */
type LegSighting = LegDraw & { exact: boolean };

interface LegSchedule {
  /** Each pair's scheduled time of day: its newest logged departure. */
  clock: Map<string, number>;
  /** Each pair's median logged block time, when the log has arrivals. */
  block: Map<string, number>;
  /** One logged departure per pair and local day, the tail seen last. */
  perDay: RouteFlightLeg[];
}

function legSchedule(legs: readonly RouteFlightLeg[]): LegSchedule {
  const latest = new Map<string, RouteFlightLeg>();
  for (const l of legs) {
    const k = `${pairOf(l)}|${l.dep_date}`;
    const prev = latest.get(k);
    if (!prev || l.last_seen > prev.last_seen) latest.set(k, l);
  }
  const perDay = [...latest.values()].sort((a, b) => a.departure_time - b.departure_time);
  const clock = new Map<string, number>();
  const blocks = new Map<string, number[]>();
  for (const l of perDay) {
    clock.set(pairOf(l), secOfDay(l.departure_time));
    if (l.arrival_time !== null && l.arrival_time > l.departure_time) {
      const list = blocks.get(pairOf(l)) ?? [];
      list.push(l.arrival_time - l.departure_time);
      blocks.set(pairOf(l), list);
    }
  }
  const block = new Map(
    [...blocks].map(([k, v]) => [k, v.sort((a, b) => a - b)[Math.floor(v.length / 2)]] as const)
  );
  return { clock, block, perDay };
}

/**
 * ADS-B departures of the number that fit this leg, oldest first, one per
 * departure. A sighting fits a pair when it left within ADSB_LEG_MATCH_SEC of
 * that pair's clock and, once it has landed, stayed airborne long enough for
 * it: UA2278's 55-minute SAN-SFO hop at SFO-ORD's hour is not SFO-ORD.
 */
function legSightings(
  index: LegIndex,
  fleet: LegFleet,
  schedule: LegSchedule,
  flightNumber: string,
  target: string,
  nowSec: number
): LegSighting[] {
  const since = nowSec - ADSB_DRAW_WINDOW_DAYS * 86400;
  const raw = (index.adsb.get(flightNumber) ?? [])
    .filter((d) => d.first_seen >= since && d.first_seen <= nowSec)
    .sort((a, b) => a.first_seen - b.first_seen || a.tail_number.localeCompare(b.tail_number));
  const out: LegSighting[] = [];
  for (const d of raw) {
    const tail = fleet.tails.get(d.tail_number);
    if (!tail) continue;
    const landed = nowSec - d.last_seen >= ADSB_LANDED_SEC;
    const airborne = d.last_seen - d.first_seen;
    const fits = [...schedule.clock].filter(([pair, sod]) => {
      if (clockDistance(secOfDay(d.first_seen), sod) > ADSB_LEG_MATCH_SEC) return false;
      const block = schedule.block.get(pair);
      return !landed || block === undefined || airborne >= ADSB_MIN_AIRBORNE_SHARE * block;
    });
    if (fits.length === 0) continue;
    const [pair] = fits.reduce((a, b) =>
      clockDistance(secOfDay(d.first_seen), b[1]) < clockDistance(secOfDay(d.first_seen), a[1])
        ? b
        : a
    );
    if (pair !== target) continue;
    if (out.some((x) => Math.abs(x.t - d.first_seen) < LEG_DUPLICATE_SEC)) continue;
    out.push({
      t: d.first_seen,
      tail: d.tail_number,
      ...tail,
      source: "adsb",
      exact: landed && fits.length === 1 && schedule.block.has(pair),
    });
  }
  return out;
}

/**
 * One leg's draws: its logged departures and the ADS-B departures that fit it
 * (legSightings). Null when the leg was never logged as departed.
 */
function computeLegDraws(
  index: LegIndex,
  fleet: LegFleet,
  flightNumber: string,
  origin: string,
  destination: string,
  nowSec: number
): LegDraw[] | null {
  return (
    legDrawsAndSightings(index, fleet, flightNumber, origin, destination, nowSec)?.draws ?? null
  );
}

function legDrawsAndSightings(
  index: LegIndex,
  fleet: LegFleet,
  flightNumber: string,
  origin: string,
  destination: string,
  nowSec: number
): { draws: LegDraw[]; sightings: LegSighting[] } | null {
  const target = `${origin}-${destination}`;
  const schedule = legSchedule(index.legs.get(flightNumber) ?? []);
  // Departed legs only: a coming assignment is the answer, not history.
  const onLeg = schedule.perDay.filter((l) => pairOf(l) === target && l.departure_time <= nowSec);
  if (onLeg.length === 0) return null;

  const draws: LegDraw[] = onLeg.map((l) => {
    const known = fleet.tails.get(l.tail_number);
    return {
      t: l.departure_time,
      tail: l.tail_number,
      equipped: l.equipped,
      family: known?.family ?? normalizeAircraftType(l.aircraft_type),
      type: known?.type ?? l.aircraft_type ?? "",
      source: "log",
    };
  });

  const sightings = legSightings(index, fleet, schedule, flightNumber, target, nowSec);
  for (const s of sightings) {
    const near = draws.findIndex((x) => Math.abs(x.t - s.t) < LEG_DUPLICATE_SEC);
    const { exact, ...seen } = s;
    if (near === -1) draws.push(seen);
    // The plane seen flying beats the one logged for that same departure (the
    // log can keep a pre-swap tail), but only on an unambiguous match.
    else if (
      exact &&
      draws[near].source === "log" &&
      draws[near].tail !== s.tail &&
      Math.abs(draws[near].t - s.t) <= ADSB_LEG_MATCH_SEC
    ) {
      draws[near] = seen;
    }
  }
  return { draws: draws.sort((a, b) => a.t - b.t), sightings };
}

/**
 * The draws predictLeg priced this leg from, oldest first, from the same
 * build; null when the leg was never logged. The board's history reads these
 * so the chart and the number can't disagree.
 */
export function predictLegDraws(
  reader: ScopedReader,
  flightNumber: string,
  origin: string,
  destination: string,
  nowSec = Math.floor(Date.now() / 1000)
): LegDraw[] | null {
  if (reader.scope === "ALL") return null;
  const index = legIndex(reader);
  const key = `${flightNumber}|${origin}|${destination}`;
  const cached = index.draws.get(key);
  if (cached !== undefined) return cached;
  const draws = computeLegDraws(index, legFleet(reader), flightNumber, origin, destination, nowSec);
  index.draws.set(key, draws);
  return draws;
}

function computeLeg(
  reader: ScopedReader,
  flightNumber: string,
  origin: string,
  destination: string,
  nowSec: number
): LegPrediction | null {
  const fleet = legFleet(reader);
  // Not through predictLegDraws: the planner prices thousands of legs, and
  // only the board needs their draws kept.
  const draws = computeLegDraws(legIndex(reader), fleet, flightNumber, origin, destination, nowSec);
  if (!draws) return null;
  const est = legEstimate(draws, (f) => fleet.familyShare.get(f), nowSec);
  if (est.probability === null) return null;

  const since = nowSec - LEG_WEIGHTING.windowDays * 86400;
  const byType = new Map<string, number>();
  for (const d of draws) {
    if (!d.type || d.t < since) continue;
    const name = aircraftName(d.type);
    byType.set(name, (byType.get(name) ?? 0) + drawWeight(nowSec - d.t, LEG_WEIGHTING));
  }
  const recentSince = nowSec - RECENT_OBSERVATION_DAYS * 86400;
  return {
    flight_number: flightNumber,
    probability: est.probability,
    confidence: est.enough ? confidenceFor(est.effective) : "low",
    method: "flight_history_smoothed",
    n_observations: est.count,
    n_recent_observations: draws.filter((d) => d.t >= recentSince).length,
    basis: est.enough ? "leg_history" : "leg_type_share",
    n_effective: est.effective,
    trend: est.enough ? legTrend(draws, nowSec) : null,
    aircraft: [...byType]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([name]) => name),
  };
}

/**
 * One leg's odds wherever a leg is known: predictLeg, else the flight
 * number's own history. Scoped check-flight, the planner's edges and baseline,
 * and predict_route all price a leg through here, so they agree.
 */
export function predictLegOrFlight(
  reader: ScopedReader,
  flightNumber: string,
  origin: string,
  destination: string,
  nowSec?: number
): Prediction {
  const leg = predictLeg(reader, flightNumber, origin, destination, nowSec);
  return leg ? legAsPrediction(leg) : predictFlight(reader, flightNumber);
}

/** A leg answer in the per-number Prediction shape every surface publishes. */
export function legAsPrediction(leg: LegPrediction): Prediction {
  const {
    basis: _basis,
    aircraft: _aircraft,
    n_effective: _effective,
    trend: _trend,
    ...pred
  } = leg;
  return pred;
}

export type { Prediction };

// ============================================================================
// Per-leg weighting backtest
// ============================================================================

type LegArm = { name: string; predict: (train: LegDraw[], at: number) => number | null };

/**
 * Scores per-leg weightings on held-out departures: every ADS-B departure
 * matched to a leg in the test window (one per departure, whether or not it
 * also became a draw; the log over-samples Starlink tails), each priced from
 * the leg's draws that departed before its local day began. Legs are matched
 * once on the full build, so the matching knows the current schedule; labels
 * never leak. "Trend legs" are the ones legTrend flags as of the window start.
 * The interval is a by-leg bootstrap of the Brier gap, chosen minus previous.
 */
function legBacktest(dbPath: string, testDays: number, until: number | null): void {
  const db = new Database(dbPath, { readonly: true });
  const reader = createReaderFactory(db)("UA");
  const index = legIndex(reader);
  const fleet = legFleet(reader);
  const share = (f: string) => fleet.familyShare.get(f);
  let anchor = 0;
  for (const list of index.adsb.values())
    for (const d of list) anchor = Math.max(anchor, d.first_seen);
  const testTo = until ?? anchor + 1;
  const testFrom = testTo - testDays * 86400;

  const weighted = (halfLifeDays: number | null, windowDays: number, priorStrength: number) => ({
    halfLifeDays,
    windowDays,
    priorStrength,
  });
  const est = (w: LegWeighting) => (train: LegDraw[], at: number) =>
    legEstimate(train, share, at, w).probability;
  const arms: LegArm[] = [
    { name: "equal-weight 60d, α=3", predict: est(weighted(null, 60, 3)) },
    { name: "half-life 30d, α=3 (before #155)", predict: est(weighted(30, 90, 3)) },
    { name: "half-life 7d, α=3 (#155)", predict: est(weighted(7, 90, 3)) },
    { name: "half-life 30d, α=8", predict: est(weighted(30, 90, 8)) },
    ...[7, 10, 14, 21].map((h) => ({
      name: `half-life ${h}d, α=8`,
      predict: est(weighted(h, 90, 8)),
    })),
    {
      name: "last 14d, else 60d, α=8",
      predict: (train, at) => {
        const recent = train.filter((d) => d.t >= at - 14 * 86400);
        return recent.length >= LEG_MIN_DRAWS
          ? legEstimate(recent, share, at, weighted(null, 14, 8)).probability
          : legEstimate(train, share, at, weighted(null, 60, 8)).probability;
      },
    },
  ];
  const chosen = arms.findIndex(
    (a) => a.name === `half-life ${LEG_WEIGHTING.halfLifeDays}d, α=${LEG_WEIGHTING.priorStrength}`
  );
  const previous = 1;

  type Rec = { leg: string; y: number; p: number[]; trend: boolean };
  const recs: Rec[] = [];
  let legs = 0;
  for (const [fn, list] of index.legs) {
    const pairs = new Set(list.map((l) => `${l.departure_airport}|${l.arrival_airport}`));
    for (const pair of pairs) {
      const [o, d] = pair.split("|");
      const built = legDrawsAndSightings(index, fleet, fn, o, d, anchor);
      if (!built) continue;
      const targets = built.sightings.filter((x) => x.t >= testFrom && x.t < testTo);
      if (targets.length === 0) continue;
      legs++;
      const trend =
        legTrend(
          built.draws.filter((x) => x.t < testFrom),
          testFrom
        ) !== null;
      for (const target of targets) {
        const dayStart = target.t - secOfDay(target.t);
        const train = built.draws.filter((x) => x.t < dayStart);
        const p = arms.map((arm) => arm.predict(train, target.t));
        if (p.some((x) => x === null)) continue;
        recs.push({ leg: `${fn}|${pair}`, y: target.equipped ? 1 : 0, p: p as number[], trend });
      }
    }
  }
  db.close();

  const score = (rs: readonly Rec[], i: number) => {
    let brier = 0;
    let logLoss = 0;
    for (const r of rs) {
      const q = Math.min(1 - 1e-4, Math.max(1e-4, r.p[i]));
      brier += (r.p[i] - r.y) ** 2;
      logLoss -= r.y * Math.log(q) + (1 - r.y) * Math.log(1 - q);
    }
    return { brier: brier / rs.length, logLoss: logLoss / rs.length };
  };
  const trendRecs = recs.filter((r) => r.trend);
  console.log(
    `Per-leg backtest: ${legs} legs, ${recs.length} ADS-B departures ${new Date(testFrom * 1000).toISOString().slice(0, 10)}..${new Date(testTo * 1000).toISOString().slice(0, 10)}\n`
  );
  console.log(`| Arm | Brier | Log-loss | Brier, trend legs (n=${trendRecs.length}) | Log-loss |`);
  console.log("|---|---|---|---|---|");
  arms.forEach((arm, i) => {
    const a = score(recs, i);
    const b = score(trendRecs, i);
    const f = (x: number) => (Number.isFinite(x) ? x.toFixed(4) : "–");
    console.log(
      `| ${arm.name} | ${f(a.brier)} | ${f(a.logLoss)} | ${f(b.brier)} | ${f(b.logLoss)} |`
    );
  });

  // By-leg bootstrap, fixed seed so reruns print the same interval.
  const byLeg = new Map<string, { d: number; n: number }>();
  for (const r of recs) {
    const e = byLeg.get(r.leg) ?? { d: 0, n: 0 };
    e.d += (r.p[chosen] - r.y) ** 2 - (r.p[previous] - r.y) ** 2;
    e.n++;
    byLeg.set(r.leg, e);
  }
  const groups = [...byLeg.values()];
  let seed = 1;
  const rand = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  const gaps: number[] = [];
  for (let b = 0; b < 1000; b++) {
    let d = 0;
    let n = 0;
    for (let k = 0; k < groups.length; k++) {
      const g = groups[Math.floor(rand() * groups.length)];
      d += g.d;
      n += g.n;
    }
    gaps.push(d / n);
  }
  gaps.sort((a, b) => a - b);
  console.log(
    `\nBrier ${arms[chosen].name} minus ${arms[previous].name}: ${(score(recs, chosen).brier - score(recs, previous).brier).toFixed(4)} [95% ${gaps[25].toFixed(4)}, ${gaps[974].toFixed(4)}]`
  );
}

// ============================================================================
// CLI
// ============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  const dbArg = args.find((a) => a.startsWith("--db="));
  const dbPath = dbArg ? dbArg.split("=")[1] : "./plane-data.sqlite";

  const windowsArg = args.find((a) => a.startsWith("--windows="));
  if (args.includes("--leg-backtest")) {
    const daysArg = args.find((a) => a.startsWith("--test-days="));
    const untilArg = args.find((a) => a.startsWith("--until="));
    legBacktest(
      dbPath,
      daysArg ? Number.parseInt(daysArg.split("=")[1], 10) : 14,
      untilArg ? Math.floor(Date.parse(`${untilArg.split("=")[1]}T00:00:00Z`) / 1000) : null
    );
  } else if (args.includes("--backtest") && windowsArg) {
    const cutoffs = windowsArg
      .split("=")[1]
      .split(",")
      .map((d) => Math.floor(Date.parse(`${d.trim()}T00:00:00Z`) / 1000));
    if (cutoffs.some((c) => !Number.isFinite(c))) {
      console.error("--windows takes comma-separated YYYY-MM-DD cutoffs");
      process.exit(2);
    }
    const daysArg = args.find((a) => a.startsWith("--test-days="));
    backtestWindows(dbPath, cutoffs, daysArg ? Number.parseInt(daysArg.split("=")[1], 10) : 7);
  } else if (args.includes("--backtest")) {
    const hoursArg = args.find((a) => a.startsWith("--holdout="));
    const hours = hoursArg ? Number.parseInt(hoursArg.split("=")[1], 10) : 48;
    backtest(dbPath, hours);
  } else if (args.some((a) => a.startsWith("--predict="))) {
    const flightArg = args.find((a) => a.startsWith("--predict="))!;
    const flightNumber = flightArg.split("=")[1];
    const db = new Database(dbPath, { readonly: true });
    const pred = predictFlight(createReaderFactory(db)("UA"), flightNumber);
    db.close();
    console.log(JSON.stringify(pred, null, 2));
  } else if (args.includes("--sweep")) {
    console.log("=== Hyperparameter Sweep ===\n");
    const priorStrengths = [0.5, 1, 2, 3, 5];
    for (const ps of priorStrengths) {
      const r = backtest(dbPath, 48, { ...DEFAULT_CONFIG, priorStrength: ps });
      console.log(
        `priorStrength=${ps} → acc=${(r.accuracy * 100).toFixed(1)}% brier=${r.brierScore.toFixed(4)} logloss=${r.logLoss.toFixed(4)}`
      );
    }
  } else if (args.includes("--cv")) {
    console.log("=== Cross-Validation Across Holdout Windows ===\n");
    for (const h of [24, 48, 72, 96, 120, 168]) {
      const r = backtest(dbPath, h);
      console.log(
        `holdout=${String(h).padStart(3)}h → n=${String(r.n).padStart(4)} acc=${(r.accuracy * 100).toFixed(1)}% brier=${r.brierScore.toFixed(4)}`
      );
    }
  } else {
    console.log("Usage:");
    console.log("  --backtest [--holdout=48] [--db=path]   Evaluate model accuracy");
    console.log(
      "  --backtest --windows=2026-08-15,2026-08-22 [--test-days=7] [--db=path]  Rolling-origin, log vs ADS-B arms"
    );
    console.log("  --cv [--db=path]                        Cross-validate across 24-168h holdouts");
    console.log(
      "  --leg-backtest [--test-days=14] [--until=YYYY-MM-DD] [--db=path]  Per-leg weighting arms on held-out ADS-B draws"
    );
    console.log("  --predict=UA4680 [--db=path]            Predict one flight");
    console.log("  --sweep [--db=path]                     Hyperparameter search (priorStrength)");
  }
}
