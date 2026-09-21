import { TypeBreakdownRow } from "../../components/atoms";
import { Eyebrow, Panel, SECTION_WIDE, StatInline } from "../../components/layout";
import { fmt } from "../../components/ui/format";
import type { AirlineContent, HeroProps } from "./index";

// Aircraft-type counts come from press-release figures (rollout is complete and
// type-deterministic). starlinkData length confirms the live-tracked subset.
// No 787 row: the 787-9s are moving to Alaska and none is in Hawaiian's roster.
const HA_TYPES: Array<{
  type: string;
  count?: number;
  status: "starlink" | "none" | "pending";
  note?: string;
}> = [
  { type: "Airbus A330-200", count: 24, status: "starlink" },
  { type: "Airbus A321neo", count: 18, status: "starlink" },
  { type: "Boeing 717-200", count: 19, status: "none", note: "No Wi-Fi (interisland)" },
];

const HAHero = ({ stats, statSentence }: HeroProps) => {
  const { starlinkCount } = stats;
  return (
    <div className={`${SECTION_WIDE} grid grid-cols-1 gap-4 md:grid-cols-3`}>
      {statSentence && <div className="md:col-span-3">{statSentence}</div>}
      <Panel className="md:col-span-1 flex flex-col items-center justify-center text-center">
        <div className="font-display text-lg text-primary">Airbus fleet complete</div>
        <div className="text-xs text-muted mt-1">September 2024</div>
        <div className="mt-3 text-sm text-secondary">
          <StatInline n={starlinkCount} /> Airbus aircraft equipped
        </div>
      </Panel>
      <Panel pad="none" className="md:col-span-2 overflow-hidden">
        <Eyebrow className="px-4 pt-4 pb-1">Fleet by aircraft type</Eyebrow>
        {HA_TYPES.map((t) => (
          <TypeBreakdownRow key={t.type} {...t} />
        ))}
      </Panel>
    </div>
  );
};

export const content: AirlineContent = {
  headerStats: [
    <span key="free" className="text-success font-semibold">
      Free
    </span>,
    <span key="g2g">Gate-to-gate</span>,
    <span key="done">
      <span className="text-success font-semibold">Airbus fleet complete</span> Sep 2024
    </span>,
  ],

  intro: () => (
    <>
      Every Hawaiian Airbus A330 and A321neo has free Starlink Wi-Fi. The Boeing 717s that fly
      interisland hops have no Wi-Fi.
    </>
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
              All {fmt(starlinkCount)} of Hawaiian's Airbus aircraft, every A330-200 and every
              A321neo, have Starlink. The rollout finished in September 2024. If your flight is on
              an Airbus, it has Starlink.
            </p>
          ),
        },
        {
          q: "Do Hawaiian interisland flights have Wi-Fi?",
          a: () => (
            <p>
              No. Interisland routes such as Honolulu to Maui, Kona and Kauai are flown on Boeing
              717s, which have no Wi-Fi. Hawaiian has announced no plan to add it.
            </p>
          ),
        },
        {
          q: "What about Hawaiian's 787 Dreamliners?",
          a: () => (
            <p>
              The 787-9s are moving to Alaska Airlines after the merger and are due to get Starlink
              under Alaska's rollout.
            </p>
          ),
        },
      ],
    },
    {
      title: "Using Starlink on Hawaiian",
      items: [
        {
          q: "Is Hawaiian Airlines Starlink Wi-Fi free?",
          a: () => (
            <p>
              Yes, free for every passenger with no paywall. Connect to the "Starlink WiFi on
              HawaiianAir" network and you're online from gate to gate.
            </p>
          ),
        },
      ],
    },
    {
      title: "The Alaska merger",
      items: [
        {
          q: "Does the Alaska Airlines merger change Hawaiian's Wi-Fi?",
          a: () => (
            <p>
              No. Hawaiian's Airbus flights keep Starlink, now under Alaska (AS) flight numbers.
              Alaska plans to finish adding Starlink to its own fleet in early 2027.
            </p>
          ),
        },
      ],
    },
  ],
};
