/**
 * Browser behavior for every FlightSearchForm: normalize the typed flight
 * number with the router's own rules (serialized into data-rules) and go to
 * its permalink. Without JS the form still GETs /check-flight, which redirects.
 */
import {
  type FlightInputRules,
  canonicalFlightFor,
  canonicalFlightInput,
} from "../airlines/flight-input";

/** The viewer's local calendar day; toISOString() is the UTC day, which is
 * already tomorrow for US evenings. */
export const localToday = () => new Date().toLocaleDateString("en-CA");

export function permalinkFor(rules: FlightInputRules, raw: string, date: string): string {
  // An unparseable entry still goes to the router, which explains itself.
  const fn = canonicalFlightFor(rules, raw) ?? canonicalFlightInput(raw);
  return `/check-flight/${encodeURIComponent(fn)}${date ? `/${encodeURIComponent(date)}` : ""}`;
}

export function wireFlightSearchForms(): void {
  for (const el of Array.from(document.querySelectorAll("form[data-flight-search]"))) {
    const form = el as HTMLFormElement;
    // Wired once even when a page loads the script twice.
    if (form.dataset.wired !== undefined) continue;
    form.dataset.wired = "";
    let rules: FlightInputRules;
    try {
      rules = JSON.parse(form.dataset.rules ?? "");
    } catch {
      continue;
    }
    const number = form.querySelector('input[name="flight_number"]') as HTMLInputElement | null;
    const date = form.querySelector('input[name="date"]') as HTMLInputElement | null;
    if (!number) continue;
    if (date && !date.value && form.dataset.prefillDate !== undefined) date.value = localToday();
    form.addEventListener("submit", (e: Event) => {
      e.preventDefault();
      const raw = number.value.trim();
      if (!raw) {
        number.focus();
        return;
      }
      window.location.href = permalinkFor(rules, raw, date?.value ?? "");
    });
  }
}
