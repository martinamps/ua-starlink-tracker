import { Eyebrow, SECTION_WIDE, StatValue } from "../../components/layout";
import { fmt } from "../../components/ui/format";
import { BY_TYPE_SUM_LABEL, ownCountAsOf, ownFigureNote } from "../published-count";
import { type QatarProgrammeState, listedTypes, qatarProgrammeState } from "../registry";
import { formatFactDate } from "../rollout-facts";
import type { AirlineContent, HeroProps } from "./index";

// Every "done" on this page is read from the phase table and the held-back
// list (qatarProgrammeState), the same two things the by-type table counts
// from, so the words and the table can't disagree.
const typeNames = (s: QatarProgrammeState) => listedTypes(s.doneExcept.map((t) => t.name));
const plural = (names: string[]) => listedTypes(names.map((n) => `${n}s`));

const MAKER: Record<string, string> = { "777": "Boeing 777", A350: "Airbus A350" };
const withMaker = (names: string[]) => names.map((n) => MAKER[n] ?? n);

/** "777 and 787-8 done except 11 aircraft", or null when none is held back. */
const exceptLine = (s: QatarProgrammeState) =>
  s.doneExcept.length > 0 ? `${typeNames(s)} done except ${fmt(s.held)} aircraft` : null;

/** The airline's own newest dated figure; a fact with no count is quoted whole. */
function OwnFigure() {
  const note = ownFigureNote("QR");
  if (!note) return null;
  if (note.kind === "count") {
    return (
      <>
        {" "}
        Qatar's own figure is {fmt(note.own.count)} {ownCountAsOf(note.own)}
        {note.own.reportedBy && (
          <>
            , as reported by{" "}
            <a
              href={note.own.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline"
            >
              {note.own.reportedBy}
            </a>
          </>
        )}
        .
      </>
    );
  }
  return null;
}

function NewestReport() {
  const note = ownFigureNote("QR");
  if (note?.kind !== "fact") return null;
  return (
    <p className="mt-3 text-xs text-secondary leading-relaxed">
      Newest report on file ({formatFactDate(note.fact.asOf)}): {note.fact.fact}{" "}
      <a
        href={note.fact.source.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent hover:underline"
      >
        {note.fact.source.label}
      </a>
      .
    </p>
  );
}

// No fleet percentage: the roster includes A380s, A330s, narrowbodies and
// freighters the programme excludes (rosterIsProgramScope false), so a blended
// share would understate a 777 passenger's odds and overstate an A380's.
const QRHero = ({ stats, statSentence }: HeroProps) => {
  const s = qatarProgrammeState();
  const rest = [
    exceptLine(s),
    s.installing.length > 0 ? `${listedTypes(s.installing)} installing` : null,
  ].filter((l) => l !== null);
  return (
    <div className={SECTION_WIDE}>
      {statSentence && <div className="mb-3">{statSentence}</div>}{" "}
      <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-subtle bg-subtle sm:grid-cols-2">
        <div className="bg-surface p-5 text-center">
          <Eyebrow className="">{BY_TYPE_SUM_LABEL}</Eyebrow>
          <StatValue size="lg" className="mt-2">
            {fmt(stats.starlinkCount)}
          </StatValue>
          {/* A paragraph, so index.html's rule underlines the source link in it. */}
          <p className="text-xs text-secondary mt-1">
            Not checked plane by plane.
            <OwnFigure />
          </p>
        </div>{" "}
        <div className="bg-surface p-5 text-center">
          <Eyebrow className="">Status</Eyebrow>
          <div className="font-display text-2xl text-primary mt-2">
            {s.done.length > 0 ? `${listedTypes(s.done)} done` : "Installing"}
          </div>{" "}
          <div className="text-xs text-secondary mt-1">{rest.join(" · ")}</div>
        </div>
      </div>{" "}
      <NewestReport />
    </div>
  );
};

const orTypes = (names: string[]) =>
  names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : (names[0] ?? "");
const article = (name: string) => (name.startsWith("A") ? "An" : "A");

/** "An A350 has it. A 777 or 787-8 has it unless it is one of 11 … aircraft that aren't confirmed." */
function FittedTypes() {
  const s = qatarProgrammeState();
  const except = s.doneExcept.map((t) => t.name);
  return (
    <>
      {s.done.length > 0 && `${article(s.done[0])} ${orTypes(s.done)} has it.`}
      {s.done.length > 0 && except.length > 0 && " "}
      {except.length > 0 &&
        `${article(except[0])} ${orTypes(except)} has it unless it is one of ${fmt(s.held)} ${s.heldGroups} aircraft that aren't confirmed.`}
    </>
  );
}

function HeldBackNote() {
  const s = qatarProgrammeState();
  if (s.doneExcept.length === 0) return null;
  return (
    <>
      {" "}
      This site leaves {fmt(s.held)} {s.heldGroups} {plural(s.doneExcept.map((t) => t.name))} out of
      its count: nothing confirms they were fitted.
    </>
  );
}

export const content: AirlineContent = {
  headerStats: () => {
    const s = qatarProgrammeState();
    return [
      s.done.length > 0 ? (
        <span key="done">
          <span className="text-accent font-semibold">{listedTypes(s.done)}</span> complete
        </span>
      ) : null,
      s.doneExcept.length > 0 ? (
        <span key="except">
          <span className="text-accent">{typeNames(s)}</span> complete except {fmt(s.held)}
        </span>
      ) : null,
      s.installing.length > 0 ? (
        <span key="installing">
          <span className="text-accent">{listedTypes(s.installing)}</span> installing
        </span>
      ) : null,
    ].filter((n) => n !== null);
  },

  intro: () => {
    const s = qatarProgrammeState();
    return (
      <>
        Qatar Airways has free Starlink Wi-Fi on every {listedTypes(withMaker(s.done))}
        {s.doneExcept.length > 0 && (
          <>
            {" "}
            and on its {plural(withMaker(s.doneExcept.map((t) => t.name)))}, except {fmt(s.held)}{" "}
            {s.heldGroups} aircraft that aren't confirmed
          </>
        )}
        {s.installing.length > 0 && <>, and is fitting its {plural(s.installing)} now</>}. The A380,
        A330 and narrowbodies are not in the programme.
      </>
    );
  },

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
              <HeldBackNote />
            </p>
          ),
        },
        {
          q: "Is Qatar Airways' Starlink Wi-Fi free?",
          a: () => (
            <p>
              Yes. Everyone gets 45 minutes free; log in to Privilege Club, which is free to join,
              and it's free for the whole flight.
            </p>
          ),
        },
        {
          q: "Does my Qatar Airways flight have Starlink?",
          a: () => (
            <p>
              It depends on the aircraft type. <FittedTypes /> A 787-9 may or may not yet; Qatar
              expects to finish them by the end of 2026. The A380, A330 and narrowbodies don't.
              Check your flight number and date to see the scheduled type.
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
