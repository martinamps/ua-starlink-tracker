import type { FleetPageData } from "../../types";
import { Sparkline } from "../charts/sparkline";
import { Eyebrow, Panel, Section, StatValue } from "../layout";
import { fmt, monthDay } from "../ui/format";

// computePulse's window: six hours back to 66 ahead.
const PULSE_WINDOW = "from 6 hours ago to 66 hours ahead";

export function LivePulse({ pulse }: { pulse: FleetPageData["pulse"] }) {
  const haveData = pulse.sparkline.length > 0;
  return (
    <Section bare wide className="text-center">
      <Panel className="glow-accent">
        <Eyebrow>Live pulse</Eyebrow>
        <div className="flex items-baseline justify-center gap-3 mb-1">
          {pulse.now > 0 && <span className="status-dot animate-pulse-glow" />}
          <StatValue size="xl" accent>
            {haveData ? fmt(pulse.now) : "—"}
          </StatValue>
        </div>
        <p className="text-sm text-secondary mb-4">
          {haveData
            ? "Starlink aircraft in the air now"
            : "Airborne count unavailable while data refreshes"}
        </p>
        {haveData && pulse.peak > 0 ? (
          <Sparkline
            values={pulse.sparkline}
            peak={pulse.peak}
            className="h-16 w-full"
            label={`Starlink aircraft in the air, ${PULSE_WINDOW}. Peak ${fmt(pulse.peak)}.`}
          />
        ) : (
          <div className="h-16 flex items-center justify-center text-muted text-xs">
            No flight data
          </div>
        )}
        {haveData && (
          <p className="text-xs text-muted mt-2 tabular-nums">
            Peak {fmt(pulse.peak)} · low {fmt(pulse.trough)} · {fmt(pulse.totalHours)} Starlink
            flight hours scheduled, {PULSE_WINDOW}
          </p>
        )}
      </Panel>
    </Section>
  );
}

export function InstallPaceSection({ pace }: { pace: FleetPageData["installPace"] }) {
  if (!pace || pace.weeks.length === 0) return null;
  const totalRecent = pace.weeks.reduce((s, w) => s + w.installs, 0);
  if (totalRecent === 0 && pace.express.starlink === 0 && pace.mainline.starlink === 0) return null;
  const peak = Math.max(1, ...pace.weeks.map((w) => w.installs));
  const first = pace.weeks[0];
  const current = pace.weeks[pace.weeks.length - 1];
  const weekly = pace.mainlinePaceWk;

  return (
    <Section
      wide
      title="Install pace"
      dek={
        <>
          Aircraft added per week. New installs usually show up here within a few days.{" "}
          {fmt(totalRecent)} added in the last {pace.weeks.length} weeks, counting this partial
          week.
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
      {pace.projectedFinishMonth && (
        <p className="text-sm text-secondary mt-4 text-pretty">
          At about {fmt(weekly, weekly < 10 ? 1 : 0)} mainline installs a week, the remaining{" "}
          {fmt(pace.remainingMainline)} mainline aircraft would be done around{" "}
          <strong className="font-semibold text-primary">{pace.projectedFinishMonth}</strong>.
          That's a straight-line estimate from the last six weeks.
        </p>
      )}
    </Section>
  );
}
