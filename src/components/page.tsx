import React from "react";
import type { Aircraft, FleetStats, Flight } from "../types";
import { PAGE_CONTENT, isUnitedDomain } from "../utils/constants";

interface PageProps {
  total: number;
  starlink: Aircraft[];
  lastUpdated?: string;
  fleetStats?: FleetStats;
  isUnited?: boolean;
  flightsByTail?: Record<string, Flight[]>;
}

const dateOverrides: Record<string, string> = {
  N127SY: "2025-03-07", // First Starlink installation per press release
};

export default function Page({
  total,
  starlink,
  fleetStats,
  isUnited = false,
  flightsByTail = {},
}: PageProps) {
  // Apply date overrides to the aircraft data
  const applyDateOverrides = (data: Aircraft[]): Aircraft[] => {
    return data.map((aircraft) => {
      const tailNumber = aircraft.TailNumber;
      if (tailNumber && dateOverrides[tailNumber]) {
        // Make sure we're using PST for the override date to avoid timezone issues
        const overrideDate = new Date(`${dateOverrides[tailNumber]}T12:00:00-08:00`);
        return {
          ...aircraft,
          DateFound: overrideDate.toISOString().split("T")[0], // Format as YYYY-MM-DD
        };
      }
      return aircraft;
    });
  };

  // Server-side rendering uses props directly, no client state needed
  const starlinkData = applyDateOverrides(starlink);
  const x = starlinkData.length;
  const y = total;
  const percentage = y > 0 ? ((x / y) * 100).toFixed(2) : "0.00";

  // Aggregate aircraft by model type for pie chart
  const getAircraftByModel = () => {
    const modelCounts: Record<string, number> = {};
    for (const plane of starlinkData) {
      // Normalize model names (e.g., "737-900" -> "737")
      const fullModel = plane.Aircraft || "Unknown";
      // Extract base model (first part before dash or space)
      const baseModel = fullModel.split(/[-\s]/)[0];
      modelCounts[baseModel] = (modelCounts[baseModel] || 0) + 1;
    }
    // Sort by count descending and return top models
    return Object.entries(modelCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([model, count]) => ({ model, count }));
  };

  const modelData = getAircraftByModel();
  const pieColors = [
    "#0ea5e9", // Accent cyan
    "#22c55e", // Green
    "#f59e0b", // Amber
    "#8b5cf6", // Purple
    "#ec4899", // Pink
    "#06b6d4", // Teal
  ];

  // Format date as relative time (e.g., "3 days ago", "2 weeks ago")
  const formatRelativeDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays} days ago`;
    if (diffDays < 14) return "1 week ago";
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
    if (diffDays < 60) return "1 month ago";
    return `${Math.floor(diffDays / 30)} months ago`;
  };

  // Get aircraft icon based on type
  const getAircraftIcon = (type: string) => {
    const t = type.toLowerCase();
    if (
      t.includes("737") ||
      t.includes("757") ||
      t.includes("767") ||
      t.includes("a31") ||
      t.includes("a32")
    ) {
      return "✈"; // Narrow body
    }
    if (t.includes("777") || t.includes("787") || t.includes("a35")) {
      return "🛫"; // Wide body
    }
    if (t.includes("e1") || t.includes("crj") || t.includes("erj")) {
      return "🛩"; // Regional
    }
    return "✈";
  };

  // Helper function to clean airport codes (remove ICAO prefixes)
  const cleanAirportCode = (code: string) => {
    if (code && code.length === 4) {
      if (code.startsWith("K")) return code.substring(1);
      if (code.startsWith("C")) return code.substring(1);
      if (code.startsWith("M")) return code.substring(1);
    }
    return code;
  };

  // Helper function to convert regional carrier codes to UA flight numbers
  const convertToUAFlightNumber = (flightNumber: string) => {
    // Common regional carrier prefixes that operate UA Express flights
    const regionalCarrierPrefixes = ["SKW", "RPA", "GJS", "ASQ", "ENY", "AWI", "UCA"];

    for (const prefix of regionalCarrierPrefixes) {
      if (flightNumber.startsWith(prefix)) {
        // Extract the numeric part and prepend with UA
        const numericPart = flightNumber.substring(prefix.length);
        if (/^\d+$/.test(numericPart)) {
          return `UA${numericPart}`;
        }
      }
    }

    // Return original if not a regional carrier or already UA
    return flightNumber;
  };

  // Helper function to format flight times
  const formatFlightTime = (timestamp: number) => {
    const date = new Date(timestamp * 1000);

    const timeStr = date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });

    const dateStr = date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });

    return `${dateStr} ${timeStr}`;
  };

  // Compact flight time (just time, e.g., "2:30p")
  const formatCompactTime = (timestamp: number) => {
    const date = new Date(timestamp * 1000);
    return date
      .toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      })
      .replace(" AM", "a")
      .replace(" PM", "p");
  };

  // Helper function to render upcoming flights
  const renderUpcomingFlights = (tailNumber: string, isMobileView = false) => {
    const flights = flightsByTail[tailNumber];

    if (!flights || flights.length === 0) {
      return React.createElement(
        "span",
        { className: "text-gray-400 text-sm" },
        "No upcoming flights"
      );
    }

    // Show more flights on desktop, fewer on mobile
    const maxFlights = isMobileView ? 2 : 3;
    const flightsToShow = flights.slice(0, maxFlights);
    const remainingCount = flights.length - maxFlights;

    return React.createElement("div", { className: "space-y-2" }, [
      ...flightsToShow.map((flight, idx) => {
        const cleanDeparture = cleanAirportCode(flight.departure_airport);
        const cleanArrival = cleanAirportCode(flight.arrival_airport);

        return React.createElement(
          "div",
          {
            key: `flight-${idx}`,
            className: `text-sm ${idx === 0 ? "border-l-2 border-blue-500 pl-2" : "pl-3"}`,
          },
          [
            React.createElement(
              "div",
              { className: "flex items-center justify-between", key: "flight-info" },
              [
                React.createElement(
                  "a",
                  {
                    href: `https://www.flightaware.com/live/flight/${flight.flight_number}`,
                    target: "_blank",
                    rel: "noopener noreferrer",
                    className: "font-medium text-united-blue hover:underline",
                    key: "flight-link",
                  },
                  convertToUAFlightNumber(flight.flight_number)
                ),
                React.createElement(
                  "span",
                  {
                    className: "text-gray-500 text-xs",
                    key: "time",
                  },
                  formatFlightTime(flight.departure_time)
                ),
              ]
            ),
            React.createElement(
              "div",
              {
                className: "text-gray-600 text-xs",
                key: "route",
              },
              `${cleanDeparture} → ${cleanArrival}`
            ),
          ]
        );
      }),
      ...(remainingCount > 0
        ? [
            React.createElement(
              "span",
              {
                className:
                  "text-united-blue hover:text-blue-700 text-xs pl-3 hover:underline cursor-pointer",
                key: "remaining",
                "data-tail": tailNumber,
                "data-flights": JSON.stringify(flights.slice(maxFlights)),
              },
              `+${remainingCount} more flights`
            ),
          ]
        : []),
    ]);
  };

  // Compact inline flight pills for new table design (responsive + expandable)
  const renderFlightPills = (tailNumber: string) => {
    const flights = flightsByTail[tailNumber];

    if (!flights || flights.length === 0) {
      return <span className="text-muted text-xs italic font-mono">No flights scheduled</span>;
    }

    const containerId = `flights-${tailNumber}`;
    // Mobile: 2, Tablet: 4, Desktop: 6
    const mobileMax = 2;
    const tabletMax = 4;
    const desktopMax = 6;

    const renderPill = (flight: (typeof flights)[0], idx: number) => {
      const dep = cleanAirportCode(flight.departure_airport);
      const arr = cleanAirportCode(flight.arrival_airport);

      // Determine visibility classes
      let visibilityClass = "inline-flex"; // Always visible
      if (idx >= desktopMax) {
        visibilityClass = "flight-extra hidden"; // Hidden until expanded
      } else if (idx >= tabletMax) {
        visibilityClass = "hidden xl:inline-flex"; // Desktop only (xl+)
      } else if (idx >= mobileMax) {
        visibilityClass = "hidden md:inline-flex"; // Tablet+ (md+)
      }

      const flightNum = convertToUAFlightNumber(flight.flight_number);
      return (
        <a
          key={idx}
          href={`https://www.flightaware.com/live/flight/${flight.flight_number}`}
          target="_blank"
          rel="noopener noreferrer"
          data-flight-tooltip={flightNum}
          className={`flight-pill font-mono items-center gap-1.5 px-2 py-1 bg-surface-elevated border border-subtle rounded text-xs text-secondary hover:text-accent hover:border-accent/50 transition-all ${visibilityClass}`}
        >
          <span className="text-accent font-medium">{dep}</span>
          <span className="text-muted">→</span>
          <span className="text-accent font-medium">{arr}</span>
          <span className="text-muted text-[10px]">{formatCompactTime(flight.departure_time)}</span>
        </a>
      );
    };

    // Calculate remaining for each breakpoint
    const mobileRemaining = Math.max(0, flights.length - mobileMax);
    const tabletRemaining = Math.max(0, flights.length - tabletMax);
    const desktopRemaining = Math.max(0, flights.length - desktopMax);

    return (
      <div className="flex flex-wrap gap-1.5" id={containerId}>
        {flights.map((flight, idx) => renderPill(flight, idx))}
        {/* Responsive expand buttons - show different counts based on screen size */}
        {mobileRemaining > 0 && (
          <button
            type="button"
            className="expand-flights md:hidden inline-flex items-center px-2 py-1 border border-accent/30 hover:border-accent rounded text-xs text-accent font-mono font-medium transition-all cursor-pointer hover:bg-accent/10"
            data-target={containerId}
            data-count={mobileRemaining}
          >
            +{mobileRemaining}
          </button>
        )}
        {tabletRemaining > 0 && (
          <button
            type="button"
            className="expand-flights hidden md:inline-flex xl:hidden items-center px-2 py-1 border border-accent/30 hover:border-accent rounded text-xs text-accent font-mono font-medium transition-all cursor-pointer hover:bg-accent/10"
            data-target={containerId}
            data-count={tabletRemaining}
          >
            +{tabletRemaining}
          </button>
        )}
        {desktopRemaining > 0 && (
          <button
            type="button"
            className="expand-flights hidden xl:inline-flex items-center px-2 py-1 border border-accent/30 hover:border-accent rounded text-xs text-accent font-mono font-medium transition-all cursor-pointer hover:bg-accent/10"
            data-target={containerId}
            data-count={desktopRemaining}
          >
            +{desktopRemaining}
          </button>
        )}
      </div>
    );
  };

  // Mobile-specific flight display component
  const renderMobileFlights = (plane: Aircraft) => {
    const flights = flightsByTail[plane.TailNumber];

    if (!flights || flights.length === 0) {
      return null;
    }

    return React.createElement("div", { className: "mt-3 pt-3 border-t border-gray-200" }, [
      React.createElement(
        "div",
        {
          className: "text-xs font-semibold text-gray-700 mb-2 flex items-center gap-1",
          key: "header",
        },
        [
          React.createElement("span", { key: "emoji" }, "✈️ Upcoming Flights"),
          React.createElement(
            "span",
            {
              className: "text-gray-400 font-normal",
              key: "count",
            },
            `(${flights.length})`
          ),
        ]
      ),
      React.createElement("div", { key: "flights" }, renderUpcomingFlights(plane.TailNumber, true)),
    ]);
  };

  return (
    <div className="w-full mx-auto px-4 sm:px-6 md:px-8 bg-base min-h-screen flex flex-col relative">
      {/* Subtle grid background */}
      <div className="absolute inset-0 grid-pattern opacity-50 pointer-events-none" />

      <header className="relative py-5 sm:py-6 text-center mb-2">
        <h1 className="font-display text-3xl sm:text-4xl md:text-5xl font-bold text-primary mb-1 tracking-tight">
          {isUnited ? PAGE_CONTENT.pageTitle.united : PAGE_CONTENT.pageTitle.generic}
        </h1>
        <p className="text-base sm:text-lg text-secondary font-display mb-2">
          {isUnited ? PAGE_CONTENT.pageSubtitle.united : PAGE_CONTENT.pageSubtitle.generic}
        </p>
        <div className="flex items-center justify-center gap-3 sm:gap-6 text-xs sm:text-sm font-mono text-muted">
          <span>
            <span className="text-accent font-semibold">250</span> Mbps
          </span>
          <span className="text-subtle">·</span>
          <span>
            <span className="text-accent font-semibold">50×</span> faster
          </span>
          <span className="text-subtle">·</span>
          <span className="text-green-400 font-semibold">FREE</span>
          <span className="text-subtle hidden sm:inline">·</span>
          <span className="hidden sm:inline">
            <span className="text-accent font-semibold">40+</span> installs/mo
          </span>
        </div>
      </header>

      {/* Fleet Stats - Instrument Panel Style */}
      <div className="relative grid grid-cols-2 lg:grid-cols-4 gap-px bg-subtle rounded-lg overflow-hidden mb-6 border border-subtle">
        {/* Mainline Fleet */}
        <div className="bg-surface p-4 flex flex-col justify-center text-center">
          <div className="text-[10px] font-mono text-muted uppercase tracking-wider mb-2">
            Mainline
          </div>
          <div className="relative w-20 h-20 mx-auto mb-2">
            <svg
              className="w-20 h-20 transform -rotate-90"
              role="img"
              aria-label="Mainline progress"
            >
              <circle cx="40" cy="40" r="34" stroke="#243044" strokeWidth="6" fill="none" />
              <circle
                cx="40"
                cy="40"
                r="34"
                stroke="#0ea5e9"
                strokeWidth="6"
                fill="none"
                strokeDasharray={`${2 * Math.PI * 34}`}
                strokeDashoffset={`${2 * Math.PI * 34 * (1 - (fleetStats?.mainline.percentage || 0) / 100)}`}
                className="transition-all duration-1000 ease-out"
                style={{ filter: "drop-shadow(0 0 6px rgba(14, 165, 233, 0.5))" }}
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="font-mono text-xl font-semibold text-primary">
                {fleetStats?.mainline.percentage.toFixed(0)}%
              </span>
            </div>
          </div>
          <div className="font-mono text-xs text-secondary">
            <span className="text-accent">{fleetStats?.mainline.starlink || 0}</span>
            <span className="text-muted"> / {fleetStats?.mainline.total || 0}</span>
          </div>
        </div>

        {/* Express Fleet */}
        <div className="bg-surface p-4 flex flex-col justify-center text-center">
          <div className="text-[10px] font-mono text-muted uppercase tracking-wider mb-2">
            Express
          </div>
          <div className="relative w-20 h-20 mx-auto mb-2">
            <svg
              className="w-20 h-20 transform -rotate-90"
              role="img"
              aria-label="Express progress"
            >
              <circle cx="40" cy="40" r="34" stroke="#243044" strokeWidth="6" fill="none" />
              <circle
                cx="40"
                cy="40"
                r="34"
                stroke="#0ea5e9"
                strokeWidth="6"
                fill="none"
                strokeDasharray={`${2 * Math.PI * 34}`}
                strokeDashoffset={`${2 * Math.PI * 34 * (1 - (fleetStats?.express.percentage || 0) / 100)}`}
                className="transition-all duration-1000 ease-out"
                style={{ filter: "drop-shadow(0 0 6px rgba(14, 165, 233, 0.5))" }}
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="font-mono text-xl font-semibold text-primary">
                {fleetStats?.express.percentage.toFixed(0)}%
              </span>
            </div>
          </div>
          <div className="font-mono text-xs text-secondary">
            <span className="text-accent">{fleetStats?.express.starlink || 0}</span>
            <span className="text-muted"> / {fleetStats?.express.total || 0}</span>
          </div>
        </div>

        {/* Combined Stats */}
        <div className="bg-surface p-4 flex flex-col justify-center text-center">
          <div className="text-[10px] font-mono text-muted uppercase tracking-wider mb-2">
            Total Fleet
          </div>
          <div className="relative w-20 h-20 mx-auto mb-2">
            <svg
              className="w-20 h-20 transform -rotate-90"
              role="img"
              aria-label="Combined progress"
            >
              <circle cx="40" cy="40" r="34" stroke="#243044" strokeWidth="6" fill="none" />
              <circle
                cx="40"
                cy="40"
                r="34"
                stroke="#22c55e"
                strokeWidth="6"
                fill="none"
                strokeDasharray={`${2 * Math.PI * 34}`}
                strokeDashoffset={`${2 * Math.PI * 34 * (1 - Number.parseFloat(percentage) / 100)}`}
                className="transition-all duration-1000 ease-out"
                strokeLinecap="round"
                style={{ filter: "drop-shadow(0 0 6px rgba(34, 197, 94, 0.5))" }}
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="font-mono text-xl font-semibold text-green-400">
                {Math.round(Number.parseFloat(percentage))}%
              </span>
            </div>
          </div>
          <div className="font-mono text-xs text-secondary">
            <span className="text-green-400">{x}</span>
            <span className="text-muted"> / {y}</span>
          </div>
        </div>

        {/* Aircraft Models Pie Chart */}
        <div className="bg-surface p-4 flex flex-col justify-center text-center">
          <div className="text-[10px] font-mono text-muted uppercase tracking-wider mb-2">
            By Type
          </div>
          {/* Pie Chart - using arc paths for proper hover */}
          <div className="relative w-20 h-20 mx-auto mb-2" id="pie-chart-container">
            <svg
              className="w-20 h-20"
              viewBox="0 0 80 80"
              role="img"
              aria-label="Aircraft types pie chart"
            >
              {/* Background ring */}
              <circle cx="40" cy="40" r="34" stroke="#243044" strokeWidth="6" fill="none" />
              {/* Arc segments */}
              {(() => {
                const total = modelData.reduce((sum, d) => sum + d.count, 0);
                const outerR = 37;
                const innerR = 31;
                let currentAngle = -90; // Start from top

                return modelData.map((item, idx) => {
                  const sliceAngle = (item.count / total) * 360;
                  const startAngle = currentAngle;
                  const endAngle = currentAngle + sliceAngle;
                  currentAngle = endAngle;

                  // Convert to radians
                  const startRad = (startAngle * Math.PI) / 180;
                  const endRad = (endAngle * Math.PI) / 180;

                  // Outer arc points
                  const ox1 = 40 + outerR * Math.cos(startRad);
                  const oy1 = 40 + outerR * Math.sin(startRad);
                  const ox2 = 40 + outerR * Math.cos(endRad);
                  const oy2 = 40 + outerR * Math.sin(endRad);

                  // Inner arc points
                  const ix1 = 40 + innerR * Math.cos(startRad);
                  const iy1 = 40 + innerR * Math.sin(startRad);
                  const ix2 = 40 + innerR * Math.cos(endRad);
                  const iy2 = 40 + innerR * Math.sin(endRad);

                  const largeArc = sliceAngle > 180 ? 1 : 0;
                  const pctDisplay = ((item.count / total) * 100).toFixed(0);

                  // Path: outer arc, then inner arc (reverse), close
                  const d = `M ${ox1} ${oy1} A ${outerR} ${outerR} 0 ${largeArc} 1 ${ox2} ${oy2} L ${ix2} ${iy2} A ${innerR} ${innerR} 0 ${largeArc} 0 ${ix1} ${iy1} Z`;

                  return (
                    <path
                      key={item.model}
                      d={d}
                      fill={pieColors[idx % pieColors.length]}
                      className="pie-slice transition-opacity duration-200 hover:opacity-70 cursor-pointer"
                      style={{
                        filter: `drop-shadow(0 0 3px ${pieColors[idx % pieColors.length]}40)`,
                      }}
                      data-model={item.model}
                      data-count={item.count}
                      data-pct={pctDisplay}
                    />
                  );
                });
              })()}
            </svg>
            {/* Center text overlay - pointer-events-none so mouse reaches pie slices */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <span id="pie-center-text" className="font-mono text-xl font-semibold text-primary">
                {modelData[0]?.count || x}
              </span>
            </div>
          </div>
          {/* Status line - shows model info on hover, defaults to largest slice */}
          <div
            id="pie-status"
            className="h-4 flex items-center justify-center text-[10px] font-mono"
          >
            <span id="pie-status-label">
              <span style={{ color: "#0ea5e9" }}>{modelData[0]?.model || "ERJ"}</span>
              <span style={{ color: "#5a6a80" }}>
                {" "}
                · {modelData[0] ? Math.round((modelData[0].count / x) * 100) : 0}%
              </span>
            </span>
          </div>
        </div>
      </div>

      {/* Aircraft List with integrated search */}
      <div className="relative bg-surface rounded-lg border border-subtle overflow-hidden mb-6">
        {/* Integrated header with search and filters */}
        <div className="px-4 md:px-6 py-3 border-b border-subtle">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <input
                type="text"
                id="aircraft-search"
                placeholder="Search tail, flight, airport..."
                className="w-full font-mono text-sm px-4 py-2 pl-9 bg-surface-elevated border border-subtle rounded text-primary placeholder-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/50 transition-all"
              />
              <svg
                className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                role="img"
                aria-label="Search icon"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
            </div>
            <div className="flex gap-1.5 sm:gap-2">
              <button
                type="button"
                id="filter-all"
                className="filter-btn font-mono text-[11px] px-3 py-2 rounded border transition-all bg-accent/20 border-accent text-accent"
                data-filter="all"
              >
                ALL <span className="hidden sm:inline">({starlinkData.length})</span>
              </button>
              <button
                type="button"
                id="filter-mainline"
                className="filter-btn font-mono text-[11px] px-3 py-2 rounded border transition-all bg-transparent border-subtle text-secondary hover:border-accent/50 hover:text-accent"
                data-filter="mainline"
              >
                MAINLINE{" "}
                <span className="hidden sm:inline">({fleetStats?.mainline.starlink || 0})</span>
              </button>
              <button
                type="button"
                id="filter-express"
                className="filter-btn font-mono text-[11px] px-3 py-2 rounded border transition-all bg-transparent border-subtle text-secondary hover:border-accent/50 hover:text-accent"
                data-filter="express"
              >
                EXPRESS{" "}
                <span className="hidden sm:inline">({fleetStats?.express.starlink || 0})</span>
              </button>
            </div>
          </div>
        </div>
        {/* Column headers - desktop only */}
        <div className="hidden md:grid md:grid-cols-12 gap-4 px-6 py-2.5 border-b border-subtle bg-surface-elevated/50 text-[10px] font-mono text-muted uppercase tracking-widest">
          <div className="col-span-3">Aircraft</div>
          <div className="col-span-2">Type</div>
          <div className="col-span-3">Operator</div>
          <div className="col-span-4">Flights</div>
        </div>

        {/* Scrollable list */}
        <div className="overflow-auto" style={{ maxHeight: "65vh" }}>
          {starlinkData.length === 0 ? (
            <div className="p-12 text-center text-muted font-mono">No aircraft data available</div>
          ) : (
            <div className="divide-y divide-subtle">
              {starlinkData.map((plane, idx) => {
                // Build searchable strings from flights
                const flights = flightsByTail[plane.TailNumber] || [];
                const airportsStr = flights
                  .flatMap((f) => [
                    cleanAirportCode(f.departure_airport),
                    cleanAirportCode(f.arrival_airport),
                  ])
                  .join(" ")
                  .toLowerCase();
                // Include both raw flight numbers and UA-normalized versions
                const flightNumbersStr = flights
                  .map((f) => `${f.flight_number} UA${f.flight_number.replace(/^[A-Z]+/, "")}`)
                  .join(" ")
                  .toLowerCase();

                return (
                  <div
                    key={plane.TailNumber || idx}
                    className="aircraft-row group px-4 md:px-6 py-4 hover:bg-surface-elevated transition-all duration-200 cursor-default border-l-2 border-transparent hover:border-accent"
                    data-tail={plane.TailNumber.toLowerCase()}
                    data-aircraft={plane.Aircraft.toLowerCase()}
                    data-operator={(plane.OperatedBy || "United Airlines").toLowerCase()}
                    data-fleet={plane.fleet}
                    data-airports={airportsStr}
                    data-flights={flightNumbersStr}
                  >
                    {/* Desktop Layout */}
                    <div className="hidden md:grid md:grid-cols-12 gap-4 items-center">
                      {/* Aircraft - Tail + Fleet badge */}
                      <div className="col-span-3 flex items-center gap-3">
                        <div className="status-dot flex-shrink-0" />
                        <div>
                          <div className="font-mono text-sm font-semibold text-primary group-hover:text-accent transition-colors">
                            {plane.TailNumber}
                          </div>
                          <div className="text-[10px] font-mono text-muted uppercase">
                            {plane.fleet === "mainline" ? "Mainline" : "Express"}
                          </div>
                        </div>
                      </div>

                      {/* Type */}
                      <div className="col-span-2">
                        <span className="font-mono text-sm text-secondary">{plane.Aircraft}</span>
                      </div>

                      {/* Operator */}
                      <div className="col-span-3 text-sm text-muted">
                        {plane.OperatedBy || "United Airlines"}
                      </div>

                      {/* Flights */}
                      <div className="col-span-4">{renderFlightPills(plane.TailNumber)}</div>
                    </div>

                    {/* Mobile Layout */}
                    <div className="md:hidden">
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center gap-3">
                          <div className="status-dot flex-shrink-0" />
                          <div>
                            <div className="font-mono text-base font-bold text-primary">
                              {plane.TailNumber}
                            </div>
                            <div className="font-mono text-xs text-secondary">{plane.Aircraft}</div>
                          </div>
                        </div>
                        <div className="text-[10px] font-mono text-accent uppercase">
                          {plane.fleet === "mainline" ? "Mainline" : "Express"}
                        </div>
                      </div>

                      {/* Operator */}
                      <div className="text-xs text-muted mb-3 pl-5">
                        {plane.OperatedBy || "United Airlines"}
                      </div>

                      {/* Flights */}
                      <div className="pt-3 border-t border-subtle">
                        {renderFlightPills(plane.TailNumber)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Chrome Extension CTA */}
      <div className="relative my-8 max-w-xl mx-auto bg-surface rounded-lg border border-subtle p-5">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="text-center sm:text-left">
            <div className="font-mono text-sm text-primary mb-0.5">
              Annotate Google Flights automatically
            </div>
            <div className="text-xs text-muted">Adds a Starlink badge on equipped flights</div>
          </div>
          <a
            href="https://chromewebstore.google.com/detail/google-flights-starlink-i/jjfljoifenkfdbldliakmmjhdkbhehoi"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 bg-surface-elevated text-xs sm:text-sm text-secondary font-mono rounded border border-subtle hover:border-accent hover:text-accent transition-colors whitespace-nowrap"
          >
            <svg
              className="w-8 h-8"
              viewBox="0 0 48 48"
              xmlns="http://www.w3.org/2000/svg"
              role="img"
              aria-label="Chrome"
            >
              <defs>
                <linearGradient
                  id="chrome-a"
                  x1="3.2173"
                  y1="15"
                  x2="44.7812"
                  y2="15"
                  gradientUnits="userSpaceOnUse"
                >
                  <stop offset="0" stopColor="#d93025" />
                  <stop offset="1" stopColor="#ea4335" />
                </linearGradient>
                <linearGradient
                  id="chrome-b"
                  x1="20.7219"
                  y1="47.6791"
                  x2="41.5039"
                  y2="11.6837"
                  gradientUnits="userSpaceOnUse"
                >
                  <stop offset="0" stopColor="#fcc934" />
                  <stop offset="1" stopColor="#fbbc04" />
                </linearGradient>
                <linearGradient
                  id="chrome-c"
                  x1="26.5981"
                  y1="46.5015"
                  x2="5.8161"
                  y2="10.506"
                  gradientUnits="userSpaceOnUse"
                >
                  <stop offset="0" stopColor="#1e8e3e" />
                  <stop offset="1" stopColor="#34a853" />
                </linearGradient>
              </defs>
              <circle cx="24" cy="23.9947" r="12" fill="#fff" />
              <path
                d="M24,12H44.7812a23.9939,23.9939,0,0,0-41.5639.0029L13.6079,30l.0093-.0024A11.9852,11.9852,0,0,1,24,12Z"
                fill="url(#chrome-a)"
              />
              <circle cx="24" cy="24" r="9.5" fill="#1a73e8" />
              <path
                d="M34.3913,30.0029,24.0007,48A23.994,23.994,0,0,0,44.78,12.0031H23.9989l-.0025.0093A11.985,11.985,0,0,1,34.3913,30.0029Z"
                fill="url(#chrome-b)"
              />
              <path
                d="M13.6086,30.0031,3.218,12.006A23.994,23.994,0,0,0,24.0025,48L34.3931,30.0029l-.0067-.0068a11.9852,11.9852,0,0,1-20.7778.007Z"
                fill="url(#chrome-c)"
              />
            </svg>
            Add to Chrome
          </a>
        </div>
      </div>

      {/* FAQ Section */}
      <div className="relative mb-12">
        <div className="text-center mb-6">
          <h2 className="font-display text-xl md:text-2xl font-semibold text-primary">FAQ</h2>
        </div>

        <div className="max-w-3xl mx-auto bg-surface rounded-lg border border-subtle p-4">
          {/* FAQ Items */}
          <div className="space-y-0 divide-y divide-subtle">
            <details className="group py-4">
              <summary className="cursor-pointer list-none flex items-start justify-between">
                <div>
                  <h3 className="font-display text-base font-medium text-secondary group-hover:text-accent transition-colors">
                    How do I know if my flight has Starlink?
                  </h3>
                </div>
                <div className="ml-4 flex-shrink-0">
                  <svg
                    className="w-4 h-4 text-muted group-open:rotate-45 transition-transform"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    role="img"
                    aria-label="Expand"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                    />
                  </svg>
                </div>
              </summary>
              <div className="mt-3 text-sm text-muted leading-relaxed">
                <p>
                  Check your boarding pass for the tail number and search above. You can also search
                  by flight number, airport codes, or aircraft type.
                </p>
              </div>
            </details>

            <details className="group py-4">
              <summary className="cursor-pointer list-none flex items-start justify-between">
                <div>
                  <h3 className="font-display text-base font-medium text-secondary group-hover:text-accent transition-colors">
                    When will my route get Starlink?
                  </h3>
                </div>
                <div className="ml-4 flex-shrink-0">
                  <svg
                    className="w-4 h-4 text-muted group-open:rotate-45 transition-transform"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    role="img"
                    aria-label="Expand"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                    />
                  </svg>
                </div>
              </summary>
              <div className="mt-3 text-sm text-muted leading-relaxed">
                <p className="mb-2">
                  <span className="text-green-400">●</span> Regional jets:{" "}
                  {fleetStats?.express.percentage.toFixed(0)}% complete
                </p>
                <p>
                  <span className="text-accent">●</span> Mainline fleet:{" "}
                  {fleetStats?.mainline.percentage.toFixed(0)}% complete
                </p>
              </div>
            </details>

            <details className="group py-4">
              <summary className="cursor-pointer list-none flex items-start justify-between">
                <div>
                  <h3 className="font-display text-base font-medium text-secondary group-hover:text-accent transition-colors">
                    Is United Starlink WiFi free?
                  </h3>
                </div>
                <div className="ml-4 flex-shrink-0">
                  <svg
                    className="w-4 h-4 text-muted group-open:rotate-45 transition-transform"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    role="img"
                    aria-label="Expand"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                    />
                  </svg>
                </div>
              </summary>
              <div className="mt-3 text-sm text-muted leading-relaxed">
                <p>
                  Yes, completely free for all passengers. No purchase required, no tiered plans -
                  just connect and go.
                </p>
              </div>
            </details>

            <details className="group py-4">
              <summary className="cursor-pointer list-none flex items-start justify-between">
                <div>
                  <h3 className="font-display text-base font-medium text-secondary group-hover:text-accent transition-colors">
                    What can I do with Starlink WiFi?
                  </h3>
                </div>
                <div className="ml-4 flex-shrink-0">
                  <svg
                    className="w-4 h-4 text-muted group-open:rotate-45 transition-transform"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    role="img"
                    aria-label="Expand"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                    />
                  </svg>
                </div>
              </summary>
              <div className="mt-3 text-sm text-muted leading-relaxed">
                <p>
                  4K streaming, live sports, online gaming, large downloads - everything you can do
                  at home.
                </p>
              </div>
            </details>

            <details className="group py-4">
              <summary className="cursor-pointer list-none flex items-start justify-between">
                <div>
                  <h3 className="font-display text-base font-medium text-secondary group-hover:text-accent transition-colors">
                    How does this tracker work?
                  </h3>
                </div>
                <div className="ml-4 flex-shrink-0">
                  <svg
                    className="w-4 h-4 text-muted group-open:rotate-45 transition-transform"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    role="img"
                    aria-label="Expand"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                    />
                  </svg>
                </div>
              </summary>
              <div className="mt-3 text-sm text-muted leading-relaxed">
                <p>
                  We aggregate data from multiple aviation data providers, cross-reference with
                  flight schedules, and verify Starlink status against United's own systems. The
                  data updates continuously throughout the day.
                </p>
                <p className="mt-2 text-xs">
                  Hat tip to the{" "}
                  <a
                    href="https://sites.google.com/site/unitedfleetsite/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:underline"
                  >
                    unitedfleetsite
                  </a>{" "}
                  community for the original fleet data that helped get this project started.
                </p>
              </div>
            </details>
          </div>
        </div>
      </div>

      {/* Search, Filter, and Expand functionality */}
      <script
        dangerouslySetInnerHTML={{
          __html: `
            document.addEventListener('DOMContentLoaded', function() {
              // Search functionality
              var searchInput = document.getElementById('aircraft-search');
              var rows = document.querySelectorAll('.aircraft-row');
              var filterBtns = document.querySelectorAll('.filter-btn');
              var currentFilter = 'all';

              function filterRows() {
                var query = (searchInput?.value || '').toLowerCase().trim();
                var visibleCount = 0;

                rows.forEach(function(row) {
                  var tail = row.dataset.tail || '';
                  var aircraft = row.dataset.aircraft || '';
                  var operator = row.dataset.operator || '';
                  var fleet = row.dataset.fleet || '';
                  var airports = row.dataset.airports || '';
                  var flights = row.dataset.flights || '';

                  var matchesSearch = !query ||
                    tail.includes(query) ||
                    aircraft.includes(query) ||
                    operator.includes(query) ||
                    airports.includes(query) ||
                    flights.includes(query);

                  var matchesFilter = currentFilter === 'all' || fleet === currentFilter;

                  if (matchesSearch && matchesFilter) {
                    row.style.display = '';
                    visibleCount++;
                  } else {
                    row.style.display = 'none';
                  }
                });
              }

              if (searchInput) {
                searchInput.addEventListener('input', filterRows);
              }

              // Filter buttons - use data attribute to track state
              var baseClass = 'filter-btn font-mono text-[11px] px-3 py-2 rounded border transition-all';
              var activeStyle = 'bg-accent/20 border-accent text-accent';
              var inactiveStyle = 'bg-transparent border-subtle text-secondary hover:border-accent/50 hover:text-accent';

              filterBtns.forEach(function(btn) {
                btn.addEventListener('click', function() {
                  currentFilter = this.dataset.filter;

                  // Update button styles
                  filterBtns.forEach(function(b) {
                    if (b.dataset.filter === currentFilter) {
                      b.className = baseClass + ' ' + activeStyle;
                    } else {
                      b.className = baseClass + ' ' + inactiveStyle;
                    }
                  });

                  filterRows();
                });
              });

              // Expand/collapse flights
              document.addEventListener('click', function(e) {
                var btn = e.target.closest('.expand-flights');
                if (!btn) return;

                var targetId = btn.dataset.target;
                var container = document.getElementById(targetId);
                if (!container) return;

                var extras = container.querySelectorAll('.flight-extra');
                var isExpanded = btn.textContent.includes('−');

                if (isExpanded) {
                  // Collapse
                  extras.forEach(function(el) {
                    el.classList.add('hidden');
                    el.classList.remove('inline-flex');
                  });
                  btn.textContent = '+' + btn.dataset.count;
                } else {
                  // Expand
                  extras.forEach(function(el) {
                    el.classList.remove('hidden');
                    el.classList.add('inline-flex');
                  });
                  btn.textContent = '−';
                }
              });

              // Flight badge tooltips - only on devices with hover (not touch/mobile)
              if (window.matchMedia('(hover: hover)').matches) {
                var tooltip = null;
                var currentPill = null;

                document.addEventListener('mouseover', function(e) {
                  var pill = e.target.closest('[data-flight-tooltip]');
                  if (pill && pill !== currentPill) {
                    // Remove old tooltip if exists
                    if (tooltip && tooltip.parentNode) {
                      tooltip.parentNode.removeChild(tooltip);
                    }

                    currentPill = pill;
                    var text = pill.dataset.flightTooltip;
                    if (!text) return;

                    // Create tooltip
                    tooltip = document.createElement('div');
                    tooltip.textContent = text;
                    tooltip.style.cssText = 'position:fixed;padding:4px 8px;background:#0ea5e9;color:#0a0f1a;font-size:11px;font-weight:600;font-family:JetBrains Mono,monospace;border-radius:4px;pointer-events:none;z-index:9999;white-space:nowrap;box-shadow:0 4px 6px rgba(0,0,0,0.3);';
                    document.body.appendChild(tooltip);

                    // Position above the element
                    var rect = pill.getBoundingClientRect();
                    tooltip.style.left = (rect.left + rect.width / 2 - tooltip.offsetWidth / 2) + 'px';
                    tooltip.style.top = (rect.top - tooltip.offsetHeight - 6) + 'px';
                  }
                });

                document.addEventListener('mouseout', function(e) {
                  var pill = e.target.closest('[data-flight-tooltip]');
                  if (!pill) return;

                  // Check if we're leaving to something outside the pill
                  var related = e.relatedTarget;
                  if (related && pill.contains(related)) return;

                  if (tooltip && tooltip.parentNode) {
                    tooltip.parentNode.removeChild(tooltip);
                    tooltip = null;
                  }
                  currentPill = null;
                });
              }

              // Pie chart hover
              var pieContainer = document.getElementById('pie-chart-container');
              var pieCenterText = document.getElementById('pie-center-text');
              var pieStatusLabel = document.getElementById('pie-status-label');

              if (pieContainer && pieCenterText && pieStatusLabel) {
                var slices = pieContainer.querySelectorAll('.pie-slice');
                // Default to largest slice (first one, since sorted by count desc)
                var firstSlice = slices[0];
                var currentCount = firstSlice ? firstSlice.dataset.count : pieCenterText.textContent;
                var currentModel = firstSlice ? firstSlice.dataset.model : '';
                var currentPct = firstSlice ? firstSlice.dataset.pct : '';

                // Set initial state to largest slice
                if (firstSlice) {
                  pieCenterText.textContent = currentCount;
                  pieStatusLabel.innerHTML = '<span style="color:#0ea5e9">' + currentModel + '</span> <span style="color:#5a6a80">· ' + currentPct + '%</span>';
                }

                // Sticky hover - remember last hovered slice
                slices.forEach(function(slice) {
                  slice.addEventListener('mouseenter', function() {
                    currentCount = this.dataset.count;
                    currentModel = this.dataset.model;
                    currentPct = this.dataset.pct;
                    pieCenterText.textContent = currentCount;
                    pieStatusLabel.innerHTML = '<span style="color:#0ea5e9">' + currentModel + '</span> <span style="color:#5a6a80">· ' + currentPct + '%</span>';
                  });
                  // No mouseleave handler - keeps last hovered value
                });
              }
            });
          `,
        }}
      />

      <footer className="relative py-6 text-center border-t border-subtle text-muted text-sm">
        <div className="flex items-center justify-center gap-4">
          <a
            href="https://x.com/martinamps"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center text-secondary hover:text-primary transition-colors"
          >
            Built with
            <svg
              className="w-4 h-4 mx-1 text-red-400"
              xmlns="http://www.w3.org/2000/svg"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="currentColor"
              stroke="currentColor"
              strokeWidth="0"
              aria-label="Heart"
              role="img"
            >
              <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
            </svg>
            by @martinamps
          </a>
          <span className="text-muted">·</span>
          <a
            href="https://github.com/martinamps/ua-starlink-tracker"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-secondary hover:text-primary transition-colors"
          >
            <svg
              className="w-4 h-4"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-label="GitHub"
              role="img"
            >
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
            GitHub
          </a>
        </div>
      </footer>
    </div>
  );
}
