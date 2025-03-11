import React from "react";

interface StarlinkAircraft {
  [key: string]: string; // This covers dynamic keys like sheet_gid, etc.
}

interface FleetStats {
  express: {
    total: number;
    starlink: number;
    percentage: number;
  };
  mainline: {
    total: number;
    starlink: number;
    percentage: number;
  };
}

interface PageProps {
  total: number;
  starlink: StarlinkAircraft[];
  lastUpdated?: string; // Optional timestamp from server
  fleetStats?: FleetStats; // Optional fleet statistics
}

const dateOverrides: Record<string, string> = {
  N127SY: "2025-03-07", // First Starlink installation per press release
};

export default function Page({
  total,
  starlink,
  lastUpdated: serverLastUpdated,
  fleetStats,
}: PageProps) {
  // Apply date overrides to the aircraft data
  const applyDateOverrides = (data: StarlinkAircraft[]): StarlinkAircraft[] => {
    return data.map((aircraft) => {
      const tailNumber = aircraft.TailNumber;
      if (tailNumber && dateOverrides[tailNumber]) {
        // Make sure we're using PST for the override date to avoid timezone issues
        const overrideDate = new Date(
          `${dateOverrides[tailNumber]}T12:00:00-08:00`
        );
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

  const [starlinkData, setStarlinkData] = React.useState<StarlinkAircraft[]>(
    applyDateOverrides(starlink)
  );
  const [totalAircraft, setTotalAircraft] = React.useState<number>(total);
  const [lastUpdated, setLastUpdated] = React.useState<string>(
    serverLastUpdated
      ? formatLastUpdated(serverLastUpdated)
      : new Date().toLocaleString()
  );
  const [loading, setLoading] = React.useState<boolean>(false);

  // State for fleet statistics
  const [fleetStatistics, setFleetStatistics] = React.useState<
    FleetStats | undefined
  >(fleetStats);

  // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  const fetchData = React.useCallback(() => {
    setLoading(true);
    fetch("/api/data")
      .then((res) => res.json())
      .then(
        ({
          totalCount,
          starlinkPlanes,
          lastUpdated: fetchedLastUpdated,
          fleetStats: fetchedFleetStats,
        }) => {
          // Apply date overrides to the new data
          const planesWithOverrides = applyDateOverrides(starlinkPlanes);
          setStarlinkData(planesWithOverrides);
          setTotalAircraft(totalCount);

          // Use the timestamp from the server instead of client time
          if (fetchedLastUpdated) {
            setLastUpdated(formatLastUpdated(fetchedLastUpdated));
          }

          // Update fleet statistics
          if (fetchedFleetStats) {
            setFleetStatistics(fetchedFleetStats);
          }
          setLoading(false);
        }
      )
      .catch((err) => {
        console.error("Error fetching data:", err);
        setLoading(false);
      });
  }, []);

  React.useEffect(() => {
    // Client-side fetch to keep data fresh
    fetchData();

    // Refresh data every 5 minutes
    const intervalId = setInterval(fetchData, 5 * 60 * 1000);
    return () => clearInterval(intervalId);
  }, [fetchData]);

  const x = starlinkData.length;
  const y = totalAircraft;
  const percentage = y > 0 ? ((x / y) * 100).toFixed(2) : "0.00";

  return (
    <div className="font-sans w-full mx-auto px-4 sm:px-6 md:px-8 bg-gray-50 text-gray-800 min-h-screen flex flex-col">
      <header className="py-6 sm:py-8 md:py-10 text-center border-b border-gray-200 mb-6 sm:mb-8">
        <h1 className="text-3xl sm:text-4xl md:text-5xl font-bold text-united-blue mb-3 tracking-tight">
          {typeof window !== "undefined" &&
          window.location.hostname.includes("unitedstarlinktracker")
            ? "United Airlines Starlink Tracker"
            : "Airline Starlink Tracker"}
        </h1>
        <p className="text-lg sm:text-xl text-gray-700 mb-4">
          {typeof window !== "undefined" &&
          window.location.hostname.includes("unitedstarlinktracker")
            ? "Tracking United Airlines aircraft with Starlink WiFi"
            : "Tracking major airlines' rollout of Starlink WiFi"}
        </p>
        <div className="max-w-4xl mx-auto px-5 py-4 bg-blue-50 rounded-xl text-gray-700 border border-blue-100 text-left shadow-sm">
          <p className="mb-2">
            United Airlines{" "}
            <a
              href="https://www.united.com/en/us/newsroom/announcements/cision-125370"
              target="_blank"
              rel="noopener noreferrer"
              className="text-united-blue hover:underline font-medium"
            >
              began equipping its fleet
            </a>{" "}
            with SpaceX's Starlink internet on March 7, 2024. The ultra-fast
            WiFi offers speeds up to 250 Mbps—
            <span className="font-bold">50 times faster</span> than previous
            systems. The airline plans to install Starlink on over 40 regional
            aircraft monthly, completing its entire two-cabin regional fleet by
            the end of 2024. Each installation takes only 8 hours, making it 10
            times faster than previous systems, and the lightweight 85-pound
            equipment improves fuel efficiency compared to older 300-pound
            systems.
          </p>
        </div>
      </header>

      {/* Fleet Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6 mb-8">
        {/* Mainline Fleet Card */}
        <div className="bg-white rounded-xl p-6 shadow-md flex flex-col justify-center text-center">
          <div className="text-lg font-semibold mb-2 text-gray-700">
            United Mainline Fleet
          </div>
          <div className="text-4xl md:text-5xl font-bold text-united-blue mb-1 leading-tight tracking-tight">
            {fleetStatistics?.mainline.percentage.toFixed(2)}%
          </div>
          <div className="text-lg">
            <span className="font-bold text-united-blue">
              {fleetStatistics?.mainline.starlink || 0}
            </span>{" "}
            out of{" "}
            <span className="font-bold">
              {fleetStatistics?.mainline.total || 0}
            </span>{" "}
            planes
          </div>
        </div>

        {/* Express Fleet Card */}
        <div className="bg-white rounded-xl p-6 shadow-md flex flex-col justify-center text-center">
          <div className="text-lg font-semibold mb-2 text-gray-700">
            United Express Fleet
          </div>
          <div className="text-4xl md:text-5xl font-bold text-united-blue mb-1 leading-tight tracking-tight">
            {fleetStatistics?.express.percentage.toFixed(2)}%
          </div>
          <div className="text-lg">
            <span className="font-bold text-united-blue">
              {fleetStatistics?.express.starlink || 0}
            </span>{" "}
            out of{" "}
            <span className="font-bold">
              {fleetStatistics?.express.total || 0}
            </span>{" "}
            planes
          </div>
        </div>

        {/* Combined Stats */}
        <div className="bg-white rounded-xl p-6 shadow-md flex flex-col justify-center text-center border-2 border-blue-100">
          <div className="text-lg font-semibold mb-2 text-gray-700">
            Combined Fleet
          </div>
          <div className="text-4xl md:text-5xl font-bold text-united-blue mb-1 leading-tight tracking-tight">
            {percentage}%
          </div>
          <div className="text-lg">
            <span className="font-bold text-united-blue">{x}</span> out of{" "}
            <span className="font-bold">{y}</span> planes
          </div>
        </div>
      </div>

      {/* Last Updated - hidden by default */}
      <div className="text-center mb-6 hidden">
        <div className="text-sm text-gray-500 bg-gray-100 px-4 py-2 rounded-full inline-block">
          Last updated: {lastUpdated}
        </div>
      </div>

      <h2 className="text-2xl md:text-3xl font-bold mb-4 text-gray-800">
        Planes with Starlink WiFi
      </h2>

      <div className="overflow-x-auto bg-white rounded-xl shadow-md flex-1 mb-6">
        <table className="w-full bg-white rounded-xl overflow-hidden">
          <thead>
            <tr className="bg-united-blue">
              <th className="py-3 px-4 text-left font-semibold text-sm md:text-base text-white">
                Tail Number
              </th>
              <th className="py-3 px-4 text-left font-semibold text-sm md:text-base hidden md:table-cell text-white">
                Aircraft Type
              </th>
              <th className="py-3 px-4 text-left font-semibold text-sm md:text-base text-white">
                Operated By
              </th>
              <th className="py-3 px-4 text-left font-semibold text-sm md:text-base text-white">
                Installation Date
              </th>
            </tr>
          </thead>
          <tbody>
            {starlinkData.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="p-8 text-center text-gray-600 bg-gray-50"
                >
                  {loading ? (
                    <div>
                      <div className="text-lg mb-3">Loading data...</div>
                      <div className="w-10 h-10 mx-auto border-3 border-gray-200 border-t-united-blue rounded-full animate-spin" />
                    </div>
                  ) : (
                    "No data available"
                  )}
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
                  <td className="py-3 px-4 font-medium text-gray-700">
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
                  <td className="py-3 px-4 hidden md:table-cell text-gray-700">
                    {plane.Aircraft}
                  </td>
                  <td className="py-3 px-4 text-gray-700">
                    {plane.OperatedBy || "United Airlines"}
                  </td>
                  <td
                    className={`py-3 px-4 text-gray-700 text-sm whitespace-nowrap ${
                      dateOverrides[plane.TailNumber] ? "font-medium" : ""
                    }`}
                  >
                    {/* Hardcode override dates to ensure correct display */}
                    {dateOverrides[plane.TailNumber]
                      ? "Mar 7, 2024" // Hardcoded display for override dates
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
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <footer className="mt-auto py-6 text-center border-t border-gray-200 text-gray-600 text-sm">
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
      </footer>
    </div>
  );
}
