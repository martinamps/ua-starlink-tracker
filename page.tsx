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

// Manual date overrides for specific tail numbers
const dateOverrides: Record<string, string> = {
  // Format: 'TailNumber': 'YYYY-MM-DD'
  'N127SY': '2024-03-07', // First Starlink installation per press release
  'ERJ-175': '2024-03-07', // Override for ERJ-175 aircraft (should be replaced when actual tail numbers are known)
};

export default function Page({ total, starlink, lastUpdated: serverLastUpdated, fleetStats }: PageProps) {
  // Apply date overrides to the aircraft data
  const applyDateOverrides = (data: StarlinkAircraft[]): StarlinkAircraft[] => {
    return data.map(aircraft => {
      const tailNumber = aircraft["TailNumber"];
      if (tailNumber && dateOverrides[tailNumber]) {
        return {
          ...aircraft,
          DateFound: dateOverrides[tailNumber]
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
    serverLastUpdated ? formatLastUpdated(serverLastUpdated) : new Date().toLocaleString()
  );
  const [loading, setLoading] = React.useState<boolean>(false);
  const [isMobile, setIsMobile] = React.useState<boolean>(false);

  // Check if viewing on mobile
  React.useEffect(() => {
    const checkIfMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };
    
    // Initial check
    checkIfMobile();
    
    // Add event listener
    window.addEventListener('resize', checkIfMobile);
    
    // Clean up
    return () => window.removeEventListener('resize', checkIfMobile);
  }, []);

  // State for fleet statistics
  const [fleetStatistics, setFleetStatistics] = React.useState<FleetStats | undefined>(fleetStats);

  const fetchData = React.useCallback(() => {
    setLoading(true);
    fetch("/api/data")
      .then(res => res.json())
      .then(({ totalCount, starlinkPlanes, lastUpdated: fetchedLastUpdated, fleetStats: fetchedFleetStats }) => {
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
      padding: isMobile ? '10px' : '20px',
      backgroundColor: '#f9f9f9',
      color: '#333',
      lineHeight: 1.6,
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column'
    }}>
      <header style={{ 
        padding: isMobile ? '20px 0' : '30px 0',
        textAlign: 'center',
        borderBottom: '1px solid #eaeaea',
        marginBottom: isMobile ? '20px' : '30px'
      }}>
        <h1 style={{ 
          fontSize: isMobile ? '2rem' : '2.5rem', 
          color: '#0066cc', 
          margin: '0 0 10px 0',
          letterSpacing: '-0.5px',
          fontWeight: 700
        }}>UA Starlink Tracker</h1>
        <p style={{ fontSize: isMobile ? '1rem' : '1.1rem', color: '#666', margin: '0 0 15px 0' }}>
          Tracking United Airlines aircraft with Starlink WiFi
        </p>
        <div style={{ 
          maxWidth: '800px', 
          margin: '0 auto', 
          padding: '16px 20px',
          backgroundColor: '#eef5ff',
          borderRadius: '12px',
          fontSize: isMobile ? '0.95rem' : '1rem',
          lineHeight: 1.6,
          color: '#444',
          border: '1px solid rgba(0,102,204,0.15)',
          textAlign: 'left'
        }}>
          <p style={{ margin: '0 0 10px 0' }}>
            United Airlines began equipping its fleet with SpaceX's Starlink internet on March 7, 2024. The ultra-fast WiFi offers speeds up to 250 Mbps—<strong>50 times faster</strong> than previous systems. The airline plans to install Starlink on over 40 regional aircraft monthly, completing its entire two-cabin regional fleet by the end of 2024. Each installation takes only 8 hours, making it 10 times faster than previous systems, and the lightweight 85-pound equipment improves fuel efficiency compared to older 300-pound systems.
          </p>
        </div>
      </header>

      {/* Fleet Stats Cards */}
      <div style={{ 
        display: 'flex',
        flexDirection: isMobile ? 'column' : 'row',
        gap: '20px',
        marginBottom: isMobile ? '20px' : '30px',
        width: '100%'
      }}>
        {/* Mainline Fleet Card */}
        <div style={{ 
          flex: 1,
          backgroundColor: 'white',
          borderRadius: '12px',
          padding: isMobile ? '20px' : '25px',
          boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
          textAlign: 'center',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center'
        }}>
          <div style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '10px', color: '#444' }}>
            United Mainline Fleet
          </div>
          <div style={{ 
            fontSize: isMobile ? '2.5rem' : '3rem', 
            fontWeight: 'bold', 
            color: '#0066cc', 
            marginBottom: '5px',
            letterSpacing: '-1px',
            lineHeight: 1.1
          }}>
            {fleetStatistics?.mainline.percentage.toFixed(2)}%
          </div>
          <div style={{ fontSize: '1.1rem', fontWeight: 'normal', margin: '0 0 5px 0' }}>
            <span style={{ fontWeight: 'bold', color: '#0066cc' }}>{fleetStatistics?.mainline.starlink || 0}</span> out of <span style={{ fontWeight: 'bold' }}>{fleetStatistics?.mainline.total || 0}</span> planes
          </div>
        </div>
        
        {/* Express Fleet Card */}
        <div style={{ 
          flex: 1,
          backgroundColor: 'white',
          borderRadius: '12px',
          padding: isMobile ? '20px' : '25px',
          boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
          textAlign: 'center',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center'
        }}>
          <div style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '10px', color: '#444' }}>
            United Express Fleet
          </div>
          <div style={{ 
            fontSize: isMobile ? '2.5rem' : '3rem', 
            fontWeight: 'bold', 
            color: '#0066cc', 
            marginBottom: '5px',
            letterSpacing: '-1px',
            lineHeight: 1.1
          }}>
            {fleetStatistics?.express.percentage.toFixed(2)}%
          </div>
          <div style={{ fontSize: '1.1rem', fontWeight: 'normal', margin: '0 0 5px 0' }}>
            <span style={{ fontWeight: 'bold', color: '#0066cc' }}>{fleetStatistics?.express.starlink || 0}</span> out of <span style={{ fontWeight: 'bold' }}>{fleetStatistics?.express.total || 0}</span> planes
          </div>
        </div>
        
        {/* Combined Stats */}
        <div style={{ 
          flex: 1,
          backgroundColor: 'white',
          borderRadius: '12px',
          padding: isMobile ? '20px' : '25px',
          boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
          textAlign: 'center',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          border: '2px solid rgba(0,102,204,0.1)'
        }}>
          <div style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '10px', color: '#444' }}>
            Combined Fleet
          </div>
          <div style={{ 
            fontSize: isMobile ? '2.5rem' : '3rem', 
            fontWeight: 'bold', 
            color: '#0066cc', 
            marginBottom: '5px',
            letterSpacing: '-1px',
            lineHeight: 1.1
          }}>
            {percentage}%
          </div>
          <div style={{ fontSize: '1.1rem', fontWeight: 'normal', margin: '0 0 5px 0' }}>
            <span style={{ fontWeight: 'bold', color: '#0066cc' }}>{x}</span> out of <span style={{ fontWeight: 'bold' }}>{y}</span> planes
          </div>
        </div>
      </div>
      
      {/* Last Updated */}
      <div style={{ 
        textAlign: 'center',
        marginBottom: '25px'
      }}>
        <div style={{ 
          fontSize: '0.9rem', 
          color: '#888',
          backgroundColor: '#f8f8f8',
          padding: '8px 12px',
          borderRadius: '20px',
          display: 'inline-block'
        }}>
          Last updated: {lastUpdated}
        </div>
      </div>

      <h2 style={{ 
        fontSize: isMobile ? '1.5rem' : '1.8rem', 
        margin: isMobile ? '20px 0 12px 0' : '30px 0 15px 0', 
        color: '#333',
        fontWeight: 600
      }}>
        Planes with Starlink WiFi
      </h2>

      <div style={{ 
        overflowX: 'auto',
        flex: 1,
        marginBottom: '20px',
        borderRadius: '12px',
        boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
        backgroundColor: 'white'
      }}>
        <table style={{ 
          width: '100%', 
          borderCollapse: 'collapse', 
          backgroundColor: 'white',
          borderRadius: '12px',
          overflow: 'hidden'
        }}>
          <thead>
            <tr style={{ 
              backgroundColor: '#0066cc', 
              color: 'white',
              boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
            }}>
              <th style={{ 
                padding: isMobile ? '12px 8px' : '16px', 
                textAlign: 'left', 
                fontWeight: '600', 
                fontSize: isMobile ? '0.85rem' : '1rem' 
              }}>Tail Number</th>
              <th style={{ 
                padding: isMobile ? '12px 8px' : '16px', 
                textAlign: 'left', 
                fontWeight: '600',
                fontSize: isMobile ? '0.85rem' : '1rem',
                display: isMobile ? 'none' : 'table-cell' // Hide on mobile
              }}>Aircraft</th>
              <th style={{ 
                padding: isMobile ? '12px 8px' : '16px', 
                textAlign: 'left', 
                fontWeight: '600',
                fontSize: isMobile ? '0.85rem' : '1rem'
              }}>Operated By</th>
              <th style={{ 
                padding: isMobile ? '12px 8px' : '16px', 
                textAlign: 'left', 
                fontWeight: '600',
                fontSize: isMobile ? '0.85rem' : '1rem'
              }}>Date Found</th>
            </tr>
          </thead>
          <tbody>
            {starlinkData.length === 0 ? (
              <tr>
                <td colSpan={isMobile ? 3 : 4} style={{ 
                  padding: '30px', 
                  textAlign: 'center', 
                  color: '#666',
                  backgroundColor: '#fafafa'
                }}>
                  {loading ? (
                    <div>
                      <div style={{ fontSize: '1.1rem', marginBottom: '10px' }}>Loading data...</div>
                      <div style={{ width: '40px', height: '40px', margin: '0 auto', border: '3px solid #f3f3f3', borderTop: '3px solid #0066cc', borderRadius: '50%', animation: 'spin 1s linear infinite' }}></div>
                      <style>{`@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>
                    </div>
                  ) : 'No data available'}
                </td>
              </tr>
            ) : (
              starlinkData.map((plane, idx) => (
                <tr key={idx} style={{ 
                  borderBottom: '1px solid #eaeaea',
                  backgroundColor: idx % 2 === 0 ? '#fafafa' : 'white',
                  transition: 'background-color 0.2s ease'
                }}>
                  <td style={{ 
                    padding: isMobile ? '12px 8px' : '14px 16px', 
                    fontWeight: 'bold'
                  }}>
                    <span style={{ 
                      display: 'inline-block',
                      backgroundColor: plane["fleet"] === "mainline" ? '#e8f0ff' : '#eef5ff',
                      color: '#0066cc',
                      borderRadius: '20px',
                      padding: '6px 12px',
                      fontSize: '0.9rem',
                      fontWeight: '600',
                      border: '1px solid rgba(0,102,204,0.2)',
                      boxShadow: '0 1px 2px rgba(0,0,0,0.05)'
                    }}>
                      {plane["TailNumber"]}
                    </span>
                    {plane["fleet"] === "mainline" ? (
                      <span style={{
                        display: 'inline-block',
                        backgroundColor: '#0066cc',
                        color: 'white',
                        borderRadius: '4px',
                        padding: '2px 6px',
                        fontSize: '0.7rem',
                        marginLeft: '8px',
                        verticalAlign: 'middle'
                      }}>
                        Mainline
                      </span>
                    ) : (
                      <span style={{
                        display: 'inline-block',
                        backgroundColor: '#6699cc',
                        color: 'white',
                        borderRadius: '4px',
                        padding: '2px 6px',
                        fontSize: '0.7rem',
                        marginLeft: '8px',
                        verticalAlign: 'middle'
                      }}>
                        Express
                      </span>
                    )}
                  </td>
                  <td style={{ 
                    padding: isMobile ? '12px 8px' : '14px 16px',
                    display: isMobile ? 'none' : 'table-cell' // Hide on mobile
                  }}>{plane["Aircraft"]}</td>
                  <td style={{ 
                    padding: isMobile ? '12px 8px' : '14px 16px',
                    fontSize: isMobile ? '0.9rem' : 'inherit'
                  }}>{plane["OperatedBy"] || "United Airlines"}</td>
                  <td style={{ 
                    padding: isMobile ? '12px 8px' : '14px 16px', 
                    color: '#555', 
                    fontSize: isMobile ? '0.85rem' : '0.9rem',
                    whiteSpace: 'nowrap',
                    // Highlight manually overridden dates
                    fontWeight: dateOverrides[plane["TailNumber"]] ? '600' : 'normal'
                  }}>
                    {/* Format date for better display */}
                    {plane["DateFound"] ? 
                      new Date(plane["DateFound"]).toLocaleDateString(undefined, {
                        year: 'numeric', 
                        month: 'short', 
                        day: 'numeric'
                      }) 
                      : new Date().toLocaleDateString(undefined, {
                        year: 'numeric', 
                        month: 'short', 
                        day: 'numeric'
                      })
                    }
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <footer style={{ 
        marginTop: 'auto', 
        textAlign: 'center',
        padding: '20px 0',
        borderTop: '1px solid #eaeaea',
        color: '#888',
        fontSize: '0.9rem'
      }}>
        <p>© {new Date().getFullYear()} UA Starlink Tracker</p>
      </footer>
    </div>
  );
}