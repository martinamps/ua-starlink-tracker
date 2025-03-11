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
  const [lastUpdated, setLastUpdated] = React.useState<string>(new Date().toLocaleString());
  const [loading, setLoading] = React.useState<boolean>(false);

  const fetchData = React.useCallback(() => {
    setLoading(true);
    fetch("/api/data")
      .then(res => res.json())
      .then(({ totalCount, starlinkPlanes }) => {
        setStarlinkData(starlinkPlanes);
        setTotalAircraft(totalCount);
        setLastUpdated(new Date().toLocaleString());
        setLoading(false);
      })
      .catch(err => {
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
    <div style={{ 
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif',
      maxWidth: '1200px',
      margin: '0 auto',
      padding: '20px',
      backgroundColor: '#f9f9f9',
      color: '#333',
      lineHeight: 1.6
    }}>
      <header style={{ 
        padding: '30px 0',
        textAlign: 'center',
        borderBottom: '1px solid #eaeaea',
        marginBottom: '30px'
      }}>
        <h1 style={{ 
          fontSize: '2.5rem', 
          color: '#0066cc', 
          margin: '0 0 10px 0',
          letterSpacing: '-0.5px'
        }}>UA Starlink Tracker</h1>
        <p style={{ fontSize: '1.1rem', color: '#666', margin: 0 }}>
          Tracking United Airlines aircraft with Starlink WiFi
        </p>
      </header>

      <div style={{ 
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '30px',
        backgroundColor: 'white',
        borderRadius: '10px',
        padding: '30px',
        boxShadow: '0 2px 10px rgba(0,0,0,0.05)'
      }}>
        <div style={{ width: '100%', textAlign: 'center' }}>
          <div style={{ 
            fontSize: '3.5rem', 
            fontWeight: 'bold', 
            color: '#0066cc', 
            marginBottom: '5px',
            letterSpacing: '-1px'
          }}>
            {percentage}%
          </div>
          <div style={{ fontSize: '1.4rem', fontWeight: 'normal' }}>
            <span style={{ fontWeight: 'bold', color: '#0066cc' }}>{x}</span> out of <span style={{ fontWeight: 'bold' }}>{y}</span> planes
          </div>
          <div style={{ fontSize: '0.9rem', color: '#888', marginTop: '15px' }}>
            Last updated: {lastUpdated}
            <button 
              onClick={fetchData} 
              disabled={loading}
              style={{
                marginLeft: '10px',
                padding: '5px 10px',
                backgroundColor: loading ? '#ccc' : '#0066cc',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: loading ? 'not-allowed' : 'pointer',
                fontSize: '0.8rem'
              }}
            >
              {loading ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
        </div>
      </div>

      <h2 style={{ fontSize: '1.8rem', margin: '30px 0 15px 0', color: '#444' }}>
        Planes with Starlink WiFi
      </h2>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ 
          width: '100%', 
          borderCollapse: 'collapse', 
          backgroundColor: 'white',
          boxShadow: '0 2px 10px rgba(0,0,0,0.05)',
          borderRadius: '10px',
          overflow: 'hidden'
        }}>
          <thead>
            <tr style={{ backgroundColor: '#0066cc', color: 'white' }}>
              <th style={{ padding: '15px', textAlign: 'left', fontWeight: '600' }}>Tail Number</th>
              <th style={{ padding: '15px', textAlign: 'left', fontWeight: '600' }}>Aircraft</th>
              <th style={{ padding: '15px', textAlign: 'left', fontWeight: '600' }}>Operated By</th>
              <th style={{ padding: '15px', textAlign: 'left', fontWeight: '600' }}>Date Found</th>
            </tr>
          </thead>
          <tbody>
            {starlinkData.length === 0 ? (
              <tr>
                <td colSpan={4} style={{ padding: '20px', textAlign: 'center', color: '#666' }}>
                  {loading ? 'Loading data...' : 'No data available'}
                </td>
              </tr>
            ) : (
              starlinkData.map((plane, idx) => (
                <tr key={idx} style={{ 
                  borderBottom: '1px solid #eaeaea',
                  backgroundColor: idx % 2 === 0 ? '#fafafa' : 'white'
                }}>
                  <td style={{ padding: '12px 15px', fontWeight: 'bold' }}>
                    <span style={{ 
                      display: 'inline-block',
                      backgroundColor: '#eef5ff',
                      color: '#0066cc',
                      borderRadius: '4px',
                      padding: '5px 10px',
                      fontSize: '0.9rem'
                    }}>
                      {plane["TailNumber"]}
                    </span>
                  </td>
                  <td style={{ padding: '12px 15px' }}>{plane["Aircraft"]}</td>
                  <td style={{ padding: '12px 15px' }}>{plane["OperatedBy"]}</td>
                  <td style={{ padding: '12px 15px', color: '#666', fontSize: '0.9rem' }}>{plane["DateFound"]}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <footer style={{ 
        marginTop: '40px', 
        textAlign: 'center',
        padding: '20px 0',
        borderTop: '1px solid #eaeaea',
        color: '#888',
        fontSize: '0.9rem'
      }}>
        <p>Data refreshes hourly from Google Sheets. Client refresh every 5 minutes.</p>
      </footer>
    </div>
  );
}