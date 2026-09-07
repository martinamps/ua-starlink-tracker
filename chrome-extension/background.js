/**
 * Service worker: the only place the extension talks to the network. Routing
 * (UA → the frozen check-flight contract, others → the hub's
 * check-any-flight) lives in lib.js so it is unit-tested in the main repo.
 *
 * Both APIs serve `Access-Control-Allow-Origin: *`, so no host permission
 * beyond the original one is required — adding one would disable the
 * extension for existing users until they re-approve the update.
 */

importScripts("lib.js");

const FETCH_TIMEOUT_MS = 10_000;

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (!request || request.action !== "checkFlight") return undefined;

  const lib = globalThis.StarlinkTrackerLib;
  const url = lib ? lib.endpointFor(request.flightNumber, request.date) : null;
  if (!url) {
    sendResponse({ success: false, error: "unsupported flight number or date" });
    return undefined;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  fetch(url, { signal: controller.signal })
    .then(async (response) => {
      const body = await response.json().catch(() => null);
      // 400/404 bodies are settled answers ("untracked airline", bad input) —
      // hand them to the normalizer instead of treating them as outages.
      if (body && (response.ok || response.status === 400 || response.status === 404)) {
        sendResponse({ success: true, data: body });
      } else {
        sendResponse({ success: false, status: response.status });
      }
    })
    .catch((err) => {
      sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) });
    })
    .finally(() => clearTimeout(timer));

  return true;
});
