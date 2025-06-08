const DEBUG = false;
const log = (...args) => DEBUG && console.log("[Starlink Tracker]", ...args);

const flightCache = new Map();
const CACHE_DURATION = 30 * 60 * 1000;

let processedElements = new WeakSet();

function extractFlightDate() {
  const urlElements = document.querySelectorAll("[data-travelimpactmodelwebsiteurl]");
  for (const element of urlElements) {
    const url = element.getAttribute("data-travelimpactmodelwebsiteurl");
    if (url) {
      const dateMatch = url.match(/(\d{8})$/);
      if (dateMatch) {
        const dateStr = dateMatch[1];
        const formatted = `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
        return formatted;
      }
    }
  }

  const hash = window.location.hash;
  const dateMatch = hash.match(/;d:(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) {
    return dateMatch[1];
  }

  return new Date().toISOString().split("T")[0];
}

async function checkFlightForStarlink(flightNumber, date) {
  const cacheKey = `${flightNumber}-${date}`;
  const cached = flightCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached.hasStarlink;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      action: "checkFlight",
      flightNumber,
      date,
    });

    if (!response.success) {
      return false;
    }

    const hasStarlink = response.data.hasStarlink || false;

    flightCache.set(cacheKey, {
      hasStarlink,
      timestamp: Date.now(),
    });

    return hasStarlink;
  } catch (error) {
    log("Error checking flight:", flightNumber, error);
    return false;
  }
}

function createStarlinkBadge() {
  const badge = document.createElement("span");
  badge.className = "starlink-wifi-badge";
  badge.style.cssText = `
    margin-left: 12px;
    display: inline-flex;
    align-items: center;
    font-size: 13px;
    color: #1967d2;
    background: #e8f0fe;
    padding: 2px 10px;
    border-radius: 12px;
    font-weight: 500;
  `;
  badge.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="vertical-align: -2px; margin-right: 4px;">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
    </svg>
    Starlink
  `;
  return badge;
}

function addStarlinkBadge(card) {
  if (card.querySelector(".starlink-wifi-badge")) return;

  const badge = createStarlinkBadge();
  const isDesktop = window.innerWidth >= 1024;

  if (isDesktop) {
    const timeContainer = card.querySelector(".zxVSec.YMlIz.tPgKwe.ogfYpf");
    if (timeContainer) {
      const timeSpan = timeContainer.querySelector("span.mv1WYe");
      if (timeSpan) {
        timeSpan.parentNode.insertBefore(badge, timeSpan.nextSibling);
        return;
      }
    }
  }

  const liElement = card.closest("li");
  if (liElement) {
    liElement.style.position = "relative";
    badge.style.cssText = `
      position: absolute;
      top: -3px;
      left: -6px;
      display: inline-flex;
      align-items: center;
      font-size: 9px;
      color: #1967d2;
      background: rgba(232, 240, 254, 0.85);
      padding: 1px 5px;
      border-radius: 8px;
      font-weight: 500;
      white-space: nowrap;
      z-index: 10;
      box-shadow: 0 1px 2px rgba(0,0,0,0.08);
    `;
    badge.innerHTML = "Starlink";
    liElement.insertBefore(badge, liElement.firstChild);
  }
}

function extractFlightNumber(card) {
  if (processedElements.has(card)) return null;
  const cardText = card.innerText || "";
  const ariaLabel = card.querySelector("[aria-label]")?.getAttribute("aria-label") || "";

  if (!cardText.includes("United") && !ariaLabel.includes("United")) return null;

  let flightNumber = null;

  const allElements = card.querySelectorAll("*");
  for (const element of allElements) {
    for (const attr of element.attributes) {
      if (attr.value.includes("UA-") || attr.value.includes("/UA/")) {
        let match = attr.value.match(/\bUA-(\d{3,4})-\d{8}\b/i);
        if (!match) match = attr.value.match(/\bUA-(\d{3,4})\b/i);
        if (!match) match = attr.value.match(/\/UA\/(\d{3,4})\//i);

        if (match) {
          flightNumber = `UA${match[1]}`;
          break;
        }
      }
    }
    if (flightNumber) break;
  }

  if (!flightNumber) {
    const uaMatch = cardText.match(/\bUA\s*(\d{1,4})\b/);
    if (uaMatch) {
      flightNumber = `UA${uaMatch[1]}`;
    }
  }

  return flightNumber;
}

async function processFlights() {
  if (isProcessing) {
    log("Already processing, skipping...");
    return;
  }

  isProcessing = true;

  try {
    const date = extractFlightDate();

    const flightCards = document.querySelectorAll(".pIav2d");
    log(`Found ${flightCards.length} flight cards`);

    let processedCount = 0;
    let starlinkCount = 0;

    for (const card of flightCards) {
      if (processedElements.has(card)) continue;

      const flightNumber = extractFlightNumber(card);
      if (!flightNumber) continue;

      log(`Found flight number: ${flightNumber}`);
      processedElements.add(card);
      processedCount++;

      const hasStarlink = await checkFlightForStarlink(flightNumber, date);
      if (hasStarlink) {
        starlinkCount++;
        addStarlinkBadge(card);
        if (!DEBUG) console.log(`✈️ ${flightNumber} has Starlink WiFi`);
      }
    }

    if (processedCount > 0 && !DEBUG) {
      console.log(
        `[Starlink Tracker] Processed ${processedCount} UA flights, ${starlinkCount} have Starlink`
      );
    }
  } finally {
    isProcessing = false;
  }
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

function reprocessAllFlights() {
  for (const badge of document.querySelectorAll(".starlink-wifi-badge")) {
    badge.remove();
  }

  processedElements = new WeakSet();

  processFlights();
}

let isProcessing = false;

function initialize() {
  setTimeout(processFlights, 1000);
  const debouncedProcess = debounce(() => {
    if (!isProcessing) {
      processFlights();
    }
  }, 2000);

  const observer = new MutationObserver((mutations) => {
    if (isProcessing) return;
    const hasNewFlights = mutations.some((mutation) => {
      return Array.from(mutation.addedNodes).some((node) => {
        return (
          node.nodeType === 1 &&
          (node.classList?.contains("pIav2d") || node.querySelector?.(".pIav2d"))
        );
      });
    });

    if (hasNewFlights) {
      debouncedProcess();
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: false,
    characterData: false,
  });

  let lastWidth = window.innerWidth;
  const handleResize = debounce(() => {
    const currentWidth = window.innerWidth;
    const wasDesktop = lastWidth >= 1024;
    const isDesktop = currentWidth >= 1024;

    if (wasDesktop !== isDesktop) {
      lastWidth = currentWidth;
      reprocessAllFlights();
    }
  }, 500);

  window.addEventListener("resize", handleResize);

  let lastUrl = location.href;
  setInterval(() => {
    const url = location.href;
    if (url !== lastUrl) {
      lastUrl = url;
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
