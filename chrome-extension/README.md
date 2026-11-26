# Google Flights Starlink Indicator

Chrome extension (Manifest V3) that badges Google Flights search results with
the Starlink WiFi status of each flight — for United, Alaska (including
Hawaiian Airlines-operated flights, which Google Flights lists under Alaska
`AS` flight numbers), Qatar Airways, from 2.4.0 Aer Lingus flights between
Ireland and North America, and from 2.5.0 Virgin Atlantic and SAS flights whose
card states the aircraft type.

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
| **Starlink (likely)** (gray) | No aircraft or schedule is held for the airline: the airline itself says Starlink is on this route (Aer Lingus, Ireland to North America) or on the aircraft type the card states (a Virgin Atlantic A350, an SAS A320neo). The tooltip quotes its sentence with the date |
| **Starlink ~92%** (gray) | No aircraft assigned yet (airlines assign ~2 days out); the percentage is this flight number's historical rate (United), the equipped share of the subfleet that flies it (Alaska), or the fitted share of the scheduled aircraft type (a Qatar 777-300ER or 787-8). Shown only at ≥80% with non-low confidence |
| *no badge* | Verified non-Starlink aircraft, a prediction below the bar or of low confidence, an answer that is type-determined with no aircraft assigned yet (see below), an untracked airline, or an API that couldn't answer — silence over invention |

Hover a badge for the full explanation, including observation counts for
predictions; screen readers get the same text from the badge's label. A
percentage that is the equipped share of a subfleet or of a scheduled aircraft
type (Alaska; a Qatar type with some aircraft not confirmed fitted) says so in
its tooltip, and makes no claim about that flight's history or about when an
aircraft is assigned.

The percentage is the whole number the tracker's site prints for the same
answer. Qatar's numbers are rounded down, as the site's sentence rounds them
(15 of 16 aircraft is 93.75%, and reads "Starlink ~93%"). United's odds and
Alaska's shares are rounded to the nearest whole number, as the site's pages
round them. "Starlink ~100%" appears only for a subfleet in which every
aircraft is equipped: a share just under that reads ~99%, and United's odds
never read 100%.

### "Starlink only"

Once a page has at least one answered flight, a "Starlink only" button appears
bottom right. It dims, and never hides, in three tiers:

| Card | With "Starlink only" on |
|---|---|
| Has a badge | Unchanged |
| No badge, but Starlink odds of 50% or more (a prediction under the 80% bar, or one of low confidence such as a Qatar date in the next schedule season) | Dimmed lightly |
| Verified non-Starlink, or odds under 50% | Dimmed |
| No answer (untracked airline, mixed-carrier itinerary, outage) | Unchanged |

The setting lasts for the tab and resets on reload: keeping it would need the
`storage` permission.

### Coverage windows differ by airline

Aircraft assignments only exist ~2 days out, and what fills the gap before that
depends on the airline:

- **United** — a per-flight-number history model, so predicted badges show for
  any date the search returns.
- **Alaska** — no per-flight history, but the subfleet a flight number belongs
  to has one equipped share, so predicted badges show at any date for the
  fully equipped subfleets (AS800-999 on Hawaiian A330/A321neo metal, and the
  regional E175s) and stay off for the mid-rollout mainline. Those badges read
  the subfleet's share: "Starlink ~100%" when every aircraft in it is
  equipped, "Starlink ~99%" when nearly all are.
- **Hawaiian** — Google Flights now lists Hawaiian-operated flights only under
  Alaska `AS` numbers, so they are answered as Alaska flights: the A330/A321neo
  routes (AS800-999, e.g. HNL → LAX) get badges at any date, and the
  interisland 717s (AS1000-1299) get none, because they have no Starlink.
  `HA`-numbered lookups still work if Google ever shows them again, but an
  `HA` number doesn't pin the aircraft type, so before the ~2-day assignment
  window it gets no badge rather than a blended guess.
- **Aer Lingus** (2.4.0) — no aircraft and no schedule are held. Aer Lingus
  said on 18 November 2026 that Starlink "is already available across all Aer
  Lingus transatlantic routes", so a card for an `EI` flight between Ireland
  and the US, Canada or Mexico shows a gray "Starlink (likely)" whose tooltip
  quotes that sentence. The tracker answers by route, so the extension must
  send the card's origin and destination: an `EI` flight with no leg, on
  another route, or dated after the statement's end date (27 March 2027) gets
  no badge and is never dimmed. An `EI` number flown by a partner airline is
  not covered by the statement; the tooltip says so, and the card is not told
  apart from Aer Lingus's own flights.
- **Virgin Atlantic and SAS** (2.5.0) — no aircraft and no schedule are held.
  Virgin Atlantic's Starlink page (undated; read 26 November 2026) says
  "Starlink is now available across our A350 fleet", and SAS said on
  1 September 2026 "With all 81 A320neo aircraft now equipped". The tracker
  answers only for an aircraft type the caller states, so the extension reads
  the type from the card's visible text and sends it as `aircraft_type`.
  Google Flights shows the type only once a card's details are open, so a
  closed card gets no badge. A partner airline's aircraft under a `VS` or
  `SK` number is not covered by the airline's statement, whatever its type, so
  the reader sends a type only when every doubt is ruled out
  (`statedAircraftType` in `lib.js`): the card's own itinerary data decoded
  and shows one flight; the page is in English and the card reads as English
  (an operating-carrier line can only be recognised in a language we read, so
  on Google Flights in any other language Virgin Atlantic and SAS get no
  badge); neither the card's text nor its aria-labels name another airline or
  operator ("Operated by", "Plane and crew by", any "by/for/as" followed by a
  name, any other "Airlines" or "Airways"); and the card states exactly one
  aircraft type, as a whole field. A type followed by anything ("Airbus A350
  900", "Airbus A320neo (Sharklets)") is refused, never shortened. A gray "Starlink (likely)" then
  appears for an "Airbus A350" or "Airbus A350-1000" on Virgin Atlantic and an
  "Airbus A320neo" on SAS; "Airbus A320" alone, any other type, and no type
  get no badge and are never dimmed. No other airline's request carries
  `aircraft_type`.
- **Qatar** — no tail-level data, but Qatar publishes the scheduled aircraft
  type about a week ahead (selected routes only). Inside that window an A350 or
  777-200LR shows green "Starlink (installed)", because Qatar reports those
  fleets fully fitted. A 777-300ER or 787-8 shows a gray "Starlink ~NN%"
  instead: a few named aircraft of each type aren't confirmed fitted, Qatar
  publishes the type and not the aircraft, so the badge gives the fitted share
  of that type, rounded down (~84% and ~93% when this was written). A 787-9
  (installs under way), A380, A330 or narrowbody shows no badge. Further out,
  a gray "Starlink ~NN%" appears only when the flight number flew a fitted
  type on nearly all (~93%+) of its recent operating days; the number is a
  conservative lower bound, rounded down, and a flight that often swaps
  aircraft gets no badge.

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
