import { wireFlightSearchForms } from "../flight-search";

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wireFlightSearchForms);
} else {
  wireFlightSearchForms();
}
