/**
 * The words for a sheet-listed tail we don't count, one clause per reason
 * (database/sql/listed-not-counted.ts). None of them says the plane has
 * Starlink: each says what the sheet lists and what our check has or hasn't read.
 */

import type { ReportedInstall } from "../types";

type Reported = Pick<ReportedInstall, "reason" | "observed_wifi" | "checks_since_listed">;

/** verified_wifi 'None' means no Wi-Fi installed; it is never a provider name. */
export function wifiPhrase(raw: string | null): string {
  return !raw || /^none$/i.test(raw) ? "no Wi-Fi" : `${raw} Wi-Fi`;
}

/** After "Not confirmed: " or "the sheet lists it with Starlink; ". `who` is "our" or "this tracker's". */
export function reportedClause(r: Reported, who: "our" | "this tracker's" = "our"): string {
  const we = who === "our" ? "we have" : "this tracker has";
  const check = who === "our" ? "our check" : "this tracker's own check of the airline's site";
  switch (r.reason) {
    case "other_provider":
      return `${check} still reads ${r.observed_wifi}`;
    case "no_wifi":
      return `${check} reads no Wi-Fi, and has never read Starlink on it`;
    default:
      return r.checks_since_listed === 0
        ? `${we} not checked it since first seeing the listing`
        : `${who} reads since the listing have not settled on a reading`;
  }
}
