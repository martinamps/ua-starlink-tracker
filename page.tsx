import React from "react";

interface StarlinkAircraft {
  [key: string]: string; // This covers dynamic keys like sheet_gid, etc.
}

interface PageProps {
  total: number;
  starlink: StarlinkAircraft[];
}

export default function Page({ total, starlink }: PageProps) {
  const [starlinkData, setStarlinkData] = React.useState<StarlinkAircraft[]>(starlink);
  const [totalAircraft, setTotalAircraft] = React.useState<number>(total);

  React.useEffect(() => {
    // Client-side fetch to keep data fresh
    fetch("/api/data")
      .then(res => res.json())
      .then(({ totalCount, starlinkPlanes }) => {
        setStarlinkData(starlinkPlanes);
        setTotalAircraft(totalCount);
      });
  }, []);

  const x = starlinkData.length;
  const y = totalAircraft;
  const percentage = y > 0 ? ((x / y) * 100).toFixed(2) : "0.00";

  return (
    <div style={{ fontFamily: "sans-serif" }}>
      <h1>UA Tracker</h1>
      <p>
        {x} out of {y} planes ({percentage}%)
      </p>
      <h2>Starlink Planes:</h2>
      <table border={1} cellPadding={8}>
        <thead>
          <tr>
            <th>Aircraft</th>
            <th>WiFi</th>
            <th>sheet_gid</th>
            <th>sheet_type</th>
            {/* Additional columns if needed */}
          </tr>
        </thead>
        <tbody>
          {starlinkData.map((plane, idx) => (
            <tr key={idx}>
              <td>{plane["Aircraft"]}</td>
              <td>{plane["WiFi"]}</td>
              <td>{plane["sheet_gid"]}</td>
              <td>{plane["sheet_type"]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}