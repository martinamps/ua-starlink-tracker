/** Hub pages: the homepage's flight check and route comparer, and a
 * community airline page's flight check and tail filter. A dated check that
 * got an answer is kept in this browser for the homepage's "Your flights". */
import { wireFlightSearchForms } from "../flight-search";
import { onReady } from "../ready";
import { browserStore, rememberHubCheck } from "../recent-checks";
import { wireRouteCompare } from "../route-compare";
import { wireShareControls } from "../share";
import { wireTailFilter } from "../tail-filter";

onReady(() => {
  wireFlightSearchForms((form, asked, answer) => {
    rememberHubCheck(browserStore(), form, asked, answer, Math.floor(Date.now() / 1000));
  });
  wireShareControls();
  wireRouteCompare();
  wireTailFilter();
});
