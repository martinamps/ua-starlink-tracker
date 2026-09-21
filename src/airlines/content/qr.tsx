import React from "react";
import { fmt } from "../../components/layout";
import type { AirlineContent, HeroProps } from "./index";

// No fleet percentage: the roster includes A380s, A330s, narrowbodies and
// freighters the programme excludes (rosterIsProgramScope false), so a blended
// share would understate a 777 passenger's odds and overstate an A380's.
const QRHero = ({ stats, statSentence }: HeroProps) => (
  <div className="relative mx-auto mb-8 w-full max-w-3xl">
    {statSentence && <div className="mb-3">{statSentence}</div>}
    <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-subtle bg-subtle sm:grid-cols-2">
      <div className="bg-surface p-5 text-center">
        <div className="text-xs font-mono text-muted uppercase tracking-wider">
          Aircraft with Starlink
        </div>
        <div className="font-display text-4xl text-primary mt-2 tabular-nums">
          {fmt(stats.starlinkCount)}
        </div>
        <div className="text-xs text-secondary mt-1">
          Counted by aircraft type. Qatar's own figure was 150 in August 2026.
        </div>
      </div>
      <div className="bg-surface p-5 text-center">
        <div className="text-xs font-mono text-muted uppercase tracking-wider">Status</div>
        <div className="font-display text-2xl text-primary mt-2">777 and A350 done</div>
        <div className="text-xs text-secondary mt-1">787-8 done · 787-9 installing</div>
      </div>
    </div>
  </div>
);

export const content: AirlineContent = {
  headerStats: [
    <span key="free" className="text-success font-semibold">
      Free
    </span>,
    <span key="widebodies">
      <span className="text-accent font-semibold">777 and A350</span> complete
    </span>,
    <span key="787">
      <span className="text-accent">787-9</span> installing
    </span>,
  ],

  intro: () => (
    <>
      Qatar Airways has free Starlink Wi-Fi on every Boeing 777, Airbus A350 and 787-8, and is
      fitting its 787-9s now. The A380, A330 and narrowbodies are not in the programme.
    </>
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
              Qatar Airways reports its passenger Boeing 777 and Airbus A350 fleets fully fitted
              (both finished by December 2025) and its Boeing 787-8 fleet since August 2026. The
              787-9 fleet is being fitted now. The A380, A330, A320-family narrowbodies and
              freighters are not in the programme.
            </p>
          ),
        },
        {
          q: "Is Qatar Airways' Starlink Wi-Fi free?",
          a: () => <p>Yes, free for every passenger, gate to gate, with no purchase required.</p>,
        },
        {
          q: "Does my Qatar Airways flight have Starlink?",
          a: () => (
            <p>
              It depends on the aircraft type. A 777, A350 or 787-8 has it. A 787-9 may or may not
              yet; Qatar expects to finish them by the end of 2026. The A380, A330 and narrowbodies
              don't. Check your flight number and date to see the scheduled type.
            </p>
          ),
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
              The fleet roster comes from public aviation data, and per-flight aircraft types from
              Qatar Airways' flight-status systems on selected routes. Qatar publishes the aircraft
              type about a week ahead, so dates inside that window use the published schedule.
              Further out, the answer is a conservative estimate from the types that flight number
              has flown recently.
            </p>
          ),
        },
      ],
    },
  ],
};
