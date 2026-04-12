import React from "react";
import { AirlineSummaryCard } from "../../components/atoms";
import type { AirlineContent, HeroProps } from "./index";

const HubHero = ({ stats, perAirlineStats = [] }: HeroProps) => {
  const { starlinkCount, totalCount } = stats;
  return (
    <div className="relative mb-6">
      <div className="text-center mb-4">
        <div className="font-mono text-sm text-secondary">
          Tracking <span className="text-accent font-semibold">{starlinkCount}</span> Starlink
          aircraft across{" "}
          <span className="text-accent font-semibold">{perAirlineStats.length}</span> airline
          {perAirlineStats.length === 1 ? "" : "s"} ·{" "}
          <span className="text-muted">{totalCount} total fleet</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-4 justify-center">
        {perAirlineStats.map((a) => (
          <AirlineSummaryCard key={a.code} a={a} />
        ))}
      </div>
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

  rowBadge: (p) => p.OperatedBy?.split(" ")[0]?.toUpperCase() || null,

  subfleetFilters: [],

  faq: [
    {
      title: "About this tracker",
      items: [
        {
          q: "Which airlines have Starlink WiFi?",
          a: ({ starlinkCount }) => (
            <p>
              United Airlines is mid-rollout across its mainline and Express fleets. Hawaiian
              Airlines completed its Airbus rollout in 2024. Alaska Airlines has announced a
              fleet-wide rollout for 2025–2027. We currently track{" "}
              <span className="text-accent">{starlinkCount}</span> Starlink-equipped aircraft across
              these carriers.
            </p>
          ),
          ld: "United Airlines is mid-rollout across its mainline and Express fleets. Hawaiian Airlines completed its Airbus rollout in 2024. Alaska Airlines has announced a fleet-wide rollout for 2025–2027.",
        },
        {
          q: "How is this data collected?",
          a: () => (
            <p>
              Fleet rosters and flight schedules come from public aviation data. Starlink status is
              verified per-tail against each airline's own systems where available, and against
              public rollout announcements where the install is type-complete.
            </p>
          ),
          ld: "Fleet rosters and flight schedules come from public aviation data. Starlink status is verified per-tail against each airline's own systems where available.",
        },
      ],
    },
  ],
};
