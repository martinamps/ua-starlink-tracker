import fs from "node:fs";

// Security headers for API responses
export const API_SECURITY_HEADERS = {
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
};

// Security headers for HTML responses
export const HTML_SECURITY_HEADERS = {
  "Content-Type": "text/html",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": 
    "default-src 'self' https://unpkg.com; connect-src 'self' https://analytics.martinamps.com; " +
    "script-src 'self' 'unsafe-inline' https://unpkg.com https://analytics.martinamps.com; " +
    "style-src 'self' 'unsafe-inline'; img-src 'self' data:;",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "Referrer-Policy": "no-referrer"
};

// Not found headers
export const NOT_FOUND_HEADERS = {
  "Content-Type": "text/html",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:;",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "Referrer-Policy": "no-referrer"
};

// Simple in-memory rate limiting
const RATE_LIMIT = 30; // requests per minute
const RATE_WINDOW = 60 * 1000; // 1 minute in milliseconds
const ipRequests = new Map<string, { count: number; resetTime: number }>();

export function applyRateLimit(req: Request): { allowed: boolean; remaining: number } {
  // Get client IP (in production, you'd rely on X-Forwarded-For or similar)
  const ip = req.headers.get("x-forwarded-for") || "unknown";
  const now = Date.now();

  if (!ipRequests.has(ip)) {
    // First request from this IP
    ipRequests.set(ip, {
      count: 1,
      resetTime: now + RATE_WINDOW,
    });
    return { allowed: true, remaining: RATE_LIMIT - 1 };
  }

  const record = ipRequests.get(ip)!;

  // Reset if window has expired
  if (now > record.resetTime) {
    record.count = 1;
    record.resetTime = now + RATE_WINDOW;
    return { allowed: true, remaining: RATE_LIMIT - 1 };
  }

  // Increment and check
  record.count += 1;
  const remaining = Math.max(0, RATE_LIMIT - record.count);

  return {
    allowed: record.count <= RATE_LIMIT,
    remaining,
  };
}

// Clean up rate limit records periodically (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of ipRequests.entries()) {
    if (now > record.resetTime) {
      ipRequests.delete(ip);
    }
  }
}, 5 * 60 * 1000);

// Generate site metadata based on domain
export function getSiteMetadata(host: string) {
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
      : "airlinestarlinktracker.com"
  };
}

// Return HTML from template
export function renderHtml(templatePath: string, variables: Record<string, string>): string {
  try {
    let template = fs.readFileSync(templatePath, 'utf8');
    
    // Replace all variables
    for (const [key, value] of Object.entries(variables)) {
      const regex = new RegExp(`{{${key}}}`, 'g');
      template = template.replace(regex, value);
    }
    
    return template;
  } catch (error) {
    console.error("Error rendering HTML template:", error);
    return `<html><body>Error rendering page</body></html>`;
  }
}

// Generate 404 page HTML
export function getNotFoundHtml(): string {
  return `
  <!DOCTYPE html>
  <html lang="en">
    <head>
      <title>404 - Page Not Found | United Airlines Starlink Tracker</title>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <meta name="robots" content="noindex, nofollow" />
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif;
          text-align: center;
          padding: 50px;
          background-color: #f9f9f9;
          color: #333;
        }
        h1 { color: #0066cc; }
        a { color: #0066cc; text-decoration: none; }
        a:hover { text-decoration: underline; }
      </style>
    </head>
    <body>
      <h1>404 - Page Not Found</h1>
      <p>The page you're looking for doesn't exist.</p>
      <p><a href="/">Return to United Airlines Starlink Tracker</a></p>
    </body>
  </html>
  `;
}