import { RolloutPanel } from "../../components/home/rollout";
import { LINK, StatInline } from "../../components/layout";
import { fmt, pct } from "../../components/ui/format";
import { AIRLINES, airlineHomeUrl } from "../registry";
import { fleetTargetSentence } from "./fleet-target";
import type { AirlineContent, ContentStats, HeroProps } from "./index";

const regional = (s: ContentStats) => s.fleetStats?.express ?? { starlink: 0, total: 0 };
const mainline = (s: ContentStats) => s.fleetStats?.mainline ?? { starlink: 0, total: 0 };

// The headline spans the same fleets as Alaska's own tracker: Alaska's
// aircraft plus Hawaiian's A321neo and A330s (registry programmePartners).
const ASHero = ({ stats, statSentence }: HeroProps) => (
  <RolloutPanel
    stats={stats}
    noun={stats.noun ?? "Alaska aircraft"}
    segments={[
      { label: "Regional E175s", n: regional(stats).starlink, total: regional(stats).total },
      { label: "Mainline", n: mainline(stats).starlink, total: mainline(stats).total },
      ...(stats.partners ?? []).map((p) => ({ label: p.label, n: p.starlink, total: p.total })),
    ]}
  >
    {statSentence}
  </RolloutPanel>
);

const partnerClause = (s: ContentStats) =>
  (s.partners ?? []).map((p) => (
    <span key={p.label}>
      , and <StatInline n={p.starlink} /> of {fmt(p.total)} {p.label} jets, which also fly Alaska
      flight numbers
    </span>
  ));

export const content: AirlineContent = {
  headerStats: [],

  intro: () => (
    <>
      Alaska Airlines is replacing its Intelsat Wi-Fi with Starlink, starting with its regional
      E175s. Check your flight or see which Alaska planes have it.
    </>
  ),

  Hero: ASHero,

  answers: [
    {
      q: "Does Alaska Airlines have Starlink?",
      a: (s) => (
        <p>
          Yes. <StatInline n={s.starlinkCount} /> of {fmt(s.totalCount)}{" "}
          {s.noun ?? "Alaska aircraft"} ({pct(s.starlinkCount, s.totalCount)}) have Starlink Wi-Fi
          {s.asOf ? <> as of {s.asOf}</> : null}. {fleetTargetSentence("AS", "Alaska")}
        </p>
      ),
    },
    {
      q: "Which Alaska planes have Starlink?",
      a: (s) => (
        <p>
          <StatInline n={regional(s).starlink} /> of {fmt(regional(s).total)} regional E175s,{" "}
          <StatInline n={mainline(s).starlink} /> of {fmt(mainline(s).total)} mainline jets
          {partnerClause(s)}. Mainline installs started with the 737 MAX 8; the{" "}
          <a href="/fleet" className={LINK}>
            fleet page
          </a>{" "}
          shows Alaska's own count for each type.
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
    // The chip appends its own "(count)", so the label drops the registry's type note.
    .map((sf) => ({ key: sf.key, label: sf.label.replace(/\s*\(.*\)$/, "") })),

  faq: [
    {
      title: "Alaska's rollout",
      items: [
        {
          q: "Is Alaska's Starlink Wi-Fi free?",
          a: () => (
            <p>
              It is free for Atmos Rewards members, under a T-Mobile sponsorship; joining Atmos
              Rewards costs nothing. Aircraft not yet converted still carry the paid Intelsat
              system.
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
          q: "Why can this count differ from Alaska's own percentage?",
          a: () => (
            <p>
              Alaska's installation tracker states one percentage across Alaska's E175s, 737s and
              787s plus Hawaiian's A321neo and A330s, and the headline here counts the same fleets.
              What remains is fleet lists: Alaska's table leaves out the 737-700s, which we count as
              not yet equipped, and our roster can differ from Alaska's by an aircraft or two in a
              type. The{" "}
              <a href="/fleet" className={LINK}>
                fleet page
              </a>{" "}
              shows Alaska's own per-type counts next to ours.
            </p>
          ),
        },
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
