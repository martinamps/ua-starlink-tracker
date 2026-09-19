const StarlinkTrackerLib = (() => {
  const API_BASES = Object.freeze({
    united: "https://unitedstarlinktracker.com",
    hub: "https://airlinestarlinktracker.com",
  });

  /**
   * Marketing carriers the tracker answers for. `marker` gates the free-text
   * fallback extractor: a bare "AS 123" in prose is only trusted when the
   * airline's name also appears in the card.
   */
  const TRACKED_CARRIERS = Object.freeze({
    UA: Object.freeze({ iata: "UA", airlineName: "United", marker: "United" }),
    HA: Object.freeze({ iata: "HA", airlineName: "Hawaiian", marker: "Hawaiian" }),
    AS: Object.freeze({ iata: "AS", airlineName: "Alaska", marker: "Alaska" }),
    QR: Object.freeze({ iata: "QR", airlineName: "Qatar", marker: "Qatar" }),
  });

  const CARRIER_CODES = Object.freeze(Object.keys(TRACKED_CARRIERS));
  const CARRIER_ALT = CARRIER_CODES.join("|");

  const FLIGHT_NUMBER_RE = new RegExp(`^(${CARRIER_ALT})\\d{1,4}$`);
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  function detectCarrier(flightNumber) {
    if (typeof flightNumber !== "string") return null;
    const m = flightNumber.toUpperCase().match(FLIGHT_NUMBER_RE);
    return m ? m[1] : null;
  }

  function isValidDate(date) {
    return typeof date === "string" && DATE_RE.test(date);
  }

  /**
   * Which endpoint answers a flight number.
   *
   * UA stays on the frozen per-airline /api/check-flight: it is the contract
   * maintained for this extension, and it is the only surface with the FR24
   * near-departure fallback (the hub disables reverse tail lookups) — moving
   * UA to the hub would silently degrade answers for the majority carrier.
   * Everything else goes to the hub's /api/check-any-flight, the designated
   * cross-carrier surface (resolves the marketing carrier server-side and
   * reports untracked carriers as a 200 error body).
   *
   * `version` rides along as `client=ext-<version>`: a service-worker fetch
   * carries the stock Chrome user agent, so without it the server cannot tell
   * extension traffic from a person on the website.
   *
   * `leg` ({origin, destination}) scopes the answer to the traveller's own leg
   * of a multi-leg flight number; it is re-validated here because it arrives
   * over extension messaging. Without one the URL is exactly the pre-2.1 URL.
   */
  function endpointFor(flightNumber, date, version, leg) {
    const carrier = detectCarrier(flightNumber);
    if (!carrier || !isValidDate(date)) return null;
    const fn = flightNumber.toUpperCase();
    let query = `flight_number=${encodeURIComponent(fn)}&date=${encodeURIComponent(date)}`;
    const scoped = legOf(leg);
    if (scoped) {
      query += `&origin=${scoped.origin}`;
      if (scoped.destination) query += `&destination=${scoped.destination}`;
    }
    if (typeof version === "string" && version.length > 0) {
      query += `&client=ext-${encodeURIComponent(version)}`;
    }
    return carrier === "UA"
      ? `${API_BASES.united}/api/check-flight?${query}`
      : `${API_BASES.hub}/api/check-any-flight?${query}`;
  }

  // ── flight extraction ──────────────────────────────────────────────────────

  // Google's Travel Impact Model link data: itinerary segments of the form
  // ORIGIN,DEST,CARRIER,NUMBER,YYYYMMDD (comma or dash separated). This is the
  // most drift-resistant hook on the page — it is semantic data Google itself
  // consumes, unlike the obfuscated class names.
  const TIM_SEGMENT_RE = /([A-Z]{3})[-,]([A-Z]{3})[-,]([A-Z][A-Z0-9])[-,](\d{1,4})[-,](\d{8})/g;

  function timDateToIso(yyyymmdd) {
    return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
  }

  /**
   * All itinerary segments in a Travel Impact Model URL — any carrier. A
   * through flight keeps one segment per leg even when both legs share a
   * number: each leg can fly a different aircraft.
   */
  function parseTimSegments(url) {
    if (typeof url !== "string") return [];
    const segments = [];
    const seen = new Set();
    for (const m of url.matchAll(TIM_SEGMENT_RE)) {
      const flightNumber = `${m[3]}${m[4]}`;
      const key = `${flightNumber}-${m[5]}-${m[1]}-${m[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      segments.push({
        origin: m[1],
        destination: m[2],
        carrier: m[3],
        flightNumber,
        date: timDateToIso(m[5]),
      });
    }
    return segments;
  }

  /**
   * Tracked segments across every Travel Impact Model URL on one card.
   *
   * `parsed` says whether ANY itinerary segment decoded, foreign carriers
   * included. That is the difference between the two empty results: an
   * itinerary that decoded and named no tracked carrier is an authoritative
   * "not ours" (heuristics would only add false positives), while nothing
   * decoding at all means the hook itself drifted and the heuristics are the
   * only thing left.
   *
   * `untrackedLegs` counts the distinct decoded legs on carriers we cannot
   * answer for. The weakest-leg rule only holds when every leg is judged, so a
   * card with any untracked leg must not be badged: dropping an AA leg from
   * AS+AS+AA would otherwise badge the whole trip "Starlink".
   */
  function timCardSegments(urls) {
    const segments = [];
    const untracked = new Set();
    let parsed = false;
    for (const url of Array.isArray(urls) ? urls : []) {
      for (const seg of parseTimSegments(url)) {
        parsed = true;
        if (!detectCarrier(seg.flightNumber)) {
          untracked.add(`${seg.flightNumber}-${seg.date}-${seg.origin}-${seg.destination}`);
          continue;
        }
        const sameLeg = (s) =>
          s.flightNumber === seg.flightNumber &&
          s.date === seg.date &&
          s.origin === seg.origin &&
          s.destination === seg.destination;
        if (segments.some(sameLeg)) continue;
        segments.push({
          flightNumber: seg.flightNumber,
          date: seg.date,
          origin: seg.origin,
          destination: seg.destination,
        });
      }
    }
    return { parsed, segments, untrackedLegs: untracked.size };
  }

  const AIRPORT_RE = /^[A-Z]{3}$/;

  /**
   * The leg a lookup may send: both airports when both are IATA-shaped and
   * differ, the origin alone when only it is, otherwise nothing. A leg that
   * lands where it departed is not a leg we can scope, and heuristic segments
   * carry no airports; both keep the unscoped lookup.
   */
  function legOf(seg) {
    if (!seg || typeof seg !== "object") return undefined;
    const origin = AIRPORT_RE.test(seg.origin ?? "") ? seg.origin : null;
    if (!origin) return undefined;
    if (!AIRPORT_RE.test(seg.destination ?? "")) return { origin };
    return seg.destination === origin ? undefined : { origin, destination: seg.destination };
  }

  /**
   * Tracked carriers whose airline name appears in a card's text. This is the
   * evidence gate both heuristic extractors run behind: "AS" and "HA" are
   * ordinary English tokens, and Google's obfuscated attribute soup is full of
   * two-letter fragments, so a code match only counts when the airline is
   * actually named on the card.
   */
  function carriersNamedIn(text) {
    if (typeof text !== "string" || text.length === 0) return [];
    return CARRIER_CODES.filter((code) => text.includes(TRACKED_CARRIERS[code].marker));
  }

  // Attribute forms observed in Google Flights markup: "UA-123-20250101",
  // "UA-123", "/UA/123/". Generalized from the v1 UA-only patterns; compiled
  // per code set (three of them at most) rather than per attribute value.
  const attrPatternCache = new Map();

  function attrPatterns(codes) {
    const key = codes.join("|");
    let patterns = attrPatternCache.get(key);
    if (!patterns) {
      patterns = [
        new RegExp(`\\b(${key})-(\\d{1,4})-\\d{8}\\b`),
        new RegExp(`\\b(${key})-(\\d{1,4})\\b`),
        new RegExp(`/(${key})/(\\d{1,4})/`),
      ];
      attrPatternCache.set(key, patterns);
    }
    return patterns;
  }

  /**
   * First flight number for one of `allowedCodes` in an attribute value, or
   * null. `allowedCodes` is required and fails closed: an ungated scan over
   * every attribute of a card matches things like "…;AS-12;…" in Google's
   * internal payloads and would badge a foreign carrier's card with a real
   * lookup for an unrelated flight.
   */
  function parseAttrFlightNumber(value, allowedCodes) {
    if (typeof value !== "string" || value.length > 4096) return null;
    if (!Array.isArray(allowedCodes)) return null;
    const codes = allowedCodes.filter((code) => CARRIER_CODES.includes(code));
    if (codes.length === 0) return null;
    // Substring prefilter before the regex loop: this runs over every attribute
    // of every element in a card, and the patterns can only match around
    // "XX-" or "/XX/".
    if (!codes.some((code) => value.includes(`${code}-`) || value.includes(`/${code}/`))) {
      return null;
    }
    for (const re of attrPatterns(codes)) {
      const m = value.match(re);
      if (m) return `${m[1]}${m[2]}`;
    }
    return null;
  }

  /**
   * Last-resort extraction from visible card text. Case-sensitive and gated on
   * the airline name appearing in the card (see carriersNamedIn).
   */
  function extractFlightNumbersFromText(text) {
    const found = [];
    for (const code of carriersNamedIn(text)) {
      const re = new RegExp(`\\b${code}\\s?(\\d{1,4})\\b`, "g");
      for (const m of text.matchAll(re)) {
        const fn = `${code}${m[1]}`;
        if (!found.includes(fn)) found.push(fn);
        if (found.length >= 4) return found;
      }
    }
    return found;
  }

  // ── claim ladder ───────────────────────────────────────────────────────────

  const PREDICTION_CONFIDENCES = Object.freeze(["high", "medium", "low"]);

  function unknownClaim() {
    return {
      status: "unknown",
      probability: null,
      predictionConfidence: null,
      nObservations: null,
      airline: null,
    };
  }

  /**
   * Map an API payload onto the claim ladder. Handles both wire shapes —
   * /api/check-flight (structured `prediction` object, ladder `confidence`)
   * and /api/check-any-flight (top-level `probability`, predictor-grade
   * `confidence`) — plus anything unexpected, which lands on `unknown`.
   * `hasStarlink: false` is a verified negative on both surfaces; null/absent
   * means "no assignment yet", never no.
   *
   * A probability with a non-prediction grade (`confidence: "type"` — the
   * registry-derived subfleet answer for carriers with no flight-history
   * model) stays on the predicted rung with a null grade: the number is real,
   * but it is not a history grade and must not be dressed up as one.
   */
  function normalizeClaim(payload) {
    const claim = unknownClaim();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return claim;
    if (typeof payload.airline === "string") claim.airline = payload.airline;
    if (payload.error !== undefined) return claim;
    // Tooltip only: grading below never reads it.
    const echoed = scopedLegEcho(payload.leg);
    if (echoed) claim.leg = echoed;
    // Equipment-type answers (QR) say where they came from: the published
    // schedule or observed-type history. Only those payloads carry `basis`,
    // so every other carrier's claim keeps its exact pre-2.1 shape.
    if (payload.basis === "schedule" || payload.basis === "history") {
      claim.basis = payload.basis;
      const type = Array.isArray(payload.flights) ? payload.flights[0]?.aircraft_type : null;
      claim.aircraftType = typeof type === "string" ? type.slice(0, 60) : null;
    }

    if (payload.hasStarlink === true) {
      claim.status = payload.confidence === "verified" ? "verified" : "installed";
      return claim;
    }
    if (payload.hasStarlink === false) {
      claim.status = "no_starlink";
      return claim;
    }

    const prediction =
      payload.prediction && typeof payload.prediction === "object" ? payload.prediction : null;
    const probability = prediction ? prediction.probability : payload.probability;
    if (typeof probability === "number" && Number.isFinite(probability)) {
      claim.status = "predicted";
      claim.probability = Math.min(1, Math.max(0, probability));
      const grade = prediction ? prediction.confidence : payload.confidence;
      if (PREDICTION_CONFIDENCES.includes(grade)) claim.predictionConfidence = grade;
      if (prediction && typeof prediction.n_observations === "number") {
        claim.nObservations = prediction.n_observations;
      } else if (claim.basis && typeof payload.n_recent_observations === "number") {
        claim.nObservations = payload.n_recent_observations;
      }
      return claim;
    }
    return claim;
  }

  /** The server's leg echo when the answer really is about that leg. */
  function scopedLegEcho(leg) {
    if (!leg || typeof leg !== "object") return null;
    if (leg.match === "unscoped" || !AIRPORT_RE.test(leg.origin ?? "")) return null;
    return {
      origin: leg.origin,
      destination: AIRPORT_RE.test(leg.destination ?? "") ? leg.destination : null,
    };
  }

  /**
   * Claim from a background-worker response envelope. A transport failure is
   * retryable (short cache); a parsed answer — even "untracked airline" — is
   * settled and cached at full TTL.
   */
  function claimFromResponse(response) {
    if (
      response &&
      response.success === true &&
      response.data &&
      typeof response.data === "object"
    ) {
      return { claim: normalizeClaim(response.data), retryable: false };
    }
    return { claim: unknownClaim(), retryable: true };
  }

  const CLAIM_RANK = Object.freeze({
    verified: 4,
    installed: 3,
    predicted: 2,
    no_starlink: 1,
    unknown: 0,
  });

  const GRADE_RANK = Object.freeze({ high: 0, medium: 1, low: 2 });

  /**
   * Combine per-segment claims for a multi-leg itinerary: the weakest rung
   * wins, so a card is never badged "Starlink" when only one leg has it. For
   * predicted legs the lowest probability and weakest grade carry through —
   * tracked separately, because the least-likely leg is not necessarily the
   * least-trusted one. Inheriting the min-probability leg's grade let a
   * high-probability/low-confidence leg (which shouldBadge suppresses on its
   * own) ride a sibling leg's "high" into a badge.
   *
   * An ungraded prediction (fleet/subfleet penetration, which carries a
   * probability but no history grade) leaves the grade alone: it is not
   * evidence of weakness, and it must not manufacture a grade either.
   */
  function combineClaims(claims) {
    if (!Array.isArray(claims) || claims.length === 0) return unknownClaim();
    let weakest = claims[0];
    for (const claim of claims.slice(1)) {
      if (CLAIM_RANK[claim.status] < CLAIM_RANK[weakest.status]) weakest = claim;
    }
    if (weakest.status !== "predicted") return { ...weakest };
    let combined = weakest;
    let grade = null;
    let gradeRank = -1;
    for (const claim of claims) {
      if (claim.status !== "predicted") continue;
      if (claim.probability < combined.probability) combined = claim;
      const rank = GRADE_RANK[claim.predictionConfidence];
      if (rank !== undefined && rank > gradeRank) {
        gradeRank = rank;
        grade = claim.predictionConfidence;
      }
    }
    return { ...combined, predictionConfidence: grade };
  }

  // Aircraft assignments only exist ~2 days out; above this historical rate a
  // "likely" badge beats silence, below it silence beats a coin-flip badge.
  const PREDICTION_BADGE_THRESHOLD = 0.8;

  function shouldBadge(claim) {
    if (!claim) return false;
    if (claim.status === "verified" || claim.status === "installed") return true;
    return (
      claim.status === "predicted" &&
      typeof claim.probability === "number" &&
      claim.probability >= PREDICTION_BADGE_THRESHOLD &&
      claim.predictionConfidence !== "low"
    );
  }

  // ── badge copy ─────────────────────────────────────────────────────────────

  function roundPct(probability) {
    return Math.round(probability * 100);
  }

  function badgeLabel(claim) {
    if (claim.status === "predicted") return `Starlink ~${roundPct(claim.probability)}%`;
    if (claim.status === "installed") return "Starlink (installed)";
    return "Starlink";
  }

  // Type-based answers name the evidence: which scheduled type, or how many
  // operating days the probability rests on. Never "verified" wording.
  function typeBasisTitle(claim) {
    const airline = claim.airline || "The airline";
    if (claim.status === "installed") {
      const type = claim.aircraftType ? ` (${claim.aircraftType})` : "";
      return `Scheduled aircraft${type} is a type ${airline} reports fully fitted with Starlink. A last-minute swap can change this.`;
    }
    if (claim.status === "predicted") {
      const days =
        typeof claim.nObservations === "number" && claim.nObservations > 0
          ? `${claim.nObservations} recent and scheduled operating days`
          : "recent operating days";
      if (claim.basis === "schedule") {
        const type = claim.aircraftType ? ` (${claim.aircraftType})` : "";
        return (
          `At least ~${roundPct(claim.probability)}% — scheduled on a fitted type${type}, ` +
          `but this flight has flown other aircraft on some of its ${days}. A swap can change this.`
        );
      }
      return (
        `At least ~${roundPct(claim.probability)}% — based on the aircraft types on ${days} ` +
        `of this flight. ${airline} publishes the actual aircraft about a week before departure.`
      );
    }
    return null;
  }

  function badgeTitle(claim) {
    const typeTitle = claim.basis ? typeBasisTitle(claim) : null;
    if (typeTitle) return typeTitle;
    const airline = claim.airline ? ` (${claim.airline})` : "";
    if (claim.status === "predicted") {
      const obs =
        typeof claim.nObservations === "number" && claim.nObservations > 0
          ? ` (${claim.nObservations} observed departure${claim.nObservations === 1 ? "" : "s"})`
          : "";
      return (
        `~${roundPct(claim.probability)}% chance this flight gets a Starlink-equipped ` +
        `aircraft${obs}${airline}. Airlines assign the actual aircraft ~2 days before departure.`
      );
    }
    if (claim.status === "installed") {
      return `Aircraft is Starlink-equipped per fleet data${airline} — not yet verified against the airline's site.`;
    }
    return `Verified Starlink WiFi${airline}`;
  }

  /**
   * Tooltip for a card's combined claim (from combineClaims over `claims`).
   * When the legs disagree it names the leg that set the badge, the weakest
   * one, so a traveller can see which leg the answer hinges on; legs that all
   * say the same thing name none. `flightNumber` is stamped on by the caller.
   */
  function cardBadgeTitle(combined, claims) {
    const title = badgeTitle(combined);
    const legs = Array.isArray(claims) ? claims : [];
    const disagree = legs.some(
      (c) => c.status !== combined.status || c.probability !== combined.probability
    );
    const { leg, flightNumber } = combined;
    if (!disagree || !leg || typeof flightNumber !== "string") return title;
    const route = leg.destination ? `${leg.origin}→${leg.destination}` : `from ${leg.origin}`;
    return `${flightNumber} ${route}: ${title}`;
  }

  function badgeClass(claim) {
    return `starlink-wifi-badge starlink-wifi-badge--${claim.status}`;
  }

  // Predicted/installed render in muted tones so an unverified claim never
  // carries verified visual weight.
  const BADGE_COLORS = Object.freeze({
    verified: Object.freeze({ fg: "#1967d2", bg: "#e8f0fe" }),
    installed: Object.freeze({ fg: "#188038", bg: "#e6f4ea" }),
    predicted: Object.freeze({ fg: "#5f6368", bg: "#f1f3f4" }),
  });

  function badgeColors(claim) {
    return BADGE_COLORS[claim.status] || BADGE_COLORS.predicted;
  }

  // ── caching policy ─────────────────────────────────────────────────────────

  // Settled answers hold for the browsing session's practical span; transport
  // failures retry soon so an API blip doesn't blank a whole search session.
  const CACHE_TTL = Object.freeze({
    resolved: 30 * 60 * 1000,
    error: 5 * 60 * 1000,
  });

  /** Today in the user's timezone — flight searches are local-date shaped. */
  function localTodayIso(now = new Date()) {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  // ── lookup and pass scheduling ─────────────────────────────────────────────

  /** One cache entry per leg; an unscoped lookup keeps the pre-2.1 key. */
  function claimKey(flightNumber, date, leg) {
    if (!leg) return `${flightNumber}-${date}`;
    return `${flightNumber}-${date}-${leg.origin}-${leg.destination || ""}`;
  }

  /**
   * Per-tab claim cache with in-flight dedupe. `send` is chrome.runtime
   * .sendMessage in the content script; it is injected so the dedupe that
   * keeps a pooled pass from double-fetching one flight is testable.
   *
   * The pending entry is registered before `send` runs: a send that throws
   * synchronously (invalidated extension context) used to settle and clear
   * its entry before the entry was set, leaving a resolved promise in the map
   * that shadowed every later retry.
   */
  function createClaimLookup(send, now = () => Date.now()) {
    const cache = new Map();
    const pending = new Map();

    function cached(key) {
      const entry = cache.get(key);
      if (entry && entry.expires > now()) return entry;
      if (entry) cache.delete(key);
      return null;
    }

    function isKnown(key) {
      return cached(key) !== null || pending.has(key);
    }

    function get(flightNumber, date, leg) {
      const key = claimKey(flightNumber, date, leg);
      const hit = cached(key);
      if (hit) return Promise.resolve(hit);
      const inflight = pending.get(key);
      if (inflight) return inflight;

      const message = leg
        ? {
            action: "checkFlight",
            flightNumber,
            date,
            origin: leg.origin,
            destination: leg.destination,
          }
        : { action: "checkFlight", flightNumber, date };
      const lookup = Promise.resolve()
        .then(() => send(message))
        .then(claimFromResponse, () => ({ claim: unknownClaim(), retryable: true }))
        .then((outcome) => {
          pending.delete(key);
          cache.set(key, {
            claim: outcome.claim,
            retryable: outcome.retryable,
            expires: now() + (outcome.retryable ? CACHE_TTL.error : CACHE_TTL.resolved),
          });
          return outcome;
        });
      pending.set(key, lookup);
      return lookup;
    }

    return { get, isKnown };
  }

  /**
   * Runs `worker` over `items` with at most `limit` in flight, starting them
   * strictly in order. Each start runs synchronously up to its first await, so
   * a worker that claims budget or registers a pending lookup before awaiting
   * is seen by the next worker exactly as in a serial loop.
   */
  async function runPool(items, limit, worker) {
    const queue = Array.from(items);
    let next = 0;
    const lane = async () => {
      while (next < queue.length) {
        const item = queue[next++];
        try {
          await worker(item);
        } catch {
          // one item must not stall its lane
        }
      }
    };
    const lanes = [];
    for (let i = 0; i < Math.min(Math.max(1, limit), queue.length); i++) lanes.push(lane());
    await Promise.all(lanes);
  }

  const MAX_RERUNS = 5;
  const RERUN_DELAY_MS = 250;

  /**
   * Serializes passes without dropping triggers. A trigger that lands while a
   * pass runs (Google appending "more flights" mid-pass) queues one rerun
   * instead of being discarded. Reruns are capped per burst; the cap resets
   * when a pass reports `{ newCards: 0 }` or on resetReruns() (navigation).
   */
  function createPassRunner(
    runPass,
    { maxReruns = MAX_RERUNS, delayMs = RERUN_DELAY_MS, schedule = setTimeout } = {}
  ) {
    let running = false;
    let rerunRequested = false;
    let rerunCount = 0;

    async function trigger() {
      if (running) {
        rerunRequested = true;
        return;
      }
      running = true;
      let result;
      try {
        result = await runPass();
      } catch {
        // a failed pass must not wedge the runner
      } finally {
        running = false;
      }
      if (result && result.newCards === 0) rerunCount = 0;
      if (rerunRequested && rerunCount++ < maxReruns) {
        rerunRequested = false;
        schedule(trigger, delayMs);
      } else {
        rerunRequested = false;
      }
    }

    return {
      trigger,
      isRunning: () => running,
      requestRerun: () => {
        rerunRequested = true;
      },
      resetReruns: () => {
        rerunCount = 0;
      },
    };
  }

  return {
    API_BASES,
    TRACKED_CARRIERS,
    CACHE_TTL,
    PREDICTION_BADGE_THRESHOLD,
    detectCarrier,
    isValidDate,
    endpointFor,
    parseTimSegments,
    timCardSegments,
    legOf,
    carriersNamedIn,
    parseAttrFlightNumber,
    extractFlightNumbersFromText,
    unknownClaim,
    normalizeClaim,
    claimFromResponse,
    combineClaims,
    shouldBadge,
    badgeLabel,
    badgeTitle,
    cardBadgeTitle,
    badgeClass,
    badgeColors,
    localTodayIso,
    claimKey,
    createClaimLookup,
    runPool,
    createPassRunner,
  };
})();

if (typeof module !== "undefined" && typeof module.exports !== "undefined") {
  module.exports = StarlinkTrackerLib;
}
if (typeof globalThis !== "undefined") {
  globalThis.StarlinkTrackerLib = StarlinkTrackerLib;
}
