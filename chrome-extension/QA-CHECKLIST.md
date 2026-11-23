# Manual QA checklist — Google Flights Starlink Indicator

The DOM-facing paths can't be unit-tested (Google Flights markup, extension
messaging, real breakpoints). Before a release, do the short pass below by
hand in a real Chrome; the full checklist after it is the reference, and most
of it needs no Google at all. Load the unpacked extension fresh
(`chrome://extensions` → reload) before starting.

Tip: set `DEBUG = true` in `content.js` for verbose per-pass logging while
testing; set it back before release.

## Release pass: the checks only Google Flights can show

About ten minutes, one sitting, in order. Use a desktop window at least
1024px wide, signed in as usual (Google answers automated browsers with a
robot check, which is why these are done by hand). Keep the page's DevTools
console open throughout.

### Routes and dates, and how to check them on the day

The pass runs on two United routes and one Alaska route. Which aircraft fly
where changes daily, so each is named with the reason it was chosen, and all
three were checked against the live tracker on **2026-11-23**:

- **Newark ↔ Washington National (EWR ↔ DCA)**, the main route. Every United
  nonstop there is a GoJet CRJ-550, a type with 103 of its 104 aircraft
  fitted, so nearly every United nonstop gets a badge on any date. On the
  day checked: 18 flights EWR → DCA and 17 DCA → EWR had a Starlink aircraft
  assigned through 25 November, all of them CRJ-550s, and every flight number
  in both directions was predicted at 97% or more. This stops being true
  only if United moves the route to another aircraft type.
- **Chicago O'Hare → Newark (ORD → EWR)**, the mixed route for step 12. It
  is flown by partly fitted mainline types, so some United cards get a badge
  and some don't. On the day checked, two weeks out: 4 of its 11 flight
  numbers were at 80% or more (UA1856 87%, UA1273 86%, UA2475 82%, UA1236
  81%) and 7 below (down to UA2151 at 45%).
- **Honolulu → Los Angeles (HNL → LAX)**, for Alaska. The Hawaiian-operated
  AS800-999 flights are a fully fitted subfleet, answered as Starlink on any
  date.

**Before step 1, confirm the routes still work today** (one minute). Open
`unitedstarlinktracker.com/routes`, the tracker's own list of routes with
Starlink departures in the next 48 hours, and find EWR ⇄ DCA and ORD ⇄ EWR,
each with departures in both directions. If one is missing, take another pair
from that list that has departures both ways and use it wherever the steps
name the missing one; the busiest pairs are at the top. To check a single
flight, enter its number and date at `unitedstarlinktracker.com/check-flight`.
A step that shows no badge on a route the list doesn't carry is a stale
route, not a failed build.

**Which dates give which badge.** United assigns aircraft about two days
ahead. A departure **today or tomorrow** gets a blue "Starlink" (verified) or
green "Starlink (installed)" badge from the assigned aircraft. A departure
**three or more days out** has no aircraft yet and gets a gray "Starlink
~NN%" badge from the flight number's history, and only at 80% or more. Use
about two weeks out wherever a step asks for gray badges.

### The steps

1. [ ] **Search from the home page.** Open `google.com/travel/flights`, fill
       in a round trip EWR → DCA leaving tomorrow and returning about two
       weeks later, press Search. *Look for:* blue "Starlink" or green
       "Starlink (installed)" badges on most United nonstops within a few
       seconds, without reloading. One or two without a badge is normal (an
       aircraft not yet assigned, or the one unfitted CRJ-550); none at all
       is a failure, once the routes list above shows the route.
2. [ ] **Badge placement.** *Look for:* each badge sitting inline right after
       the flight times. Pinned to the card's corner is the fallback and is
       acceptable; covering text is not. No card has two badges.
3. [ ] **Hover a badge.** *Look for:* a tooltip that says in words what the
       badge means (verified, installed, or a percentage with an observation
       count).
4. [ ] **Expand and collapse.** Open one result's "Flight details", then close
       it. *Look for:* every other card's badge back within about a second.
5. [ ] **Load more.** Scroll down and press "View more flights" (or "Other
       departing flights"), if the page offers it. *Look for:* the late cards
       that are United nonstops get badges without a reload. Connecting
       itineraries get one only when every leg qualifies, so most have none.
6. [ ] **Date arrows, fast.** Click the > arrow next to the departure date
       four or five times quickly. *Look for:* once the list settles, at
       least one United nonstop has a gray "Starlink ~NN%" badge whose
       tooltip speaks of a chance, and no blue or green badge is left over
       from the first date (five days out, no aircraft is assigned yet).
7. [ ] **Date picker.** Pick a departure date about two weeks out in the
       calendar. *Look for:* the old badges are gone, and most United
       nonstops carry a gray "Starlink ~NN%" of 80% or more (on this route,
       97% to 99% when checked).
8. [ ] **Round trip.** Set the departure back to tomorrow, choose an outbound
       flight, and wait for the return results. *Look for:* at least one
       badge on the return results, and every badge on them gray (the return
       is two weeks out), not blue or green carried over from tomorrow. The
       outbound flight you chose, if Google repeats it above the return
       results, rightly keeps its own blue or green badge.
9. [ ] **Narrow window.** Drag the window narrower than 1024px and back.
       *Look for:* badges move to the card's corner and back, never doubled.
10. [ ] **From a search link.** In a new tab, search Google for "flights from
        EWR to DCA" and follow the link into Flights
        (`/travel/flights?q=…`). *Look for:* badges without a reload. Google
        picks the dates here: gray badges if the departure is three or more
        days out, blue or green if sooner.
11. [ ] **One other airline.** Search HNL → LAX one way, for tomorrow. *Look
        for:* at least one badge on an Alaska result. Leave this page open
        for the next step's last check.
12. [ ] **Starlink only, on a mixed route.** In another tab, search ORD → EWR
        one way, about two weeks out. *Look for:* gray badges on some United
        nonstops and none on others. Press the "Starlink only" chip, bottom
        right. *Look for:* the cards that go dim (dimmed, never hidden) are
        those the tracker answered as not Starlink or under 80%: here, the
        United cards without a badge. Badged cards stay as they are, and so
        do cards of airlines the extension doesn't cover (Delta, American,
        JetBlue and the like). Press it again: everything back to full. If
        every United card on the page has a badge, there is nothing to dim:
        try another date. Then press the chip on the HNL → LAX page from
        step 11: unbadged Alaska cards dim too, mainline Alaska among them
        (Alaska is an airline the extension covers, and its mainline is far
        below 80%). That is correct, not a fault.
13. [ ] **Console.** *Look for:* no errors or warnings from the extension in
        the page's console across all of the above.

### What needs no repeating by hand

`bun test tests/extension.test.ts` covers the extension's logic: which host
and address each airline's lookup goes to, the `client` tag, itinerary
decoding, the badge ladder and the 80% bar, the weakest-leg and mixed-carrier
rules, leg-scoped lookups, what "Starlink only" dims, retry scheduling, the
manifest's permissions and the package's contents.

The 2.2.0 run of 2026-11-23 also loaded the unpacked extension in Chromium on
a local stand-in for the Flights page, fed by the live tracker's answers. It
agreed with every item in these sections, apart from the lines marked "under
review": Setup sanity, United, Alaska / Hawaiian-operated, Qatar, Untracked
airlines and negatives, Multi-leg itineraries, Leg-scoped lookups, Starlink
only toggle, Failure honesty, and the package line under Release. It could not
show anything about Google's own markup, which is what the pass above is for.
One item neither covers: a 3-leg card with one flight number, for want of a
real one to search for.

Known for a later version, not a reason to fail the pass: an Alaska
percentage badge one day before departure carries the far-date tooltip
("Airlines assign the actual aircraft ~2 days before departure").

## Full checklist

The reference list, section by section.

## Setup sanity

- [ ] `chrome://extensions` shows version 2.2.0, no errors on the card
- [ ] Service worker "Inspect views" console shows no errors on load
- [ ] Site access listed: unitedstarlinktracker.com and www.google.com (the
      content script's site, listed for 1.2.0 too) — no storage, no other hosts

## United (frozen endpoint)

- [ ] Search a route from the tracker's live list at
      `unitedstarlinktracker.com/routes` (e.g. ORD → EWR, tomorrow; see
      "Routes and dates" above). Blue "Starlink" or green "Starlink
      (installed)" badges appear on some results within a few seconds
- [ ] Search the same route ~2 weeks out. Gray "Starlink ~NN%" badges appear
      only on flights at ≥80%; no badge on the rest
- [ ] Hover each badge tier — tooltip explains verified / installed / predicted
      wording and (for predictions) observation count
- [ ] DevTools Network tab (service worker): UA lookups go to
      `unitedstarlinktracker.com/api/check-flight` and carry
      `&client=ext-2.2.0` after `flight_number` and `date` (and after
      `origin`/`destination` on itinerary-decoded cards)

## Alaska / Hawaiian-operated (hub endpoint)

Google Flights lists Hawaiian-operated flights only under Alaska `AS` numbers
(no `HA` numbers appear in results), so every check here is an `AS` lookup.

- [ ] Search HNL → LAX within ~2 days: the Hawaiian-operated AS8xx results get
      badges; lookups go to `airlinestarlinktracker.com/api/check-any-flight`
      with `flight_number=AS8…`
- [ ] Search SEA → PDX within ~2 days: Alaska/Horizon E175 results get badges
- [ ] Far-future SEA → PDX (E175 regional, AS2000+): gray "Starlink ~99%"
      badges — Alaska's subfleet answer carries a probability past the
      assignment window, and the badge caps a prediction at 99%
- [ ] Far-future SEA → LAX (mainline 737, AS1-1999): no badge — the mainline
      subfleet is mid-rollout, far below the 80% bar
- [ ] Far-future HNL → LAX: the AS800-999 results (Hawaiian A330/A321neo) get
      a gray "Starlink ~99%" badge from the `hawaiian_metal` subfleet
- [ ] Far-future HNL → OGG (interisland, AS1000-1299 on the 717): no badge
- [ ] (Dead-safe path, only if Google shows `HA` numbers again) a far-future
      HA-numbered flight gets no badge: HA's answer is a per-type split with no
      single probability (see README "Coverage windows differ by airline")

## Qatar (hub endpoint, equipment type)

- [ ] DOH → LHR tomorrow: QR1/7/15 (777/A350) get green "Starlink
      (installed)"; QR3/11 (A380) get no badge. Hover names the scheduled type
      and the swap caveat; lookups go to `airlinestarlinktracker.com/api/check-any-flight`.
      *Under review (2026-11-23): the tracker had no answer for QR1, so it got
      no badge; QR7 and QR15 behaved as written. Don't fail a release on QR1
      until the tracker's answer is settled*
- [ ] DOH → LHR 3+ weeks out: QR1/7 get gray "Starlink ~8x-9x%" (hover cites
      the number of operating days); QR3/11 get no badge
- [ ] A flight scheduled on a 787-9 gets no badge (installs under way)
- [ ] JFK → DOH → BKK on QR+QR: one badge only when both legs qualify
- [ ] A QR + British Airways itinerary gets no badge and no lookup
- [ ] A date more than ~7 months out gets no badge. *Under review
      (2026-11-23): QR7 still showed "Starlink ~93%" ten months out; what the
      tracker should answer that far ahead is being settled, so don't fail a
      release on this line*

## Untracked airlines and negatives

- [ ] Delta/American/JetBlue results never get a badge and never trigger
      console errors
- [ ] A page with zero tracked flights makes zero API requests (Network tab)

## Multi-leg itineraries

- [ ] A connecting itinerary where only one leg is Starlink shows no
      "Starlink" badge (weakest-leg rule) — or, if both legs qualify, one badge
      per card, never two
- [ ] A mixed-carrier itinerary (e.g. SFO → MSN on Alaska + American, or UA +
      Lufthansa) shows no badge, and makes no lookup for it in the Network tab:
      the untracked leg cannot be vouched for

## Leg-scoped lookups (2.1)

- [ ] A card whose TIM is `ORD-DEN-UA-318,DEN-DRO-UA-1217` asks for UA1217 with
      `origin=DEN&destination=DRO` (Network tab)
- [ ] A through flight with UA1217 on both legs makes 2 lookups, one per leg;
      it shows one badge. The tooltip names a leg (e.g. "UA1217 DEN→DRO: …")
      only when the two legs' answers differ, and then it names the weaker
      one; legs that agree name none
- [ ] A UA540 SFO → DEN card no longer shows DEN → SAN's tail in the response
      `flights` (Network tab)
- [ ] A 3-leg same-number card still badges; a 5+ leg card shows no badge
      (more legs than the extension looks up — fails closed)
- [ ] A TIM leg whose origin equals its destination sends no `origin`/
      `destination` at all

## Starlink only toggle (2.2)

- [ ] ORD → EWR tomorrow (or another route from the tracker's live list): a
      "Starlink only" chip appears bottom-right once results are answered; on a page with no tracked flights it never appears
- [ ] Toggle on: cards answered as not Starlink or below the bar dim. That is
      UA cards with no badge, and on other routes unbadged cards of the other
      covered airlines too (Alaska mainline, Qatar's A380). Badged cards and
      non-tracked airlines (Delta, JetBlue) stay as is
- [ ] Toggle off: every card back to full opacity; badges unchanged
- [ ] With the toggle on, scroll / "View more flights": late cards dim once
      answered, cards still loading are left alone
- [ ] Change dates (SPA navigation): toggle stays on, new results follow it
- [ ] Reload the tab: toggle is off again (state is in memory only, no
      `storage` permission)

## Layout and drift resilience

- [ ] Desktop (≥1024px): badge sits inline after the flight times when Google's
      current markup allows; otherwise it appears pinned to the card corner —
      either way, never overlapping content illegibly
- [ ] Narrow window (<1024px): corner badge form, its left edge just outside
      the card's; resize across the breakpoint re-renders badges without
      duplicates
- [ ] Start on the Flights home page (`google.com/travel/flights`), fill in a
      route and date, press Search: results get badges without a reload (the
      app never loads a new page for this)
- [ ] Same from a Google Search "flights from X to Y" link (`/travel/flights?q=…`)
- [ ] Expand a result ("Flight details"), then collapse it: every other card's
      badge comes back within ~1 s, with no new API requests
- [ ] Change dates via the date picker (SPA navigation, URL change): old badges
      cleared, new results processed
- [ ] Click the date arrows (< >) next to the departure date several times
      quickly: after the list settles, every badge matches the date on screen
      (hover a badge; check the Network request's `date`), and no card keeps a
      badge from the previous date
- [ ] Scroll to load more results, and expand "Other departing flights" /
      "View more flights" while the first pass is still running: the late
      cards get badged without a reload
- [ ] Page console (not the worker's) shows **zero** errors or warnings from
      the extension during all of the above — including with DevTools "Pause on
      exceptions" off/on

## Failure honesty

- [ ] Block both API hosts (DevTools → Network request blocking), reload the
      search: no badges, no page errors. Unblock and leave the tab alone (no
      reload, no scrolling): within ~5 minutes the extension re-runs its own
      pass and the badges appear (cards left unsettled by a transient failure
      are never retired, and the pass reschedules itself up to 3 times)
- [ ] Kill the service worker (chrome://serviceworker-internals or wait for
      idle), then interact with the page: lookups still work (worker wakes) or
      degrade silently

## Round-trip / date correctness

- [ ] Round-trip search: badges on the return-leg results reflect the return
      date, not the outbound date (per-leg dates come from the Travel Impact
      Model attribute — verify a request in the Network tab carries the return
      date)

## Release

- [ ] `bun run ext:package` → `dist/ext-<version>.zip` lists only manifest,
      background/content/lib JS, styles.css and icons (no `.md`)
- [ ] Run this checklist against the unpacked build of the same commit
- [ ] Owner uploads the zip to the Chrome Web Store and Edge Add-ons dashboards
- [ ] After review: `bun run ext:store-version` reports the new version, and
      the "Published CWS version" line in docs/DEVELOPMENT.md is updated
