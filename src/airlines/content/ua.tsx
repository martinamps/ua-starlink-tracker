import React from "react";
import type { AirlineContent } from "./index";

export const content: AirlineContent = {
  showNavLinks: true,

  intro: () => (
    <p className="text-sm text-secondary leading-relaxed mb-3">
      United Airlines is rolling out free Starlink WiFi across its fleet — the fastest internet ever
      available on a commercial airline. Use this tracker to browse all equipped aircraft, check
      your flight, or plan a Starlink-maximizing itinerary.
    </p>
  ),

  statCards: [
    { key: "mainline", label: "Mainline" },
    { key: "express", label: "Express" },
  ],

  faq: [
    {
      title: "Checking your flight",
      items: [
        {
          q: "Does my United flight have Starlink?",
          a: () => (
            <p>
              Search above by flight number, tail number, or airport code. For a specific flight,{" "}
              <a href="/check-flight" className="text-accent hover:underline">
                check a flight by number and date
              </a>{" "}
              — if the flight is more than ~2 days out, you'll get a probability estimate based on
              12,000+ historical aircraft assignments. You can also install our{" "}
              <a
                href="https://chromewebstore.google.com/detail/google-flights-starlink-i/jjfljoifenkfdbldliakmmjhdkbhehoi"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                Chrome extension
              </a>{" "}
              to see Starlink badges on Google Flights.
            </p>
          ),
          ld: "Check a flight by number and date — if it's within 2 days you'll get a firm answer, otherwise a probability estimate based on 12,000+ historical aircraft assignments. You can also search the tracker by tail number or route, install our Chrome extension for Google Flights, or use the Route Planner to find the best Starlink routing.",
        },
        {
          q: "How do I know if my flight has Starlink?",
          a: () => (
            <p>
              Check your boarding pass for the tail number and search above. You can also search by
              flight number, airport codes, or aircraft type.
            </p>
          ),
          ld: "Check your boarding pass for the tail number and search the tracker. You can also search by flight number, airport codes, or aircraft type.",
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
          a: ({ starlinkCount, totalCount }) => (
            <p>
              Yes, United Airlines has been installing Starlink since March 2025. Currently{" "}
              <span className="text-accent">{starlinkCount}</span> of {totalCount} aircraft are
              equipped, with 40+ new installations per month.
            </p>
          ),
          ld: "Yes, United Airlines has been installing Starlink since March 2025. Currently {{totalCount}} of {{totalAircraftCount}} aircraft are equipped, with 40+ new installations per month.",
        },
        {
          q: "How many United planes have Starlink?",
          a: ({ starlinkCount, percentage, fleetStats }) => (
            <p>
              As of today, <span className="text-accent">{starlinkCount}</span> United aircraft have
              Starlink WiFi — {fleetStats?.mainline.starlink || 0} mainline and{" "}
              {fleetStats?.express.starlink || 0} Express planes. That's {percentage}% of the fleet.
            </p>
          ),
          ld: "As of today, {{totalCount}} United aircraft have Starlink WiFi — {{mainlineCount}} mainline and {{expressCount}} Express planes. That's {{percentage}}% of the fleet.",
        },
        {
          q: "Do all United flights have Starlink?",
          a: ({ percentage }) => (
            <p>
              Not yet. United is installing Starlink on 40+ planes per month. Currently {percentage}
              % of the fleet is equipped. Starlink is available on both mainline and United Express
              aircraft.
            </p>
          ),
          ld: "Not yet. United is installing Starlink on 40+ planes per month. Currently {{percentage}}% of the fleet is equipped. Starlink is available on both mainline and United Express aircraft.",
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
              United is installing Starlink on 40+ aircraft per month across a fleet of {totalCount}
              + planes. At the current pace, the full rollout will take until 2028–2029. Currently{" "}
              {percentage}% of the fleet is equipped. Regional jets and narrow-body aircraft are
              being equipped first.
            </p>
          ),
          ld: "United is installing Starlink on 40+ aircraft per month across a fleet of {{totalAircraftCount}}+ planes. At the current pace, the full rollout will take until 2028–2029. Currently {{percentage}}% of the fleet is equipped. Regional jets and narrow-body aircraft are being equipped first.",
        },
        {
          q: "Does United have Starlink on international flights?",
          a: () => (
            <p>
              Yes. Starlink works seamlessly over oceans, unlike previous WiFi systems. Check the
              aircraft list above — 787s and 777s with Starlink fly international routes.
            </p>
          ),
          ld: "Yes. Starlink works seamlessly over oceans, unlike previous WiFi systems. 787s and 777s with Starlink fly international routes.",
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
              Yes, completely free for all passengers. No purchase required, no tiered plans — just
              connect and go.
            </p>
          ),
          ld: "Yes, United's Starlink WiFi is completely free for all passengers. No purchase required, no tiered plans, no data caps - just connect to the WiFi network and enjoy high-speed internet throughout your flight.",
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
