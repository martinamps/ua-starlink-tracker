import type { FleetPageData } from "../../types";
import { EYEBROW, H2, PANEL, SECTION_WIDE, StatValue } from "../layout";
import { fmt, monthDay } from "../ui/format";

// computePulse's window: six hours back to 66 ahead.
const PULSE_WINDOW = "from 6 hours ago to 66 hours ahead";

function Sparkline({ data, peak }: { data: number[]; peak: number }) {
  if (data.length < 2 || peak === 0) {
    return (
      <div className="h-16 flex items-center justify-center text-muted text-xs">No flight data</div>
    );
  }
  const w = 600;
  const h = 64;
  const step = w / (data.length - 1);
  const y = (v: number) => h - (v / peak) * (h - 4) - 2;
  const path = data
    .map((v, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${y(v).toFixed(1)}`)
    .join("");
  const area = `${path} L${w},${h} L0,${h} Z`;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="w-full h-16"
      preserveAspectRatio="none"
      role="img"
      aria-label={`Starlink aircraft in the air, ${PULSE_WINDOW}. Peak ${fmt(peak)}.`}
    >
      <path d={area} fill="var(--color-accent)" opacity="0.15" />
      <path d={path} stroke="var(--color-accent)" strokeWidth="1.5" fill="none" />
    </svg>
  );
}

export function LivePulse({ pulse }: { pulse: FleetPageData["pulse"] }) {
  const haveData = pulse.sparkline.length > 0;
  return (
    <section className="relative max-w-4xl mx-auto w-full text-center mb-8">
      <div className={`${PANEL} glow-accent`}>
        <div className={EYEBROW}>Live pulse</div>
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
        <Sparkline data={pulse.sparkline} peak={pulse.peak} />
        {haveData && (
          <p className="text-xs text-muted mt-2 tabular-nums">
            Peak {fmt(pulse.peak)} · low {fmt(pulse.trough)} · {fmt(pulse.totalHours)} Starlink
            flight hours scheduled, {PULSE_WINDOW}
          </p>
        )}
      </div>
    </section>
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
    <section className={SECTION_WIDE}>
      <h2 className={H2}>Install pace</h2>
      <p className="mt-1 mb-4 text-sm text-secondary text-pretty">
        Aircraft added per week. New installs usually show up here within a few days.{" "}
        {fmt(totalRecent)} added in the last {pace.weeks.length} weeks, counting this partial week.
      </p>
      <div className={PANEL}>
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
            At about {fmt(weekly, weekly < 10 ? 1 : 0)} a week, the remaining{" "}
            {fmt(pace.remainingMainline)} mainline aircraft would be done around{" "}
            <strong className="font-semibold text-primary">{pace.projectedFinishMonth}</strong>.
            That's a straight-line estimate from the last six weeks.
          </p>
        )}
      </div>
    </section>
  );
}
