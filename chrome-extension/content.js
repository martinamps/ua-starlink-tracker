/**
 * Google Flights content script. Finds flight cards, resolves each tracked
 * flight to a claim-ladder answer via the background worker, and renders a
 * compact badge for verified / installed / high-probability-predicted flights.
 *
 * Resilience posture: Google's class names are obfuscated and churn, so
 * discovery leans on the semantic Travel Impact Model data attribute first
 * and treats every class-name selector as an optional fast path. Any failure
 * — markup drift, API outage, extension reload — degrades to "no badge",
 * never to a wrong badge or an error surfaced to the page.
 */

(() => {
  const lib = typeof globalThis !== "undefined" ? globalThis.StarlinkTrackerLib : null;
  if (!lib || typeof chrome === "undefined" || !chrome.runtime) return;

  const DEBUG = false;
  const log = (...args) => DEBUG && console.log("[Starlink Tracker]", ...args);

  // Google Flights result-card class — an optional fast path, not a
  // requirement: the TIM attribute anchor below survives class renames.
  const LEGACY_CARD_SELECTOR = ".pIav2d";
  const TIM_ATTR = "data-travelimpactmodelwebsiteurl";
  const CARD_HINT_SELECTOR = `${LEGACY_CARD_SELECTOR},[${TIM_ATTR}]`;

  // Caps a runaway pass (selector drift matching everything) before it can
  // hammer the API; unbadged cards are retried by later passes.
  const MAX_NEW_LOOKUPS_PER_PASS = 40;
  const MAX_SEGMENTS_PER_CARD = 4;
  const MAX_ATTR_SCAN_ELEMENTS = 400;

  const claimCache = new Map();
  const pendingLookups = new Map();
  let processedElements = new WeakSet();
  let isProcessing = false;

  // ── claim lookup ───────────────────────────────────────────────────────────

  function cachedClaim(key) {
    const entry = claimCache.get(key);
    if (entry && entry.expires > Date.now()) return entry.claim;
    if (entry) claimCache.delete(key);
    return null;
  }

  function getClaim(flightNumber, date) {
    const key = `${flightNumber}-${date}`;
    const cached = cachedClaim(key);
    if (cached) return Promise.resolve(cached);
    const pending = pendingLookups.get(key);
    if (pending) return pending;

    const lookup = (async () => {
      let outcome;
      try {
        const response = await chrome.runtime.sendMessage({
          action: "checkFlight",
          flightNumber,
          date,
        });
        outcome = lib.claimFromResponse(response);
      } catch (err) {
        // Worker restart or invalidated context — honest unknown, retry soon.
        log("lookup failed", flightNumber, err);
        outcome = { claim: lib.unknownClaim(), retryable: true };
      } finally {
        pendingLookups.delete(key);
      }
      claimCache.set(key, {
        claim: outcome.claim,
        expires: Date.now() + (outcome.retryable ? lib.CACHE_TTL.error : lib.CACHE_TTL.resolved),
      });
      return outcome.claim;
    })();
    pendingLookups.set(key, lookup);
    return lookup;
  }

  // ── page/card parsing ──────────────────────────────────────────────────────

  function extractPageDate() {
    try {
      for (const el of document.querySelectorAll(`[${TIM_ATTR}]`)) {
        const segments = lib.parseTimSegments(el.getAttribute(TIM_ATTR) || "");
        if (segments.length) return segments[0].date;
      }
      const hashMatch = window.location.hash.match(/;d:(\d{4}-\d{2}-\d{2})/);
      if (hashMatch) return hashMatch[1];
    } catch {
      // fall through to today
    }
    return lib.localTodayIso();
  }

  /** A stable per-result element: the enclosing <li> when there is one. */
  function canonicalCard(el) {
    return el.closest("li") || el;
  }

  function findFlightCards() {
    const cards = new Set();
    for (const el of document.querySelectorAll(CARD_HINT_SELECTOR)) {
      cards.add(canonicalCard(el));
    }
    return cards;
  }

  /**
   * Flight segments for one card as [{flightNumber, date|null}], most-reliable
   * source first. A card WITH itinerary data but no tracked segment returns []
   * without consulting the heuristics — the itinerary already settled "not a
   * tracked airline", and a text match on top of that would be a false positive.
   */
  function extractSegments(card) {
    const timEls = [];
    if (card.hasAttribute?.(TIM_ATTR)) timEls.push(card);
    timEls.push(...card.querySelectorAll(`[${TIM_ATTR}]`));
    if (timEls.length > 0) {
      const segments = [];
      for (const el of timEls) {
        for (const seg of lib.parseTimSegments(el.getAttribute(TIM_ATTR) || "")) {
          if (!lib.detectCarrier(seg.flightNumber)) continue;
          if (segments.some((s) => s.flightNumber === seg.flightNumber && s.date === seg.date)) {
            continue;
          }
          segments.push({ flightNumber: seg.flightNumber, date: seg.date });
        }
      }
      return segments.slice(0, MAX_SEGMENTS_PER_CARD);
    }

    const elements = card.querySelectorAll("*");
    const scanLimit = Math.min(elements.length, MAX_ATTR_SCAN_ELEMENTS);
    for (let i = 0; i < scanLimit; i++) {
      for (const attr of elements[i].attributes) {
        const flightNumber = lib.parseAttrFlightNumber(attr.value);
        if (flightNumber) return [{ flightNumber, date: null }];
      }
    }

    const text = `${card.innerText || ""} ${
      card.querySelector("[aria-label]")?.getAttribute("aria-label") || ""
    }`;
    return lib
      .extractFlightNumbersFromText(text)
      .slice(0, MAX_SEGMENTS_PER_CARD)
      .map((flightNumber) => ({ flightNumber, date: null }));
  }

  // ── badge rendering ────────────────────────────────────────────────────────

  function buildBadge(claim) {
    const colors = lib.badgeColors(claim);
    const badge = document.createElement("span");
    badge.className = lib.badgeClass(claim);
    badge.title = lib.badgeTitle(claim);
    badge.textContent = lib.badgeLabel(claim);
    badge.style.cssText = [
      "margin-left: 12px",
      "display: inline-flex",
      "align-items: center",
      "font-size: 13px",
      `color: ${colors.fg}`,
      `background: ${colors.bg}`,
      "padding: 2px 10px",
      "border-radius: 12px",
      "font-weight: 500",
    ].join("; ");
    return badge;
  }

  // v1's exact insertion point, kept as a fast path while the classes exist.
  function insertInline(card, badge) {
    const timeContainer = card.querySelector(".zxVSec.YMlIz.tPgKwe.ogfYpf");
    const timeSpan = timeContainer?.querySelector("span.mv1WYe");
    if (!timeSpan || !timeSpan.parentNode) return false;
    timeSpan.parentNode.insertBefore(badge, timeSpan.nextSibling);
    return true;
  }

  // Layout-independent fallback: pin to the result row's corner. Needs no
  // knowledge of the card's internals, so it survives markup drift.
  function insertCorner(card, badge, claim) {
    const row = card.closest("li") || card;
    const colors = lib.badgeColors(claim);
    row.style.position = "relative";
    badge.style.cssText = [
      "position: absolute",
      "top: -3px",
      "left: -6px",
      "display: inline-flex",
      "align-items: center",
      "font-size: 9px",
      `color: ${colors.fg}`,
      `background: ${colors.bg}`,
      "padding: 1px 5px",
      "border-radius: 8px",
      "font-weight: 500",
      "white-space: nowrap",
      "z-index: 10",
      "box-shadow: 0 1px 2px rgba(0,0,0,0.08)",
    ].join("; ");
    row.insertBefore(badge, row.firstChild);
  }

  function addBadge(card, claim) {
    try {
      if (card.querySelector(".starlink-wifi-badge")) return;
      const badge = buildBadge(claim);
      const wantInline = window.innerWidth >= 1024;
      if (wantInline && insertInline(card, badge)) return;
      insertCorner(card, badge, claim);
    } catch (err) {
      log("badge insert failed", err);
    }
  }

  // ── main pass ──────────────────────────────────────────────────────────────

  async function processCard(card, pageDate, budget) {
    const segments = extractSegments(card);
    if (segments.length === 0) {
      // Nothing tracked here (authoritative or not) — settled for this card.
      processedElements.add(card);
      return false;
    }

    // Respect the per-pass network budget BEFORE marking processed, so
    // skipped cards get picked up by a later pass.
    for (const seg of segments) {
      const key = `${seg.flightNumber}-${seg.date || pageDate}`;
      if (!cachedClaim(key) && !pendingLookups.has(key)) {
        if (budget.remaining <= 0) return false;
        budget.remaining--;
      }
    }
    processedElements.add(card);

    const claims = await Promise.all(
      segments.map((seg) => getClaim(seg.flightNumber, seg.date || pageDate))
    );
    const combined = lib.combineClaims(claims);
    if (lib.shouldBadge(combined)) {
      addBadge(card, combined);
      log("badged", segments.map((s) => s.flightNumber).join("+"), combined.status);
    }
    return true;
  }

  async function processFlights() {
    if (isProcessing) return;
    isProcessing = true;
    try {
      const pageDate = extractPageDate();
      const budget = { remaining: MAX_NEW_LOOKUPS_PER_PASS };
      const cards = findFlightCards();
      log(`pass: ${cards.size} cards`);
      for (const card of cards) {
        if (processedElements.has(card)) continue;
        try {
          await processCard(card, pageDate, budget);
        } catch (err) {
          // One broken card must not stop the pass or reach the page.
          log("card failed", err);
        }
      }
    } catch (err) {
      log("pass failed", err);
    } finally {
      isProcessing = false;
    }
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  function debounce(fn, wait) {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn(...args), wait);
    };
  }

  function reprocessAllFlights() {
    try {
      for (const badge of document.querySelectorAll(".starlink-wifi-badge")) {
        badge.remove();
      }
    } catch {
      // removal is cosmetic; keep going
    }
    processedElements = new WeakSet();
    processFlights();
  }

  function initialize() {
    setTimeout(processFlights, 1000);
    const debouncedProcess = debounce(processFlights, 2000);

    const looksLikeFlightNode = (node) =>
      node.nodeType === 1 &&
      (node.matches?.(CARD_HINT_SELECTOR) || node.querySelector?.(CARD_HINT_SELECTOR) != null);

    const observer = new MutationObserver((mutations) => {
      try {
        if (isProcessing) return;
        const hasNewFlights = mutations.some((mutation) =>
          Array.from(mutation.addedNodes).some(looksLikeFlightNode)
        );
        if (hasNewFlights) debouncedProcess();
      } catch {
        // observer callbacks must never throw into the page
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Badge placement differs across the desktop/mobile breakpoint.
    let lastWidth = window.innerWidth;
    window.addEventListener(
      "resize",
      debounce(() => {
        const wasDesktop = lastWidth >= 1024;
        lastWidth = window.innerWidth;
        if (wasDesktop !== lastWidth >= 1024) reprocessAllFlights();
      }, 500)
    );

    // SPA navigation never fires load events — poll the URL.
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        processedElements = new WeakSet();
        setTimeout(processFlights, 1000);
      }
    }, 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize);
  } else {
    initialize();
  }
})();
