/**
 * The onboard banner: shown once per browser to a visitor on a Starlink IP,
 * it takes the flight number they're on and beacons it. Any carrier's number
 * is accepted, since the report is about the aircraft, not this site.
 * localStorage writes are individually guarded: legacy Safari private mode and
 * a full quota throw on setItem but not getItem, and that must not block the UI.
 */
import { FLIGHT_INPUT_SEPARATORS } from "../airlines/flight-input";

const KEY = "psgr_banner_v1";

function remember(value: string): void {
  try {
    localStorage.setItem(KEY, value);
  } catch {}
}

export function wirePassengerBanner(): void {
  try {
    const banner = document.getElementById("psgr-banner");
    const form = document.getElementById("psgr-form") as HTMLFormElement | null;
    if (!banner || !form || localStorage.getItem(KEY)) return;
    banner.classList.remove("hidden");
    document.getElementById("psgr-dismiss")?.addEventListener("click", () => {
      banner.classList.add("hidden");
      remember("dismissed");
    });
    const sep = new RegExp(FLIGHT_INPUT_SEPARATORS.source, "g");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = form.elements.namedItem("flight_number") as HTMLInputElement;
      const flight = (input.value || "").toUpperCase().replace(sep, "");
      if (!/^[A-Z]{2,3}\d{1,4}$/.test(flight)) return;
      try {
        navigator.sendBeacon?.(
          "/api/passenger-probe",
          JSON.stringify({ source: "manual", outcome: "manual_report", claimed_flight: flight })
        );
      } catch {}
      document.getElementById("psgr-thanks")?.classList.remove("hidden");
      const button = form.querySelector("button");
      if (button) button.disabled = true;
      remember(`sent:${flight}`);
      setTimeout(() => banner.classList.add("hidden"), 2500);
    });
  } catch {}
}
