// Only ever rendered when the server already saw a Starlink-geofeed IP on the
// UA tenant — the gate lives in passenger-detect.ts, not here.

export function PassengerBanner() {
  return (
    <>
      <div id="psgr-banner" className="relative max-w-3xl mx-auto w-full mb-4 mt-4 hidden">
        <div className="bg-surface-elevated border border-accent/40 rounded-lg p-4 sm:p-5 shadow-lg shadow-accent/10">
          <button
            id="psgr-dismiss"
            type="button"
            aria-label="Dismiss"
            className="absolute top-2 right-3 text-muted hover:text-secondary text-lg leading-none"
          >
            ×
          </button>
          <div className="text-[10px] font-mono text-accent uppercase tracking-wider mb-1">
            Detected · Starlink wifi
          </div>
          <p className="text-sm text-secondary mb-3 pr-6">
            You look like you're connected through Starlink. If you're on a flight right now,
            telling us the flight number helps confirm this aircraft's wifi for other travelers.
          </p>
          <form id="psgr-form" noValidate className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              name="flight_number"
              aria-label="Flight number"
              placeholder="e.g. UA2019"
              autoComplete="off"
              required
              className="flex-1 font-mono text-sm px-3 py-2 bg-surface border border-subtle rounded text-primary placeholder-muted focus:outline-none focus:border-accent"
            />
            <button
              type="submit"
              className="font-mono text-sm px-4 py-2 bg-accent/20 border border-accent rounded text-accent hover:bg-accent/30 transition-colors"
            >
              Confirm flight
            </button>
          </form>
          <output
            id="psgr-thanks"
            className="hidden text-xs font-mono text-[var(--color-success)] mt-2"
          >
            ✓ Thanks — recorded.
          </output>
          <p className="text-[10px] text-muted mt-2">
            We only store the flight number and the fact your IP is in Starlink's published range.
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
const PSGR_BANNER_SCRIPT = `(function(){try{
var KEY="psgr_banner_v1",ls=function(v){try{localStorage.setItem(KEY,v)}catch(e){}};
var b=document.getElementById("psgr-banner");
if(!b||localStorage.getItem(KEY))return;
b.classList.remove("hidden");
document.getElementById("psgr-dismiss").onclick=function(){b.classList.add("hidden");ls("dismissed")};
document.getElementById("psgr-form").addEventListener("submit",function(e){
  e.preventDefault();
  var v=(e.target.flight_number.value||"").toUpperCase().replace(/\\s+/g,"");
  if(!/^[A-Z]{2,3}\\d{1,4}$/.test(v))return;
  try{navigator.sendBeacon&&navigator.sendBeacon("/api/passenger-probe",JSON.stringify({source:"manual",outcome:"manual_report",claimed_flight:v}))}catch(x){}
  document.getElementById("psgr-thanks").classList.remove("hidden");
  e.target.querySelector("button").disabled=true;
  ls("sent:"+v);
  setTimeout(function(){b.classList.add("hidden")},2500);
});
}catch(e){}})();`;
