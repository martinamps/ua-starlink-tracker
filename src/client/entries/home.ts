/** Airline homepages: the flight search, the aircraft list and the onboard banner. */
import { wireAircraftList } from "../aircraft-list";
import { wireFlightSearchForms } from "../flight-search";
import { wirePassengerBanner } from "../passenger-banner";
import { onReady } from "../ready";

onReady(() => {
  wireFlightSearchForms();
  wireAircraftList();
  wirePassengerBanner();
});
