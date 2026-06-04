/**
 * Starlink Probability Predictor
 *
 * Given a flight_number (and optionally route/date), estimate the probability
 * that the scheduled aircraft will have Starlink WiFi.
 *
 * Model: hierarchical fallback with Bayesian smoothing
 *   1. Flight-number historical rate (Laplace-smoothed toward log-conditional prior)
 *   2. Fall back to fleet-type prior (express ~49%, mainline ~2%)
 *
 * Trained on starlink_verification_log (12k+ historical checks of United.com).
 * Backtested by holding out the most recent N hours of observations.
 *
 * CLI:
 *   bun run src/scripts/starlink-predictor.ts --backtest           # Evaluate accuracy
 *   bun run src/scripts/starlink-predictor.ts --predict=UA4680     # Get probability
 *   bun run src/scripts/starlink-predictor.ts --cv                 # Cross-validate
 */

import { Database } from "bun:sqlite";
import { ensureAirlinePrefix, inferSubfleet } from "../airlines/flight-number";
import {
  AIRLINES,
  type AirlineConfig,
  type SubfleetDef,
  type WifiPhase,
  airlineHomeUrl,
  publicAirlines,
  siteForAirline,
  wifiPhaseFamilies,
} from "../airlines/registry";
import type {
  VerificationObservation as Observation,
  SubfleetPenetration,
} from "../database/database";
import {
  type Scope,
  type ScopedReader,
  aggregatePenetration,
  createReaderFactory,
} from "../database/reader";
import { flightDateWindow, matchesLocalDate } from "../utils/airport-tz";

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
  | "fleet_prior_unknown";

interface Prediction {
  flight_number: string;
  probability: number;
  confidence: "high" | "medium" | "low";
  method: PredictionMethod;
  n_observations: number;
}

/**
 * Bayesian smoothing (Laplace-style): blend empirical rate with prior.
 * With few observations, trust the prior more. With many, trust the data.
 *
 * Uses RAW observation counts, not time-weighted. Empirical backtesting found
 * all-history beats time-decayed variants (Brier 0.102 vs 0.126) — aircraft
 * rotation patterns are stable over our ~65-day window, and time-decay washed
 * out consistent evidence too aggressively (e.g., 5 all-negative obs pulled
 * to 50% by aggressive decay + strong prior).
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

  // Cold-start priors: for flights WITH NO history, fall back to true fleet-stat
  // install rate. "Not in the log after 12k checks" is itself a weak negative
  // signal (verifier only checks Starlink-suspected tails), so these are
  // upper bounds.
  expressColdPrior: number;
  mainlineColdPrior: number;
}

const DEFAULT_CONFIG: ModelConfig = {
  priorStrength: 3, // α=3 found optimal via Brier sweep (marginally beats α=2)
  expressSmoothingPrior: 0.768,
  mainlineSmoothingPrior: 0.004,
  expressColdPrior: 0.39,
  mainlineColdPrior: 0.02,
};

/**
 * Build a prediction model from training observations.
 * Returns a predict() function that takes a flight_number and returns probability.
 */
export function buildModel(trainObs: Observation[], config: ModelConfig = DEFAULT_CONFIG) {
  // Pre-aggregate: for each flight_number, count Starlink hits and total obs
  const flightStats = new Map<string, { nStarlink: number; n: number }>();

  for (const obs of trainObs) {
    const key = obs.flight_number;
    const cur = flightStats.get(key) || { nStarlink: 0, n: 0 };
    cur.nStarlink += obs.has_starlink;
    cur.n += 1;
    flightStats.set(key, cur);
  }

  function predict(flightNumber: string): Prediction {
    const fleet = uaSubfleet(flightNumber);

    const stats = flightStats.get(flightNumber);
    if (!stats || stats.n === 0) {
      // No history — use cold-start prior (true fleet install rate)
      const coldPrior =
        fleet === "express"
          ? config.expressColdPrior
          : fleet === "mainline"
            ? config.mainlineColdPrior
            : (config.expressColdPrior + config.mainlineColdPrior) / 2;
      return {
        flight_number: flightNumber,
        probability: coldPrior,
        confidence: "low",
        method: `fleet_prior_${fleet}` as PredictionMethod,
        n_observations: 0,
      };
    }

    // Has history — smooth toward log-conditional rate (not fleet rate),
    // since the log is biased toward Starlink-suspected planes
    const smoothPrior =
      fleet === "express"
        ? config.expressSmoothingPrior
        : fleet === "mainline"
          ? config.mainlineSmoothingPrior
          : (config.expressSmoothingPrior + config.mainlineSmoothingPrior) / 2;

    const prob = smoothedRate(stats.nStarlink, stats.n, smoothPrior, config.priorStrength);

    const confidence = stats.n >= 5 ? "high" : stats.n >= 2 ? "medium" : "low";

    return {
      flight_number: flightNumber,
      probability: prob,
      confidence,
      method: "flight_history_smoothed",
      n_observations: stats.n,
    };
  }

  return { predict, flightStats };
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
function loadFleetPriors(reader: ScopedReader): { express: number; mainline: number } {
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

  const derivedConfig = deriveConfig(reader, trainObs, config);
  const { predict } = buildModel(trainObs, derivedConfig);

  const predictions = testObs.map((obs) => ({
    pred: predict(obs.flight_number),
    actual: obs.has_starlink,
  }));

  db.close();

  const result = evaluate(predictions);

  console.log(`\n=== Backtest: holdout=${holdoutHours}h ===`);
  console.log(`Train: ${trainObs.length} obs | Test: ${testObs.length} obs`);
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

  return result;
}

/**
 * Derive a ModelConfig by computing log-conditional smoothing priors from
 * observations and loading cold-start priors from the meta table.
 * Shared by backtest() and buildProductionModel().
 */
function deriveConfig(
  reader: ScopedReader,
  trainObs: Observation[],
  base: ModelConfig = DEFAULT_CONFIG
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
    // Express cold start: blend fleet rate and log-conditional rate. A flight
    // NEWLY entering the verification log is selection-biased — it was checked
    // because it was on a Starlink-suspected tail. True rate for such flights
    // is ~0.65, not the fleet-wide ~0.49. Backtested: optimal blend is ~0.5·each.
    expressColdPrior: 0.5 * fleetRate.express + 0.5 * logRate.express,
    mainlineColdPrior: fleetRate.mainline,
  };
}

// ============================================================================
// Cached model for production use (rebuilt at most every MODEL_TTL_SEC)
// ============================================================================

const MODEL_TTL_SEC = 3600; // 1 hour — matches scrape cadence
const modelCache = new Map<Scope, { predict: (fn: string) => Prediction; builtAt: number }>();

function buildProductionModel(reader: ScopedReader): { predict: (fn: string) => Prediction } {
  const trainObs = reader.getVerificationObservations();
  const config = deriveConfig(reader, trainObs);
  return buildModel(trainObs, config);
}

/**
 * Predict Starlink probability for a flight number.
 * Caches the model per reader scope for MODEL_TTL_SEC to avoid reloading 12k+ rows per call.
 */
export function predictFlight(reader: ScopedReader, flightNumber: string): Prediction {
  const now = Math.floor(Date.now() / 1000);
  let cached = modelCache.get(reader.scope);
  if (!cached || now - cached.builtAt > MODEL_TTL_SEC) {
    cached = { ...buildProductionModel(reader), builtAt: now };
    modelCache.set(reader.scope, cached);
  }
  return cached.predict(flightNumber);
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
      ? `Route ${routeDesc} is UNOBSERVED — no Starlink-equipped aircraft has flown it in our ~65-day history. Distinct from "0% observed": unobserved means no data. The fleet-prior baseline applies (mainline routes ~2%, express higher — see get_fleet_stats for current numbers).`
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
 * (e.g. AS800-899 on Hawaiian A330/A321neo), so equipped/total don't exist
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
  | { kind: "no_model"; reason: string };

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
  flightNumber: string
): CarrierPrediction {
  const noModel: CarrierPrediction = {
    kind: "no_model",
    reason: `No per-flight prediction model exists for ${cfg.name} — Starlink status is determined by aircraft type, not flight-number history. ${cfg.rollout.phaseNote}`,
  };
  // Defensive: a reader scoped to another airline (e.g. a hub caller that
  // skipped resolveCarrier) must never produce that airline's roster counts
  // as this carrier's answer.
  if (reader.scope !== cfg.code) return noModel;

  const groups = phaseSplit(cfg);
  if (groups) return { kind: "type_split", groups };

  const sf = cfg.subfleets.find((s) => s.match(flightNumber));
  const pen = sf ? subfleetPenetration(reader.getSubfleetPenetration(), sf) : null;
  if (sf && pen && (pen.synthetic || pen.total >= MIN_PENETRATION_TOTAL)) {
    return { kind: "penetration", sf, pen };
  }
  return noModel;
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

/** One-sentence prose for a CarrierPrediction — keeps REST and MCP wording identical. */
export function describeCarrierPrediction(cfg: AirlineConfig, answer: CarrierPrediction): string {
  if (answer.kind === "no_model") return answer.reason;
  if (answer.kind === "type_split") {
    const parts = answer.groups.map((g) => `${g.families.join("/")}: ${PHASE_LABEL[g.phase]}`);
    return joinSentences(
      `Starlink on ${cfg.name} is determined by aircraft type — ${parts.join("; ")}`,
      "Check a specific flight and date to see which aircraft type is scheduled"
    );
  }
  const { sf, pen } = answer;
  const pct = (pen.pct * 100).toFixed(0);
  const hint = sf.flightNumberHint ? ` (${sf.flightNumberHint})` : "";
  const basis = pen.synthetic
    ? `${sf.label}${hint} — Starlink status is set by the operating subfleet`
    : `${pen.equipped} of ${pen.total} ${sf.label}${hint} aircraft equipped`;
  return joinSentences(`~${pct}% Starlink probability (${basis})`, cfg.rollout.phaseNote);
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
  const penMap = reader.getSubfleetPenetration();
  if (penMap.size === 0) return null;
  const penArr: SubfleetBreakdown[] = cfg.subfleets.map((sf) => {
    const p = subfleetPenetration(penMap, sf) ?? {
      synthetic: false as const,
      equipped: 0,
      total: 0,
      pct: 0,
    };
    return { key: sf.key, label: sf.label, hint: sf.flightNumberHint, ...p };
  });
  const maxPct = Math.max(...penArr.map((p) => p.pct));
  const minSub = penArr.reduce((a, b) => (a.pct <= b.pct ? a : b));

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
    const lowSibling = penArr.find((p) => p.key !== sf.key && p.pct < 0.5);
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
          ? `${shortLabel(sf.label)} on this route — Starlink-equipped fleet`
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
  if (phaseSplit(cfg)) return null;
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
// Mainline rotates far more freely (~35% swap rate) than express (~9%).
const CONFIRMED_PROB = {
  express: 0.9, // 1 - 9.1% observed swap rate
  mainline: 0.65, // 1 - 35.5% observed swap rate
};

export type ItineraryLeg = BasePrediction & {
  route: string;
  duration_hours: number | null;
  // True if this leg comes from a confirmed near-term Starlink assignment in
  // upcoming_flights (not historical prediction). Render differently.
  confirmed?: boolean;
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

function makePositioningLeg(route: string): ItineraryLeg {
  return {
    flight_number: "(any)",
    route,
    probability: DEFAULT_CONFIG.mainlineColdPrior,
    confidence: "low",
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
  } = {}
): Itinerary[] {
  const orig = origin.toUpperCase().trim();
  const dest = destination.toUpperCase().trim();
  if (orig === dest) return [];

  const maxItineraries = options.maxItineraries ?? 10;
  const minLegProb = options.minLegProbability ?? MIN_LEG_PROBABILITY;
  const maxStops = Math.min(options.maxStops ?? 2, 3);

  const graph = buildRouteGraph(reader, minLegProb, options.targetDateUnix);
  const itineraries: Itinerary[] = [];

  // --- BFS up to maxStops+1 legs ---
  type SearchState = { airport: string; legs: ItineraryLeg[]; joint: number };
  let frontier: SearchState[] = [{ airport: orig, legs: [], joint: 1 }];
  const seenPaths = new Set<string>();

  for (let depth = 0; depth <= maxStops; depth++) {
    const nextFrontier: SearchState[] = [];
    for (const state of frontier) {
      const edges = graph.get(state.airport);
      if (!edges) continue;

      for (const [nextAirport, leg] of edges.entries()) {
        if (nextAirport === orig) continue;
        if (state.legs.some((l) => l.route.split("-")[1] === nextAirport)) continue;

        const newLegs = [...state.legs, leg];
        const newJoint = state.joint * leg.probability;

        if (nextAirport === dest) {
          const pathKey = newLegs.map((l) => l.route).join("|");
          if (!seenPaths.has(pathKey)) {
            seenPaths.add(pathKey);
            itineraries.push(computeItinerary(newLegs, "full"));
          }
        } else if (depth < maxStops) {
          nextFrontier.push({ airport: nextAirport, legs: newLegs, joint: newJoint });
        }
      }
    }
    nextFrontier.sort((a, b) => b.joint - a.joint);
    frontier = nextFrontier.slice(0, 200);
  }

  // --- Partial-coverage baselines (both directions) ---
  // Only when maxStops > 0 (respect user's "direct only" intent) and when
  // we don't already have a strong direct (≥70% joint) — extra options
  // are noise when a 92% direct exists.
  const directIt = itineraries.find((it) => it.via.length === 0);
  const showPartials = maxStops > 0 && (!directIt || directIt.joint_probability < 0.7);

  if (showPartials) {
    const partialLimit = itineraries.length === 0 ? maxItineraries : 3;
    type PartialCandidate = { starlinkLeg: ItineraryLeg; hub: string; direction: "in" | "out" };
    const candidates: PartialCandidate[] = [];

    // Direction "in": (any) orig→hub, then Starlink hub→dest
    for (const [hub, edges] of graph.entries()) {
      const leg = edges.get(dest);
      if (!leg || leg.probability < minLegProb || hub === orig) continue;
      if (itineraries.some((it) => it.via.length === 1 && it.via[0] === hub)) continue;
      candidates.push({ starlinkLeg: leg, hub, direction: "in" });
    }
    // Direction "out": Starlink orig→hub, then (any) hub→dest
    const outEdges = graph.get(orig);
    if (outEdges) {
      for (const [hub, leg] of outEdges.entries()) {
        if (hub === dest || leg.probability < minLegProb) continue;
        if (itineraries.some((it) => it.via.length === 1 && it.via[0] === hub)) continue;
        candidates.push({ starlinkLeg: leg, hub, direction: "out" });
      }
    }

    // Prefer longer Starlink legs (more hours) at similar probability
    candidates.sort((a, b) => {
      const aH = (a.starlinkLeg.duration_hours ?? 0) * a.starlinkLeg.probability;
      const bH = (b.starlinkLeg.duration_hours ?? 0) * b.starlinkLeg.probability;
      return bH - aH;
    });

    for (const c of candidates.slice(0, partialLimit)) {
      const legs =
        c.direction === "in"
          ? [makePositioningLeg(`${orig}-${c.hub}`), c.starlinkLeg]
          : [c.starlinkLeg, makePositioningLeg(`${c.hub}-${dest}`)];
      itineraries.push(computeItinerary(legs, "partial"));
    }
  }

  // --- Ranking ---
  // Primary: COVERAGE RATIO (eSL / totalH). This treats a 1h 92% direct and a
  // 10h 90% multi-stop as roughly equal quality — the user's EXPERIENCE is the
  // same. Raw eSL would rank the 10h option absurdly higher.
  // Secondary: fewer legs (users prefer simpler routings).
  // Tertiary: more expected Starlink hours (breaks ties for similar ratios).
  itineraries.sort((a, b) => {
    if (a.coverage !== b.coverage) return a.coverage === "full" ? -1 : 1;

    const aR = a.coverage_ratio;
    const bR = b.coverage_ratio;
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
  const fullSorted = itineraries.filter((it) => it.coverage === "full");
  const partialSorted = itineraries.filter((it) => it.coverage === "partial");
  const direct = fullSorted.find((it) => it.via.length === 0);
  const nonDirect = fullSorted.filter((it) => it.via.length > 0);

  const fullKept = direct
    ? [direct, ...nonDirect.slice(0, maxItineraries - 1)]
    : nonDirect.slice(0, maxItineraries);

  return [...fullKept, ...partialSorted.slice(0, 3)];
}

export type { Prediction };

// ============================================================================
// CLI
// ============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  const dbArg = args.find((a) => a.startsWith("--db="));
  const dbPath = dbArg ? dbArg.split("=")[1] : "./plane-data.sqlite";

  if (args.includes("--backtest")) {
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
    console.log("  --cv [--db=path]                        Cross-validate across 24-168h holdouts");
    console.log("  --predict=UA4680 [--db=path]            Predict one flight");
    console.log("  --sweep [--db=path]                     Hyperparameter search (priorStrength)");
  }
}
