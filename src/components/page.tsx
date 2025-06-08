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
  lastUpdated: serverLastUpdated,
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

  // Format the timestamp from server to human-readable format
  const formatLastUpdated = (isoTimestamp: string): string => {
    try {
      const date = new Date(isoTimestamp);
      return date.toLocaleString();
    } catch (e) {
      return new Date().toLocaleString(); // Fallback
    }
  };

  // Server-side rendering uses props directly, no client state needed
  const starlinkData = applyDateOverrides(starlink);
  const x = starlinkData.length;
  const y = total;
  const percentage = y > 0 ? ((x / y) * 100).toFixed(2) : "0.00";

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
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();

    const timeStr = date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });

    // Always show the date for clarity
    const dateStr = date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });

    return `${dateStr} ${timeStr}`;
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
    <div className="w-full mx-auto px-4 sm:px-6 md:px-8 bg-gray-50 text-gray-800 min-h-screen flex flex-col">
      <header className="py-6 sm:py-8 md:py-10 text-center border-b border-gray-200 mb-6 sm:mb-8">
        <h1 className="text-3xl sm:text-4xl md:text-5xl font-bold text-united-blue mb-3 tracking-tight">
          {isUnited ? PAGE_CONTENT.pageTitle.united : PAGE_CONTENT.pageTitle.generic}
        </h1>
        <p className="text-lg sm:text-xl text-gray-700 mb-4">
          {isUnited ? PAGE_CONTENT.pageSubtitle.united : PAGE_CONTENT.pageSubtitle.generic}
        </p>
        <div className="max-w-4xl mx-auto px-5 py-4 bg-blue-50 rounded-xl text-gray-700 border border-blue-100 text-left shadow-sm">
          <p className="mb-2">
            United Airlines{" "}
            <a
              href={PAGE_CONTENT.mainDescription.pressReleaseUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-united-blue hover:underline font-medium"
            >
              began equipping its fleet
            </a>{" "}
            with SpaceX's Starlink internet on March 7, 2025. The ultra-fast WiFi offers speeds up
            to 250 Mbps—
            <span className="font-bold">50 times faster</span> than previous systems. The airline
            plans to install Starlink on over 40 regional aircraft monthly, completing its entire
            two-cabin regional fleet by the end of 2025. Each installation takes only 8 hours,
            making it 10 times faster than previous systems, and the lightweight 85-pound equipment
            improves fuel efficiency compared to older 300-pound systems.
          </p>
        </div>
      </header>

      {/* Fleet Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6 mb-8">
        {/* Mainline Fleet Card */}
        <div className="bg-white rounded-xl p-6 shadow-md flex flex-col justify-center text-center relative overflow-hidden">
          <div className="text-lg font-semibold mb-2 text-gray-700">
            {PAGE_CONTENT.fleetLabels.mainline}
          </div>
          {/* Progress Ring */}
          <div className="relative w-32 h-32 mx-auto mb-3">
            <svg
              className="w-32 h-32 transform -rotate-90"
              role="img"
              aria-label="Mainline fleet progress ring showing percentage with Starlink"
            >
              <circle cx="64" cy="64" r="56" stroke="#e5e7eb" strokeWidth="12" fill="none" />
              <circle
                cx="64"
                cy="64"
                r="56"
                stroke="#0066cc"
                strokeWidth="12"
                fill="none"
                strokeDasharray={`${2 * Math.PI * 56}`}
                strokeDashoffset={`${2 * Math.PI * 56 * (1 - (fleetStats?.mainline.percentage || 0) / 100)}`}
                className="transition-all duration-1000 ease-out"
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-3xl font-bold text-united-blue">
                {fleetStats?.mainline.percentage.toFixed(0)}%
              </span>
            </div>
          </div>
          <div className="text-sm text-gray-600">
            <span className="font-bold text-united-blue">{fleetStats?.mainline.starlink || 0}</span>{" "}
            out of <span className="font-bold">{fleetStats?.mainline.total || 0}</span> planes
          </div>
        </div>

        {/* Express Fleet Card */}
        <div className="bg-white rounded-xl p-6 shadow-md flex flex-col justify-center text-center relative overflow-hidden">
          <div className="text-lg font-semibold mb-2 text-gray-700">
            {PAGE_CONTENT.fleetLabels.express}
          </div>
          {/* Progress Ring */}
          <div className="relative w-32 h-32 mx-auto mb-3">
            <svg
              className="w-32 h-32 transform -rotate-90"
              role="img"
              aria-label="Express fleet progress ring showing percentage with Starlink"
            >
              <circle cx="64" cy="64" r="56" stroke="#e5e7eb" strokeWidth="12" fill="none" />
              <circle
                cx="64"
                cy="64"
                r="56"
                stroke="#0066cc"
                strokeWidth="12"
                fill="none"
                strokeDasharray={`${2 * Math.PI * 56}`}
                strokeDashoffset={`${2 * Math.PI * 56 * (1 - (fleetStats?.express.percentage || 0) / 100)}`}
                className="transition-all duration-1000 ease-out"
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-3xl font-bold text-united-blue">
                {fleetStats?.express.percentage.toFixed(0)}%
              </span>
            </div>
          </div>
          <div className="text-sm text-gray-600">
            <span className="font-bold text-united-blue">{fleetStats?.express.starlink || 0}</span>{" "}
            out of <span className="font-bold">{fleetStats?.express.total || 0}</span> planes
          </div>
        </div>

        {/* Combined Stats */}
        <div className="bg-white rounded-xl p-6 shadow-md flex flex-col justify-center text-center border-2 border-blue-100 relative overflow-hidden">
          <div className="text-lg font-semibold mb-2 text-gray-700">
            {PAGE_CONTENT.fleetLabels.combined}
          </div>
          {/* Progress Ring */}
          <div className="relative w-32 h-32 mx-auto mb-3">
            <svg
              className="w-32 h-32 transform -rotate-90"
              role="img"
              aria-label="Combined fleet progress ring showing overall percentage with Starlink"
            >
              <circle cx="64" cy="64" r="56" stroke="#e5e7eb" strokeWidth="12" fill="none" />
              <circle
                cx="64"
                cy="64"
                r="56"
                stroke="#0066cc"
                strokeWidth="12"
                fill="none"
                strokeDasharray={`${2 * Math.PI * 56}`}
                strokeDashoffset={`${2 * Math.PI * 56 * (1 - Number.parseFloat(percentage) / 100)}`}
                className="transition-all duration-1000 ease-out"
                strokeLinecap="round"
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-3xl font-bold text-united-blue">
                {Math.round(Number.parseFloat(percentage))}%
              </span>
            </div>
          </div>
          <div className="text-sm text-gray-600">
            <span className="font-bold text-united-blue">{x}</span> out of{" "}
            <span className="font-bold">{y}</span> planes
          </div>
          <div className="text-xs text-gray-500 mt-2">+40 monthly installations</div>
        </div>
      </div>

      {/* Last Updated - hidden by default */}
      <div className="text-center mb-6 hidden">
        <div className="text-sm text-gray-500 bg-gray-100 px-4 py-2 rounded-full inline-block">
          Last updated:{" "}
          {serverLastUpdated ? formatLastUpdated(serverLastUpdated) : new Date().toLocaleString()}
        </div>
      </div>

      {/* Search and Filter Section */}
      <div className="mb-6 bg-white rounded-xl shadow-md p-4">
        <div className="flex flex-col md:flex-row gap-4">
          <div className="flex-1">
            <div className="relative">
              <input
                type="text"
                placeholder="Search by tail number, aircraft type, or operator..."
                className="w-full px-4 py-2 pl-10 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-united-blue focus:border-transparent"
              />
              <svg
                className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400"
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
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="px-4 py-2 rounded-lg font-medium transition-colors bg-united-blue text-white"
              data-filter="all"
            >
              All ({starlinkData.length})
            </button>
            <button
              type="button"
              className="px-4 py-2 rounded-lg font-medium transition-colors bg-gray-100 text-gray-700 hover:bg-gray-200"
              data-filter="mainline"
            >
              Mainline ({fleetStats?.mainline.starlink || 0})
            </button>
            <button
              type="button"
              className="px-4 py-2 rounded-lg font-medium transition-colors bg-gray-100 text-gray-700 hover:bg-gray-200"
              data-filter="express"
            >
              Express ({fleetStats?.express.starlink || 0})
            </button>
          </div>
        </div>
        <div className="mt-2 text-sm text-gray-600" style={{ display: "none" }}>
          {/* Will be updated by JavaScript */}
        </div>
      </div>

      <h2 className="text-2xl md:text-3xl font-bold mb-4 text-gray-800">
        Which United Planes Have Starlink WiFi?
      </h2>

      {/* Desktop Table View */}
      <div className="hidden md:block bg-white rounded-xl shadow-md mb-6">
        <div className="overflow-auto" style={{ maxHeight: "60vh" }}>
          <table className="w-full bg-white">
            <thead className="sticky top-0 z-10">
              <tr className="bg-united-blue">
                <th className="py-3 px-4 text-left font-semibold text-sm lg:text-base text-white">
                  Tail Number
                </th>
                <th className="py-3 px-4 text-left font-semibold text-sm lg:text-base text-white">
                  Aircraft Type
                </th>
                <th className="py-3 px-4 text-left font-semibold text-sm lg:text-base text-white">
                  Operated By
                </th>
                <th className="py-3 px-4 text-left font-semibold text-sm lg:text-base text-white">
                  Installation Date
                </th>
                <th className="py-3 px-4 text-left font-semibold text-sm lg:text-base text-white">
                  Upcoming Flights
                </th>
              </tr>
            </thead>
            <tbody>
              {starlinkData.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-8 text-center text-gray-600 bg-gray-50">
                    No data available
                  </td>
                </tr>
              ) : (
                starlinkData.map((plane, idx) => (
                  <tr
                    key={plane.TailNumber || idx}
                    className={`border-b border-gray-200 ${
                      idx % 2 === 0 ? "bg-gray-50" : "bg-white"
                    } transition-colors`}
                  >
                    <td className="py-4 px-4 font-medium text-gray-700">
                      <span className="inline-block px-3 py-1.5 rounded-full text-sm font-semibold bg-blue-50 text-united-blue border border-blue-100 shadow-sm">
                        {plane.TailNumber}
                      </span>
                      {plane.fleet === "mainline" ? (
                        <span className="inline-block ml-2 px-1.5 py-0.5 text-xs bg-united-blue text-white rounded">
                          Mainline
                        </span>
                      ) : (
                        <span className="inline-block ml-2 px-1.5 py-0.5 text-xs bg-blue-500 text-white rounded">
                          Express
                        </span>
                      )}
                    </td>
                    <td className="py-4 px-4 text-gray-700 font-medium">{plane.Aircraft}</td>
                    <td className="py-4 px-4 text-gray-700">
                      {plane.OperatedBy || "United Airlines"}
                    </td>
                    <td
                      className={`py-4 px-4 text-gray-700 text-sm whitespace-nowrap ${
                        dateOverrides[plane.TailNumber] ? "font-medium" : ""
                      }`}
                    >
                      {dateOverrides[plane.TailNumber]
                        ? "Mar 7, 2025"
                        : plane.DateFound
                          ? new Date(plane.DateFound).toLocaleDateString("en-US", {
                              year: "numeric",
                              month: "short",
                              day: "numeric",
                              timeZone: "America/Los_Angeles",
                            })
                          : new Date().toLocaleDateString("en-US", {
                              year: "numeric",
                              month: "short",
                              day: "numeric",
                              timeZone: "America/Los_Angeles",
                            })}
                    </td>
                    <td className="py-4 px-4">{renderUpcomingFlights(plane.TailNumber, false)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile Card View */}
      <div className="md:hidden mb-6">
        <div className="overflow-auto" style={{ maxHeight: "70vh" }}>
          <div className="space-y-4">
            {starlinkData.length === 0 ? (
              <div className="bg-white rounded-xl shadow-md p-6 text-center text-gray-600">
                No data available
              </div>
            ) : (
              starlinkData.map((plane, idx) => (
                <div
                  key={plane.TailNumber || idx}
                  className="bg-white rounded-xl shadow-md p-4 border border-gray-200"
                >
                  {/* Header with tail number and fleet type */}
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="inline-block px-3 py-1.5 rounded-full text-sm font-semibold bg-blue-50 text-united-blue border border-blue-100 shadow-sm">
                        {plane.TailNumber}
                      </span>
                      {plane.fleet === "mainline" ? (
                        <span className="inline-block px-1.5 py-0.5 text-xs bg-united-blue text-white rounded">
                          Mainline
                        </span>
                      ) : (
                        <span className="inline-block px-1.5 py-0.5 text-xs bg-blue-500 text-white rounded">
                          Express
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Aircraft info grid */}
                  <div className="grid grid-cols-1 gap-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-600 font-medium">Aircraft:</span>
                      <span className="text-gray-800 font-medium">{plane.Aircraft}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600 font-medium">Operator:</span>
                      <span className="text-gray-800">{plane.OperatedBy || "United Airlines"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600 font-medium">Installed:</span>
                      <span
                        className={`text-gray-800 ${dateOverrides[plane.TailNumber] ? "font-medium" : ""}`}
                      >
                        {dateOverrides[plane.TailNumber]
                          ? "Mar 7, 2025"
                          : plane.DateFound
                            ? new Date(plane.DateFound).toLocaleDateString("en-US", {
                                year: "numeric",
                                month: "short",
                                day: "numeric",
                                timeZone: "America/Los_Angeles",
                              })
                            : new Date().toLocaleDateString("en-US", {
                                year: "numeric",
                                month: "short",
                                day: "numeric",
                                timeZone: "America/Los_Angeles",
                              })}
                      </span>
                    </div>
                  </div>

                  {/* Mobile flights display */}
                  {renderMobileFlights(plane)}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* FAQ Section - Apple-inspired design */}
      <div className="mt-16 mb-12">
        <div className="text-center mb-12">
          <h2 className="text-3xl md:text-4xl font-semibold text-gray-900 mb-3">
            Everything you need to know
          </h2>
          <p className="text-lg text-gray-600">About United's Starlink WiFi rollout</p>
        </div>

        <div className="max-w-4xl mx-auto">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-12">
            {/* Quick Stats Cards */}
            <div className="text-center">
              <div className="text-4xl font-bold text-united-blue mb-2">{x}</div>
              <div className="text-sm text-gray-600 font-medium">Aircraft Equipped</div>
            </div>
            <div className="text-center">
              <div className="text-4xl font-bold text-united-blue mb-2">250 Mbps</div>
              <div className="text-sm text-gray-600 font-medium">50x Faster</div>
            </div>
            <div className="text-center">
              <div className="text-4xl font-bold text-united-blue mb-2">Free</div>
              <div className="text-2xl">😍</div>
            </div>
          </div>

          {/* Clean FAQ Items */}
          <div className="space-y-0 divide-y divide-gray-200">
            <details className="group py-6">
              <summary className="cursor-pointer list-none flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-medium text-gray-900 group-hover:text-united-blue transition-colors">
                    How do I know if my flight has Starlink?
                  </h3>
                  <p className="mt-1 text-sm text-gray-500 pr-8">
                    Search by tail number, flight number, or route above
                  </p>
                </div>
                <div className="ml-6 flex-shrink-0">
                  <svg
                    className="w-5 h-5 text-gray-400 group-open:rotate-45 transition-transform"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    role="img"
                    aria-label="Expand or collapse FAQ item"
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
              <div className="mt-4 text-gray-600 text-sm leading-relaxed">
                <p>
                  Check your boarding pass for the tail number (e.g., N127SY) and search above. You
                  can also search by:
                </p>
                <ul className="mt-3 space-y-2">
                  <li className="flex items-start">
                    <span className="text-united-blue mr-2">•</span>
                    <span>
                      <strong>Flight number</strong> - UA123 or regional codes like SKW5573
                    </span>
                  </li>
                  <li className="flex items-start">
                    <span className="text-united-blue mr-2">•</span>
                    <span>
                      <strong>Airport codes</strong> - SFO, LAX, ORD, etc.
                    </span>
                  </li>
                  <li className="flex items-start">
                    <span className="text-united-blue mr-2">•</span>
                    <span>
                      <strong>Aircraft type</strong> - 737, E175, CRJ, etc.
                    </span>
                  </li>
                </ul>
              </div>
            </details>

            <details className="group py-6">
              <summary className="cursor-pointer list-none flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-medium text-gray-900 group-hover:text-united-blue transition-colors">
                    When will my route get Starlink?
                  </h3>
                  <p className="mt-1 text-sm text-gray-500 pr-8">
                    United is installing on 40+ aircraft monthly
                  </p>
                </div>
                <div className="ml-6 flex-shrink-0">
                  <svg
                    className="w-5 h-5 text-gray-400 group-open:rotate-45 transition-transform"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    role="img"
                    aria-label="Expand or collapse FAQ item"
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
              <div className="mt-4 text-gray-600 text-sm leading-relaxed">
                <div className="space-y-3">
                  <div className="flex items-start">
                    <span className="text-green-500 mr-3">✓</span>
                    <div>
                      <strong>Now - End of 2025:</strong> Regional jets (E175, CRJ)
                      <div className="text-xs text-gray-500 mt-1">
                        Currently {fleetStats?.express.percentage.toFixed(0)}% complete
                      </div>
                    </div>
                  </div>
                  <div className="flex items-start">
                    <span className="text-gray-400 mr-3">○</span>
                    <div>
                      <strong>2025 - 2026:</strong> Mainline fleet (737, 757, 767, 777, 787,
                      A319/320)
                      <div className="text-xs text-gray-500 mt-1">
                        Currently {fleetStats?.mainline.percentage.toFixed(0)}% complete
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </details>

            <details className="group py-6">
              <summary className="cursor-pointer list-none flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-medium text-gray-900 group-hover:text-united-blue transition-colors">
                    What can I do with Starlink WiFi?
                  </h3>
                  <p className="mt-1 text-sm text-gray-500 pr-8">Everything you can do at home</p>
                </div>
                <div className="ml-6 flex-shrink-0">
                  <svg
                    className="w-5 h-5 text-gray-400 group-open:rotate-45 transition-transform"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    role="img"
                    aria-label="Expand or collapse FAQ item"
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
              <div className="mt-4 text-gray-600 text-sm leading-relaxed">
                <p className="mb-3">With speeds up to 250 Mbps (50x faster than before):</p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex items-center">
                    <span className="text-green-500 mr-2">✓</span>
                    <span>4K streaming</span>
                  </div>
                  <div className="flex items-center">
                    <span className="text-green-500 mr-2">✓</span>
                    <span>Video calls</span>
                  </div>
                  <div className="flex items-center">
                    <span className="text-green-500 mr-2">✓</span>
                    <span>Online gaming</span>
                  </div>
                  <div className="flex items-center">
                    <span className="text-green-500 mr-2">✓</span>
                    <span>Large downloads</span>
                  </div>
                </div>
              </div>
            </details>
          </div>
        </div>
      </div>

      <footer className="mt-12 py-6 text-center border-t border-gray-200 text-gray-600 text-sm">
        <a
          href="https://x.com/martinamps"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center text-gray-600 hover:text-gray-800 transition-colors"
        >
          Built with
          <svg
            className="w-4 h-4 mx-1 text-red-400"
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-label="Heart"
            role="img"
          >
            <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
          </svg>
          by @martinamps
        </a>
        <div className="mt-2 text-xs text-gray-500">
          Made possible thanks to the enthusiasts maintaining{" "}
          <a
            href="https://sites.google.com/site/unitedfleetsite/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-600 hover:text-gray-800 hover:underline transition-colors"
          >
            unitedfleetsite
          </a>
        </div>
      </footer>
    </div>
  );
}
