# Manual QA checklist — Google Flights Starlink Indicator

The DOM-facing paths can't be unit-tested (Google Flights markup, extension
messaging, real breakpoints). Before a release, do the short pass below by
hand in a real Chrome; the full checklist after it is the reference, and most
of it needs no Google at all. Load the unpacked extension fresh
(`chrome://extensions` → reload) before starting.

Tip: set `DEBUG = true` in `content.js` for verbose per-pass logging while
testing; set it back before release.

## Release pass: the checks only Google Flights can show

About fifteen minutes, one sitting, in order. Use a desktop window at least
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
       count). On a gray United badge (step 7 shows them) the tooltip reads
       "~NN% chance this flight gets a Starlink-equipped aircraft (N observed
       departures). Airlines assign the actual aircraft ~2 days before
       departure." That wording is unchanged from 2.2.0.
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
11. [ ] **One other airline, and its tooltip (new in 2.3.0).** Search
        HNL → LAX one way, for tomorrow. *Look for:* at least one badge on an
        Alaska result. Hover every gray "Starlink ~NN%" badge on an Alaska
        card (if tomorrow shows only blue and green ones, pick a date three
        weeks out, where the AS800-999 flights are gray). *Look for:* the
        tooltip is "Nearly all of the Alaska Airlines aircraft that fly
        flights like this one have Starlink. The tracker has no specific
        aircraft on file for this flight." (or it starts "About NN% of the
        Alaska Airlines aircraft…" when the share is under 99.5%). It must
        not say "~2 days before departure", tomorrow or three weeks out.
        Leave this page open for the next step's last check.
12. [ ] **Starlink only, three levels (new in 2.3.0).** In another tab,
        search ORD → EWR one way, about two weeks out. *Look for:* gray
        badges on some United nonstops and none on others. Hover the
        "Starlink only" chip, bottom right. *Look for:* its tooltip is "Dim
        flights without a Starlink badge. Flights with better-than-even
        Starlink odds but no badge are dimmed less." Press it. *Look for:*
        nothing is hidden, and the cards fall into three levels:
        - cards with a badge stay as they are;
        - United cards with no badge whose odds are 50% or more dim
          **lightly** (still easy to read);
        - United cards whose odds are under 50%, or that the tracker
          answered as not Starlink, dim **clearly more** (washed out).

        The two dim levels must be easy to tell apart at a glance; if they
        are not, on Google's light or dark page, that is a finding to send
        back, since no stand-in page can show it. Cards of airlines the
        extension doesn't cover (Delta, American, JetBlue and the like) stay
        as they are. Move the mouse over a dimmed card: a lightly dimmed one
        goes to full, a clearly dimmed one brightens but stays a little
        faded. To see a card's odds, enter its flight number and date at
        `unitedstarlinktracker.com/check-flight`. When checked on
        2026-11-23 seven of the route's flight numbers were under 80%, the
        lowest at 45% (UA2151, which would dim clearly); if no card is under
        50% on your date, every unbadged United card dims lightly, and the
        clearer dim shows on the HNL → LAX page below. If every United card has a
        badge, there is nothing to dim: try another date. Press the chip
        again: everything back to full, badges unchanged. Then press the
        chip on the HNL → LAX page from step 11: unbadged Alaska cards dim
        too, mainline Alaska among them (Alaska is an airline the extension
        covers; a mainline flight dims clearly while fewer than half of
        Alaska's mainline aircraft are fitted). That is correct, not a
        fault.
13. [ ] **The dim holds while the page changes (new in 2.3.0).** On the
        ORD → EWR page, with "Starlink only" on and both dim levels in view,
        note which cards are dimmed and how much. Open one result's "Flight
        details" and close it; scroll to the bottom and back; press "View
        more flights" (or "Other departing flights") if the page offers it.
        *Look for:* after each, within a few seconds, every card that was
        dimmed is dimmed at the same level again, and badged cards are still
        at full. Newly loaded United cards get their badge or their dim
        level a few seconds after they appear, without pressing the chip
        again; until then they are at full, which is correct. A card that
        stays at full for more than about ten seconds when the tracker has
        an answer for it is a failure: note which action caused it.
14. [ ] **Console.** *Look for:* no errors or warnings from the extension in
        the page's console across all of the above.

### What needs no repeating by hand

`bun test tests/extension.test.ts` covers the extension's logic: which host
and address each airline's lookup goes to, the `client` tag, itinerary
decoding, the badge ladder and the 80% bar, the weakest-leg and mixed-carrier
rules, leg-scoped lookups, which of its three levels "Starlink only" gives a
card, the wording of every tooltip, retry scheduling, the manifest's
permissions and the package's contents.

The 2.3.0 runs of 2026-11-23 loaded the unpacked extension in Chromium on a
local stand-in for the Flights page. The answers came from the tracker's own
code run against seeded local data, not from the live tracker. Compared with
the version before it on the same answers, 2.3.0 showed a badge on exactly
the same cards with the same label; only the two share tooltips and the dim
levels differed, and they read as the Alaska, Qatar and Starlink only
sections below now say. The run of the version before it, the same day, was
fed by the live tracker's answers and agreed with these sections as they then
read: Setup sanity, United, Alaska / Hawaiian-operated, Qatar, Untracked
airlines and negatives, Multi-leg itineraries, Leg-scoped lookups, Starlink
only toggle, Failure honesty, and the package line under Release. None of
these runs could show anything about Google's own markup, which is what the
pass above is for. Not covered by any of them: a 3-leg card with one flight
number, for want of a real one to search for; how the two dim levels look on
Google's own cards; and whether a dim survives Google redrawing a card
(steps 12 and 13 above).

Known, and not a reason to fail the pass:

- A lightly dimmed card carries no label of its own. The chip's tooltip is
  the only explanation on the page; the tracker keeps those odds off badges
  on purpose.
- A United flight number with no history of its own is answered with the
  fleet's rate, so such a card can dim lightly on a fleet figure.
- Qatar's two older gray tooltips ("At least ~NN% — scheduled on a fitted
  type…" and "At least ~NN% — based on the aircraft types on…") don't say
  when their number includes a type's fitted share. "At least" stays true.

## Full checklist

The reference list, section by section.

## Setup sanity

- [ ] `chrome://extensions` shows version 2.3.0, no errors on the card
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
- [ ] A gray United badge's tooltip is worded as in 2.2.0: "~NN% chance this
      flight gets a Starlink-equipped aircraft (N observed departures).
      Airlines assign the actual aircraft ~2 days before departure."
- [ ] DevTools Network tab (service worker): UA lookups go to
      `unitedstarlinktracker.com/api/check-flight` and carry
      `&client=ext-2.3.0` after `flight_number` and `date` (and after
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
- [ ] (2.3.0) Hover a gray Alaska badge on HNL → LAX or SEA → PDX for
      tomorrow, then on the same search three weeks out. Both times the
      tooltip is "Nearly all of the Alaska Airlines aircraft that fly flights
      like this one have Starlink. The tracker has no specific aircraft on
      file for this flight." For a subfleet under 99.5% it starts "About NN%
      of the Alaska Airlines aircraft…" instead. It never says "~2 days
      before departure". Tomorrow's page may show only blue and green badges
      (aircraft already assigned); then there is no gray one to hover, and
      only the three-weeks-out half applies
- [ ] (Dead-safe path, only if Google shows `HA` numbers again) a far-future
      HA-numbered flight gets no badge: HA's answer is a per-type split with no
      single probability (see README "Coverage windows differ by airline")

## Qatar (hub endpoint, equipment type)

Qatar's flight numbers come and go with its schedule, so pick them on the day:
the Google results for DOH → LHR show which fly, and
`airlinestarlinktracker.com/api/check-any-flight?flight_number=QR7&date=YYYY-MM-DD`
shows what the tracker answers for each (`hasStarlink` true or false inside
about six days, a `probability` further out). Checked on 2026-11-23: the route
ran QR3, 5, 7, 11, 15, 105, 109 and 119. QR1 was not flying, so the tracker
had no answer for it and it rightly got no badge.

- [ ] DOH → LHR tomorrow: flights scheduled on an A350 get green "Starlink
      (installed)"; flights on the A380 get no badge (QR3 and QR11 on
      2026-11-23). Hover names the scheduled type and the swap caveat;
      lookups go to `airlinestarlinktracker.com/api/check-any-flight`
- [ ] (2.3.0) Same page, a flight Google lists on a 777-300ER or a 787-8.
      Some aircraft of these two types are not counted as fitted, so which
      badge is right depends on the tracker; ask the hub address above for
      that flight and date first:
      - `hasStarlink` is `null`, `confidence` is `"type"` and there is a
        `probability` (the tracker once pull request 195 is deployed): a
        gray "Starlink ~NN%" badge, NN being that probability as a
        percentage. Its tooltip starts "Scheduled aircraft type (Boeing
        777-300ER): about NN% of that type in the Qatar Airways fleet counts
        as fitted with Starlink." and ends "Qatar Airways doesn't say which
        aircraft flies, and a swap can change the type." It nowhere says the
        flight "has flown other aircraft". If the probability is under 0.8
        there is no badge
      - `hasStarlink` is `true` (the tracker before it): green "Starlink
        (installed)", as for the A350
- [ ] DOH → LHR 3+ weeks out, inside the current schedule season: A350
      flights get gray "Starlink ~8x-9x%" (hover starts "At least ~NN% —
      based on the aircraft types on" and cites the number of operating
      days); the A380 flights get no badge. A flight number that mostly
      flies the 777-300ER has its number scaled by that type's fitted share
      once pull request 195 is deployed, and then may fall under 80% and
      show no badge (with "Starlink only" on it dims lightly); before that
      it shows a gray badge like the A350's (QR5, 7, 15 and 109 at 93% and
      QR105 at 88% on 2026-11-23)
- [ ] A flight scheduled on a 787-9 gets no badge (installs under way)
- [ ] JFK → DOH → BKK on QR+QR: one badge only when both legs qualify
- [ ] A QR + British Airways itinerary gets no badge and no lookup
- [ ] A date in the next schedule season: from 2027-03-28 through
      2027-10-30 (seasons change on the last Sunday of March and of October;
      the current one ends 2027-03-27, the next on 2027-10-30). Which answer
      is right depends on the tracker, not on the extension, so first ask
      the hub address above for such a date and read `confidence`:
      - `low` (the tracker once pull request 192 is deployed): no Qatar
        badge on any date in that season. (2.3.0) With "Starlink only" on,
        flights whose `probability` is 0.5 or more dim lightly (the 777 and
        A350 ones) and those under it dim clearly more (the A380 ones).
      - `medium` (the tracker before it, as on 2026-11-23): the gray
        "Starlink ~NN%" badge still shows through that whole season (QR7 at
        93% for 2027-09-15), and a badged card is not dimmed.
- [ ] A date two seasons out (2027-10-31 or later) gets no Qatar badge, and
      with "Starlink only" on its Qatar cards are not dimmed at all: the
      tracker sends no number for it, so there is nothing to filter on

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

## Starlink only toggle (2.2; three levels since 2.3.0)

The chip never hides a card. A card's level comes from the tracker's answer:
a badge leaves it alone; no badge with odds of 50% or more dims it lightly
(70% opacity); a verified no, or odds under 50%, dims it clearly (35%
opacity); no answer at all leaves it alone.

- [ ] ORD → EWR tomorrow (or another route from the tracker's live list): a
      "Starlink only" chip appears bottom-right once results are answered; on a page with no tracked flights it never appears
- [ ] Hover the chip: "Dim flights without a Starlink badge. Flights with
      better-than-even Starlink odds but no badge are dimmed less."
- [ ] Toggle on, ~2 weeks out on a mixed route (ORD → EWR): badged cards and
      non-tracked airlines (Delta, JetBlue) stay as is; unbadged UA cards at
      50% or more dim lightly; UA cards under 50% dim clearly more. On other
      routes the clear dim also falls on Qatar's A380 and on Alaska flights
      answered as not Starlink or under 50%. The two levels are easy to tell
      apart at a glance
- [ ] Hover a dimmed card: a lightly dimmed one goes to full opacity, a
      clearly dimmed one to 80%
- [ ] Mixed itineraries the extension can't judge (Alaska + Delta) and
      flights with no answer (an outage, a Qatar date two seasons out) are
      not dimmed
- [ ] Toggle off: every card back to full opacity; badges unchanged
- [ ] With the toggle on, scroll / "View more flights": late cards get their
      level once answered, cards still loading are left alone
- [ ] With the toggle on, expand a result ("Flight details") and collapse
      it, then scroll away and back: each card that was dimmed is dimmed at
      the same level again within a few seconds, and no badged card is
      dimmed
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
