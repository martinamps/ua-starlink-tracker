import {
  METER_ACCENT,
  METER_BG,
  METER_FILL,
  METER_HEIGHT,
  METER_TRACK,
  type MeterSize,
  meterWidth,
} from "../../client/meter";

export interface MeterSegment {
  key: string;
  /** 0..1 of the whole track. */
  share: number;
  className?: string;
  color?: string;
  title?: string;
  /** Keep a nonzero segment visible however small its share. */
  minPx?: number;
}

/**
 * The one progress bar. A single fill takes `share` (0..1) in the accent, or
 * in `color` — an airline's brand color, say. `segments` stack side by side
 * instead, each with its own class or color. `label` is the bar's spoken text.
 */
export function Meter({
  share = 0,
  segments,
  color,
  size = "md",
  gap = false,
  label,
  className = "",
}: {
  share?: number;
  segments?: MeterSegment[];
  color?: string;
  size?: MeterSize;
  /** A hairline between segments. */
  gap?: boolean;
  label?: string;
  className?: string;
}) {
  const a11y = label ? { role: "img" as const, "aria-label": label } : { "aria-hidden": true };
  return (
    <div
      className={`${segments ? "flex" : ""} ${gap ? "gap-px" : ""} ${METER_TRACK} ${METER_BG} ${METER_HEIGHT[size]} ${className}`}
      {...a11y}
    >
      {segments ? (
        segments.map((s) => (
          <span
            key={s.key}
            title={s.title}
            className={`h-full ${s.className ?? ""}`}
            style={{
              width: meterWidth(s.share),
              ...(s.color ? { background: s.color } : {}),
              ...(s.minPx ? { minWidth: s.minPx } : {}),
            }}
          />
        ))
      ) : (
        <div
          className={`${METER_FILL} ${color ? "" : METER_ACCENT}`}
          style={{ width: meterWidth(share), ...(color ? { background: color } : {}) }}
        />
      )}
    </div>
  );
}
