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
    EI: Object.freeze({ iata: "EI", airlineName: "Aer Lingus", marker: "Aer Lingus" }),
    // Answered only for an aircraft type the card itself states (statesType):
    // the tracker holds no schedule for these, and the airline's statement is
    // about one type.
    VS: Object.freeze({
      iata: "VS",
      airlineName: "Virgin Atlantic",
      marker: "Virgin Atlantic",
      statesType: true,
      ownNames: Object.freeze(["Virgin Atlantic Airways", "Virgin Atlantic"]),
    }),
    SK: Object.freeze({
      iata: "SK",
      airlineName: "SAS",
      marker: "SAS",
      statesType: true,
      ownNames: Object.freeze(["Scandinavian Airlines System", "Scandinavian Airlines", "SAS"]),
    }),
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
  function endpointFor(flightNumber, date, version, leg, aircraftType) {
    const carrier = detectCarrier(flightNumber);
    if (!carrier || !isValidDate(date)) return null;
    const fn = flightNumber.toUpperCase();
    let query = `flight_number=${encodeURIComponent(fn)}&date=${encodeURIComponent(date)}`;
    const scoped = legOf(leg);
    if (scoped) {
      query += `&origin=${scoped.origin}`;
      if (scoped.destination) query += `&destination=${scoped.destination}`;
    }
    // Only for an airline answered by stated type, and re-validated: it
    // arrives over extension messaging. Without one the URL is the 2.4 URL.
    const type = TRACKED_CARRIERS[carrier].statesType ? typeOf(aircraftType) : null;
    if (type) query += `&aircraft_type=${encodeURIComponent(type)}`;
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
  // An airline code is two characters with at least one letter, and the letter
  // need not come first (6E, 9K, 3M): a leg this pattern cannot see is a leg
  // nobody judged, and its card would be badged on the other leg alone.
  const TIM_SEGMENT_RE =
    /([A-Z]{3})[-,]([A-Z]{3})[-,]([A-Z][A-Z0-9]|[0-9][A-Z])[-,](\d{1,4})[-,](\d{8})/g;

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

  // An aircraft type as a results card prints it, and nothing else: a field
  // is a type only when the whole field is one. A type is never cut out of a
  // longer run of text, since a cut type ("Airbus A350" out of "Airbus
  // A350/900") can read as another aircraft.
  const WHOLE_TYPE_RE =
    /^(?:Airbus A\d{3}(?:-\d{3,4})?(?:neo|XLR|LR)?|Boeing 7\d7(?:-\d{1,3}(?:ER|LR)?)?(?: MAX(?: \d{1,2})?)?|Embraer E?\d{3}(?:-E2)?|Bombardier CRJ ?\d{3,4}|Canadair RJ ?\d{3,4}|ATR ?\d{2}(?:-\d{3})?)$/;
  // Any sign that a field speaks of an aircraft. A field with one that is not
  // a whole type is a type we cannot read, and the card then states none.
  const AIRCRAFT_WORD_RE =
    /\b(?:airbus|boeing|embraer|bombardier|canadair|atr|de havilland|dash|saab|fokker|mcdonnell|douglas|comac|sukhoi|cessna|pilatus|beechcraft|dornier|tupolev|antonov|ilyushin|avro|bae|mitsubishi|crj|erj|dreamliner|a[23]\d{2}\w*)\b/i;
  // A field that would lengthen the type before it, whatever its form: "900",
  // "-1000", "neo", "(900)", "900 series", "Series 900", "F", "ULR". Wider
  // than the forms seen so far on purpose: a line refused by mistake costs a
  // badge, a variant missed turns an A350-900 into "Airbus A350".
  const TRAILING_VARIANT_RE =
    /^[-/]? ?(?:\d{3,4}[A-Za-z]{0,3}|neo|XLR|LR|ER|XWB|MAX(?: \d{1,2})?)$/i;
  // A field that opens with a joiner continues the line before it.
  const CONTINUES_RE = /^[-/\\([{<+~_,;:&]/;
  // Short suffixes count only as the field's first word; they are too common
  // inside ordinary text ("ER" in a name, "Max" in a baggage rule).
  const LEADING_SUFFIX_RE = /^[^A-Za-z0-9]*(?:F|LR|ER|MAX|ceo|neo)(?![A-Za-z0-9])/i;
  const VARIANT_WORD_RE =
    /(?<![A-Za-z0-9])(?:XWB|ULR|XLR|series|variant|version|family|freighter|sharklets?|winglets?|stretch(?:ed)?)(?![A-Za-z0-9])/i;
  // A three- or four-digit number is a variant ("900", "1000", "941",
  // "900ULR") unless it is plainly something else: a quantity with its unit,
  // or a clock time.
  const VARIANT_NUMBER_RE =
    /(?<![A-Za-z0-9.:])\d{3,4}[A-Za-z]{0,3}(?![A-Za-z0-9]|:\d| ?(?:kg|lbs?|min|mi|km|g|%)(?![A-Za-z]))/;
  // A flight number alone ("VS 4012") is the one field with such a number
  // that a card is known to print after its type.
  const FLIGHT_NUMBER_FIELD_RE = /^[A-Z0-9]{2} ?\d{1,4}$/;

  function lengthensType(field) {
    if (TRAILING_VARIANT_RE.test(field) || CONTINUES_RE.test(field)) return true;
    if (FLIGHT_NUMBER_FIELD_RE.test(field)) return false;
    return (
      LEADING_SUFFIX_RE.test(field) || VARIANT_WORD_RE.test(field) || VARIANT_NUMBER_RE.test(field)
    );
  }
  const TYPE_TEXT_RE = /^[A-Za-z0-9 -]{1,40}$/;
  const MAX_CARD_TEXT = 20000;

  const DASHES_RE = /[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g;
  const INVISIBLE_RE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;
  const FIELD_BREAK_RE = /[\n\r\v\f\u0085\u2028\u2029\u00b7\u2022\u2219\u22c5|]+/;

  /**
   * A card's text as fields: one per line or dot-separated part, with every
   * kind of space folded to a plain space and every kind of dash to a hyphen
   * first, so "A350" + no-break space + "900" is one field, not a type and a
   * stray number.
   */
  function cardFields(text) {
    if (typeof text !== "string" || text.length > MAX_CARD_TEXT) return null;
    return text
      .normalize("NFKC")
      .replace(INVISIBLE_RE, "")
      .replace(DASHES_RE, "-")
      .split(FIELD_BREAK_RE)
      .map((field) => field.replace(/\s+/g, " ").trim())
      .filter(Boolean);
  }

  function typeOf(value) {
    return typeof value === "string" && TYPE_TEXT_RE.test(value) ? value : null;
  }

  /** Does this flight number belong to an airline answered by stated type? */
  function wantsAircraftType(flightNumber) {
    const carrier = detectCarrier(flightNumber);
    return Boolean(carrier && TRACKED_CARRIERS[carrier].statesType);
  }

  // Words an operating-carrier line uses, and the shape "by Delta" / "for
  // United Express" / "as SAS Link". Wider than the one phrase on purpose: a
  // word matched by mistake costs a badge, a line missed gives a wrong one.
  const OPERATOR_WORD_RE =
    /\b(?:operat\w*|crew\w*|leas(?:e|ed|ing)|wet[- ]?leas\w*|code[- ]?shar\w*|behalf|dba|flown|partner\w*|subsidiar\w*|affiliat\w*|franchis\w*)\b|d\/b\/a|trading as|doing business/i;
  const BY_A_NAME_RE = /\b(?:[Bb][Yy]|[Ff][Oo][Rr]|[Aa][Ss])\s+\p{Lu}/u;
  const AIRLINE_WORD_RE = /\bair ?lines?\b|\bairways\b|\baviation\b/i;
  const ENGLISH_PAGE_RE = /^en(?:[-_]|$)/i;
  // Words an English results card prints and a card in another language does
  // not: the page's declared language alone is not trusted.
  const ENGLISH_CARD_RE =
    /\b(?:hr|legroom|emissions|layover|overnight|travel time|select flight)\b/i;

  function escapeRe(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Does any of this text name an airline other than `carrier`, or say that
   * someone flies the aircraft for it? English wording only: the caller reads
   * a type on an English page and on no other. "Operated by Virgin Atlantic"
   * as a whole field is the airline flying its own flight and is let through;
   * "Operated by SAS Connect" is not, since that names another operator.
   */
  function namesAnotherOperator(fields, carrier) {
    const own = TRACKED_CARRIERS[carrier].ownNames;
    const ownRe = new RegExp(`\\b(?:${own.map(escapeRe).join("|")})\\b`, "gi");
    const selfOperated = new RegExp(`^operated by (?:${own.map(escapeRe).join("|")})$`, "i");
    for (const field of fields) {
      if (selfOperated.test(field)) continue;
      if (OPERATOR_WORD_RE.test(field) || BY_A_NAME_RE.test(field)) return true;
      if (AIRLINE_WORD_RE.test(field.replace(ownRe, " "))) return true;
    }
    return false;
  }

  /**
   * The one aircraft type a card states for the flight `card.flightNumber`,
   * or null. Every doubt ends in no type, so in no badge:
   *
   *  - `card.decoded` must be true: the card's own itinerary data said how
   *    many flights it shows. A count guessed from text can be wrong, and the
   *    type could then be another flight's.
   *  - `card.segmentCount` must be 1: with two legs nothing says which leg a
   *    type belongs to.
   *  - `card.lang` must be English, and the card's own text must read as
   *    English. The airline's statement is about its own aircraft, so a card
   *    that names another operator must send nothing, and we can only
   *    recognise such a line in a language we read. Any other page language,
   *    or none, sends no type.
   *  - Neither the text nor `card.labels` (the card's aria-labels) may name
   *    another airline or operator (namesAnotherOperator).
   *  - Exactly one type, and every field that speaks of an aircraft must be a
   *    whole type we know: a type followed by anything (" 900", "/900",
   *    " (Sharklets)") is refused, never shortened, and so is a type whose
   *    next field would lengthen it (lengthensType).
   */
  function statedAircraftType(text, card) {
    if (!card || card.decoded !== true || card.segmentCount !== 1) return null;
    if (typeof card.lang !== "string" || !ENGLISH_PAGE_RE.test(card.lang)) return null;
    const carrier = detectCarrier(card.flightNumber);
    if (!carrier || !TRACKED_CARRIERS[carrier].statesType) return null;
    const fields = cardFields(text);
    const labels = cardFields(card.labels ?? "");
    if (!fields || !labels) return null;
    if (!fields.some((field) => ENGLISH_CARD_RE.test(field))) return null;
    if (namesAnotherOperator(fields, carrier) || namesAnotherOperator(labels, carrier)) return null;

    const found = new Set();
    for (let i = 0; i < fields.length; i++) {
      if (WHOLE_TYPE_RE.test(fields[i])) {
        if (i + 1 < fields.length && lengthensType(fields[i + 1])) return null;
        found.add(fields[i]);
      } else if (AIRCRAFT_WORD_RE.test(fields[i])) {
        return null;
      }
    }
    if (found.size !== 1) return null;
    return typeOf([...found][0]);
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
   * but it is not a history grade and must not be dressed up as one. It is
   * marked `typeShare` for the tooltip: the number is the fitted share of the
   * aircraft that fly such a flight, which says nothing about this flight's
   * past departures or about when an aircraft gets assigned.
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

    // An airline answered from its own dated statement: by route (Aer
    // Lingus), or for the aircraft type the card states (Virgin Atlantic,
    // SAS). Only "likely" is a claim; every other answer ("needs_route",
    // "needs_type", another type, a date outside it) stays unknown, never a no.
    const statement = payload.airline_statement;
    if (statement && typeof statement === "object") {
      if (statement.answer === "likely" && typeof statement.quote === "string") {
        claim.status = "stated";
        claim.statement = {
          quote: statement.quote.slice(0, 200),
          asOf: DATE_RE.test(statement.as_of ?? "") ? statement.as_of : null,
          // An undated page: the date is the day it was read, not said.
          checked: statement.as_of_kind === "checked",
          statedType: statement.by === "aircraft_type" ? typeOf(statement.aircraft_type) : null,
        };
        const caution =
          statement.by === "aircraft_type" ? statedCaution(payload.reason, claim.airline) : null;
        if (caution) claim.statement.caution = caution;
      }
      return claim;
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
      else if (!prediction && grade === "type") claim.typeShare = true;
      if (prediction && typeof prediction.n_observations === "number") {
        claim.nObservations = prediction.n_observations;
      } else if (claim.basis && typeof payload.n_recent_observations === "number") {
        claim.nObservations = payload.n_recent_observations;
      }
      return claim;
    }
    return claim;
  }

  const OUR_OWN_WORDS = " We go by the aircraft type";

  /**
   * The airline's own caution about the aircraft its claim covers ("The same
   * page says that availability may vary …"), read out of the server's
   * sentence for a type yes: the wire key has no field for it. The server
   * puts it between the airline's claim and the tracker's own words. With no
   * caution the sentence there is the claim itself, which opens with the
   * airline's name. tests/extension-page.test.ts and the type rule's tests
   * hold this to the server's real answer.
   */
  function statedCaution(reason, airline) {
    if (typeof reason !== "string" || typeof airline !== "string" || !airline) return null;
    const end = reason.indexOf(OUR_OWN_WORDS);
    if (end <= 0 || reason[end - 1] !== ".") return null;
    const before = reason.slice(0, end);
    // The sentence before it must itself follow one: the claim always does.
    const start = before.lastIndexOf(". ", before.length - 2);
    if (start < 0) return null;
    const sentence = before.slice(start + 2);
    if (sentence.startsWith(airline) || sentence.length > 240) return null;
    return sentence;
  }

  /**
   * The server's leg echo, only when the answer is about exactly that leg.
   * On "origin", "unmatched" and "no_data" the server found nothing (or a
   * different hop) for the requested leg and answered for the flight number,
   * so a tooltip naming the leg would assert odds the server disclaimed.
   */
  function scopedLegEcho(leg) {
    if (!leg || typeof leg !== "object") return null;
    if (leg.match !== "exact" || !AIRPORT_RE.test(leg.origin ?? "")) return null;
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
    verified: 5,
    installed: 4,
    // The airline's word for a route: weaker than an aircraft we can name,
    // firmer than odds.
    stated: 3,
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
    if (claim.status === "stated") return true;
    return (
      claim.status === "predicted" &&
      typeof claim.probability === "number" &&
      claim.probability >= PREDICTION_BADGE_THRESHOLD &&
      claim.predictionConfidence !== "low"
    );
  }

  // Below a badge, odds that are still better than even are a "maybe": the
  // answer most often there is a sound number held off the badge on purpose
  // (a "low" grade for a date in the next schedule season, or a type share
  // just under the bar), and it is not the same answer as a no.
  const MAYBE_THRESHOLD = 0.5;

  /**
   * Where "Starlink only" puts a card:
   *   "starlink": badged, left alone
   *   "maybe":    odds of at least MAYBE_THRESHOLD and no badge, dimmed lightly
   *   "no":       a verified no or lower odds, dimmed
   *   null:       unknown (untracked carrier, outage, no data yet); never
   *               dimmed, because there is no answer to filter on
   */
  function filterTier(claim) {
    if (!claim) return null;
    if (shouldBadge(claim)) return "starlink";
    if (claim.status === "no_starlink") return "no";
    if (claim.status !== "predicted") return null;
    return typeof claim.probability === "number" && claim.probability >= MAYBE_THRESHOLD
      ? "maybe"
      : "no";
  }

  // ── badge copy ─────────────────────────────────────────────────────────────

  // The site prints a percentage by two rules, and the badge follows whichever
  // one the site uses for the same answer, so a traveller reads one number in
  // both places. Equipment-type answers (`basis`, Qatar) are rounded down, as
  // the server's sentence is: a lower bound must not be rounded past itself.
  // Everything else (United's history odds, an Alaska subfleet's share) is
  // rounded to the nearest whole number, as the site's pages do. Only a share
  // that is exactly the whole subfleet reads 100; odds never do.
  function wholePct(claim) {
    const p = claim.probability;
    if (p >= 1) return claim.typeShare ? 100 : 99;
    if (claim.basis) return Math.floor(p * 100);
    return Math.min(99, Math.round(p * 100));
  }

  // A share of aircraft, in words, with the site's edges: "all" only for a
  // whole subfleet, and "over 99%" where the site prints ">99%".
  function shareWords(claim) {
    if (claim.probability >= 1) return "all";
    if (!claim.basis && claim.probability > 0.99) return "over 99%";
    return `about ${wholePct(claim)}%`;
  }

  function capitalize(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function badgeLabel(claim) {
    if (claim.status === "predicted") return `Starlink ~${wholePct(claim)}%`;
    if (claim.status === "installed") return "Starlink (installed)";
    if (claim.status === "stated") return "Starlink (likely)";
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
    if (claim.status === "predicted" && claim.typeShare) {
      if (claim.basis !== "schedule") return null;
      const type = claim.aircraftType ? ` (${claim.aircraftType})` : "";
      const fleet = claim.airline ? `the ${claim.airline} fleet` : "the airline's fleet";
      return (
        `Scheduled aircraft type${type}: ${shareWords(claim)} of that type in ${fleet} ` +
        `counts as fitted with Starlink. ${airline} doesn't say which aircraft flies, and a swap can change the type.`
      );
    }
    if (claim.status === "predicted") {
      const days =
        typeof claim.nObservations === "number" && claim.nObservations > 0
          ? `${claim.nObservations} recent and scheduled operating days`
          : "recent operating days";
      if (claim.basis === "schedule") {
        const type = claim.aircraftType ? ` (${claim.aircraftType})` : "";
        return (
          `At least ~${wholePct(claim)}% — scheduled on a fitted type${type}, ` +
          `but this flight has flown other aircraft on some of its ${days}. A swap can change this.`
        );
      }
      return (
        `At least ~${wholePct(claim)}% — based on the aircraft types on ${days} ` +
        `of this flight. ${airline} publishes the actual aircraft about a week before departure.`
      );
    }
    return null;
  }

  function badgeTitle(claim) {
    const typeTitle = claim.basis ? typeBasisTitle(claim) : null;
    if (typeTitle) return typeTitle;
    if (claim.status === "stated") {
      // The airline's own sentence, quoted: the tracker holds no aircraft or
      // schedule for this airline, so it adds nothing of its own.
      const who = claim.airline || "The airline";
      const asOf = claim.statement?.asOf;
      const said = claim.statement?.checked
        ? `${who}'s own page${asOf ? `, checked ${asOf},` : ""} says`
        : `${who} said${asOf ? ` on ${asOf}` : ""},`;
      const quoted = `${said} "${claim.statement?.quote ?? ""}"`;
      const type = claim.statement?.statedType;
      if (type) {
        return (
          `Likely Starlink, only if this flight stays on the ${type} this card shows: ${quoted} ` +
          `${claim.statement.caution ? `${claim.statement.caution} ` : ""}The tracker goes by the type on the card alone and holds no ${who} schedule. That holds for an aircraft ${who} itself flies, not a partner airline's, and an aircraft change can alter it.`
        );
      }
      return (
        `Likely Starlink: ${quoted} ` +
        `That holds for flights ${who} itself operates, not a partner airline's, and a last-minute aircraft change can alter it.`
      );
    }
    const airline = claim.airline ? ` (${claim.airline})` : "";
    if (claim.status === "predicted" && claim.typeShare) {
      // True at any distance from departure: the hub gives this answer
      // whenever it has no aircraft on file for the flight, the day before too.
      const share = capitalize(shareWords(claim));
      const whose = claim.airline || "airline's";
      return `${share} of the ${whose} aircraft that fly flights like this one have Starlink. The tracker has no specific aircraft on file for this flight.`;
    }
    if (claim.status === "predicted") {
      const obs =
        typeof claim.nObservations === "number" && claim.nObservations > 0
          ? ` (${claim.nObservations} observed departure${claim.nObservations === 1 ? "" : "s"})`
          : "";
      return (
        `~${wholePct(claim)}% chance this flight gets a Starlink-equipped ` +
        `aircraft${obs}${airline}. Airlines assign the actual aircraft ~2 days before departure.`
      );
    }
    if (claim.status === "installed") {
      return `Aircraft is Starlink-equipped per fleet data${airline} — not yet verified against the airline's site.`;
    }
    return `Verified Starlink WiFi${airline}: the aircraft assigned to this flight was confirmed Starlink-equipped on the airline's own site. A last-minute swap can change this.`;
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
    if (!disagree || typeof flightNumber !== "string") return title;
    if (!leg) return `${flightNumber}: ${title}`;
    const route = leg.destination ? `${leg.origin}→${leg.destination}` : `from ${leg.origin}`;
    return `${flightNumber} ${route}: ${title}`;
  }

  /**
   * What a pass owes a card it already settled. Google re-renders result
   * cards in place (expanding one rebuilds every card's contents), which
   * strips badges from cards a pass has retired, and it can patch a different
   * itinerary into the same element. `entry` is what the card was settled
   * with ({signature, badged}); `signature` is its itinerary now.
   *   "process": never settled, or it now shows a different itinerary
   *   "restore": same itinerary, but the page removed its badge
   *   "skip":    nothing to do
   */
  function settledCardAction(entry, signature, hasBadge) {
    if (!entry || entry.signature !== signature) return "process";
    if (entry.badged && !hasBadge) return "restore";
    return "skip";
  }

  function badgeClass(claim) {
    return `starlink-wifi-badge starlink-wifi-badge--${claim.status}`;
  }

  // Predicted/installed render in muted tones so an unverified claim never
  // carries verified visual weight.
  const BADGE_COLORS = Object.freeze({
    verified: Object.freeze({ fg: "#1967d2", bg: "#e8f0fe" }),
    installed: Object.freeze({ fg: "#188038", bg: "#e6f4ea" }),
    stated: Object.freeze({ fg: "#5f6368", bg: "#f1f3f4" }),
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

  /** One cache entry per leg, and per stated aircraft type; an unscoped
   * lookup keeps the pre-2.1 key. */
  function claimKey(flightNumber, date, leg, aircraftType) {
    const type = aircraftType ? `-type:${aircraftType}` : "";
    if (!leg) return `${flightNumber}-${date}${type}`;
    return `${flightNumber}-${date}-${leg.origin}-${leg.destination || ""}${type}`;
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

    function get(flightNumber, date, leg, aircraftType) {
      const key = claimKey(flightNumber, date, leg, aircraftType);
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
      if (aircraftType) message.aircraftType = aircraftType;
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
    wantsAircraftType,
    statedAircraftType,
    carriersNamedIn,
    parseAttrFlightNumber,
    extractFlightNumbersFromText,
    unknownClaim,
    normalizeClaim,
    claimFromResponse,
    combineClaims,
    shouldBadge,
    filterTier,
    badgeLabel,
    badgeTitle,
    cardBadgeTitle,
    settledCardAction,
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
