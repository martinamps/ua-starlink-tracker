// Check if the current domain is for United Airlines specific tracking
export function isUnitedDomain(hostname: string): boolean {
  return hostname.includes("unitedstarlinktracker");
}

// Database path
export const DB_PATH =
  process.env.NODE_ENV === "production"
    ? "/srv/ua-starlink-tracker/plane-data.sqlite" // Container path
    : "./plane-data.sqlite"; // Local path

// Page-specific content that changes based on the domain
export const PAGE_CONTENT = {
  pageTitle: {
    united: "United Airlines Starlink Tracker",
    generic: "Airline Starlink Tracker",
  },
  pageSubtitle: {
    united: "Tracking United Airlines aircraft with Starlink WiFi",
    generic: "Tracking major airlines' rollout of Starlink WiFi",
  },
  mainDescription: {
    pressReleaseUrl: "https://www.united.com/en/us/newsroom/announcements/cision-125370",
    united:
      "United Airlines began equipping its fleet with SpaceX's Starlink internet on March 7, 2025. The ultra-fast WiFi offers speeds up to 250 Mbps—50 times faster than previous systems. The airline plans to install Starlink on over 40 regional aircraft monthly, completing its entire two-cabin regional fleet by the end of 2025. Each installation takes only 8 hours, making it 10 times faster than previous systems, and the lightweight 85-pound equipment improves fuel efficiency compared to older 300-pound systems.",
  },
  fleetLabels: {
    mainline: "United Mainline Fleet",
    express: "United Express Fleet",
    combined: "Combined Fleet",
  },
};

// Domain-specific content mapping for HTML metadata
export function getDomainContent(host: string) {
  const unitedDomain = isUnitedDomain(host);

  return {
    siteTitle: unitedDomain
      ? "Which United Planes Have Starlink? | Live United Starlink Status Tracker"
      : "Airline Starlink Tracker | United, Delta & All Airlines WiFi Rollout",

    siteDescription: unitedDomain
      ? "Find out which United Airlines planes have Starlink WiFi. Live tracker showing United's Starlink status by aircraft, installation dates, and upcoming flights with high-speed internet."
      : "Track the rollout of SpaceX's Starlink WiFi on major airlines. See live statistics on United Airlines, Delta and more as they equip their fleets with high-speed satellite internet.",

    ogTitle: unitedDomain
      ? PAGE_CONTENT.pageTitle.united
      : "Airline Starlink Tracker - United, Delta & More",

    ogDescription: unitedDomain
      ? "Live statistics showing United Airlines Starlink WiFi installation progress across mainline and express fleets."
      : "Live statistics tracking SpaceX's Starlink WiFi rollout across major airlines like United and Delta.",

    keywords: unitedDomain
      ? "which united planes have starlink, united starlink status, United Airlines Starlink WiFi, united starlink tracker, united starlink rollout, E175 starlink, CRJ-550 starlink, united mainline starlink, united express starlink, check united flight starlink"
      : "Airlines, Starlink, WiFi, Internet, SpaceX, Aircraft, United, Delta, In-flight WiFi, Satellite Internet",

    analyticsUrl: unitedDomain ? "unitedstarlinktracker.com" : "airlinestarlinktracker.com",

    siteName: unitedDomain ? PAGE_CONTENT.pageTitle.united : PAGE_CONTENT.pageTitle.generic,
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
    "Cache-Control": "no-store, max-age=0",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
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
    "Referrer-Policy": "no-referrer",
  },
  notFound: {
    "Content-Type": "text/html",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy":
      "default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:;",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
    "Referrer-Policy": "no-referrer",
  },
};

// File content types
export const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  webp: "image/webp",
  ico: "image/x-icon",
  webmanifest: "application/manifest+json",
  svg: "image/svg+xml",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};
