import React from "react";
import {
  AirlineStatusCards,
  FlightCheckInput,
  RecentInstallsFeed,
  RouteComparePanel,
} from "../../components/atoms";
import { publicAirlines } from "../registry";
import type { AirlineContent, HeroProps } from "./index";

const HubHero = ({ stats, perAirlineStats = [], recentInstalls = [] }: HeroProps) => {
  const { starlinkCount, totalCount } = stats;
  return (
    <div className="relative mb-6 space-y-4">
      <div className="text-center">
        <div className="font-mono text-sm text-secondary">
          Tracking <span className="text-accent font-semibold">{starlinkCount}</span> Starlink
          aircraft across <span className="text-muted">{totalCount}</span> planes over{" "}
          <span className="text-accent font-semibold">{perAirlineStats.length}</span> airline
          {perAirlineStats.length === 1 ? "" : "s"}
        </div>
      </div>

      <AirlineStatusCards stats={perAirlineStats} />
      <RouteComparePanel />
      <FlightCheckInput />
      <RecentInstallsFeed items={recentInstalls} airlines={perAirlineStats} />

      {/* Client-side wiring for flight-check + route-compare forms + preset chips */}
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: SSR client wiring, no user input
        dangerouslySetInnerHTML={{
          __html: `
          document.addEventListener('DOMContentLoaded', function() {
            function esc(s){var d=document.createElement('div');d.textContent=String(s==null?'':s);return d.innerHTML.replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
            var cf = document.getElementById('hub-check-flight');
            var cr = document.getElementById('hub-check-result');
            if (cf) cf.addEventListener('submit', function(e) {
              e.preventDefault();
              var fd = new FormData(cf);
              cr.classList.remove('hidden');
              cr.textContent = 'Checking…';
              fetch('/api/check-any-flight?flight_number=' + encodeURIComponent(fd.get('flight_number')) + '&date=' + encodeURIComponent(fd.get('date')))
                .then(function(r){return r.json()})
                .then(function(d){
                  if (d.error) { cr.innerHTML = '<span class="text-amber-400">' + esc(d.error) + '</span>'; return; }
                  var label, cls;
                  if (d.hasStarlink === true) { label = 'Starlink'; cls = 'text-green-400'; }
                  else if (d.hasStarlink === false) { label = 'No Starlink'; cls = 'text-muted'; }
                  else if (typeof d.probability === 'number') { label = '~' + Math.round(d.probability * 100) + '% Starlink'; cls = 'text-accent'; }
                  else { label = 'Unknown'; cls = 'text-muted'; }
                  cr.innerHTML = '<span class="' + cls + '">' + label + '</span> · ' + esc(d.airline || '') + ' · ' + esc(d.reason || d.message || '');
                })
                .catch(function(){ cr.textContent = 'Lookup failed.'; });
            });
            var rf = document.getElementById('hub-compare-route');
            var rr = document.getElementById('hub-compare-result');
            var rfoot = document.getElementById('hub-compare-footer');
            var rplnk = document.getElementById('hub-compare-rp');
            function bar(pct, color, dotted) {
              var style = 'width:'+pct+'%;background:'+esc(color);
              if (dotted) style = 'width:'+pct+'%;border-top:2px dotted '+esc(color)+';background:transparent';
              return '<div class="h-1.5 bg-surface-elevated rounded overflow-hidden mt-1"><div class="h-full" style="'+style+'"></div></div>';
            }
            function pill(href, txt, color) {
              return '<a href="'+esc(href)+'" class="ml-2 font-mono text-[9px] px-1.5 py-0.5 rounded-full whitespace-nowrap hover:underline" style="color:'+esc(color)+';background:color-mix(in srgb,'+esc(color)+' 14%,transparent);border:1px solid color-mix(in srgb,'+esc(color)+' 40%,transparent)">'+esc(txt)+' \\u2192</a>';
            }
            function shorten(label){return String(label||'').replace(/\\s*Fleet$/i,'').trim();}
            function fleetTip(a, b){
              return esc(b.total)+' '+esc(shorten(b.label))+' aircraft in '+esc(a.shortName||a.name)+'\\u2019s fleet \\u2014 '+esc(b.equipped)+' have Starlink';
            }
            function tip(cls, tipText, inner){
              if (!tipText) return '<span class="'+cls+'">'+inner+'</span>';
              return '<span class="'+cls+' tip" tabindex="0" data-tip="'+tipText+'">'+inner+'</span>';
            }
            function renderResult(a, O, D) {
              var color = a.accentColor || '#0ea5e9';
              var inferred = a.kind === 'inferred_absent';
              var rp = a.routePlannerBase ? a.routePlannerBase+'/'+O+'/'+D : null;
              if (a.kind === 'no_data') {
                return '<div class="mb-3 opacity-60"><div class="flex justify-between items-center font-mono text-xs"><span class="text-muted">'+esc(a.name)+(rp?pill(rp,'check route planner',color):'')+'</span><span class="text-muted">\\u2014</span></div>'
                     + '<div class="font-mono text-[10px] text-muted">No route data yet</div></div>';
              }
              if (a.kind === 'observed_mixed') {
                var head = '<div class="flex justify-between items-center font-mono text-xs"><span class="text-primary">'+esc(a.name)+'</span></div>'
                         + '<div class="font-mono text-[10px] text-muted">'+esc(a.reason)+'</div>';
                var rows = (a.breakdown||[]).map(function(b,i){
                  var br = Math.round(b.pct*100);
                  var lblTip = b.hint ? 'Flight numbers '+esc(b.hint) : '';
                  var best = i===0 && br>=50 ? ' '+tip('text-[8px] px-1 py-px rounded no-underline','Pick a flight in this group for the best Starlink odds','<span style="background:color-mix(in srgb,'+esc(color)+' 18%,transparent);color:'+esc(color)+';padding:1px 4px;border-radius:3px">best bet</span>') : '';
                  return '<div class="mt-1.5 ml-3"><div class="flex justify-between font-mono text-[10px]">'
                       + '<span>'+tip('text-secondary',lblTip,esc(shorten(b.label)))+best+'</span>'
                       + tip('text-accent tip-l',fleetTip(a,b),esc(b.equipped)+'/'+esc(b.total)+' aircraft \\u00b7 '+br+'%')+'</div>'+bar(br,color,false)+'</div>';
                }).join('');
                return '<div class="mb-3">'+head+rows+'</div>';
              }
              var pct = Math.round(a.probability*100);
              var bd0 = (a.breakdown||[])[0]||{};
              var pctTip = (bd0.equipped!=null) ? fleetTip(a,bd0) : '';
              var chipL = (pct < 50 && a.kind !== 'type_rule' && rp) ? pill(rp, 'try a connection', color) : '';
              return '<div class="mb-3"><div class="flex justify-between items-center font-mono text-xs"><span class="text-primary">'+esc(a.name)+chipL+'</span>'
                   + tip('text-accent tip-l',pctTip,pct+'%')+'</div>'
                   + '<div class="font-mono text-[10px] text-muted">'+esc(a.reason)+'</div>'+bar(pct,color,inferred)+'</div>';
            }
            function doCompare(origin, dest) {
              rr.classList.remove('hidden');
              rr.textContent = 'Comparing…';
              fetch('/api/compare-route?origin=' + encodeURIComponent(origin) + '&destination=' + encodeURIComponent(dest))
                .then(function(r){return r.json()})
                .then(function(d){
                  if (d.error) { rr.innerHTML = '<span class="text-amber-400 font-mono text-xs">' + esc(d.error) + '</span>'; return; }
                  var O = esc((d.origin||'').toUpperCase()), D = esc((d.destination||'').toUpperCase());
                  var html = (d.results||[]).map(function(r){return renderResult(r,O,D)}).join('');
                  rr.innerHTML = html || '<span class="font-mono text-xs text-muted">No tracked airline shows a Starlink-equipped nonstop on '+O+' \\u21c4 '+D+' yet.</span>';
                  if (rfoot) rfoot.classList.remove('hidden');
                  // Hub has no route planner; the per-row chip links to whichever
                  // airline's planner exists. Footer link goes to UA's (the only
                  // tenant with a planner page) until the hub grows its own.
                  if (rplnk) rplnk.href = 'https://unitedstarlinktracker.com/route-planner/'+O+'/'+D;
                })
                .catch(function(){ rr.textContent = 'Lookup failed.'; });
            }
            if (rf) rf.addEventListener('submit', function(e) {
              e.preventDefault();
              var fd = new FormData(rf);
              doCompare(fd.get('origin'), fd.get('destination'));
            });
            if (rf) Array.prototype.forEach.call(document.querySelectorAll('.hub-route-preset'), function(btn) {
              btn.addEventListener('click', function() {
                var o = btn.getAttribute('data-preset-origin') || '';
                var d = btn.getAttribute('data-preset-dest') || '';
                rf.elements.origin.value = o;
                rf.elements.destination.value = d;
                doCompare(o, d);
              });
            });
          });
        `,
        }}
      />
    </div>
  );
};

export const content: AirlineContent = {
  showNavLinks: false,

  headerStats: [
    <span key="free" className="text-green-400 font-semibold">
      FREE
    </span>,
    <span key="mbps">
      <span className="text-accent font-semibold">250</span> Mbps
    </span>,
  ],

  intro: () => (
    <p className="text-sm text-secondary leading-relaxed mb-3">
      Live rollout status for SpaceX Starlink in-flight WiFi across United, Hawaiian, and Alaska —
      by fleet segment, with per-tail verification.
    </p>
  ),

  Hero: HubHero,

  rowBadge: (_p, airline) => airline,

  subfleetFilters: publicAirlines().map((a) => ({ key: a.code, label: a.name })),

  faq: [
    {
      title: "Which airlines have Starlink",
      items: [
        {
          q: "Which airlines have Starlink WiFi?",
          a: ({ starlinkCount }) => (
            <p>
              <strong>United Airlines</strong> is mid-rollout — most United Express regional jets
              have it, with mainline 737s and widebodies being equipped through 2026.{" "}
              <strong>Hawaiian Airlines</strong> finished in September 2024: every A330 and A321neo
              has Starlink. <strong>Alaska Airlines</strong> is rolling out across its 737 fleet
              through 2027. We currently track <span className="text-accent">{starlinkCount}</span>{" "}
              Starlink-equipped aircraft.
            </p>
          ),
          ld: "United Airlines is mid-rollout across mainline and Express fleets. Hawaiian Airlines completed its rollout in September 2024 — every A330 and A321neo has Starlink. Alaska Airlines is rolling out through 2027.",
        },
        {
          q: "Hawaiian shows under 100% but says 'Complete' — why?",
          a: () => (
            <p>
              Hawaiian's Starlink rollout is <strong>finished</strong>: every A330 and A321neo has
              it, gate-to-gate, since September 2024. The Boeing 717 interisland jets were never in
              scope — short hops, no WiFi, and the type is being retired. The card's percentage is
              over Hawaiian's <em>whole</em> fleet so you can read it as "odds on a random Hawaiian
              flight." The Complete badge means every plane that's ever going to get Starlink
              already has it.
            </p>
          ),
          ld: "Hawaiian's Starlink rollout is finished: every A330 and A321neo has it since September 2024. The Boeing 717 interisland fleet was never in scope and is being retired. The percentage is over the whole fleet; the Complete badge means every plane that will ever get Starlink already has it.",
        },
        {
          q: "Does Delta have Starlink?",
          a: () => (
            <p>
              No. Delta announced a partnership with <strong>Amazon's Project Kuiper</strong> (a
              Starlink competitor) for in-flight WiFi starting around 2028. Delta is not currently
              tracked here.
            </p>
          ),
          ld: "No. Delta has partnered with Amazon's Project Kuiper, not Starlink, with service expected around 2028.",
        },
        {
          q: "Is Starlink WiFi free on these airlines?",
          a: () => (
            <p>
              Yes — United, Hawaiian, and Alaska all offer Starlink free to every passenger,
              gate-to-gate, with no login wall or loyalty requirement. This is a deliberate contrast
              with the paid legacy WiFi most carriers still use.
            </p>
          ),
          ld: "Yes. United, Hawaiian, and Alaska all offer Starlink WiFi free to every passenger, gate-to-gate.",
        },
      ],
    },
    {
      title: "About this tracker",
      items: [
        {
          q: "How is this data collected?",
          a: () => (
            <p>
              Fleet rosters and flight schedules come from public aviation data. Starlink status is
              verified per-tail against each airline's own flight-status systems where available
              (United, Alaska), and against official rollout announcements where the install is
              type-complete (Hawaiian). Data refreshes hourly.
            </p>
          ),
          ld: "Fleet rosters and flight schedules come from public aviation data. Starlink status is verified per-tail against each airline's own systems where available, and against official announcements where the install is type-complete.",
        },
        {
          q: "How accurate is this?",
          a: () => (
            <p>
              For United we measure precision continuously against united.com — currently above 96%
              on firm yes/no calls. Hawaiian is type-deterministic (if it's an Airbus, it has
              Starlink), so accuracy is effectively 100%. Aircraft swaps close to departure are the
              main source of uncertainty on any airline.
            </p>
          ),
          ld: "United precision is measured continuously against united.com (currently above 96%). Hawaiian is type-deterministic, so accuracy is effectively 100%. Aircraft swaps close to departure are the main uncertainty.",
        },
      ],
    },
  ],
};
