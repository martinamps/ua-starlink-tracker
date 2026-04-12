import React from "react";
import { TypeBreakdownRow } from "../../components/atoms";
import type { AirlineContent, HeroProps } from "./index";

const HAHero = ({ stats }: HeroProps) => {
  const { starlinkCount } = stats;
  return (
    <div className="relative mb-6 grid grid-cols-1 md:grid-cols-3 gap-4">
      <div className="md:col-span-1 bg-surface border border-green-400/30 rounded-lg p-6 flex flex-col items-center justify-center text-center">
        <div className="w-12 h-12 rounded-full bg-green-400/15 flex items-center justify-center mb-3">
          <svg
            className="w-7 h-7 text-green-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            role="img"
            aria-label="Complete"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <div className="font-display text-lg text-primary font-semibold">Rollout Complete</div>
        <div className="text-xs font-mono text-muted mt-1">September 2024</div>
        <div className="mt-3 font-mono text-sm">
          <span className="text-green-400 font-semibold">{starlinkCount}</span>
          <span className="text-secondary"> Airbus aircraft equipped</span>
        </div>
        <div className="text-[10px] font-mono text-muted mt-2 max-w-[200px]">
          First major U.S. carrier to finish a fleet-wide Starlink install
        </div>
      </div>
      <div className="md:col-span-2 bg-surface border border-subtle rounded-lg overflow-hidden">
        <div className="text-[10px] font-mono text-muted uppercase tracking-wider px-4 pt-4 pb-1">
          Fleet by aircraft type
        </div>
        <TypeBreakdownRow type="Airbus A330-200" count={24} status="starlink" />
        <TypeBreakdownRow type="Airbus A321neo" count={18} status="starlink" />
        <TypeBreakdownRow
          type="Boeing 717-200"
          count={19}
          status="none"
          note="No WiFi (interisland)"
        />
        <TypeBreakdownRow type="Boeing 787-9" status="pending" note="Transferring to Alaska" />
      </div>
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
    <span key="g2g">Gate-to-gate</span>,
    <span key="done" className="hidden sm:inline">
      <span className="text-green-400 font-semibold">Complete</span> Sep 2024
    </span>,
  ],

  intro: () => (
    <p className="text-sm text-secondary leading-relaxed mb-3">
      Hawaiian Airlines completed its Starlink rollout in September 2024 — every Airbus A330 and
      A321neo now has free, gate-to-gate high-speed Starlink WiFi. Hawaiian was the first major U.S.
      carrier to finish a fleet-wide Starlink install. The Boeing 717 interisland fleet does not
      have WiFi.
    </p>
  ),

  Hero: HAHero,

  rowBadge: () => null,

  subfleetFilters: [],

  faq: [
    {
      title: "Which Hawaiian aircraft have Starlink",
      items: [
        {
          q: "Which Hawaiian Airlines planes have Starlink?",
          a: ({ starlinkCount }) => (
            <p>
              All <span className="text-accent">{starlinkCount}</span> of Hawaiian's transpacific
              Airbus aircraft — every A330-200 and every A321neo — have Starlink. The rollout was
              completed in September 2024. If your flight is on an Airbus, it has Starlink.
            </p>
          ),
          ld: "All of Hawaiian's transpacific Airbus aircraft — every A330-200 and every A321neo — have Starlink WiFi. The rollout was completed in September 2024.",
        },
        {
          q: "Do Hawaiian interisland flights have WiFi?",
          a: () => (
            <p>
              No. Interisland routes (HNL–OGG, HNL–KOA, HNL–LIH, etc.) are flown on Boeing 717s,
              which do not have WiFi of any kind. Hawaiian has no announced plans to add
              connectivity to the 717 fleet — flights are typically 30–45 minutes.
            </p>
          ),
          ld: "No. Hawaiian interisland routes are flown on Boeing 717 aircraft, which do not have WiFi. Flights are typically 30–45 minutes.",
        },
        {
          q: "What about Hawaiian's 787 Dreamliners?",
          a: () => (
            <p>
              Hawaiian's small 787-9 fleet does not yet have Starlink. Those aircraft are
              transferring to Alaska Airlines following the 2024 merger and are expected to receive
              Starlink under Alaska's rollout.
            </p>
          ),
          ld: "Hawaiian's 787-9 fleet does not yet have Starlink. Those aircraft are transferring to Alaska Airlines following the 2024 merger.",
        },
      ],
    },
    {
      title: "Using Starlink on Hawaiian",
      items: [
        {
          q: "Is Hawaiian Airlines Starlink WiFi free?",
          a: () => (
            <p>
              Yes — completely free for every passenger, with no login, paywall, or loyalty
              requirement. Connect to the "Starlink WiFi on HawaiianAir" network and you're online
              from gate to gate.
            </p>
          ),
          ld: "Yes — Hawaiian's Starlink WiFi is completely free for every passenger, with no login, paywall, or loyalty requirement.",
        },
        {
          q: "How fast is Hawaiian's Starlink WiFi?",
          a: () => (
            <p>
              Typical speeds are 100–250 Mbps to each device — fast enough for 4K streaming, video
              calls, and large downloads. Latency is low enough for gaming and real-time
              collaboration tools, even mid-Pacific.
            </p>
          ),
          ld: "Typical speeds are 100–250 Mbps to each device — fast enough for 4K streaming, video calls, and large downloads, even mid-Pacific.",
        },
      ],
    },
    {
      title: "The Alaska merger",
      items: [
        {
          q: "Does the Alaska Airlines merger change Hawaiian's WiFi?",
          a: () => (
            <p>
              No change for Hawaiian-operated Airbus flights — they keep Starlink. Hawaiian flights
              now appear under Alaska (AS) flight numbers, and Alaska has announced its own
              fleet-wide Starlink rollout for 2025–2027, so the combined airline is moving to
              Starlink across the board.
            </p>
          ),
          ld: "No change for Hawaiian-operated Airbus flights — they keep Starlink. Alaska Airlines has announced its own fleet-wide Starlink rollout for 2025–2027.",
        },
      ],
    },
  ],
};
