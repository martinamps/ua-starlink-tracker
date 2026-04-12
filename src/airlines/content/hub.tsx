import React from "react";
import {
  FlightCheckInput,
  RecentInstallsFeed,
  RolloutLeaderboard,
  RouteComparePanel,
} from "../../components/atoms";
import { enabledAirlines } from "../registry";
import type { AirlineContent, HeroProps } from "./index";

const HubHero = ({ stats, perAirlineStats = [], recentInstalls = [] }: HeroProps) => {
  const { starlinkCount, totalCount } = stats;
  return (
    <div className="relative mb-6 space-y-4">
      <div className="text-center">
        <div className="font-mono text-sm text-secondary">
          Tracking <span className="text-accent font-semibold">{starlinkCount}</span> Starlink
          aircraft across{" "}
          <span className="text-accent font-semibold">{perAirlineStats.length}</span> airline
          {perAirlineStats.length === 1 ? "" : "s"} ·{" "}
          <span className="text-muted">{totalCount} total fleet</span>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <FlightCheckInput />
        <RouteComparePanel />
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <RolloutLeaderboard stats={perAirlineStats} />
        </div>
        <RecentInstallsFeed items={recentInstalls} airlines={perAirlineStats} />
      </div>

      {/* Client-side wiring for flight-check + route-compare forms */}
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: SSR client wiring, no user input
        dangerouslySetInnerHTML={{
          __html: `
          document.addEventListener('DOMContentLoaded', function() {
            function esc(s){var d=document.createElement('div');d.textContent=String(s==null?'':s);return d.innerHTML;}
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
            if (rf) rf.addEventListener('submit', function(e) {
              e.preventDefault();
              var fd = new FormData(rf);
              rr.classList.remove('hidden');
              rr.textContent = 'Comparing…';
              fetch('/api/compare-route?origin=' + encodeURIComponent(fd.get('origin')) + '&destination=' + encodeURIComponent(fd.get('destination')))
                .then(function(r){return r.json()})
                .then(function(d){
                  if (d.error) { rr.innerHTML = '<span class="text-amber-400 font-mono text-xs">' + esc(d.error) + '</span>'; return; }
                  rr.innerHTML = (d.results || []).map(function(a){
                    var pct = Math.round(a.probability * 100);
                    var bar = '<div class="h-1.5 bg-surface-elevated rounded overflow-hidden mt-1"><div class="h-full" style="width:'+pct+'%;background:'+esc(a.accentColor||'#0ea5e9')+'"></div></div>';
                    return '<div class="mb-2"><div class="flex justify-between font-mono text-xs"><span class="text-primary">'+esc(a.name)+'</span><span class="text-accent">'+pct+'%</span></div><div class="font-mono text-[10px] text-muted">'+esc(a.reason)+'</div>'+bar+'</div>';
                  }).join('') || '<span class="font-mono text-xs text-muted">No tracked airline serves this route.</span>';
                })
                .catch(function(){ rr.textContent = 'Lookup failed.'; });
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
    <span key="leo">Low-Earth-orbit</span>,
  ],

  intro: () => (
    <p className="text-sm text-secondary leading-relaxed mb-3">
      Tracking the rollout of SpaceX Starlink in-flight WiFi across major airlines. Browse every
      equipped aircraft by airline and tail number, with live flight schedules so you can see which
      flights have fast, free connectivity.
    </p>
  ),

  Hero: HubHero,

  rowBadge: (_p, airline) => airline,

  subfleetFilters: enabledAirlines().map((a) => ({ key: a.code, label: a.name })),

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
              through 2027. <strong>Qatar Airways</strong> is equipping its 777 and A350 fleet. We
              currently track <span className="text-accent">{starlinkCount}</span> Starlink-equipped
              aircraft.
            </p>
          ),
          ld: "United Airlines is mid-rollout across mainline and Express fleets. Hawaiian Airlines completed its rollout in September 2024 — every A330 and A321neo has Starlink. Alaska Airlines is rolling out through 2027. Qatar Airways is equipping its 777 and A350 fleet.",
        },
        {
          q: "Hawaiian's rollout is complete — why isn't it 100%?",
          a: () => (
            <p>
              Hawaiian completed Starlink on <strong>100% of its Airbus fleet</strong> — every A330
              and A321neo. The remaining aircraft are Boeing 717s flying short interisland hops;
              those were never in scope for any WiFi provider and are being retired. So every
              in-scope aircraft is done; the headline percentage just includes the 717s in the
              denominator.
            </p>
          ),
          ld: "Hawaiian completed Starlink on 100% of its Airbus fleet. The remaining Boeing 717s fly short interisland routes and were never in scope for WiFi.",
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
              Yes — United, Hawaiian, Alaska, and Qatar all offer Starlink free to every passenger,
              gate-to-gate, with no login wall or loyalty requirement. This is a deliberate contrast
              with the paid legacy WiFi most carriers still use.
            </p>
          ),
          ld: "Yes. United, Hawaiian, Alaska, and Qatar all offer Starlink WiFi free to every passenger, gate-to-gate.",
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
