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
| **Starlink ~92%** (gray) | No aircraft assigned yet (airlines assign ~2 days out); the percentage is this flight number's historical rate (United) or the equipped share of the subfleet that flies it (Alaska). Shown only at ≥80% with non-low confidence |
| *no badge* | Verified non-Starlink aircraft, a prediction below the bar or of low confidence, an answer that is type-determined with no aircraft assigned yet (see below), an untracked airline, or an API that couldn't answer — silence over invention |

Hover a badge for the full explanation, including observation counts for
predictions.

### Coverage windows differ by airline

Aircraft assignments only exist ~2 days out, and what fills the gap before that
depends on the airline:

- **United** — a per-flight-number history model, so predicted badges show for
  any date the search returns.
- **Alaska** — no per-flight history, but the subfleet a flight number belongs
  to has one equipped share, so predicted badges show at any date for the
  ~100%-equipped subfleets (AS800-899 on Hawaiian A330/A321neo metal, and the
  regional E175s) and stay off for the mid-rollout mainline.
- **Hawaiian** — Starlink is decided by aircraft type (A330/A321neo yes, 787
  installing, 717 no) and a flight number doesn't pin the type. Beyond the ~2-day
  assignment window there is no honest single number, so **Hawaiian results show
  no badge until the aircraft is assigned**. Blending the types into one
  percentage would be a guess dressed as data.

## How it works

- Flight numbers, legs, and dates are read from Google's own Travel Impact
  Model data attributes when present (semantic, drift-resistant). If nothing
  decodes out of them — the attribute is missing, or Google changed the
  itinerary encoding — the v1 attribute and text heuristics take over, both
  gated on the airline's name appearing in the card so a stray two-letter match
  in Google's markup can't badge someone else's flight. An itinerary that
  decodes and names no tracked airline is trusted as-is: no heuristics run.
- United flights are checked against `unitedstarlinktracker.com/api/check-flight`
  (the long-standing contract for this extension, and the only surface with the
  near-departure FR24 fallback). Hawaiian and Alaska flights are checked
  against the hub, `airlinestarlinktracker.com/api/check-any-flight`, which
  resolves the marketing carrier server-side.
- Multi-leg itineraries are badged by their weakest leg — a card is never
  marked "Starlink" when only one leg has it.
- Answers are cached in-memory for 30 minutes (5 minutes for transient
  failures). At most 40 uncached lookups run per page pass.
- A card is only retired once its answer is settled. A pass that ends with any
  card still unsettled — an API blip, an exhausted per-pass budget — schedules
  itself again after the short cache expires, up to three times, so a blip
  doesn't blank the rest of the session.

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
