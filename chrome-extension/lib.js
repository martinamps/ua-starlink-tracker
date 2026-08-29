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

  // Attribute forms observed in Google Flights markup: "UA-123-20250101",
  // "UA-123", "/UA/123/". Generalized from the v1 UA-only patterns.
  const ATTR_PATTERNS = [
    new RegExp(`\\b(${CARRIER_ALT})-(\\d{1,4})-\\d{8}\\b`),
    new RegExp(`\\b(${CARRIER_ALT})-(\\d{1,4})\\b`),
    new RegExp(`/(${CARRIER_ALT})/(\\d{1,4})/`),
  ];

  /** First tracked-carrier flight number in an attribute value, or null. */
  function parseAttrFlightNumber(value) {
    if (typeof value !== "string" || value.length > 4096) return null;
    for (const re of ATTR_PATTERNS) {
      const m = value.match(re);
      if (m) return `${m[1]}${m[2]}`;
    }
    return null;
  }

  /**
   * Last-resort extraction from visible card text. Case-sensitive and gated on
   * the airline name appearing in the card — "AS" and "HA" are common English
   * words/abbreviations, so a bare code match is not evidence by itself.
   */
  function extractFlightNumbersFromText(text) {
    if (typeof text !== "string" || text.length === 0) return [];
    const found = [];
    for (const code of CARRIER_CODES) {
      if (!text.includes(TRACKED_CARRIERS[code].marker)) continue;
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

  /**
   * Combine per-segment claims for a multi-leg itinerary: the weakest rung
   * wins, so a card is never badged "Starlink" when only one leg has it. For
   * predicted legs the lowest probability and weakest grade carry through.
   */
  function combineClaims(claims) {
    if (!Array.isArray(claims) || claims.length === 0) return unknownClaim();
    let weakest = claims[0];
    for (const claim of claims.slice(1)) {
      if (CLAIM_RANK[claim.status] < CLAIM_RANK[weakest.status]) weakest = claim;
    }
    if (weakest.status !== "predicted") return { ...weakest };
    let combined = weakest;
    for (const claim of claims) {
      if (claim.status !== "predicted") continue;
      if (claim.probability < combined.probability) combined = claim;
    }
    return { ...combined };
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
