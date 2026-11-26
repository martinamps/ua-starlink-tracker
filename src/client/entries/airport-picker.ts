import { attachAirportBox } from "../airport-picker";

// Fetched by the route planner when a visitor first touches a box; the planner
// reads this back once the script has run.
(window as unknown as { attachAirportBox?: typeof attachAirportBox }).attachAirportBox =
  attachAirportBox;
