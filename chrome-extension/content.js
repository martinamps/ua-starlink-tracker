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

  const lookup = lib.createClaimLookup((message) => chrome.runtime.sendMessage(message));
  let processedElements = new WeakSet();
  // Bumped on every navigation; a pass that started under an older generation
  // must not badge (or retire) cards that now show a different search.
  let generation = 0;

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

  /** Every Travel Impact Model URL carried by a card, itself included. */
  function timUrls(card) {
    const urls = card.hasAttribute?.(TIM_ATTR) ? [card.getAttribute(TIM_ATTR) || ""] : [];
    for (const el of card.querySelectorAll(`[${TIM_ATTR}]`)) {
      urls.push(el.getAttribute(TIM_ATTR) || "");
    }
    return urls;
  }

  function cardText(card) {
    return `${card.innerText || ""} ${
      card.querySelector("[aria-label]")?.getAttribute("aria-label") || ""
    }`;
  }

  function attrFlightNumber(card, codes) {
    const elements = card.querySelectorAll("*");
    const scanLimit = Math.min(elements.length, MAX_ATTR_SCAN_ELEMENTS);
    for (let i = 0; i < scanLimit; i++) {
      for (const attr of elements[i].attributes) {
        const flightNumber = lib.parseAttrFlightNumber(attr.value, codes);
        if (flightNumber) return flightNumber;
      }
    }
    return null;
  }

  /**
   * Flight segments for one card as {segments: [{flightNumber, date|null}],
   * complete}, most-reliable source first. `complete` is false when the
   * itinerary has a leg we cannot judge (untracked carrier, or more legs than
   * we look up): the weakest-leg rule cannot vouch for such a card, so it gets
   * no badge. The heuristic paths only ever see our own carriers and are
   * treated as complete.
   *
   * A card whose itinerary data DECODED but named no tracked carrier returns no
   * segments without consulting the heuristics — the itinerary already settled
   * "not a tracked airline", and a text match on top of that would be a false
   * positive.
   * When nothing decodes (the attribute is absent, or Google changed the
   * itinerary encoding) the heuristics still run: gating them on the attribute's
   * mere presence made an encoding change silently badge nothing, which is the
   * drift this extractor exists to survive.
   */
  function extractSegments(card) {
    const tim = lib.timCardSegments(timUrls(card));
    if (tim.parsed) {
      return {
        segments: tim.segments.slice(0, MAX_SEGMENTS_PER_CARD),
        complete: tim.untrackedLegs === 0 && tim.segments.length <= MAX_SEGMENTS_PER_CARD,
      };
    }

    // Both heuristics run behind the airline-name gate: only carriers actually
    // named on the card may be matched out of its text or attribute soup.
    const text = cardText(card);
    const codes = lib.carriersNamedIn(text);
    if (codes.length === 0) return { segments: [], complete: true };

    const flightNumber = attrFlightNumber(card, codes);
    if (flightNumber) return { segments: [{ flightNumber, date: null }], complete: true };

    return {
      segments: lib
        .extractFlightNumbersFromText(text)
        .slice(0, MAX_SEGMENTS_PER_CARD)
        .map((fn) => ({ flightNumber: fn, date: null })),
      complete: true,
    };
  }

  // ── badge rendering ────────────────────────────────────────────────────────

  function buildBadge(claim, title) {
    const colors = lib.badgeColors(claim);
    const badge = document.createElement("span");
    badge.className = lib.badgeClass(claim);
    badge.title = title;
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

  function removeBadge(card) {
    try {
      card.querySelector(".starlink-wifi-badge")?.remove();
    } catch {
      // removal is cosmetic
    }
  }

  /** `key` names the itinerary the badge answers for, so a card Google
   * patches in place with a different flight never keeps the old answer. */
  function addBadge(card, claim, key, title) {
    try {
      const existing = card.querySelector(".starlink-wifi-badge");
      if (existing) {
        if (
          existing.dataset.starlinkKey === key &&
          existing.dataset.starlinkStatus === claim.status
        ) {
          return;
        }
        existing.remove();
      }
      const badge = buildBadge(claim, title);
      badge.dataset.starlinkKey = key;
      badge.dataset.starlinkStatus = claim.status;
      const wantInline = window.innerWidth >= 1024;
      if (wantInline && insertInline(card, badge)) return;
      insertCorner(card, badge, claim);
    } catch (err) {
      log("badge insert failed", err);
    }
  }

  // ── main pass ──────────────────────────────────────────────────────────────

  // Lookups per pass run this many cards at a time: a pass used to cost the
  // sum of every lookup's latency, and one FR24-fallback flight (~2 s) held up
  // every card behind it.
  const CARD_CONCURRENCY = 3;

  /** True when the card needs no further passes. */
  async function processCard(card, pageDate, budget, gen) {
    const { segments, complete } = extractSegments(card);
    if (segments.length === 0 || !complete) {
      // Nothing tracked here, or a leg we cannot judge — settled for this card.
      removeBadge(card);
      processedElements.add(card);
      return true;
    }

    // Each TIM leg is its own lookup, two legs sharing a number included:
    // they can fly different aircraft.
    const legs = segments.map((seg) => lib.legOf(seg));
    const keys = segments.map((seg, i) =>
      lib.claimKey(seg.flightNumber, seg.date || pageDate, legs[i])
    );

    // Respect the per-pass network budget BEFORE marking processed, so
    // skipped cards get picked up by a later pass.
    for (const key of keys) {
      if (!lookup.isKnown(key)) {
        if (budget.remaining <= 0) return false;
        budget.remaining--;
      }
    }

    const outcomes = await Promise.all(
      segments.map((seg, i) => lookup.get(seg.flightNumber, seg.date || pageDate, legs[i]))
    );
    // The page moved on while this card waited; its answer belongs to a search
    // that is no longer on screen, and processedElements is a new set.
    if (gen !== generation) return true;

    // Only a settled answer retires the card. Marking it processed on a
    // transient failure would strand it unbadged for the rest of the session:
    // nothing else clears processedElements short of an SPA navigation.
    const settled = outcomes.every((outcome) => !outcome.retryable);
    if (settled) processedElements.add(card);

    const claims = outcomes.map((outcome, i) => ({
      ...outcome.claim,
      flightNumber: segments[i].flightNumber,
    }));
    const combined = lib.combineClaims(claims);
    if (lib.shouldBadge(combined)) {
      addBadge(card, combined, keys.join("+"), lib.cardBadgeTitle(combined, claims));
      log("badged", keys.join("+"), combined.status);
    } else {
      removeBadge(card);
    }
    return settled;
  }

  // A pass that ends with unsettled cards schedules its own retry: when the
  // user is just sitting on a result list nothing else wakes the extension, so
  // the short error TTL alone would never be spent. Bounded so a hard outage
  // costs a handful of passes, not an endless poll.
  const MAX_RETRY_PASSES = 3;
  const RETRY_DELAY_MS = lib.CACHE_TTL.error + 5000;
  let retryPasses = 0;
  let retryTimer = null;

  function scheduleRetryPass() {
    if (retryTimer !== null || retryPasses >= MAX_RETRY_PASSES) return;
    retryPasses++;
    // Wait past the error TTL so the retry is a fresh lookup, not a cache replay.
    retryTimer = setTimeout(() => {
      retryTimer = null;
      processFlights();
    }, RETRY_DELAY_MS);
  }

  function cancelRetryPass() {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    retryPasses = 0;
  }

  async function runPass() {
    const gen = generation;
    let unsettled = false;
    let newCards = 0;
    try {
      const pageDate = extractPageDate();
      const budget = { remaining: MAX_NEW_LOOKUPS_PER_PASS };
      const pending = [...findFlightCards()].filter((card) => !processedElements.has(card));
      newCards = pending.length;
      log(`pass: ${newCards} new cards`);
      await lib.runPool(pending, CARD_CONCURRENCY, async (card) => {
        if (gen !== generation) return;
        try {
          if (!(await processCard(card, pageDate, budget, gen))) unsettled = true;
        } catch (err) {
          // One broken card must not stop the pass or reach the page.
          log("card failed", err);
        }
      });
    } catch (err) {
      log("pass failed", err);
    }
    if (gen === generation) {
      if (unsettled) scheduleRetryPass();
      else cancelRetryPass();
    }
    return { newCards };
  }

  const passRunner = lib.createPassRunner(runPass);
  const processFlights = passRunner.trigger;

  // ── lifecycle ──────────────────────────────────────────────────────────────

  function debounce(fn, wait) {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn(...args), wait);
    };
  }

  /** Shared by SPA navigation and breakpoint changes: old badges go, every
   * card is fresh, and any pass still in flight stops badging. */
  function resetForNavigation() {
    try {
      for (const badge of document.querySelectorAll(".starlink-wifi-badge")) {
        badge.remove();
      }
    } catch {
      // removal is cosmetic; keep going
    }
    processedElements = new WeakSet();
    generation++;
    cancelRetryPass();
    passRunner.resetReruns();
  }

  function reprocessAllFlights() {
    resetForNavigation();
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
        const hasNewFlights = mutations.some((mutation) =>
          Array.from(mutation.addedNodes).some(looksLikeFlightNode)
        );
        if (!hasNewFlights) return;
        if (passRunner.isRunning()) passRunner.requestRerun();
        else debouncedProcess();
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
        resetForNavigation();
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
