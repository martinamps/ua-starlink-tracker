/** Homepages: the flight search, the aircraft list, the onboard banner, and
 * the flights this browser checked before. */
import { wireAircraftList } from "../aircraft-list";
import { wireFlightSearchForms } from "../flight-search";
import { wirePassengerBanner } from "../passenger-banner";
import { onReady } from "../ready";
import { wireRecentChecks } from "../recent-checks";

onReady(() => {
  wireFlightSearchForms();
  wireAircraftList();
  wirePassengerBanner();
  wireRecentChecks();
});
