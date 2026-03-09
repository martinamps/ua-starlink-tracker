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
import { ensureUAPrefix, inferFleet } from "../utils/constants";

// ============================================================================
// Types
// ============================================================================

interface Observation {
  flight_number: string;
  tail_number: string;
  has_starlink: number; // 0 or 1
  checked_at: number;
}

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
  priorStrength: 2, // α=2 found optimal via Brier sweep
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

function loadObservations(db: Database, beforeSec?: number, afterSec?: number): Observation[] {
  let sql = `
    SELECT flight_number, tail_number, has_starlink, checked_at
    FROM starlink_verification_log
    WHERE flight_number IS NOT NULL
      AND source = 'united'
      AND has_starlink IS NOT NULL
  `;
  const params: number[] = [];
  if (beforeSec !== undefined) {
    sql += " AND checked_at < ?";
    params.push(beforeSec);
  }
  if (afterSec !== undefined) {
    sql += " AND checked_at >= ?";
    params.push(afterSec);
  }
  return db.query(sql).all(...params) as Observation[];
}

/**
 * Load true fleet-stat priors from the meta table (actual Starlink install rate
 * per fleet). These are updated hourly by the scraper and reflect ground truth,
 * unlike the heavily biased verification_log.
 */
function loadFleetPriors(db: Database): { express: number; mainline: number } {
  const get = (key: string) => {
    const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as {
      value: string;
    } | null;
    return row ? Number.parseFloat(row.value) : null;
  };

  const expressStarlink = get("expressStarlink");
  const expressTotal = get("expressTotal");
  const mainlineStarlink = get("mainlineStarlink");
  const mainlineTotal = get("mainlineTotal");

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
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - holdoutHours * 3600;

  const trainObs = loadObservations(db, cutoff);
  const testObs = loadObservations(db, undefined, cutoff);

  const derivedConfig = deriveConfig(db, trainObs, config);
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
  db: Database,
  trainObs: Observation[],
  base: ModelConfig = DEFAULT_CONFIG
): ModelConfig {
  const byFleet = { express: { s: 0, t: 0 }, mainline: { s: 0, t: 0 } };
  for (const obs of trainObs) {
    const f = inferFleet(obs.flight_number);
    if (f === "express" || f === "mainline") {
      byFleet[f].s += obs.has_starlink;
      byFleet[f].t += 1;
    }
  }

  const coldPriors = loadFleetPriors(db);

  return {
    ...base,
    expressSmoothingPrior:
      byFleet.express.t > 0 ? byFleet.express.s / byFleet.express.t : base.expressSmoothingPrior,
    mainlineSmoothingPrior:
      byFleet.mainline.t > 0
        ? byFleet.mainline.s / byFleet.mainline.t
        : base.mainlineSmoothingPrior,
    expressColdPrior: coldPriors.express,
    mainlineColdPrior: coldPriors.mainline,
  };
}

// ============================================================================
// Cached model for production use (rebuilt at most every MODEL_TTL_SEC)
// ============================================================================

const MODEL_TTL_SEC = 3600; // 1 hour — matches scrape cadence
let cachedModel: { predict: (fn: string) => Prediction; builtAt: number } | null = null;

function buildProductionModel(db: Database): { predict: (fn: string) => Prediction } {
  const trainObs = loadObservations(db);
  const config = deriveConfig(db, trainObs);
  return buildModel(trainObs, config);
}

/**
 * Predict Starlink probability for a flight number.
 * Caches the model for MODEL_TTL_SEC to avoid reloading 12k+ rows per call.
 */
export function predictFlight(db: Database, flightNumber: string): Prediction {
  const now = Math.floor(Date.now() / 1000);
  if (!cachedModel || now - cachedModel.builtAt > MODEL_TTL_SEC) {
    cachedModel = { ...buildProductionModel(db), builtAt: now };
  }
  return cachedModel.predict(flightNumber);
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
  db: Database,
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

  // Find all flight numbers seen on this route, with observation counts
  let sql = `
    SELECT flight_number, departure_airport, arrival_airport, COUNT(*) as route_obs
    FROM upcoming_flights
    WHERE 1=1
  `;
  const params: string[] = [];
  if (orig) {
    sql += " AND departure_airport = ?";
    params.push(orig);
  }
  if (dest) {
    sql += " AND arrival_airport = ?";
    params.push(dest);
  }
  sql += " GROUP BY flight_number, departure_airport, arrival_airport ORDER BY route_obs DESC";

  const routeFlights = db.query(sql).all(...params) as Array<{
    flight_number: string;
    departure_airport: string;
    arrival_airport: string;
    route_obs: number;
  }>;

  // Predict each (upcoming_flights stores SKW/OO/UAL/etc, predictor wants UA####)
  // De-dupe by normalized flight number, keeping highest route_obs
  const seen = new Map<string, RouteFlightPrediction>();
  for (const rf of routeFlights) {
    const normalized = ensureUAPrefix(rf.flight_number);
    const existing = seen.get(normalized);
    if (existing && rf.route_obs <= existing.route_observations) continue;

    const pred = predictFlight(db, normalized);
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

// Minimum leg probability to include in full-coverage itineraries
const MIN_LEG_PROBABILITY = 0.3;
// Minimum probability for the Starlink leg in partial-coverage fallback
const PARTIAL_FALLBACK_MIN_PROB = 0.5;

export type ItineraryLeg = BasePrediction & {
  route: string;
  duration_hours: number | null; // null when we don't know (positioning legs on routes outside our data)
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
}

/**
 * Build the Starlink route adjacency graph: for each airport, the best
 * (highest-probability) flight number to each reachable destination.
 * One SQL query + one prediction per distinct route. Includes avg leg duration.
 */
function buildRouteGraph(db: Database, minLegProb: number): Map<string, Map<string, ItineraryLeg>> {
  const rows = db
    .query(
      `SELECT flight_number, departure_airport, arrival_airport,
              COUNT(*) as obs,
              AVG(arrival_time - departure_time) as avg_duration_sec
       FROM upcoming_flights
       GROUP BY flight_number, departure_airport, arrival_airport`
    )
    .all() as Array<{
    flight_number: string;
    departure_airport: string;
    arrival_airport: string;
    obs: number;
    avg_duration_sec: number;
  }>;

  // For each directed edge (dep → arr), keep the highest-probability flight
  const graph = new Map<string, Map<string, ItineraryLeg>>();
  for (const r of rows) {
    const dep = r.departure_airport;
    const arr = r.arrival_airport;
    const pred = predictFlight(db, ensureUAPrefix(r.flight_number));
    if (pred.probability < minLegProb) continue;

    if (!graph.has(dep)) graph.set(dep, new Map());
    const edges = graph.get(dep)!;
    const existing = edges.get(arr);
    if (!existing || pred.probability > existing.probability) {
      edges.set(arr, {
        ...pred,
        route: `${dep}-${arr}`,
        duration_hours: r.avg_duration_sec / 3600,
      });
    }
  }
  return graph;
}

function computeItinerary(legs: ItineraryLeg[], coverage: "full" | "partial"): Itinerary {
  const joint = legs.reduce((p, l) => p * l.probability, 1);
  const atLeastOne = 1 - legs.reduce((p, l) => p * (1 - l.probability), 1);
  const via = legs.slice(0, -1).map((l) => l.route.split("-")[1]);

  // Time-aware metrics. Null if any leg has unknown duration (positioning legs).
  const allDurationsKnown = legs.every((l) => l.duration_hours !== null);
  const totalHours = allDurationsKnown
    ? legs.reduce((s, l) => s + (l.duration_hours as number), 0)
    : null;
  const expectedStarlinkHours = allDurationsKnown
    ? legs.reduce((s, l) => s + l.probability * (l.duration_hours as number), 0)
    : null;

  return {
    via,
    legs,
    joint_probability: joint,
    at_least_one_probability: atLeastOne,
    coverage,
    total_flight_hours: totalHours,
    expected_starlink_hours: expectedStarlinkHours,
  };
}

/**
 * Find the best Starlink-maximizing itineraries from origin to destination.
 *
 * Multi-stop graph search: builds the full Starlink route graph once, then
 * BFS up to max_stops depth. A path's score is the joint probability of all
 * legs having Starlink. Returns the top-K distinct paths.
 *
 * FALLBACK: if no all-Starlink path exists, suggests partial-coverage options
 * (mainline positioning leg + Starlink connection legs).
 *
 * LIMITATION: only knows routes Starlink planes have flown (~738 edges).
 */
export function planItinerary(
  db: Database,
  origin: string,
  destination: string,
  options: { maxItineraries?: number; minLegProbability?: number; maxStops?: number } = {}
): Itinerary[] {
  const orig = origin.toUpperCase().trim();
  const dest = destination.toUpperCase().trim();
  if (orig === dest) return []; // guard: can't plan A→A

  const maxItineraries = options.maxItineraries ?? 10;
  const minLegProb = options.minLegProbability ?? MIN_LEG_PROBABILITY;
  const maxStops = Math.min(options.maxStops ?? 2, 3); // cap at 3 stops (4 legs)

  const graph = buildRouteGraph(db, minLegProb);
  const itineraries: Itinerary[] = [];

  // BFS: paths up to (maxStops + 1) legs. Track visited airports per-path
  // to avoid cycles. Prune aggressively by joint probability.
  type SearchState = { airport: string; legs: ItineraryLeg[]; joint: number };
  let frontier: SearchState[] = [{ airport: orig, legs: [], joint: 1 }];
  const seenPaths = new Set<string>();

  for (let depth = 0; depth <= maxStops; depth++) {
    const nextFrontier: SearchState[] = [];
    for (const state of frontier) {
      const edges = graph.get(state.airport);
      if (!edges) continue;

      for (const [nextAirport, leg] of edges.entries()) {
        // No cycles (can't revisit an airport already in the path, including origin)
        if (nextAirport === orig) continue;
        if (state.legs.some((l) => l.route.split("-")[1] === nextAirport)) continue;

        const newLegs = [...state.legs, leg];
        const newJoint = state.joint * leg.probability;

        if (nextAirport === dest) {
          // Reached destination — record itinerary
          const pathKey = newLegs.map((l) => l.route).join("|");
          if (!seenPaths.has(pathKey)) {
            seenPaths.add(pathKey);
            itineraries.push(computeItinerary(newLegs, "full"));
          }
        } else if (depth < maxStops) {
          // Continue search — but prune low-joint-prob branches to keep frontier bounded
          // (if we already have maxItineraries full-coverage options, anything with
          // lower joint prob won't make the cut)
          if (itineraries.length >= maxItineraries) {
            itineraries.sort((a, b) => b.joint_probability - a.joint_probability);
            if (newJoint < itineraries[maxItineraries - 1].joint_probability) continue;
          }
          nextFrontier.push({ airport: nextAirport, legs: newLegs, joint: newJoint });
        }
      }
    }
    // Sort frontier by joint prob and cap to keep search bounded (beam search)
    nextFrontier.sort((a, b) => b.joint - a.joint);
    frontier = nextFrontier.slice(0, 200);
  }

  // --- Fallback: PARTIAL coverage when no full-Starlink path exists ---
  if (itineraries.length === 0) {
    // Find all Starlink-reachable paths TO dest (ignoring orig) — these are
    // the final legs the user CAN get Starlink on. Positioning leg is mainline.
    // Use a smaller 1-stop search TO dest for simplicity.
    const intoDestLegs: ItineraryLeg[] = [];
    for (const [hub, edges] of graph.entries()) {
      const leg = edges.get(dest);
      if (leg && leg.probability >= PARTIAL_FALLBACK_MIN_PROB && hub !== orig) {
        intoDestLegs.push(leg);
      }
    }
    intoDestLegs.sort((a, b) => b.probability - a.probability);

    for (const finalLeg of intoDestLegs.slice(0, maxItineraries)) {
      const hub = finalLeg.route.split("-")[0];
      const positioningLeg: ItineraryLeg = {
        flight_number: "(any)",
        route: `${orig}-${hub}`,
        probability: DEFAULT_CONFIG.mainlineColdPrior,
        confidence: "low",
        n_observations: 0,
        duration_hours: null, // unknown — mainline route outside our Starlink-tracked data
      };
      itineraries.push(computeItinerary([positioningLeg, finalLeg], "partial"));
    }
  }

  // Rank by EXPECTED STARLINK HOURS (what users actually want to maximize).
  // Full-coverage paths sort above partial. Within coverage: expected Starlink
  // hours (descending), then fewer legs as tiebreaker. Falls back to joint prob
  // when duration unknown.
  itineraries.sort((a, b) => {
    if (a.coverage !== b.coverage) return a.coverage === "full" ? -1 : 1;

    // Primary: expected Starlink hours (higher is better). Unknown sorts last.
    const aE = a.expected_starlink_hours;
    const bE = b.expected_starlink_hours;
    if (aE !== null && bE !== null) {
      if (Math.abs(bE - aE) > 0.05) return bE - aE;
    } else if (aE !== null) return -1;
    else if (bE !== null) return 1;

    // Secondary: joint probability (for when durations tie or are unknown)
    const probDiff = b.joint_probability - a.joint_probability;
    if (Math.abs(probDiff) > 0.01) return probDiff;

    // Tertiary: fewer legs (simpler routing)
    return a.legs.length - b.legs.length;
  });

  return itineraries.slice(0, maxItineraries);
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
    const pred = predictFlight(db, flightNumber);
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
