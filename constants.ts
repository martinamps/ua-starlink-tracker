// Domain-specific content mapping
export function getDomainContent(host: string) {
  const isUnitedDomain = host.includes("unitedstarlinktracker");
  
  return {
    siteTitle: isUnitedDomain
      ? "United Airlines Starlink Tracker | Live WiFi Rollout Statistics"
      : "Airline Starlink Tracker | United, Delta & All Airlines WiFi Rollout",
      
    siteDescription: isUnitedDomain
      ? "Track United Airlines and United Express Starlink WiFi installation progress. Live statistics showing percentage of the fleet equipped with SpaceX's Starlink internet."
      : "Track the rollout of SpaceX's Starlink WiFi on major airlines. See live statistics on United Airlines, Delta and more as they equip their fleets with high-speed satellite internet.",
      
    ogTitle: isUnitedDomain
      ? "United Airlines Starlink Tracker"
      : "Airline Starlink Tracker - United, Delta & More",
      
    ogDescription: isUnitedDomain
      ? "Live statistics showing United Airlines Starlink WiFi installation progress across mainline and express fleets."
      : "Live statistics tracking SpaceX's Starlink WiFi rollout across major airlines like United and Delta.",
      
    keywords: isUnitedDomain
      ? "United Airlines, Starlink, WiFi, Internet, SpaceX, Aircraft, Fleet, United Express, In-flight WiFi"
      : "Airlines, Starlink, WiFi, Internet, SpaceX, Aircraft, United, Delta, In-flight WiFi, Satellite Internet",
      
    analyticsUrl: isUnitedDomain
      ? "unitedstarlinktracker.com"
      : "airlinestarlinktracker.com",
      
    siteName: isUnitedDomain
      ? "United Airlines Starlink Tracker"
      : "Airline Starlink Tracker"
  };
}

// Security headers
export const SECURITY_HEADERS = {
  api: {
    "Content-Type": "application/json",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": 
      "default-src 'self' https://unpkg.com; connect-src 'self' https://analytics.martinamps.com; " + 
      "script-src 'self' 'unsafe-inline' https://unpkg.com https://analytics.martinamps.com; " + 
      "style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*;",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store, max-age=0"
  },
  html: {
    "Content-Type": "text/html",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": 
      "default-src 'self' https://unpkg.com; connect-src 'self' https://analytics.martinamps.com; " + 
      "script-src 'self' 'unsafe-inline' https://unpkg.com https://analytics.martinamps.com; " + 
      "style-src 'self' 'unsafe-inline'; img-src 'self' data:;",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
    "Referrer-Policy": "no-referrer"
  },
  notFound: {
    "Content-Type": "text/html",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:;",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
    "Referrer-Policy": "no-referrer"
  }
};

// File content types
export const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  webp: "image/webp",
  ico: "image/x-icon",
  webmanifest: "application/manifest+json",
  svg: "image/svg+xml",
  jpg: "image/jpeg",
  jpeg: "image/jpeg"
};