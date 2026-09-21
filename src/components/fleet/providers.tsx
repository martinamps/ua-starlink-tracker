import type React from "react";
import type { WifiProvider } from "../../types";

import { fmt } from "../ui/format";

export const PROVIDER_ORDER: WifiProvider[] = [
  "starlink",
  "viasat",
  "panasonic",
  "thales",
  "none",
  "unknown",
];

export const PROVIDER_LABEL: Record<WifiProvider, string> = {
  starlink: "Starlink",
  viasat: "Viasat",
  panasonic: "Panasonic",
  thales: "Thales",
  none: "No Wi-Fi",
  unknown: "Not checked yet",
};

export type ProviderCounts = Record<WifiProvider, number>;

export function emptyProviderCounts(): ProviderCounts {
  return { starlink: 0, viasat: 0, panasonic: 0, thales: 0, none: 0, unknown: 0 };
}

function Swatch({ provider, className = "" }: { provider: WifiProvider; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`wifi-${provider} inline-block w-2.5 h-2.5 rounded-[1px] shrink-0 ${className}`}
    />
  );
}

/**
 * One key for every provider-colored mark on a page. With `counts`, each entry
 * carries its number and zero entries drop out; without, it is the bare key.
 */
export function ProviderLegend({
  counts,
  providers = PROVIDER_ORDER,
  labels = PROVIDER_LABEL,
  after,
  className = "",
}: {
  counts?: ProviderCounts;
  providers?: WifiProvider[];
  labels?: Record<WifiProvider, string>;
  /** Extra <li> entries for marks that aren't providers (pipeline states). */
  after?: React.ReactNode;
  className?: string;
}) {
  const shown = counts ? providers.filter((p) => counts[p] > 0) : providers;
  return (
    <ul
      className={`flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-secondary ${className}`}
    >
      {shown.map((p) => (
        <li key={p} className="inline-flex items-center gap-1.5">
          <Swatch provider={p} />
          {counts ? (
            <span>
              <span className="tabular-nums text-primary">{fmt(counts[p])}</span> {labels[p]}
            </span>
          ) : (
            labels[p]
          )}
        </li>
      ))}
      {after}
    </ul>
  );
}
