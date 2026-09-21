import React from "react";
import {
  AirlineProgressList,
  FlightCheckInput,
  RecentInstallsFeed,
  RouteComparePanel,
  completeScope,
} from "../../components/atoms";
import { H2, StatInline, fmt } from "../../components/layout";
import { airlineHomeUrl, publicAirlines } from "../registry";
import { AIRLINE_FACTS, type AirlineFactsEntry, type RolloutFactsStatus } from "../rollout-facts";
import type { AirlineContent, HeroProps, HubHomeLinks } from "./index";

const CHIP =
  "font-mono text-xs px-2.5 py-1 rounded border border-subtle bg-surface-elevated text-secondary hover:border-accent hover:text-accent transition-colors";
const LINK = "text-accent hover:underline";

// The hub answers cross-airline questions; United-specific intent belongs to
// the United tracker, so every United mention here links there.
const UNITED_URL = airlineHomeUrl("UA");
const UNITED_HOST = new URL(UNITED_URL).host;

function namesWith(status: RolloutFactsStatus): string[] {
  return AIRLINE_FACTS.filter((e: AirlineFactsEntry) => e.status === status).map((e) => {
    const scope = status === "complete" ? completeScope(e.trackedCode) : undefined;
    return scope ? `${e.shortName} (${scope})` : e.shortName;
  });
}

function list(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const FLYING_COUNT = AIRLINE_FACTS.filter(
  (e) => e.status === "installing" || e.status === "complete"
).length;

/** Crawlable inlinks to the hub's own URL families: most of its sitemap URLs
 * were discovered but never crawled while the homepage linked only /airlines. */
function HubLinkGrid({ links }: { links?: HubHomeLinks }) {
  if (!links || (links.airlines.length === 0 && links.compares.length === 0)) return null;
  return (
    <nav className="bg-surface border border-subtle rounded-lg p-5" aria-label="Airlines">
      {links.airlines.length > 0 && (
        <>
          <h2 className="text-xs font-mono text-muted uppercase tracking-wider mb-3">
            Airlines with Starlink
          </h2>
          <div className="flex flex-wrap gap-2">
            {links.airlines.map((l) => (
              <a key={l.href} href={l.href} className={CHIP}>
                {l.label}
              </a>
            ))}
          </div>
        </>
      )}
      {links.compares.length > 0 && (
        <>
          <h2 className="text-xs font-mono text-muted uppercase tracking-wider mt-4 mb-3">
            Compare
          </h2>
          <div className="flex flex-wrap gap-2">
            {links.compares.map((l) => (
              <a key={l.href} href={l.href} className={CHIP}>
                {l.label}
              </a>
            ))}
          </div>
        </>
      )}
    </nav>
  );
}

const HubHero = ({ perAirlineStats = [], recentInstalls = [], hubLinks }: HeroProps) => {
  return (
    <div className="relative mx-auto mb-8 w-full max-w-3xl space-y-6">
      <section>
        <h2 className={H2}>Where each tracked rollout stands</h2>
        <div className="mt-4 rounded-lg border border-subtle bg-surface p-5">
          <AirlineProgressList stats={perAirlineStats} />
        </div>
        <p className="mt-2 text-sm">
          <a href="/airlines" className={LINK}>
            All {AIRLINE_FACTS.length} airlines, including the ones that said no →
          </a>
        </p>
      </section>
      <RouteComparePanel />
      <FlightCheckInput />
      <RecentInstallsFeed items={recentInstalls} airlines={perAirlineStats} />
      <HubLinkGrid links={hubLinks} />

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
                  if (d.error) { cr.innerHTML = '<span class="text-warn">' + esc(d.error) + '</span>'; return; }
                  var label, cls;
                  if (d.hasStarlink === true) { label = 'Starlink'; cls = 'text-success'; }
                  else if (d.hasStarlink === false) { label = 'No Starlink'; cls = 'text-muted'; }
                  else if (typeof d.probability === 'number' && d.basis && d.probability === 0) { label = 'Unlikely'; cls = 'text-muted'; }
                  else if (typeof d.probability === 'number' && d.basis) { label = '≥' + Math.floor(d.probability * 100) + '% Starlink'; cls = 'text-accent'; }
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
              var color = a.accentText || a.accentColor || '#0ea5e9';
              var inferred = a.kind === 'inferred_absent';
              var rp = a.routePlannerBase ? a.routePlannerBase+'/'+O+'/'+D : null;
              if (a.kind === 'no_data') {
                return '<div class="mb-3 opacity-60"><div class="flex justify-between items-center font-mono text-xs"><span class="text-muted">'+esc(a.name)+(rp?pill(rp,'check route planner',color):'')+'</span><span class="text-muted">\\u2014</span></div>'
                     + '<div class="font-mono text-xs text-muted">No route data yet</div></div>';
              }
              if (a.kind === 'observed_mixed') {
                var head = '<div class="flex justify-between items-center font-mono text-xs"><span class="text-primary">'+esc(a.name)+'</span></div>'
                         + '<div class="font-mono text-xs text-muted">'+esc(a.reason)+'</div>';
                var rows = (a.breakdown||[]).map(function(b,i){
                  var br = Math.round(b.pct*100);
                  var lblTip = b.hint ? 'Flight numbers '+esc(b.hint) : '';
                  var best = i===0 && br>=50 ? ' '+tip('text-[8px] px-1 py-px rounded no-underline','Pick a flight in this group for the best Starlink odds','<span style="background:color-mix(in srgb,'+esc(color)+' 18%,transparent);color:'+esc(color)+';padding:1px 4px;border-radius:3px">best bet</span>') : '';
                  var counts = b.equipped!=null ? esc(b.equipped)+'/'+esc(b.total)+' aircraft \\u00b7 ' : '';
                  return '<div class="mt-1.5 ml-3"><div class="flex justify-between font-mono text-xs">'
                       + '<span>'+tip('text-secondary',lblTip,esc(shorten(b.label)))+best+'</span>'
                       + tip('text-accent tip-l',b.equipped!=null?fleetTip(a,b):'',counts+br+'%')+'</div>'+bar(br,color,false)+'</div>';
                }).join('');
                return '<div class="mb-3">'+head+rows+'</div>';
              }
              var pct = Math.round(a.probability*100);
              var bd0 = (a.breakdown||[])[0]||{};
              var pctTip = (bd0.equipped!=null) ? fleetTip(a,bd0) : '';
              var chipL = (pct < 50 && a.kind !== 'type_rule' && rp) ? pill(rp, 'try a connection', color) : '';
              return '<div class="mb-3"><div class="flex justify-between items-center font-mono text-xs"><span class="text-primary">'+esc(a.name)+chipL+'</span>'
                   + tip('text-accent tip-l',pctTip,pct+'%')+'</div>'
                   + '<div class="font-mono text-xs text-muted">'+esc(a.reason)+'</div>'+bar(pct,color,inferred)+'</div>';
            }
            function doCompare(origin, dest) {
              rr.classList.remove('hidden');
              rr.textContent = 'Comparing…';
              fetch('/api/compare-route?origin=' + encodeURIComponent(origin) + '&destination=' + encodeURIComponent(dest))
                .then(function(r){return r.json()})
                .then(function(d){
                  if (d.error) { rr.innerHTML = '<span class="text-warn font-mono text-xs">' + esc(d.error) + '</span>'; return; }
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
  headerStats: [
    <span key="flying">
      <span className="text-accent font-semibold">{FLYING_COUNT}</span> airlines flying or
      installing Starlink
    </span>,
  ],

  intro: () => (
    <>
      {AIRLINE_FACTS.length} airlines, from finished fleets to firm no's, each with a dated source.
      We count{" "}
      {list(
        publicAirlines()
          .filter((a) => !a.communitySource && a.rollout.rosterIsProgramScope)
          .map((a) => a.shortName)
      )}{" "}
      plane by plane.
    </>
  ),

  Hero: HubHero,

  answers: [
    {
      q: "Which airlines have Starlink Wi-Fi?",
      a: () => (
        <p>
          {FLYING_COUNT} airlines fly Starlink or are installing it. Finished:{" "}
          {list(namesWith("complete"))}. Installing: {list(namesWith("installing"))}. Announced but
          not flying yet: {list(namesWith("announced"))}. The{" "}
          <a href="/airlines" className={LINK}>
            full list
          </a>{" "}
          dates and sources every status.
        </p>
      ),
    },
    {
      q: "Which airline has the most Starlink planes?",
      a: ({ perAirline = [] }) => {
        const [top, ...rest] = [...perAirline].sort((a, b) => b.starlink - a.starlink);
        if (!top) return <p>See the full list for each airline's count.</p>;
        return (
          <p>
            Of the airlines tracked here, {top.name} has the most, with{" "}
            <StatInline n={top.starlink} /> planes
            {top.code === "UA" ? (
              <>
                {" "}
                on the{" "}
                <a href={UNITED_URL} className={LINK}>
                  United Starlink Tracker
                </a>
              </>
            ) : null}
            .{" "}
            {rest.length > 0 && (
              <>Next: {list(rest.map((r) => `${r.name} (${fmt(r.starlink)})`))}.</>
            )}
          </p>
        );
      },
    },
    {
      q: "Is Starlink Wi-Fi free on every airline?",
      a: () => (
        <p>
          Not always, and the rules differ. United's is free for MileagePlus members, Alaska's for
          Atmos Rewards members, and Hawaiian's and Qatar's for every passenger. Each airline's page
          on the{" "}
          <a href="/airlines" className={LINK}>
            full list
          </a>{" "}
          gives its terms with a source.
        </p>
      ),
    },
    {
      q: "How do I check if my flight has Starlink?",
      a: () => (
        <p>
          Enter the flight number and date in the flight check above; it covers every airline we
          track. For United flights,{" "}
          <a href={UNITED_URL} className={LINK}>
            {UNITED_HOST}
          </a>{" "}
          has the full answer, including route odds.
        </p>
      ),
    },
  ],

  rowBadge: (_p, airline) => airline,

  subfleetFilters: publicAirlines().map((a) => ({ key: a.code, label: a.name })),

  faq: [
    {
      title: "Airlines",
      items: [
        {
          q: "Does Delta have Starlink?",
          a: () => (
            <p>
              No. Delta has partnered with Amazon's Project Kuiper, a Starlink competitor, for
              in-flight Wi-Fi from around 2028.{" "}
              <a href="/airlines/delta" className={LINK}>
                Delta's page
              </a>{" "}
              has the details.
            </p>
          ),
        },
        {
          q: "Does United have Starlink?",
          a: () => (
            <p>
              Yes, and it's the biggest rollout we track. The{" "}
              <a href={UNITED_URL} className={LINK}>
                United Starlink Tracker
              </a>{" "}
              has the live count, every equipped aircraft and a flight check.
            </p>
          ),
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
              confirmed per aircraft against each airline's own systems where they show it (United,
              Alaska), and by aircraft type where the airline has finished whole types (Hawaiian,
              Qatar). Airlines we don't track aircraft by aircraft get dated, sourced status pages.
            </p>
          ),
        },
        {
          q: "How accurate is this?",
          a: () => (
            <p>
              For United we check answers against united.com continuously. Type-based answers
              (Hawaiian, Qatar) are as good as the airline's own type list. Aircraft swaps close to
              departure are the main source of error on any airline.
            </p>
          ),
        },
      ],
    },
  ],
};
