import React from "react";
import { ModelPie, StatRing, computeModelBreakdown } from "../../components/atoms";
import type { AirlineContent, HeroProps } from "./index";

const ASHero = ({ stats, starlinkData }: HeroProps) => {
  const { starlinkCount, totalCount, percentage } = stats;
  const modelData = computeModelBreakdown(starlinkData);
  return (
    <div className="relative grid grid-cols-1 sm:grid-cols-3 gap-px bg-subtle rounded-lg overflow-hidden mb-6 border border-subtle">
      <StatRing
        label="Fleet Progress"
        pct={Number.parseFloat(percentage)}
        starlink={starlinkCount}
        total={totalCount}
        color="#01426a"
      />
      <div className="bg-surface px-4 py-6 flex flex-col items-center justify-center text-center">
        <div className="text-[10px] font-mono text-muted uppercase tracking-wider">Target</div>
        <div className="font-display text-2xl text-primary mt-2">End 2027</div>
        <div className="font-mono text-xs text-secondary mt-1">~half by end 2026</div>
        <div className="font-mono text-[10px] text-muted mt-3">
          E175 first · then 737 · then 787
        </div>
      </div>
      <ModelPie data={modelData} total={starlinkCount} />
    </div>
  );
};

export const content: AirlineContent = {
  showNavLinks: false,

  headerStats: [
    <span key="mbps">
      <span className="text-accent font-semibold">250</span> Mbps
    </span>,
    <span key="free" className="text-green-400 font-semibold">
      FREE
    </span>,
    <span key="rollout">
      Rollout <span className="text-accent">2025–2027</span>
    </span>,
  ],

  intro: () => (
    <p className="text-sm text-secondary leading-relaxed mb-3">
      Alaska Airlines is rolling out free Starlink WiFi across its entire fleet — Horizon Air
      Embraer E175s went first in late 2025, with the 737 and 787 fleets following through 2027.
      Alaska is replacing its legacy Intelsat system, so equipped aircraft already had paid WiFi;
      Starlink makes it free and an order of magnitude faster.
    </p>
  ),

  Hero: ASHero,

  rowBadge: (p) => (p.fleet === "horizon" ? "Horizon" : null),

  subfleetFilters: [
    { key: "mainline", label: "Mainline (737/787)" },
    { key: "horizon", label: "Horizon (E175)" },
  ],

  faq: [
    {
      title: "Alaska's rollout",
      items: [
        {
          q: "Which Alaska Airlines aircraft have Starlink?",
          a: () => (
            <p>
              Alaska started with the <strong>Horizon Air Embraer E175</strong> regional fleet in
              December 2025, then began equipping the <strong>737</strong> mainline fleet (737-700,
              -800, -900ER, MAX 8, MAX 9) and the <strong>787-9</strong> through 2026. Alaska
              expects roughly half the fleet done by the end of 2026 and all aircraft equipped by
              the end of 2027. The list above shows tails confirmed so far.
            </p>
          ),
          ld: "Alaska started with Horizon Air E175s in December 2025, then the 737 family and 787-9 through 2026. Roughly half the fleet by end 2026; all aircraft by end 2027.",
        },
        {
          q: "Is Alaska's Starlink WiFi free?",
          a: () => (
            <p>
              Yes — free for every passenger, gate-to-gate, with no login or loyalty requirement.
              Aircraft that haven't been retrofitted yet still carry Alaska's legacy Intelsat
              system, which is paid.
            </p>
          ),
          ld: "Yes. Alaska's Starlink WiFi is free for every passenger, gate-to-gate. Aircraft not yet retrofitted still carry the paid legacy Intelsat system.",
        },
        {
          q: "What about Hawaiian Airlines flights operated by Alaska?",
          a: () => (
            <p>
              Following the 2024 merger, Hawaiian-branded routes are flown by the Hawaiian Airbus
              fleet (A330, A321neo) — those aircraft <strong>all have Starlink already</strong>. See{" "}
              <a href="https://hawaiianstarlinktracker.com" className="text-accent hover:underline">
                the Hawaiian tracker
              </a>{" "}
              for that fleet. Some 787-9s originally ordered by Hawaiian are transferring to
              Alaska's fleet and will be equipped on Alaska's schedule.
            </p>
          ),
          ld: "Hawaiian-branded routes are flown by the Hawaiian Airbus fleet (A330, A321neo), all of which already have Starlink. Some 787-9s are transferring from Hawaiian to Alaska's fleet.",
        },
        {
          q: "Do Horizon Air and SkyWest regional flights have Starlink?",
          a: () => (
            <p>
              <strong>Horizon Air E175s</strong> were the first Alaska aircraft to get Starlink and
              are tracked here. <strong>SkyWest-operated</strong> Alaska Express flights are not yet
              tracked separately (SkyWest tails fly for multiple carriers).
            </p>
          ),
          ld: "Horizon Air E175s were the first Alaska aircraft to get Starlink. SkyWest-operated Alaska Express flights are not yet tracked separately.",
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
              Fleet roster from public aviation data; per-tail Starlink status from Alaska's
              flight-status systems and public rollout announcements. Alaska's own status page does
              not yet expose a per-aircraft WiFi-provider field, so individual tails are confirmed
              as installations are reported.
            </p>
          ),
          ld: "Fleet roster from public aviation data; per-tail Starlink status from Alaska's flight-status systems and public rollout announcements.",
        },
      ],
    },
  ],
};
