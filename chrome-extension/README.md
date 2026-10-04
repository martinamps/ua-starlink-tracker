# Google Flights Starlink Indicator

Chrome extension (Manifest V3) that badges Google Flights search results with
the Starlink WiFi status of each flight — for United, Alaska (including
Hawaiian Airlines-operated flights, which Google Flights lists under Alaska
`AS` flight numbers), and Qatar Airways.

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
predictions; screen readers get the same text from the badge's label.

### Coverage windows differ by airline

Aircraft assignments only exist ~2 days out, and what fills the gap before that
depends on the airline:

- **United** — a per-flight-number history model, so predicted badges show for
  any date the search returns.
- **Alaska** — no per-flight history, but the subfleet a flight number belongs
  to has one equipped share, so predicted badges show at any date for the
  ~100%-equipped subfleets (AS800-899 on Hawaiian A330/A321neo metal, and the
  regional E175s) and stay off for the mid-rollout mainline.
- **Hawaiian** — Google Flights now lists Hawaiian-operated flights only under
  Alaska `AS` numbers, so they are answered as Alaska flights: the A330/A321neo
  routes (AS800-899, e.g. HNL → LAX) get badges at any date, and the
  interisland 717s (AS1000-1299) get none, because they have no Starlink.
  `HA`-numbered lookups still work if Google ever shows them again, but an
  `HA` number doesn't pin the aircraft type, so before the ~2-day assignment
  window it gets no badge rather than a blended guess.
- **Qatar** — no tail-level data, but Qatar publishes the scheduled aircraft
  type about a week ahead (selected routes only). Inside that window a 777,
  A350 or 787-8 shows green "Starlink (installed)" — Qatar reports those fleets
  fully fitted — while a 787-9 (installs under way), A380, A330 or narrowbody
  shows no badge. Further out, a gray "Starlink ~NN%" appears only when the
  flight number flew a fitted type on nearly all (~93%+) of its recent
  operating days; the number is a conservative lower bound, and a flight that
  often swaps aircraft gets no badge.

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
  near-departure FR24 fallback). Hawaiian, Alaska and Qatar flights are checked
  against the hub, `airlinestarlinktracker.com/api/check-any-flight`, which
  resolves the marketing carrier server-side.
- Multi-leg itineraries are badged by their weakest leg — a card is never
  marked "Starlink" when only one leg has it. An itinerary with any leg on an
  airline the tracker doesn't cover (UA + Lufthansa, Alaska + American) gets
  no badge and no lookup: that leg can't be vouched for.
- Answers are cached in-memory for 30 minutes (5 minutes for transient
  failures). At most 40 uncached lookups run per page pass, three cards at a
  time. Cards Google adds while a pass is running queue a follow-up pass.
- Changing the search (dates, route) clears every badge before the new
  results are processed; a pass still running for the old search stops
  badging.
- A card is only retired once its answer is settled. A pass that ends with any
  card still unsettled — an API blip, an exhausted per-pass budget — schedules
  itself again after the short cache expires, up to three times, so a blip
  doesn't blank the rest of the session.
- Google re-renders result cards in place (expanding one rebuilds the list),
  which strips badges. A settled card's badge is restored from memory with no
  new lookup; a card Google reuses for a different itinerary is looked up
  afresh.
- The content script matches `www.google.com/travel/flights*`, not just
  `/travel/flights/*`: Flights is a single-page app, and a session that starts
  on the home page or a `?q=` link from Search reaches results without loading
  a new page, so the narrower pattern never ran for it (2.1.1). Same host as
  1.2.0, so no new permission prompt.

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
- For each United/Alaska/Hawaiian/Qatar flight it finds, it sends **only the
  flight number, date, and each leg's departure/arrival airport codes** to
  unitedstarlinktracker.com or airlinestarlinktracker.com to ask "does this
  leg have Starlink?", plus the extension's version number
  (`client=ext-2.1.1`) so the site can count extension lookups separately
  from website visits.
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
