import React from "react";
import { ModelPie, StatRing, computeModelBreakdown } from "../../components/atoms";
import type { AirlineContent, HeroProps } from "./index";

const QRHero = ({ stats, starlinkData }: HeroProps) => {
  const { starlinkCount, totalCount, percentage } = stats;
  const modelData = computeModelBreakdown(starlinkData);
  return (
    <div className="relative grid grid-cols-1 sm:grid-cols-3 gap-px bg-subtle rounded-lg overflow-hidden mb-6 border border-subtle">
      <StatRing
        label="Fleet Progress"
        pct={Number.parseFloat(percentage)}
        starlink={starlinkCount}
        total={totalCount}
        color="#5c0632"
      />
      <div className="bg-surface px-4 py-6 flex flex-col items-center justify-center text-center">
        <div className="text-xs font-mono text-muted uppercase tracking-wider">Status</div>
        <div className="font-display text-2xl text-primary mt-2">777 + A350 done</div>
        <div className="font-mono text-xs text-secondary mt-1">completed Dec 2025</div>
        <div className="font-mono text-xs text-muted mt-3">787-8 done · 787-9 in progress</div>
      </div>
      <ModelPie data={modelData} total={starlinkCount} />
    </div>
  );
};

export const content: AirlineContent = {
  headerStats: [
    <span key="free" className="text-green-400 font-semibold">
      FREE
    </span>,
    <span key="widebodies">
      <span className="text-accent font-semibold">777 + A350</span> complete
    </span>,
    <span key="787">
      <span className="text-accent">787-9</span> rolling out
    </span>,
  ],

  intro: () => (
    <p className="text-sm text-secondary leading-relaxed mb-3">
      Qatar Airways has finished installing free Starlink WiFi on its entire Boeing 777 and Airbus
      A350 passenger fleets — the rollout for both was completed in December 2025 — and on its
      787-8s, and is now equipping the 787-9s. The A380, A330, narrowbody Airbus jets and freighters
      are not part of the program.
    </p>
  ),

  Hero: QRHero,

  rowBadge: () => null,

  subfleetFilters: [],

  faq: [
    {
      title: "Qatar Airways' rollout",
      items: [
        {
          q: "Which Qatar Airways aircraft have Starlink?",
          a: () => (
            <p>
              Qatar Airways reports its passenger <strong>Boeing 777</strong> and{" "}
              <strong>Airbus A350</strong> fleets fully fitted with Starlink (both completed by
              December 2025), and its <strong>Boeing 787-8</strong> fleet since August 2026. The{" "}
              <strong>787-9</strong> fleet is being equipped now. The A380, A330, narrowbody
              A320-family aircraft and freighters are not in the program.
            </p>
          ),
          ld: "Qatar Airways reports its passenger Boeing 777 and Airbus A350 fleets fully fitted with Starlink (both completed by December 2025) and its 787-8 fleet since August 2026. The 787-9 fleet is mid-installation. The A380, A330, A320-family narrowbodies and freighters are not in the program.",
        },
        {
          q: "Is Qatar Airways' Starlink WiFi free?",
          a: () => (
            <p>
              Yes — free for every passenger, gate-to-gate, with no purchase or loyalty status
              required.
            </p>
          ),
          ld: "Yes. Qatar Airways' Starlink WiFi is free for every passenger, gate-to-gate, with no purchase required.",
        },
        {
          q: "Does my Qatar Airways flight have Starlink?",
          a: () => (
            <p>
              It depends on the aircraft type scheduled for your flight. Qatar reports its 777, A350
              and 787-8 fleets fully fitted, so those are a yes. 787-9 installs are under way (due
              end-2026), so a 787-9 may or may not have it yet. The A380, A330 and narrowbodies are
              not in the program. Check your flight number and date to see the scheduled aircraft
              type.
            </p>
          ),
          ld: "Qatar reports its 777, A350 and 787-8 fleets fully fitted with Starlink. 787-9 installs are under way, due end-2026. The A380, A330 and narrowbodies are not in the program. Check your flight number and date for the scheduled aircraft type.",
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
              Fleet roster from public aviation data; per-flight equipment from Qatar Airways'
              flight-status systems on selected routes. Qatar publishes the aircraft type about a
              week ahead, so dates inside that window are answered from the published schedule.
              Further out, the answer is a conservative estimate from the aircraft types that flight
              number has flown on recent operating days.
            </p>
          ),
          ld: "Fleet roster from public aviation data; per-flight equipment from Qatar Airways' flight-status systems on selected routes. Dates about a week out are answered from the published aircraft type; further out, from the aircraft types the flight number has flown recently.",
        },
      ],
    },
  ],
};
