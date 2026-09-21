/** Hub pages: the homepage's flight check and route comparer, and a
 * community airline page's flight check and tail filter. */
import { wireFlightSearchForms } from "../flight-search";
import { onReady } from "../ready";
import { wireRouteCompare } from "../route-compare";
import { wireTailFilter } from "../tail-filter";

onReady(() => {
  wireFlightSearchForms();
  wireRouteCompare();
  wireTailFilter();
});
