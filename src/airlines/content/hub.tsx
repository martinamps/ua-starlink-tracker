import React from "react";
import type { AirlineContent } from "./index";

export const content: AirlineContent = {
  showNavLinks: false,

  intro: () => (
    <p className="text-sm text-secondary leading-relaxed mb-3">
      Tracking the rollout of SpaceX Starlink in-flight WiFi across major airlines. Browse every
      equipped aircraft by airline and tail number, with live flight schedules so you can see which
      flights have fast, free connectivity.
    </p>
  ),

  statCards: [{ key: "mainline", label: "Equipped" }],

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
