# Manual QA checklist — Google Flights Starlink Indicator

The DOM-facing paths can't be unit-tested (Google Flights markup, extension
messaging, real breakpoints). Run this checklist in a real browser before
tagging a release. Load the unpacked extension fresh (`chrome://extensions` →
reload) before starting.

Tip: set `DEBUG = true` in `content.js` for verbose per-pass logging while
testing; set it back before release.

## Setup sanity

- [ ] `chrome://extensions` shows version 2.0.1, no errors on the card
- [ ] Service worker "Inspect views" console shows no errors on load
- [ ] Permissions listed: only unitedstarlinktracker.com — no storage, no new hosts

## United (frozen endpoint)

- [ ] Search a UA-heavy route (e.g. SFO → EWR, tomorrow). Blue "Starlink" or
      green "Starlink (installed)" badges appear on some results within a few
      seconds
- [ ] Search the same route ~2 weeks out. Gray "Starlink ~NN%" badges appear
      only on flights at ≥80%; no badge on the rest
- [ ] Hover each badge tier — tooltip explains verified / installed / predicted
      wording and (for predictions) observation count
- [ ] DevTools Network tab (service worker): UA lookups go to
      `unitedstarlinktracker.com/api/check-flight` and carry
      `&client=ext-2.0.1` after `flight_number` and `date`

## Hawaiian / Alaska (hub endpoint)

- [ ] Search HNL → LAX within ~2 days: Hawaiian results get badges; lookups go
      to `airlinestarlinktracker.com/api/check-any-flight`
- [ ] Search SEA → PDX within ~2 days: Alaska/Horizon E175 results get badges
- [ ] Far-future SEA → PDX (E175 regional, AS2000+): gray "Starlink ~100%"
      badges — Alaska's subfleet answer carries a probability past the
      assignment window
- [ ] Far-future SEA → LAX (mainline 737, AS1-1999): no badge — the mainline
      subfleet is mid-rollout, far below the 80% bar
- [ ] Far-future HNL → LAX: Hawaiian metal now sells mostly as AS800-999
      (AS-marketed on HA A330/A321neo). Those results get a gray
      "Starlink ~100%" badge from the `hawaiian_metal` subfleet. Until the
      registry range is widened past AS899, AS900-999 shows no badge
- [ ] Far-future HNL → OGG (interisland, AS1000-1299 on the 717): no badge
- [ ] Far-future HA-marketed flights (HA1-HA999): no badge. HA's answer is a
      per-type split, which carries no single probability — an honest
      abstention, not a bug (see README "Coverage windows differ by airline")

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

## Layout and drift resilience

- [ ] Desktop (≥1024px): badge sits inline after the flight times when Google's
      current markup allows; otherwise it appears pinned to the card corner —
      either way, never overlapping content illegibly
- [ ] Narrow window (<1024px): corner badge form; resize across the breakpoint
      re-renders badges without duplicates
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
