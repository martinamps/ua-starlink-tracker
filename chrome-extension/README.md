# Google Flights Starlink Indicator

Chrome extension (Manifest V3) that badges Google Flights search results with
the Starlink WiFi status of each flight — for United, Hawaiian, and Alaska
Airlines.

## Installation (development)

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select the `chrome-extension` folder
5. Visit [Google Flights](https://www.google.com/travel/flights) and search for flights

Publishing to the Chrome Web Store is a separate, manual step.

## What the badges mean

The extension never shows a bare yes/no. Every answer sits on a claim ladder,
strongest first, and anything weaker than the last rung shows **no badge at
all** rather than a guess:

| Badge | Meaning |
|---|---|
| **Starlink** (blue) | Verified — the assigned aircraft was confirmed Starlink against the airline's own site |
| **Starlink (installed)** (green) | The assigned aircraft is Starlink-equipped per fleet data, not yet re-verified |
| **Starlink ~92%** (gray) | No aircraft assigned yet (airlines assign ~2 days out); percentage is the historical rate for this flight. Shown only at ≥80% with non-low confidence |
| *no badge* | Verified non-Starlink aircraft, low/uncertain prediction, untracked airline, or the API couldn't answer — silence over invention |

Hover a badge for the full explanation, including observation counts for
predictions.

## How it works

- Flight numbers, legs, and dates are read from Google's own Travel Impact
  Model data attributes when present (semantic, drift-resistant), falling back
  to attribute and text heuristics only when needed.
- United flights are checked against `unitedstarlinktracker.com/api/check-flight`
  (the long-standing contract for this extension, and the only surface with the
  near-departure FR24 fallback). Hawaiian and Alaska flights are checked
  against the hub, `airlinestarlinktracker.com/api/check-any-flight`, which
  resolves the marketing carrier server-side.
- Multi-leg itineraries are badged by their weakest leg — a card is never
  marked "Starlink" when only one leg has it.
- Answers are cached in-memory for 30 minutes (5 minutes for transient
  failures). At most 40 uncached lookups run per page pass.

## Permissions

- `host_permissions: unitedstarlinktracker.com` — unchanged since v1. The hub
  API is reached with an ordinary CORS request (both APIs serve
  `Access-Control-Allow-Origin: *`), so v2 deliberately adds **no** new host
  permissions: adding one would disable the extension for existing users until
  they re-approve the update.
- No `storage`, `tabs`, or other permissions. v2 removed the unused `storage`
  permission from v1.

## Privacy (plain language)

- The extension reads flight numbers and dates from Google Flights pages you
  are already viewing. It does not read anything else on the page.
- For each United/Hawaiian/Alaska flight it finds, it sends **only the flight
  number and date** to unitedstarlinktracker.com or
  airlinestarlinktracker.com to ask "does this flight have Starlink?".
  No account data, no page contents, no URLs, no identifiers ride along.
- It does not collect, store, or transmit any personal information.
- It does not track your browsing history; it only runs on Google Flights.
- Results are cached in memory in your browser for up to 30 minutes and vanish
  when the tab or browser closes.
- Everything else happens locally in your browser.

## Development

Pure logic (flight extraction, endpoint routing, response normalization,
badge copy) lives in `lib.js` and is unit-tested from the main repo:

```bash
bun test tests/extension.test.ts
```

Content-script behavior that needs a real browser is covered by the manual
checklist in [QA-CHECKLIST.md](QA-CHECKLIST.md) — run it before any release.
