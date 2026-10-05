import { wireOddsHistory } from "../odds-history";
import { onReady } from "../ready";
import { wireRoutePlanner } from "../route-planner";

onReady(() => {
  wireRoutePlanner();
  wireOddsHistory();
});
