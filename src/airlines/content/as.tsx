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
const ASHero = ({ stats }: HeroProps) => (
  <RolloutPanel
    stats={stats}
    noun={stats.noun ?? "Alaska aircraft"}
    segments={[
      { label: "Regional E175s", n: regional(stats).starlink, total: regional(stats).total },
      { label: "Mainline", n: mainline(stats).starlink, total: mainline(stats).total },
      ...(stats.partners ?? []).map((p) => ({ label: p.label, n: p.starlink, total: p.total })),
    ]}
  />
);

/** "All 93 regional E175s" once a group is finished, "12 of 254 mainline jets" before. */
const share = (n: number, total: number, what: string, lead = false) => (
  <>
    {n === total && total > 0 ? (
      <>
        {lead ? "All" : "all"} <StatInline n={n} />
      </>
    ) : (
      <>
        <StatInline n={n} /> of {fmt(total)}
      </>
    )}{" "}
    {what}
  </>
);

export const content: AirlineContent = {
  headerStats: [],

  intro: () => (
    <>
      Alaska Airlines is replacing its paid Intelsat Wi-Fi with Starlink, starting with its regional
      E175s.
    </>
  ),

  Hero: ASHero,

  answers: [
    {
      q: "Does Alaska Airlines have Starlink?",
      // The panel above gives the count; the structured answer keeps it.
      a: () => <p>Yes. {fleetTargetSentence("AS", "Alaska")}</p>,
      ld: (s) =>
        `Yes. ${fmt(s.starlinkCount)} of ${fmt(s.totalCount)} ${s.noun ?? "Alaska aircraft"} (${pct(s.starlinkCount, s.totalCount)}) have Starlink Wi-Fi${s.asOf ? ` as of ${s.asOf}` : ""}. ${fleetTargetSentence("AS", "Alaska")}`,
    },
    {
      q: "Which Alaska planes have Starlink?",
      a: (s) => (
        <p>
          {share(regional(s).starlink, regional(s).total, "regional E175s", true)}
          {s.partners?.length ? ", " : " and "}
          {share(mainline(s).starlink, mainline(s).total, "mainline jets")}
          {(s.partners ?? []).map((p) => (
            <span key={p.label}>
              {" "}
              and {share(p.starlink, p.total, `${p.label.replace(" & ", " and ")} jets`)}, which
              also fly Alaska flight numbers
            </span>
          ))}
          . Mainline installs started with the 737 MAX 8; the{" "}
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
          No.{" "}
          {regional(s).total > 0 && regional(s).starlink === regional(s).total
            ? "All"
            : `${pct(regional(s).starlink, regional(s).total)} of`}{" "}
          regional E175s have it, but only {pct(mainline(s).starlink, mainline(s).total)} of
          mainline aircraft, so most 737 flights don't yet.
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
      title: "Flying Alaska",
      items: [
        {
          q: "Is Alaska's Starlink Wi-Fi free?",
          a: () => (
            <p>Yes, for Atmos Rewards members, and joining is free. T-Mobile sponsors it.</p>
          ),
        },
        {
          q: "What about Hawaiian Airlines flights?",
          a: () => (
            <p>
              Hawaiian's A330s and A321neos all have Starlink. Its Boeing 717s, which fly the short
              interisland hops, have no Wi-Fi. See{" "}
              <a href={airlineHomeUrl("HA")} className={LINK}>
                Hawaiian's aircraft
              </a>
              .
            </p>
          ),
        },
        {
          q: "Do Horizon Air and SkyWest regional flights have Starlink?",
          a: (s) => {
            const { starlink, total } = regional(s);
            return (
              <p>
                Yes.{" "}
                {starlink === total && total > 0 ? (
                  <>
                    All {fmt(total)} of Alaska's E175s, flown by Horizon Air and SkyWest, have
                    Starlink.
                  </>
                ) : (
                  <>
                    {fmt(starlink)} of Alaska's {fmt(total)} E175s, flown by Horizon Air and
                    SkyWest, have Starlink.
                  </>
                )}{" "}
                They were the first to get it.
              </p>
            );
          },
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
              Both count the same fleets, Hawaiian's A321neos and A330s included. Alaska's list
              leaves out the 737-700s, which we count as not yet having Starlink. Our roster can
              also differ from Alaska's by an aircraft or two in a type, and we round shares down.
              The{" "}
              <a href="/fleet" className={LINK}>
                fleet page
              </a>{" "}
              shows both counts for each type.
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
