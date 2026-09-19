import React from "react";
import { StatRing } from "../../components/atoms";
import type { AirlineContent, HeroProps } from "./index";

// Air France has no tenant site: this content backs only the registry's
// exhaustiveness guarantee and any future homepage. The hub's
// /airlines/air-france page is the real surface, and it renders by aircraft
// type, never one blended percentage.
const AFHero = ({ stats }: HeroProps) => (
  <div className="relative grid grid-cols-1 gap-px bg-subtle rounded-lg overflow-hidden mb-6 border border-subtle">
    <StatRing
      label="At least"
      pct={Number.parseFloat(stats.percentage)}
      starlink={stats.starlinkCount}
      total={stats.totalCount}
      color="#002157"
    />
  </div>
);

export const content: AirlineContent = {
  headerStats: [
    <span key="free" className="text-green-400 font-semibold">
      FREE
    </span>,
    <span key="bytype">by aircraft type</span>,
  ],

  intro: () => (
    <p className="text-sm text-secondary leading-relaxed mb-3">
      Air France is installing free Starlink WiFi fleet by fleet. Whether your flight has it depends
      on the aircraft type — and on a 777, on whether it is the -300ER or the -200ER.
    </p>
  ),

  Hero: AFHero,

  rowBadge: () => null,

  subfleetFilters: [],

  faq: [
    {
      title: "Air France's rollout",
      items: [
        {
          q: "Does my Air France flight have Starlink?",
          a: () => (
            <p>
              It depends on the aircraft. Most 777-300ERs, A350s, A220s and E190s have it; the
              787-9, 777-200ER, A321 and E170 have not started. Per-aircraft status comes from the
              FlyerTalk Air France fleet guide, a community-curated list.
            </p>
          ),
          ld: "It depends on the aircraft. Most 777-300ERs, A350s, A220s and E190s have Starlink; the 787-9, 777-200ER, A321 and E170 have not started. Per-aircraft status comes from the community-curated FlyerTalk Air France fleet guide.",
        },
      ],
    },
  ],
};
