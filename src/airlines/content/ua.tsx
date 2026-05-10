import React from "react";
import { ModelPie, StatRing, computeModelBreakdown } from "../../components/atoms";
import type { AirlineContent, HeroProps } from "./index";

const UAHero = ({ stats, starlinkData }: HeroProps) => {
  const { fleetStats, starlinkCount: x, totalCount: y, percentage } = stats;
  const modelData = computeModelBreakdown(starlinkData);
  return (
    <div className="relative grid grid-cols-2 lg:grid-cols-4 gap-px bg-subtle rounded-lg overflow-hidden mb-6 border border-subtle">
      <StatRing
        label="Mainline"
        pct={fleetStats?.mainline.percentage || 0}
        starlink={fleetStats?.mainline.starlink || 0}
        total={fleetStats?.mainline.total || 0}
      />
      <StatRing
        label="Express"
        pct={fleetStats?.express.percentage || 0}
        starlink={fleetStats?.express.starlink || 0}
        total={fleetStats?.express.total || 0}
      />
      <StatRing
        label="Total Fleet"
        pct={Number.parseFloat(percentage)}
        starlink={x}
        total={y}
        color="#22c55e"
        variant="total"
      />
      <ModelPie data={modelData} total={x} />
    </div>
  );
};

export const content: AirlineContent = {
  showNavLinks: true,

  headerStats: [
    <span key="mbps">
      <span className="text-accent font-semibold">250</span> Mbps
    </span>,
    <span key="faster">
      <span className="text-accent font-semibold">50×</span> faster
    </span>,
    <span key="free" className="text-green-400 font-semibold">
      FREE
    </span>,
    <span key="installs" className="hidden sm:inline">
      <span className="text-accent font-semibold">40+</span> installs/mo
    </span>,
  ],

  intro: () => (
    <p className="text-sm text-secondary leading-relaxed mb-3">
      United Airlines is rolling out free Starlink WiFi across its fleet — the fastest internet ever
      available on a commercial airline. Use this tracker to browse all equipped aircraft, check
      your flight, or plan a Starlink-maximizing itinerary.
    </p>
  ),

  Hero: UAHero,

  rowBadge: (p) => (p.fleet === "mainline" ? "Mainline" : "Express"),

  subfleetFilters: [
    { key: "mainline", label: "Mainline" },
    { key: "express", label: "Express" },
  ],

  // ld strings are the FAQPage JSON-LD copy; keep them in sync with the visible a()
  // body — Google requires markup to match rendered content. {{...}} placeholders in
  // ld resolve against buildBaseTemplateVars() in renderHtml().
  faq: [
    {
      title: "Checking your flight",
      items: [
        {
          q: "Does my United flight have Starlink?",
          a: () => (
            <p>
              Search your flight number and date above for a live answer. Within roughly two days of
              departure the exact aircraft is usually assigned, so you get a firm yes or no; further
              out you get a probability estimate built from 12,000+ historical aircraft assignments
              on that route. You can also{" "}
              <a href="/check-flight" className="text-accent hover:underline">
                check a flight by number and date
              </a>{" "}
              or install our{" "}
              <a
                href="https://chromewebstore.google.com/detail/google-flights-starlink-i/jjfljoifenkfdbldliakmmjhdkbhehoi"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                Chrome extension
              </a>{" "}
              to see Starlink badges right on Google Flights.
            </p>
          ),
          ld: "Search your flight number and date for a live answer. Within roughly two days of departure the exact aircraft is usually assigned, so you get a firm yes or no; further out you get a probability estimate built from 12,000+ historical aircraft assignments on that route. You can also check a flight by number and date or install our Chrome extension to see Starlink badges right on Google Flights.",
        },
        {
          q: "How do I maximize my chances of getting Starlink?",
          a: ({ fleetStats }) => (
            <>
              <p className="mb-2">
                Use the{" "}
                <a href="/route-planner" className="text-accent hover:underline">
                  Route Planner
                </a>{" "}
                — it finds direct flights and 1-stop connections ranked by Starlink probability.
                Express flights (UA3000-6999, regional jets) have ~
                {fleetStats?.express.percentage.toFixed(0)}% Starlink coverage vs ~
                {fleetStats?.mainline.percentage.toFixed(0)}% for mainline, so a connection through
                a hub can beat a direct mainline flight.
              </p>
              <p>
                For example: DEN→ORD direct is mainline (~2%), but DEN→ASE→ORD is ~90% Starlink on
                both legs.
              </p>
            </>
          ),
          ld: "Use the Route Planner to compare direct flights and 1-stop connections ranked by Starlink probability. Express flights (UA3000-6999, regional jets) have much higher coverage than mainline — a connection through a hub can beat a direct mainline flight. For example: DEN→ORD direct is ~2%, but DEN→ASE→ORD is ~90% Starlink on both legs.",
        },
      ],
    },
    {
      title: "The rollout",
      items: [
        {
          q: "Does United have Starlink?",
          a: ({ starlinkCount, totalCount, percentage }) => (
            <p>
              Yes. United started installing Starlink in March 2025 and currently has it live on{" "}
              <span className="text-accent">{starlinkCount}</span> of {totalCount} aircraft (
              {percentage}% of the fleet), across both mainline and United Express jets.
            </p>
          ),
          ld: "Yes. United started installing Starlink in March 2025 and currently has it live on {{starlinkCount}} of {{totalAircraftCount}} aircraft ({{percentage}}% of the fleet), across both mainline and United Express jets.",
        },
        {
          q: "How many United planes have Starlink?",
          a: ({ starlinkCount, totalCount, percentage }) => (
            <p>
              As of {new Date().toLocaleDateString()},{" "}
              <span className="text-accent">{starlinkCount}</span> United aircraft have Starlink —{" "}
              {percentage}% of the {totalCount}-plane fleet, split across mainline and United
              Express. The count updates here as new tails are verified against United's own
              systems.
            </p>
          ),
          ld: "As of {{currentDate}}, {{starlinkCount}} United aircraft have Starlink — {{percentage}}% of the {{totalAircraftCount}}-plane fleet, split across mainline and United Express. The count updates here as new tails are verified against United's own systems.",
        },
        {
          q: "Do all United flights have Starlink?",
          a: ({ percentage, fleetStats }) => (
            <p>
              Not yet — {percentage}% of the fleet is equipped today. United Express regional jets
              (E175, CRJ-550) are at {(fleetStats?.express.percentage || 0).toFixed(2)}%; mainline
              narrowbodies and widebodies are following. The{" "}
              <a href="/fleet" className="text-accent hover:underline">
                fleet page
              </a>{" "}
              lists every verified tail.
            </p>
          ),
          ld: "Not yet — {{percentage}}% of the fleet is equipped today. United Express regional jets (E175, CRJ-550) are at {{expressPercentage}}%; mainline narrowbodies and widebodies are following. The fleet page lists every verified tail.",
        },
        {
          q: "When will my route get Starlink?",
          a: ({ fleetStats }) => (
            <>
              <p className="mb-2">
                <span className="text-green-400">●</span> Regional jets:{" "}
                {fleetStats?.express.percentage.toFixed(0)}% complete
              </p>
              <p>
                <span className="text-accent">●</span> Mainline fleet:{" "}
                {fleetStats?.mainline.percentage.toFixed(0)}% complete
              </p>
            </>
          ),
          ld: "Regional jets are {{expressPercentage}}% complete; mainline fleet is {{mainlinePercentage}}% complete.",
        },
        {
          q: "When will all United flights have Starlink?",
          a: ({ totalCount, percentage }) => (
            <p>
              United hasn't published a completion date. Currently {percentage}% of the {totalCount}
              -plane fleet is equipped — regional jets and narrow-body aircraft are being equipped
              first, with widebodies to follow. The count on this page updates as new tails are
              verified.
            </p>
          ),
          ld: "United hasn't published a completion date. Currently {{percentage}}% of the {{totalAircraftCount}}-plane fleet is equipped — regional jets and narrow-body aircraft are being equipped first, with widebodies to follow. The count on this page updates as new tails are verified.",
        },
        {
          q: "Does United have Starlink on international flights?",
          a: () => (
            <p>
              Not on widebody international routes yet. Starlink works over oceans and at the poles
              — unlike older Ku/Ka-band systems with coverage gaps — so it's a matter of when, but
              787, 777, and 767 installs haven't started. Today's equipped aircraft are E175 and
              CRJ-550 regional jets on near-international routes to Canada, Mexico, and the
              Caribbean. Check the{" "}
              <a href="/fleet" className="text-accent hover:underline">
                fleet page
              </a>{" "}
              for current coverage.
            </p>
          ),
          ld: "Not on widebody international routes yet. Starlink works over oceans and at the poles — unlike older Ku/Ka-band systems with coverage gaps — so it's a matter of when, but 787, 777, and 767 installs haven't started. Today's equipped aircraft are E175 and CRJ-550 regional jets on near-international routes to Canada, Mexico, and the Caribbean. Check the fleet page for current coverage.",
        },
      ],
    },
    {
      title: "About Starlink WiFi",
      items: [
        {
          q: "Is United Starlink WiFi free?",
          a: () => (
            <p>
              Yes — free for MileagePlus members, and MileagePlus is free to join. No purchase, no
              tiers, no data caps.
            </p>
          ),
          ld: "Yes — free for MileagePlus members, and MileagePlus is free to join. No purchase, no tiers, no data caps.",
        },
        {
          q: "What can I do with Starlink WiFi?",
          a: () => (
            <p>
              4K streaming, live sports, online gaming, large downloads — everything you can do at
              home.
            </p>
          ),
          ld: "United's Starlink WiFi offers speeds up to 250 Mbps, which is 50 times faster than previous systems. This enables 4K streaming, live sports, online gaming, and large downloads.",
        },
      ],
    },
    {
      title: "Using this tracker",
      items: [
        {
          q: "How does this tracker work?",
          a: () => (
            <>
              <p>
                We aggregate data from multiple aviation data providers, cross-reference with flight
                schedules, and verify Starlink status against United's own systems. The data updates
                continuously throughout the day.
              </p>
              <p className="mt-2 text-xs">
                Hat tip to the{" "}
                <a
                  href="https://sites.google.com/site/unitedfleetsite/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline"
                >
                  unitedfleetsite
                </a>{" "}
                community for the original fleet data that helped get this project started.
              </p>
            </>
          ),
          ld: "We aggregate data from multiple aviation data providers, cross-reference with flight schedules, and verify Starlink status against United's own systems. The data updates continuously throughout the day to provide accurate, real-time tracking.",
        },
        {
          q: "Can I use this with Claude, ChatGPT, or other AI assistants?",
          a: () => (
            <p>
              Yes — there's a free{" "}
              <a href="/mcp" className="text-accent hover:underline">
                MCP connector
              </a>{" "}
              that works with Claude Desktop, Cursor, and any MCP-compatible client. Once connected,
              you can ask your AI assistant things like "does UA4680 next week have Starlink?" or
              "find me the best way to fly SFO to JAX with Starlink" and get live tracker data.
            </p>
          ),
          ld: "Yes — there's a free MCP server at https://unitedstarlinktracker.com/mcp that works with Claude Desktop, Cursor, and any MCP-compatible client. Once connected, you can ask your AI assistant to check flights, predict Starlink probability, or plan routes using live tracker data.",
        },
      ],
    },
  ],
};
