import type { FleetPageData } from "../../types";
import { Sparkline } from "../charts/sparkline";
import { Eyebrow, Panel, Section, StatValue } from "../layout";
import { fmt, monthDay } from "../ui/format";

// computePulse's window runs six hours back to 66 ahead; "next 3 days" is
// close enough for a reader and avoids the odd 6/66 split.
const PULSE_WINDOW = "next 3 days";

export function LivePulse({ pulse }: { pulse: FleetPageData["pulse"] }) {
  const haveData = pulse.sparkline.length > 0;
  return (
    <Section bare wide className="text-center">
      <Panel className="glow-accent">
        <Eyebrow>In the air now</Eyebrow>
        <div className="flex items-baseline justify-center gap-3 mb-1">
          {pulse.now > 0 && <span className="status-dot animate-pulse-glow" />}
          <StatValue size="xl" accent>
            {haveData ? fmt(pulse.now) : "—"}
          </StatValue>
        </div>
        <p className="text-sm text-secondary mb-4">
          {haveData ? "Starlink aircraft" : "No flight data right now"}
        </p>
        {haveData && pulse.peak > 0 ? (
          <Sparkline
            values={pulse.sparkline}
            peak={pulse.peak}
            className="h-16 w-full"
            label={`Starlink aircraft in the air, ${PULSE_WINDOW}. Peak ${fmt(pulse.peak)}.`}
          />
        ) : (
          <div className="h-16" />
        )}
        {haveData && (
          <p className="text-xs text-muted mt-2 tabular-nums">
            Next 3 days: peak {fmt(pulse.peak)}, low {fmt(pulse.trough)} in the air at once.
          </p>
        )}
      </Panel>
    </Section>
  );
}

export function InstallPaceSection({
  pace,
  projectionHref,
}: {
  pace: FleetPageData["installPace"];
  /** /install-rate when this host serves it. Its 3-month whole-fleet pace is
   * the site's one projection, so this page links there instead of making its own. */
  projectionHref?: string | null;
}) {
  if (!pace || pace.weeks.length === 0) return null;
  const totalRecent = pace.weeks.reduce((s, w) => s + w.installs, 0);
  if (totalRecent === 0 && pace.express.starlink === 0 && pace.mainline.starlink === 0) return null;
  const peak = Math.max(1, ...pace.weeks.map((w) => w.installs));
  const first = pace.weeks[0];
  const current = pace.weeks[pace.weeks.length - 1];

  return (
    <Section
      wide
      title="Install pace"
      dek={
        <>
          Aircraft added per week: {fmt(totalRecent)} in the last {pace.weeks.length} weeks, this
          week so far included.
        </>
      }
    >
      <div
        className="flex items-end gap-1.5 h-28"
        role="img"
        aria-label={pace.weeks
          .map((w) => `Week of ${monthDay(w.weekStart)}: ${fmt(w.installs)}`)
          .join(", ")}
      >
        {pace.weeks.map((w) => (
          <div key={w.weekStart} className="flex-1 flex flex-col items-center gap-1">
            <span className="text-xs text-secondary tabular-nums">
              {w.installs > 0 ? fmt(w.installs) : ""}
            </span>
            <div
              className={`w-full bg-[var(--color-accent)] rounded-t ${
                w === current ? "opacity-40" : "opacity-80"
              }`}
              style={{ height: `${(w.installs / peak) * 80}px` }}
            />
          </div>
        ))}
      </div>
      <div className="flex justify-between text-xs text-muted mt-1">
        <span>Week of {monthDay(first.weekStart)}</span>
        <span>This week so far</span>
      </div>
      {projectionHref && (
        <p className="text-sm text-secondary mt-4 text-pretty">
          <a href={projectionHref} className="text-accent hover:underline">
            Monthly pace and projected finish against stated targets →
          </a>
        </p>
      )}
    </Section>
  );
}
