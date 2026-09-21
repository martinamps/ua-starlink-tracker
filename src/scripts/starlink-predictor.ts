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
import { normalizeAircraftType } from "../airlines/aircraft-families";
import { ensureAirlinePrefix, inferSubfleet } from "../airlines/flight-number";
import {
  AIRLINES,
  type AirlineConfig,
  COMMUNITY_SOURCE_UPDATED_META,
  type SubfleetDef,
  type WifiPhase,
  airlineHomeUrl,
  programTypeOf,
  publicAirlines,
  siteForAirline,
  uiAccent,
  wifiPhaseFamilies,
} from "../airlines/registry";
import { formatFactDate } from "../airlines/rollout-facts";
import type { AdsbFlightDraw } from "../database/adsb-flight-draws";
import type {
  FleetRosterEntry,
  GuideMark,
  VerificationObservation as Observation,
  SubfleetPenetration,
  TypeProgress,
} from "../database/database";
import {
  type Scope,
  type ScopedReader,
  aggregatePenetration,
  createReaderFactory,
} from "../database/reader";
import { airportDistanceMiles, detourBoundMiles, hubAllowedForTrip } from "../utils/airport-geo";
import { flightDateWindow, matchesLocalDate } from "../utils/airport-tz";
import { memo, perOwner } from "../utils/ttl-cache";

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

    const pred = predictFlight(reader, normalized);
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
  | { kind: "penetration"; sf: SubfleetDef; pen: ResolvedPenetration }
  | { kind: "type_split"; groups: { phase: WifiPhase; families: string[] }[] }
  | { kind: "no_model"; reason: string }
  // Community-source carriers (AF). Per programme type, never one blended
  // number: a flight number doesn't pin the type, and the types run from
  // "not started" to nearly done.
  | { kind: "type_progress"; types: TypeProgress[]; guideUpdated: string | null }
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
    }
  | { kind: "partner_operated"; tail: string };

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
  noModel: CarrierPrediction
): CarrierPrediction {
  // Before the first guide sync every type would read "not started".
  const guideUpdated = reader.getMeta(COMMUNITY_SOURCE_UPDATED_META);
  const types = guideUpdated ? reader.getTypeProgress() : [];
  if (types.length === 0) return noModel;
  if (aircraftType) {
    const { key } = programTypeOf(cfg, aircraftType);
    if (namesUnflownVariant(cfg, aircraftType, key))
      return { kind: "type_progress", types, guideUpdated };
    const row = types.find((t) => t.key === key && t.total > 0);
    if (row) return { kind: "type_rate", type: row, share: typeShare(row), types, guideUpdated };
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
      };
    }
  }
  return { kind: "type_progress", types, guideUpdated };
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
  ctx: { aircraftType?: string | null } = {}
): CarrierPrediction {
  const noModel: CarrierPrediction = {
    kind: "no_model",
    reason: `No per-flight prediction model exists for ${cfg.name} — Starlink status is determined by aircraft type, not flight-number history. ${cfg.rollout.phaseNote}`,
  };
  // Defensive: a reader scoped to another airline (e.g. a hub caller that
  // skipped resolveCarrier) must never produce that airline's roster counts
  // as this carrier's answer.
  if (reader.scope !== cfg.code) return noModel;

  if (cfg.communitySource) return communityPrediction(cfg, reader, ctx.aircraftType, noModel);

  const groups = phaseSplit(cfg);
  if (groups) return { kind: "type_split", groups };

  const sf = cfg.subfleets.find((s) => s.match(flightNumber));
  const pen = sf ? subfleetPenetration(reader.getSubfleetPenetration(), sf) : null;
  if (sf && pen && (pen.synthetic || pen.total >= MIN_PENETRATION_TOTAL)) {
    return { kind: "penetration", sf, pen };
  }
  return noModel;
}

/** A named tail is a tail-level answer, not a per-type one. */
export function noModelConfidence(answer: CarrierPrediction): "tail" | "type" {
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
  const informative = answer !== null && answer.kind !== "no_model";
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

const plural = (label: string) => (/\d$|[A-Z]$/.test(label) ? `${label}s` : label);

/** "At least: 777-300ER 34 of 43, …; not started on 787-9, …; A318/A330 retiring". */
function typeProgressSummary(types: readonly TypeProgress[]): string {
  const live = types.filter((t) => !t.excluded && t.total > 0);
  const done = live.filter((t) => t.equipped === t.total).map((t) => `${t.label} all ${t.total}`);
  const going = live
    .filter((t) => t.equipped > 0 && t.equipped < t.total)
    .map((t) => `${t.label} ${t.equipped} of ${t.total}`);
  const idle = live.filter((t) => t.equipped === 0).map((t) => t.label);
  const retiring = types.filter((t) => t.excluded).map((t) => t.label);
  return [
    done.length + going.length > 0 ? `At least: ${[...done, ...going].join(", ")}` : null,
    idle.length > 0 ? `not started on ${idle.join(", ")}` : null,
    retiring.length > 0 ? `${retiring.join("/")} retiring` : null,
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
  if (t.equipped === 0) {
    return joinSentences(`No ${cfg.name} ${t.label} is listed with Starlink yet ${cite}`);
  }
  if (t.equipped === t.total) {
    return joinSentences(`All ${t.total} ${cfg.name} ${name} have Starlink ${cite}`);
  }
  return joinSentences(
    `At least ${t.equipped} of ${t.total} ${cfg.name} ${name} have Starlink ${cite}`,
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
  if (answer.mark === null) return joinSentences(`${on}; not yet listed in ${guide}`);
  if (answer.mark === "starlink") {
    return joinSentences(`${on}; listed with Starlink in ${guide}, not yet confirmed here`);
  }
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
  if (answer.kind === "type_progress") {
    const g = guideRef(cfg, answer.guideUpdated);
    return joinSentences(
      `On ${cfg.name}-operated flights, Starlink depends on the aircraft type. ${typeProgressSummary(answer.types)}`,
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
  const pct = (pen.pct * 100).toFixed(0);
  const hint = sf.flightNumberHint ? `, ${sf.flightNumberHint}` : "";
  const basis = pen.synthetic
    ? `${sf.label}${hint} — ${sf.overrideReason ?? "Starlink status is set by the operating subfleet"}`
    : `${pen.equipped} of ${pen.total} ${sf.label}${hint} aircraft equipped`;
  return joinSentences(`~${pct}% Starlink probability (${basis})`, cfg.rollout.phaseNote);
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
};

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
}

/**
 * Build the Starlink route adjacency graph: for each airport, the best
 * (highest-probability) flight number to each reachable destination.
 *
 * Probability comes from TWO sources, in priority order:
 *  1. CONFIRMED assignment: if the flight is on a verified-Starlink tail in our
 *     current upcoming_flights snapshot, use CONFIRMED_EDGE_PROBABILITY (0.95).
 *     The flight number's history is irrelevant — we KNOW the near-term answer.
 *  2. Historical prediction: predictFlight() from the verification log.
 *
 * Without (1), a flight like UA1358 ORD→MIA (0% history, but literally on a
 * Starlink plane tomorrow) gets filtered out and the planner says "no path."
 */
function buildRouteGraph(
  reader: ScopedReader,
  minLegProb: number,
  targetDateUnix?: number
): Map<string, Map<string, ItineraryLeg>> {
  const rows = reader.getRouteGraphEdges();

  // Confirmed-edge seeding is only valid when the target date is covered by
  // our upcoming_flights snapshot. Outside that window, today's tail
  // assignment has no bearing — a mainline flight rotates tails freely.
  // Without a target date (e.g. exploratory planning), skip confirmed seeding
  // and rely on historical prediction, which is honest about uncertainty.
  // Confirmed-edge seeding: same-day assignments on VERIFIED-Starlink tails only
  // (verified_wifi = 'Starlink', not NULL — spreadsheet-listed-but-unverified
  // planes don't get the confirmed tier). Fleet-aware swap discount applied.
  const confirmedEdges = new Map<string, "express" | "mainline">();
  if (targetDateUnix !== undefined) {
    // targetDateUnix is noon UTC of the traveler's date (flightDateWindow.mid),
    // so its UTC date IS the queried date. Match rows on the departure
    // airport's LOCAL date over the widened bounds, same as check-flight core
    // — a strict UTC day window drops verified evening departures (SFO 6pm =
    // 01:00Z next day) and seeds the wrong day's tail instead.
    const date = new Date(targetDateUnix * 1000).toISOString().slice(0, 10);
    const window = flightDateWindow(date);
    if (window) {
      const confirmedRows = reader.getConfirmedStarlinkEdges(window.queryStart, window.queryEnd);
      for (const r of confirmedRows) {
        if (
          !matchesLocalDate(date, r.departure_airport, r.departure_time, window.start, window.end)
        ) {
          continue;
        }
        const fleet = r.fleet === "mainline" ? "mainline" : "express";
        confirmedEdges.set(`${r.flight_number}|${r.departure_airport}|${r.arrival_airport}`, fleet);
      }
    }
  }

  const graph = new Map<string, Map<string, ItineraryLeg>>();
  for (const r of rows) {
    const dep = r.departure_airport;
    const arr = r.arrival_airport;
    // A row whose origin equals its destination is bad upstream data; letting
    // it into the graph is what let the planner emit self-loop legs.
    if (!dep || !arr || dep === arr) continue;
    const uaNum = uaPrefix(r.flight_number);
    const confirmedFleet = confirmedEdges.get(`${r.flight_number}|${dep}|${arr}`);

    let pred: BasePrediction;
    if (confirmedFleet) {
      // Use the MAX of (historical prediction, confirmed swap-adjusted) —
      // a flight with 100% history shouldn't drop to 90% just because it's
      // also in the snapshot.
      const hist = predictFlight(reader, uaNum);
      const confirmedP = CONFIRMED_PROB[confirmedFleet];
      pred =
        hist.probability >= confirmedP
          ? hist
          : {
              flight_number: uaNum,
              probability: confirmedP,
              confidence: "high",
              // Was omitted, which tsc flags: BasePrediction requires it and
              // the field was simply missing from the wire response.
              method: "confirmed_assignment",
              n_observations: 1,
            };
    } else {
      pred = predictFlight(reader, uaNum);
    }

    if (pred.probability < minLegProb) continue;

    if (!graph.has(dep)) graph.set(dep, new Map());
    const edges = graph.get(dep)!;
    const existing = edges.get(arr);
    if (!existing || pred.probability > existing.probability) {
      edges.set(arr, {
        ...pred,
        route: `${dep}-${arr}`,
        duration_hours: r.avg_duration_sec > 0 ? r.avg_duration_sec / 3600 : null,
        confirmed: confirmedFleet !== undefined,
      });
    }
  }
  return graph;
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
 */
export function planItinerary(
  reader: ScopedReader,
  origin: string,
  destination: string,
  options: {
    maxItineraries?: number;
    minLegProbability?: number;
    maxStops?: number;
    targetDateUnix?: number;
    /** Time budget + 2-stop gain rule; defaults to ENFORCE_ITINERARY_TIME_BUDGET. */
    enforceTimeBudget?: boolean;
  } = {}
): Itinerary[] {
  const orig = origin.toUpperCase().trim();
  const dest = destination.toUpperCase().trim();
  if (orig === dest) return [];

  const enforceBudget = options.enforceTimeBudget ?? ENFORCE_ITINERARY_TIME_BUDGET;
  const maxItineraries = options.maxItineraries ?? 10;
  const minLegProb = options.minLegProbability ?? MIN_LEG_PROBABILITY;
  const maxStops = Math.min(options.maxStops ?? 2, 3);

  // Detour gate. Unknown airports null the bound / the running path total,
  // which disables pruning for that query / that path (fail open).
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

  const graph = buildRouteGraph(reader, minLegProb, options.targetDateUnix);
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
    elapsedHours(it) <= budgetHours;
  const hubAllowed = (hub: string) => hubAllowedForTrip(orig, dest, hub);

  // --- BFS up to maxStops+1 legs ---
  type SearchState = { airport: string; legs: ItineraryLeg[]; joint: number; flown: number | null };
  let frontier: SearchState[] = [{ airport: orig, legs: [], joint: 1, flown: 0 }];
  const seenPaths = new Set<string>();
  const fulls: Itinerary[] = [];

  for (let depth = 0; depth <= maxStops; depth++) {
    const nextFrontier: SearchState[] = [];
    for (const state of frontier) {
      const edges = graph.get(state.airport);
      if (!edges) continue;

      for (const [nextAirport, leg] of edges.entries()) {
        if (nextAirport === orig) continue;
        if (state.legs.some((l) => l.route.split("-")[1] === nextAirport)) continue;
        if (nextAirport !== dest && !hubAllowed(nextAirport)) continue;

        const flown = pathMiles(state.flown, state.airport, nextAirport);
        if (exceedsBound(flown, nextAirport)) continue;

        const newLegs = [...state.legs, leg];
        const newJoint = state.joint * leg.probability;

        if (nextAirport === dest) {
          const pathKey = newLegs.map((l) => l.route).join("|");
          if (!seenPaths.has(pathKey)) {
            seenPaths.add(pathKey);
            fulls.push(build(newLegs, "full"));
          }
        } else if (depth < maxStops) {
          nextFrontier.push({ airport: nextAirport, legs: newLegs, joint: newJoint, flown });
        }
      }
    }
    nextFrontier.sort((a, b) => b.joint - a.joint);
    frontier = nextFrontier.slice(0, 200);
  }
  const connections = fulls.filter((it) => it.via.length > 0);
  if (!hasNonstop || (!firmNonstop && !connections.some(withinBudget))) {
    budgetFromFastest(connections);
  }
  itineraries.push(...fulls.filter(withinBudget));

  // --- Partial-coverage baselines (both directions) ---
  // Only when maxStops > 0 (respect user's "direct only" intent) and when
  // we don't already have a strong direct (≥70% joint) — extra options
  // are noise when a 92% direct exists.
  const directIt = fulls.find((it) => it.via.length === 0);
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
    for (const [hub, edges] of graph.entries()) {
      const leg = edges.get(dest);
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
      for (const [hub, leg] of outEdges.entries()) {
        if (hub === dest || leg.probability < minLegProb) continue;
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

    const partials = candidates.map((c) =>
      build(
        c.direction === "in"
          ? [makePositioningLeg(`${orig}-${c.hub}`, positioningPrior), c.starlinkLeg]
          : [c.starlinkLeg, makePositioningLeg(`${c.hub}-${dest}`, positioningPrior)],
        "partial"
      )
    );
    const partialsEmptied = itineraries.length === 0 && !partials.some(withinBudget);
    if (!firmNonstop && (budgetHours === null || partialsEmptied)) budgetFromFastest(partials);
    itineraries.push(...partials.filter(withinBudget).slice(0, partialLimit));
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

  return [...fullKept, ...partialSorted.slice(0, 3)];
}

/**
 * Time budget for connections relative to the nonstop. Ratio-only ranking
 * recommended SFO→EWR as 9–10h 2-stops (via Halifax, Nantucket) against a
 * 5.7h nonstop, and IAH→CLE at 2x the trip time. Flip to false to restore
 * pure coverage-ratio ranking with no time/stop gates.
 */
export const ENFORCE_ITINERARY_TIME_BUDGET = true;
const BUDGET_FACTOR = 1.5;
const BUDGET_SLACK_HOURS = 2.5;
// Minimum connection time per stop; total_flight_hours is airborne time only.
const LAYOVER_HOURS = 1.0;
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

/** Flying time plus a minimum connection per stop. */
export function elapsedHours(it: Itinerary): number {
  return (it.total_flight_hours ?? 0) + LAYOVER_HOURS * it.via.length;
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
    ? predictFlight(reader, flightNumber).probability
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

export type { Prediction };

// ============================================================================
// CLI
// ============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  const dbArg = args.find((a) => a.startsWith("--db="));
  const dbPath = dbArg ? dbArg.split("=")[1] : "./plane-data.sqlite";

  const windowsArg = args.find((a) => a.startsWith("--windows="));
  if (args.includes("--backtest") && windowsArg) {
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
    console.log("  --predict=UA4680 [--db=path]            Predict one flight");
    console.log("  --sweep [--db=path]                     Hyperparameter search (priorStrength)");
  }
}
