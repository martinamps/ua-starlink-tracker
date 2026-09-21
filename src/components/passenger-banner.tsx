// Only ever rendered when the server already saw a Starlink-geofeed IP on the
// UA tenant — the gate lives in passenger-detect.ts, not here.
import { FLIGHT_INPUT_SEPARATORS } from "../airlines/flight-input";
import { BUTTON } from "./flight-search-form";

export function PassengerBanner() {
  return (
    <>
      <div id="psgr-banner" className="relative mx-auto mt-4 mb-4 hidden w-full max-w-3xl">
        <div className="rounded-lg border border-accent/40 bg-surface-elevated p-4 shadow-lg shadow-accent/10 sm:p-5">
          <button
            id="psgr-dismiss"
            type="button"
            aria-label="Dismiss"
            className="absolute top-2 right-3 text-lg leading-none text-muted hover:text-secondary"
          >
            ×
          </button>
          <h2 className="mb-1 pr-6 font-display text-lg text-primary">
            Are you on a Starlink flight?
          </h2>
          <p className="mb-3 pr-6 text-sm text-secondary">
            Your connection looks like Starlink. Tell us your flight number and we'll confirm this
            aircraft's Wi-Fi for other travelers.
          </p>
          <form id="psgr-form" noValidate className="flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              name="flight_number"
              aria-label="Flight number"
              placeholder="UA2019"
              autoComplete="off"
              autoCapitalize="characters"
              required
              className="flex-1 rounded border border-subtle bg-surface px-3 py-2 font-mono text-base text-primary placeholder-muted focus:border-accent focus:outline-none sm:text-sm"
            />
            <button type="submit" className={BUTTON}>
              Confirm flight
            </button>
          </form>
          <output id="psgr-thanks" className="mt-2 hidden text-sm text-success">
            Thanks, recorded.
          </output>
          <p className="mt-2 text-xs text-muted">
            We store only the flight number and that your IP is in Starlink's published range.
          </p>
        </div>
      </div>
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static SSR-only inline handler
        dangerouslySetInnerHTML={{ __html: PSGR_BANNER_SCRIPT }}
      />
    </>
  );
}

// localStorage writes are individually try-wrapped: legacy Safari private mode /
// quota-full throws on setItem but not getItem, and that must not block the UI.
// Separators come from the shared input rules; any carrier's number is accepted
// because the report is about the aircraft the visitor is on, not this site.
const PSGR_BANNER_SCRIPT = `(function(){try{
var KEY="psgr_banner_v1",SEP=new RegExp(${JSON.stringify(FLIGHT_INPUT_SEPARATORS.source)},"g"),ls=function(v){try{localStorage.setItem(KEY,v)}catch(e){}};
var b=document.getElementById("psgr-banner");
if(!b||localStorage.getItem(KEY))return;
b.classList.remove("hidden");
document.getElementById("psgr-dismiss").onclick=function(){b.classList.add("hidden");ls("dismissed")};
document.getElementById("psgr-form").addEventListener("submit",function(e){
  e.preventDefault();
  var v=(e.target.flight_number.value||"").toUpperCase().replace(SEP,"");
  if(!/^[A-Z]{2,3}\\d{1,4}$/.test(v))return;
  try{navigator.sendBeacon&&navigator.sendBeacon("/api/passenger-probe",JSON.stringify({source:"manual",outcome:"manual_report",claimed_flight:v}))}catch(x){}
  document.getElementById("psgr-thanks").classList.remove("hidden");
  e.target.querySelector("button").disabled=true;
  ls("sent:"+v);
  setTimeout(function(){b.classList.add("hidden")},2500);
});
}catch(e){}})();`;
