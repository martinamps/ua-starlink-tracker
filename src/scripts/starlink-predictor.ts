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
import { airlineHomeUrl, enabledAirlines } from "../airlines/registry";
import type { VerificationObservation as Observation } from "../database/database";
import { type Scope, type ScopedReader, createReaderFactory } from "../database/reader";
import { ensureUAPrefix, inferFleet } from "../utils/constants";

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
    const fleet = inferFleet(flightNumber);

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
 * Load true fleet-stat priors from the meta table (actual Starlink install rate
 * per fleet). These are updated hourly by the scraper and reflect ground truth,
 * unlike the heavily biased verification_log.
 */
function loadFleetPriors(reader: ScopedReader): { express: number; mainline: number } {
  const num = (key: string) => {
    const v = reader.getMeta(key);
    return v ? Number.parseFloat(v) : null;
  };

  const expressStarlink = num("expressStarlink");
  const expressTotal = num("expressTotal");
  const mainlineStarlink = num("mainlineStarlink");
  const mainlineTotal = num("mainlineTotal");

  return {
    express:
      expressStarlink && expressTotal && expressTotal > 0
        ? expressStarlink / expressTotal
        : DEFAULT_CONFIG.expressColdPrior,
    mainline:
      mainlineStarlink && mainlineTotal && mainlineTotal > 0
        ? mainlineStarlink / mainlineTotal
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
    const f = inferFleet(obs.flight_number);
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
  "flight_number" | "probability" | "confidence" | "n_observations"
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
    const normalized = ensureUAPrefix(rf.flight_number);
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
// Itinerary planning (multi-stop graph search)
// ============================================================================

// Minimum leg probability to include in the graph (full-coverage or partial)
export interface RouteCompareResult {
  airline: string;
  name: string;
  probability: number;
  reason: string;
  n: number;
  accentColor: string;
  canonicalHost: string;
}

/**
 * Per-airline Starlink probability for an O-D pair. Hub-only — answers
 * "should I fly UA or HA on SFO-HNL?". Uses observed upcoming_flights when
 * available, falls back to routeTypeRule for type-deterministic airlines,
 * skips airlines that neither serve the route nor have a rule.
 */
export function compareRoute(
  reader: ScopedReader,
  origin: string,
  destination: string
): RouteCompareResult[] {
  const o = origin.toUpperCase().trim();
  const d = destination.toUpperCase().trim();
  const results: RouteCompareResult[] = [];
  const airlines = enabledAirlines().filter((a) => reader.airlines.includes(a.code));

  for (const cfg of airlines) {
    const rows = reader.getRouteAirlineCoverage(o, d, cfg.code);

    let probability: number;
    let reason: string;
    let n = rows.length;

    if (rows.length > 0) {
      const sl = rows.filter((r) => r.sl).length;
      probability = sl / rows.length;
      reason = `${sl} of ${rows.length} scheduled flights on Starlink-equipped aircraft (next ~48h)`;
    } else if (cfg.routeTypeRule) {
      const rule = cfg.routeTypeRule(o, d);
      probability = rule.probability;
      reason = rule.reason;
      n = 0;
    } else {
      continue;
    }

    results.push({
      airline: cfg.code,
      name: cfg.name,
      probability,
      reason,
      n,
      accentColor: cfg.brand.accentColor,
      canonicalHost: new URL(airlineHomeUrl(cfg.code)).host,
    });
  }

  return results.sort((a, b) => b.probability - a.probability);
}

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
    const startOfDay = targetDateUnix - (targetDateUnix % 86400);
    const endOfDay = startOfDay + 86400;
    const confirmedRows = reader.getConfirmedStarlinkEdges(startOfDay, endOfDay);
    for (const r of confirmedRows) {
      const fleet = r.fleet === "mainline" ? "mainline" : "express";
      confirmedEdges.set(`${r.flight_number}|${r.departure_airport}|${r.arrival_airport}`, fleet);
    }
  }

  const graph = new Map<string, Map<string, ItineraryLeg>>();
  for (const r of rows) {
    const dep = r.departure_airport;
    const arr = r.arrival_airport;
    const uaNum = ensureUAPrefix(r.flight_number);
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
