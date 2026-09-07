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
   */
  function endpointFor(flightNumber, date) {
    const carrier = detectCarrier(flightNumber);
    if (!carrier || !isValidDate(date)) return null;
    const fn = flightNumber.toUpperCase();
    const query = `flight_number=${encodeURIComponent(fn)}&date=${encodeURIComponent(date)}`;
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

  /** All itinerary segments in a Travel Impact Model URL — any carrier. */
  function parseTimSegments(url) {
    if (typeof url !== "string") return [];
    const segments = [];
    const seen = new Set();
    for (const m of url.matchAll(TIM_SEGMENT_RE)) {
      const flightNumber = `${m[3]}${m[4]}`;
      const key = `${flightNumber}-${m[5]}`;
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
   */
  function timCardSegments(urls) {
    const segments = [];
    let parsed = false;
    for (const url of Array.isArray(urls) ? urls : []) {
      for (const seg of parseTimSegments(url)) {
        parsed = true;
        if (!detectCarrier(seg.flightNumber)) continue;
        if (segments.some((s) => s.flightNumber === seg.flightNumber && s.date === seg.date)) {
          continue;
        }
        segments.push({ flightNumber: seg.flightNumber, date: seg.date });
      }
    }
    return { parsed, segments };
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
      }
      return claim;
    }
    return claim;
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

  function badgeTitle(claim) {
    const airline = claim.airline ? ` (${claim.airline})` : "";
    if (claim.status === "predicted") {
      const obs =
        typeof claim.nObservations === "number" && claim.nObservations > 0
          ? ` (${claim.nObservations} recent departure${claim.nObservations === 1 ? "" : "s"} observed)`
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
    badgeClass,
    badgeColors,
    localTodayIso,
  };
})();

if (typeof module !== "undefined" && typeof module.exports !== "undefined") {
  module.exports = StarlinkTrackerLib;
}
if (typeof globalThis !== "undefined") {
  globalThis.StarlinkTrackerLib = StarlinkTrackerLib;
}
