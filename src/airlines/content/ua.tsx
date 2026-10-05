import { RolloutPanel } from "../../components/home/rollout";
import { LINK, StatInline } from "../../components/layout";
import { fmt, pct } from "../../components/ui/format";
import { fleetTargetSentence } from "./fleet-target";
import type { AirlineContent, ContentStats, HeroProps } from "./index";

/** Rounded pace for copy; null means say nothing rather than a stale guess. */
const installsPerMonth = (s: ContentStats): number | null =>
  s.installsPerMonth ? Math.round(s.installsPerMonth) : null;

const express = (s: ContentStats) => s.fleetStats?.express ?? { starlink: 0, total: 0 };
const mainline = (s: ContentStats) => s.fleetStats?.mainline ?? { starlink: 0, total: 0 };

// United's June 22, 2026 release, the source of the widebody figures.
const UA_WIDEBODY_RELEASE =
  "https://www.prnewswire.com/news-releases/united-accelerates-starlink-wi-fi-rollout-with-first-widebody-transatlantic-flight-302806746.html";

const UAHero = ({ stats }: HeroProps) => (
  <RolloutPanel
    stats={stats}
    noun="United aircraft"
    segments={[
      { label: "United Express", n: express(stats).starlink, total: express(stats).total },
      { label: "Mainline", n: mainline(stats).starlink, total: mainline(stats).total },
    ]}
  />
);

export const content: AirlineContent = {
  headerStats: (s) => [
    <span key="free" className="text-success font-semibold">
      Free with MileagePlus
    </span>,
    ...(installsPerMonth(s)
      ? [
          <span key="installs">
            <span className="text-accent font-semibold">~{fmt(installsPerMonth(s) ?? 0)}</span>{" "}
            installs a month{s.installsPaceWindow ? ` (${s.installsPaceWindow} average)` : ""}
          </span>,
        ]
      : []),
  ],

  intro: () => (
    <>
      United is adding Starlink Wi-Fi to every plane, starting with its United Express regional
      jets.
    </>
  ),

  Hero: UAHero,

  answers: [
    {
      q: "Does United have Starlink?",
      // The panel above gives the count; the structured answer keeps it.
      a: () => <p>Yes. {fleetTargetSentence("UA", "United")}</p>,
      ld: (s) =>
        `Yes. ${fmt(s.starlinkCount)} of ${fmt(s.totalCount)} United aircraft (${pct(s.starlinkCount, s.totalCount)}) have Starlink Wi-Fi${s.asOf ? ` as of ${s.asOf}` : ""}. ${fleetTargetSentence("UA", "United")}`,
    },
    {
      q: "Which United planes have Starlink?",
      a: () => (
        <p>
          Mostly United Express regional jets. The panel above has the split, and the{" "}
          <a href="/fleet" className={LINK}>
            fleet page
          </a>{" "}
          lists every plane.
        </p>
      ),
      ld: (s) =>
        `Mostly United Express regional jets: ${fmt(express(s).starlink)} of ${fmt(express(s).total)} (${pct(express(s).starlink, express(s).total)}) have it, against ${fmt(mainline(s).starlink)} of ${fmt(mainline(s).total)} mainline aircraft (${pct(mainline(s).starlink, mainline(s).total)}).`,
    },
    {
      q: "Do all United flights have Starlink?",
      a: (s) => (
        <p>
          No, not yet. {pct(s.starlinkCount, s.totalCount)} of the fleet has it, so it depends on
          the plane assigned to your flight. United Express flights (UA3000 to UA6999) are the
          likeliest to have it.
        </p>
      ),
    },
    {
      q: "How do I know if my United flight has Starlink?",
      a: () => (
        <p>
          Enter your flight number and date in the{" "}
          <a href="/check-flight" className={LINK}>
            flight check
          </a>
          . About two days before departure United assigns the aircraft and you get a firm yes or
          no. Further out you get the odds, based on the planes that flight has used recently. The{" "}
          <a href="/chrome" className={LINK}>
            Chrome extension
          </a>{" "}
          shows the same answer on Google Flights.
        </p>
      ),
    },
  ],

  rowBadge: (p) => (p.fleet === "mainline" ? "Mainline" : "Express"),

  subfleetFilters: [
    { key: "mainline", label: "Mainline" },
    { key: "express", label: "Express" },
  ],

  faq: [
    {
      title: "Planning a trip",
      items: [
        {
          q: "How do I maximize my chances of getting Starlink?",
          a: () => (
            <p>
              Use the{" "}
              <a href="/route-planner" className={LINK}>
                route planner
              </a>
              . It ranks nonstop flights and one-stop connections by their chance of Starlink.
              Express jets are far likelier to have it than mainline, so a connection on two Express
              jets can beat a mainline nonstop. Denver to Chicago nonstop is mainline, for example,
              while Denver to Aspen to Chicago is Express on both legs.
            </p>
          ),
        },
        {
          q: "Does United have Starlink on international flights?",
          a: () => (
            <p>
              On some. Widebody installs began with UA14, Newark to London on a Boeing 777-200, on
              June 22, 2026. In{" "}
              <a
                href={UA_WIDEBODY_RELEASE}
                target="_blank"
                rel="noopener noreferrer"
                className={LINK}
              >
                that day's release
              </a>
              , United said nearly 60 widebodies would have Starlink during 2026 and the whole
              widebody fleet by summer 2027.{" "}
              <a href="/check-flight" className={LINK}>
                Check your flight
              </a>{" "}
              for its aircraft.
            </p>
          ),
        },
      ],
    },
    {
      title: "The rollout",
      items: [
        {
          q: "How fast is United's Starlink rollout?",
          a: (s) => (
            <p>
              {installsPerMonth(s) && <>About {installsPerMonth(s)} aircraft a month. </>}
              United's first Starlink install was in March 2025, and{" "}
              <StatInline n={s.starlinkCount} /> aircraft have it today. The{" "}
              <a href="/install-rate" className={LINK}>
                install pace page
              </a>{" "}
              tracks it against United's targets.
            </p>
          ),
        },
        {
          q: "When will all United flights have Starlink?",
          a: (s) => (
            <p>
              United's target is every United and United Express aircraft by the end of 2027, with
              more than 880 expected by the end of 2026. Today {pct(s.starlinkCount, s.totalCount)}{" "}
              of the {fmt(s.totalCount)}
              -plane fleet has it. The{" "}
              <a href="/timeline" className={LINK}>
                rollout timeline
              </a>{" "}
              lists each milestone with its source.
            </p>
          ),
        },
      ],
    },
    {
      title: "About Starlink Wi-Fi",
      items: [
        {
          q: "Is United Starlink Wi-Fi free?",
          a: () => (
            <p>
              Yes. It's free for MileagePlus members, and MileagePlus is free to join. There are no
              tiers or data caps.
            </p>
          ),
        },
        {
          q: "What can I do with Starlink Wi-Fi?",
          a: () => <p>Stream video, watch live sports and make video calls.</p>,
        },
      ],
    },
    {
      title: "Using this tracker",
      items: [
        {
          q: "How does this tracker work?",
          a: () => (
            <>
              <p>
                We combine fleet data from aviation data providers with flight schedules, then
                confirm each aircraft's Wi-Fi against United's own systems. The{" "}
                <a href="/methodology" className={LINK}>
                  methodology page
                </a>{" "}
                has the details.
              </p>
              <p className="mt-2">
                Thanks to the{" "}
                <a
                  href="https://sites.google.com/site/unitedfleetsite/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className={LINK}
                >
                  unitedfleetsite
                </a>{" "}
                community, whose fleet data got this project started.
              </p>
            </>
          ),
        },
        {
          q: "Can I use this with Claude or other AI assistants?",
          a: () => (
            <p>
              Yes. The free{" "}
              <a href="/mcp" className={LINK}>
                MCP server
              </a>{" "}
              works with Claude Desktop, Cursor and any MCP client. Ask things like "does UA4680
              next week have Starlink?" or "find me the best way to fly SFO to JAX with Starlink".
            </p>
          ),
        },
      ],
    },
  ],
};
