import React from "react";
import { StatRing } from "../../components/atoms";
import type { AirlineContent, HeroProps } from "./index";

// Rollout counter: live count against the two honest denominators (the 300+
// end-of-2026 commitment and the ~800-strong 737 fleet), plus the "no provider
// announced beyond that" caveat that makes this a WiFi tracker rather than a
// Starlink assumption. Every number here traces to a Southwest release; the
// third panel names no vendor because Southwest has named none.
const WNHero = ({ stats }: HeroProps) => {
  const { starlinkCount, totalCount, percentage } = stats;
  return (
    <div className="relative grid grid-cols-1 sm:grid-cols-3 gap-px bg-subtle rounded-lg overflow-hidden mb-6 border border-subtle">
      <StatRing
        label="737s With Starlink"
        pct={Number.parseFloat(percentage)}
        starlink={starlinkCount}
        total={totalCount}
        color="#304cb2"
      />
      <div className="bg-surface px-4 py-6 flex flex-col items-center justify-center text-center">
        <div className="text-[10px] font-mono text-muted uppercase tracking-wider">Commitment</div>
        <div className="font-display text-2xl text-primary mt-2">300+ by end 2026</div>
        <div className="font-mono text-xs text-secondary mt-1">
          of ~{totalCount > 700 ? totalCount.toLocaleString("en-US") : "800"} 737s
        </div>
        <div className="font-mono text-[10px] text-muted mt-3">
          announced Feb 11, 2026 · first install Jun 22, 2026
        </div>
      </div>
      <div className="bg-surface px-4 py-6 flex flex-col items-center justify-center text-center">
        <div className="text-[10px] font-mono text-muted uppercase tracking-wider">
          Rest of Fleet
        </div>
        <div className="font-display text-2xl text-primary mt-2">Not announced</div>
        <div className="font-mono text-xs text-secondary mt-1">
          ~500 aircraft, no provider named
        </div>
        <div className="font-mono text-[10px] text-muted mt-3">
          tracked per tail, whichever provider ships
        </div>
      </div>
    </div>
  );
};

export const content: AirlineContent = {
  headerStats: [
    <span key="free">
      <span className="text-green-400 font-semibold">FREE</span> for Rapid Rewards
    </span>,
    <span key="target">
      <span className="text-accent font-semibold">300+</span> 737s by end 2026
    </span>,
    <span key="assign">
      aircraft assigned <span className="text-accent">~1h</span> before departure
    </span>,
  ],

  intro: () => (
    <p className="text-sm text-secondary leading-relaxed mb-3">
      Southwest started flying Starlink WiFi on June 22, 2026 — first aircraft N8543Z, a 737-800, on
      Dallas Love Field to Albuquerque — and plans 300+ of its ~800 737s equipped by the end of
      2026. Southwest finalizes which aircraft operates a flight only about an hour before
      departure, so no tracker can honestly promise Starlink on a specific flight in advance. What
      this site can tell you: the live equipped count, every equipped tail, and where those tails
      have been flying.
    </p>
  ),

  Hero: WNHero,

  rowBadge: () => null,

  subfleetFilters: [],

  faq: [
    {
      title: "Southwest's rollout",
      items: [
        {
          q: "Which Southwest aircraft have Starlink?",
          a: (s) => (
            <p>
              {s.starlinkCount.toLocaleString("en-US")} of Southwest's ~800 Boeing 737s have
              Starlink so far — the rollout began with <strong>N8543Z</strong>, a 737-800 whose
              first Starlink revenue flight was Dallas Love Field to Albuquerque on{" "}
              <strong>June 22, 2026</strong>. Southwest has committed to{" "}
              <strong>300+ aircraft by the end of 2026</strong>. The list above shows every equipped
              tail and its upcoming flights.
            </p>
          ),
          ld: "The rollout began June 22, 2026 with N8543Z, a 737-800 (first revenue flight Dallas Love Field to Albuquerque). Southwest has committed to 300+ of its ~800 737s by the end of 2026.",
        },
        {
          q: "Is Southwest's WiFi free?",
          a: () => (
            <p>
              Free for <strong>Rapid Rewards members</strong> —{" "}
              <a
                href="https://investors.southwest.com/news-events/press-releases/detail/1892/free-wifi-in-the-sky-southwest-airlines-partners-with-t-mobile-to-offer-free-inflight-wifi-for-all-rapid-rewards-members"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                since October 24, 2025
              </a>
              , T-Mobile has sponsored free WiFi for members on Southwest's whole fleet,
              Starlink-equipped or not. Without a (free-to-create) Rapid Rewards account, WiFi is $8
              per device. The difference on a Starlink aircraft is speed and reliability, not price.
            </p>
          ),
          ld: "Free for Rapid Rewards members via a T-Mobile sponsorship since October 24, 2025, on the whole fleet; $8 per device otherwise. Starlink changes the speed, not the pricing.",
        },
        {
          q: "Will my specific Southwest flight have Starlink?",
          a: () => (
            <p>
              Honestly: nobody can tell you in advance. Southwest assigns the actual aircraft only
              about <strong>an hour before departure</strong>, and tail assignments published
              earlier are unreliable. So this tracker gives <strong>fleet odds</strong> — how many
              737s are equipped so far — plus the equipped-tail list and the routes those tails have
              been flying, instead of a per-flight promise that would often be wrong.
            </p>
          ),
          ld: "Not predictable in advance: Southwest finalizes the operating aircraft about an hour before departure. This tracker gives honest fleet odds, the equipped-tail list, and where those tails have been flying.",
        },
        {
          q: "Will the whole Southwest fleet get Starlink?",
          a: () => (
            <p>
              Southwest says it intends to upgrade its whole fleet to low-Earth-orbit satellite
              WiFi, but the only announced Starlink commitment covers 300+ aircraft by the end of
              2026. It has not named a provider for the remaining ~500 737s. This site tracks the
              WiFi provider per tail, so whichever vendor equips the rest of the fleet, the map
              stays honest.
            </p>
          ),
          ld: "Southwest says it intends to upgrade its whole fleet to low-Earth-orbit satellite WiFi, but the announced Starlink commitment covers 300+ aircraft by the end of 2026 and no provider has been named for the remaining ~500 737s. This tracker records the WiFi provider per tail.",
        },
      ],
    },
    {
      title: "About this data",
      items: [
        {
          q: "How is this data collected?",
          a: () => (
            <p>
              Southwest publishes no per-aircraft WiFi roster, so equipped tails come from a curated
              evidence log: each tail is recorded with the date of its first public evidence (launch
              announcements, first revenue flights, credible passenger and spotter reports) and a
              note saying what proved it. The fleet denominator comes from public aviation data. See
              the{" "}
              <a href="/methodology" className="text-accent hover:underline">
                methodology page
              </a>{" "}
              for the full story.
            </p>
          ),
          ld: "Equipped tails come from a curated per-tail evidence log (launch announcements, first revenue flights, credible spotter reports), each dated. The fleet denominator comes from public aviation data.",
        },
      ],
    },
  ],
};
