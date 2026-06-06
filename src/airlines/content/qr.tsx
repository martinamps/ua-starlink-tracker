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
        <div className="text-[10px] font-mono text-muted uppercase tracking-wider">Status</div>
        <div className="font-display text-2xl text-primary mt-2">777 + A350 done</div>
        <div className="font-mono text-xs text-secondary mt-1">completed Dec 2025</div>
        <div className="font-mono text-[10px] text-muted mt-3">787 in progress</div>
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
      <span className="text-accent">787</span> rolling out
    </span>,
  ],

  intro: () => (
    <p className="text-sm text-secondary leading-relaxed mb-3">
      Qatar Airways has finished installing free Starlink WiFi on its entire Boeing 777 and Airbus
      A350 passenger fleets — the rollout for both was completed in December 2025 — and is now
      equipping the Boeing 787s. Narrowbody Airbus jets and freighters are not part of the program.
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
              Every passenger <strong>Boeing 777</strong> and <strong>Airbus A350</strong> has
              Starlink — Qatar Airways completed both fleets in December 2025. The{" "}
              <strong>Boeing 787</strong> fleet is being equipped now. Narrowbody A320-family
              aircraft and freighters are not in the program.
            </p>
          ),
          ld: "Every passenger Boeing 777 and Airbus A350 has Starlink (both fleets completed December 2025). The Boeing 787 fleet is mid-installation. A320-family narrowbodies and freighters are not in the program.",
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
              It depends on the aircraft type scheduled for your flight. If it's a 777 or A350, yes.
              If it's a 787, it depends on whether that airframe has been retrofitted yet. Use the
              check-flight tool above with your flight number and date to see the scheduled
              equipment.
            </p>
          ),
          ld: "If the flight is scheduled on a 777 or A350, yes. 787s are being retrofitted, so it depends on the airframe. Check your flight number and date for the scheduled equipment.",
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
              flight-status systems. Because Qatar Airways swaps equipment on the same flight number
              day-to-day, answers are per-date, not per-flight-number.
            </p>
          ),
          ld: "Fleet roster from public aviation data; per-flight equipment from Qatar Airways' flight-status systems. Equipment varies by date, so answers are per-date.",
        },
      ],
    },
  ],
};
