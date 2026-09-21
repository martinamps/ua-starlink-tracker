import { RolloutPanel } from "../../components/home/rollout";
import { StatInline, fmt, pct } from "../../components/layout";
import { AIRLINES, airlineHomeUrl } from "../registry";
import type { AirlineContent, ContentStats, HeroProps } from "./index";

const LINK = "text-accent hover:underline";
const regional = (s: ContentStats) => s.fleetStats?.express ?? { starlink: 0, total: 0 };
const mainline = (s: ContentStats) => s.fleetStats?.mainline ?? { starlink: 0, total: 0 };

// Alaska's own tracker (Aug 28, 2026; rollout-facts) counts Hawaiian's Airbus
// jets too, so its percentage runs higher than this Alaska-only roster.
const ALASKA_OWN_FIGURE =
  "Alaska's own tracker put the combined Alaska and Hawaiian fleet at 38% on Aug 28, 2026.";

const ASHero = ({ stats, statSentence }: HeroProps) => (
  <RolloutPanel
    stats={stats}
    noun="Alaska aircraft"
    segments={[
      { label: "Regional E175s", n: regional(stats).starlink, total: regional(stats).total },
      { label: "Mainline", n: mainline(stats).starlink, total: mainline(stats).total },
    ]}
  >
    {statSentence}
    <p className="mt-2 text-xs text-muted">{ALASKA_OWN_FIGURE}</p>
  </RolloutPanel>
);

export const content: AirlineContent = {
  headerStats: [
    <span key="mbps">
      <span className="text-accent font-semibold">250</span> Mbps
    </span>,
    <span key="free" className="text-success font-semibold">
      Free for Atmos Rewards members
    </span>,
  ],

  intro: () => (
    <>
      Alaska is replacing its paid Intelsat Wi-Fi with free Starlink. Check your flight or see which
      aircraft have it.
    </>
  ),

  Hero: ASHero,

  answers: [
    {
      q: "Does Alaska Airlines have Starlink?",
      a: (s) => (
        <p>
          Yes. <StatInline n={s.starlinkCount} /> of {fmt(s.totalCount)} Alaska aircraft (
          {pct(s.starlinkCount, s.totalCount)}) have free Starlink Wi-Fi
          {s.asOf ? <> as of {s.asOf}</> : null}. Alaska expects to finish the rollout in early
          2027.
        </p>
      ),
    },
    {
      q: "Which Alaska planes have Starlink?",
      a: (s) => (
        <p>
          <StatInline n={regional(s).starlink} /> of {fmt(regional(s).total)} regional E175s and{" "}
          <StatInline n={mainline(s).starlink} /> of {fmt(mainline(s).total)} mainline jets.
          Mainline installs started with the 737 MAX 8; Alaska's Aug 28 tracker showed no 737-800,
          737-900, 737 MAX 9 or 787 connected yet.
        </p>
      ),
    },
    {
      q: "Do all Alaska flights have Starlink?",
      a: (s) => (
        <p>
          No. {pct(regional(s).starlink, regional(s).total)} of regional E175s have it, but only{" "}
          {pct(mainline(s).starlink, mainline(s).total)} of mainline aircraft, so most 737 flights
          don't yet. Aircraft without Starlink still carry Alaska's older paid Wi-Fi.
        </p>
      ),
    },
    {
      q: "How do I know if my Alaska flight has Starlink?",
      a: () => (
        <p>
          Enter your flight number and date in the{" "}
          <a href="/check-flight" className={LINK}>
            flight check
          </a>
          . Once Alaska assigns the aircraft, usually a day or two out, you get a yes or no for that
          plane.
        </p>
      ),
    },
  ],

  // Horizon and SkyWest both operate AS regional E175s — badge the row's real
  // operator, never a hardcoded one.
  rowBadge: (p) =>
    p.fleet === "horizon" ? p.OperatedBy?.replace(/ Air(lines)?$/, "") || "Regional" : null,

  // Hawaiian-operated tails live in HA's roster, so their chips would always be empty.
  subfleetFilters: AIRLINES.AS.subfleets
    .filter((sf) => sf.key !== "hawaiian_metal" && sf.key !== "hawaiian_interisland")
    .map((sf) => ({ key: sf.key, label: sf.label })),

  faq: [
    {
      title: "Alaska's rollout",
      items: [
        {
          q: "Is Alaska's Starlink Wi-Fi free?",
          a: () => (
            <p>
              Yes, for Atmos Rewards members. The Wi-Fi is sponsored by T-Mobile and Atmos Rewards
              is free to join. Aircraft not yet converted still carry the paid Intelsat system.
            </p>
          ),
        },
        {
          q: "What about Hawaiian Airlines flights?",
          a: () => (
            <p>
              Hawaiian's A330s and A321neos all have Starlink. Its Boeing 717s, which fly the short
              interisland hops, have no Wi-Fi. See{" "}
              <a href={airlineHomeUrl("HA")} className={LINK}>
                the Hawaiian tracker
              </a>{" "}
              for that fleet.
            </p>
          ),
        },
        {
          q: "Do Horizon Air and SkyWest regional flights have Starlink?",
          a: (s) => (
            <p>
              Yes. Alaska's regional E175s, flown by Horizon Air and SkyWest, were the first to get
              Starlink. {fmt(regional(s).starlink)} of the {fmt(regional(s).total)} in our roster
              have it, and both operators' aircraft are counted.
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
              The fleet roster comes from public aviation data. Starlink status per aircraft comes
              from Alaska's flight-status systems, Alaska's own rollout tracker and community
              reports. The{" "}
              <a href="/methodology" className={LINK}>
                methodology page
              </a>{" "}
              has the details.
            </p>
          ),
        },
      ],
    },
  ],
};
