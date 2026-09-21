import { RolloutPanel } from "../../components/home/rollout";
import type { AirlineContent, HeroProps } from "./index";

// Air France has no tenant site: this content backs only the registry's
// exhaustiveness guarantee and any future homepage. The hub's
// /airlines/air-france page is the real surface, and it renders by aircraft
// type, never one blended percentage.
const AFHero = ({ stats, statSentence }: HeroProps) => (
  <RolloutPanel
    stats={stats}
    noun="Air France aircraft, at least"
    segments={[{ label: "Starlink", n: stats.starlinkCount, total: stats.totalCount }]}
  >
    {statSentence}
  </RolloutPanel>
);

export const content: AirlineContent = {
  headerStats: [
    <span key="free" className="text-success font-semibold">
      Free
    </span>,
    <span key="bytype">by aircraft type</span>,
  ],

  intro: () => (
    <>
      Air France is installing free Starlink Wi-Fi fleet by fleet. Whether your flight has it
      depends on the aircraft type, and on a 777 on whether it is the -300ER or the -200ER.
    </>
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
        },
      ],
    },
  ],
};
