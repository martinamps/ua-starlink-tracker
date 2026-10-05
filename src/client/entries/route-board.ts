/** /route-planner/{origin}/{destination}: the nonstop board's odds history. */
import { wireOddsHistory } from "../odds-history";
import { onReady } from "../ready";

onReady(wireOddsHistory);
