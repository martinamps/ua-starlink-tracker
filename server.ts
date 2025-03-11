import React from "react";
import ReactDOMServer from "react-dom/server";
import path from "node:path";
import fs from "node:fs";
import Page from "./page";

// Import modules
import {
  initializeDatabase,
  updateStarlinkData,
  getTotalCount,
  getLastUpdated,
  getStarlinkPlanes,
  getFleetStats,
} from "./database";
import { getDomainContent, SECURITY_HEADERS, CONTENT_TYPES } from "./constants";

// Determine the static directory path based on environment
const STATIC_DIR =
  process.env.NODE_ENV === "production"
    ? "/app/static"
    : path.join(path.dirname(import.meta.url.replace("file://", "")), "static");

// Initialize database
const db = initializeDatabase();

// Get port from environment variable or use 3000 as default
const PORT = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3000;

// Log basic server info
console.log(
  `Server starting on port ${PORT}. Environment: ${
    process.env.NODE_ENV || "development"
  }`
);

// Initialize data
updateStarlinkData(db);

// Set an hourly interval to re-fetch and store the data
setInterval(() => {
  console.log("Running scheduled update...");
  updateStarlinkData(db);
}, 60 * 60 * 1000); // 1 hour

// Rate limiting setup
const RATE_LIMIT = 30; // requests per minute
const RATE_WINDOW = 60 * 1000; // 1 minute in milliseconds
const ipRequests = new Map<string, { count: number; resetTime: number }>();

// Helper to apply rate limits
function applyRateLimit(req: Request): { allowed: boolean; remaining: number } {
  const ip = req.headers.get("x-forwarded-for") || "unknown";
  const now = Date.now();

  if (!ipRequests.has(ip)) {
    ipRequests.set(ip, { count: 1, resetTime: now + RATE_WINDOW });
    return { allowed: true, remaining: RATE_LIMIT - 1 };
  }

  const record = ipRequests.get(ip)!;
  if (now > record.resetTime) {
    record.count = 1;
    record.resetTime = now + RATE_WINDOW;
    return { allowed: true, remaining: RATE_LIMIT - 1 };
  }

  record.count += 1;
  const remaining = Math.max(0, RATE_LIMIT - record.count);
  return { allowed: record.count <= RATE_LIMIT, remaining };
}

// Clean up rate limit records periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of ipRequests.entries()) {
    if (now > record.resetTime) {
      ipRequests.delete(ip);
    }
  }
}, 5 * 60 * 1000);

// Generate 404 page HTML
function getNotFoundHtml(host: string): string {
  const content = getDomainContent(host);

  return `
  <!DOCTYPE html>
  <html lang="en">
    <head>
      <title>404 - Page Not Found | ${content.siteName}</title>
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
      <p><a href="/">Return to ${content.siteName}</a></p>
    </body>
  </html>
  `;
}

// Read HTML template
const HTML_TEMPLATE = fs.readFileSync(
  path.join(path.dirname(import.meta.url.replace("file://", "")), "index.html"),
  "utf8"
);

// Fill HTML template with data
function renderHtml(
  template: string,
  variables: Record<string, string>
): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    const regex = new RegExp(`{{${key}}}`, "g");
    result = result.replace(regex, value);
  }
  return result;
}

// Bun server
Bun.serve({
  port: PORT,

  // Define static routes
  routes: {
    // Static files - directly serve using Bun.file with buffering
    "/favicon.ico": new Response(
      await Bun.file(path.join(STATIC_DIR, "favicon.ico")).bytes(),
      {
        headers: {
          "Content-Type": "image/x-icon",
          "Cache-Control": "public, max-age=86400",
        },
      }
    ),

    "/site.webmanifest": new Response(
      await Bun.file(path.join(STATIC_DIR, "site.webmanifest")).bytes(),
      {
        headers: {
          "Content-Type": "application/manifest+json",
          "Cache-Control": "public, max-age=86400",
        },
      }
    ),

    "/apple-touch-icon.png": new Response(
      await Bun.file(path.join(STATIC_DIR, "apple-touch-icon.png")).bytes(),
      {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400",
        },
      }
    ),

    "/android-chrome-192x192.png": new Response(
      await Bun.file(
        path.join(STATIC_DIR, "android-chrome-192x192.png")
      ).bytes(),
      {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400",
        },
      }
    ),

    "/android-chrome-512x512.png": new Response(
      await Bun.file(
        path.join(STATIC_DIR, "android-chrome-512x512.png")
      ).bytes(),
      {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400",
        },
      }
    ),

    "/favicon-16x16.png": new Response(
      await Bun.file(path.join(STATIC_DIR, "favicon-16x16.png")).bytes(),
      {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400",
        },
      }
    ),

    "/favicon-32x32.png": new Response(
      await Bun.file(path.join(STATIC_DIR, "favicon-32x32.png")).bytes(),
      {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400",
        },
      }
    ),

    "/static/social-image.webp": new Response(
      await Bun.file(path.join(STATIC_DIR, "social-image.webp")).bytes(),
      {
        headers: {
          "Content-Type": "image/webp",
          "Cache-Control": "public, max-age=86400",
        },
      }
    ),
    
    // API endpoint
    "/api/data": (req) => {
      // Apply rate limiting
      const rateLimit = applyRateLimit(req);
      if (!rateLimit.allowed) {
        return new Response(
          JSON.stringify({ error: "Rate limit exceeded. Try again later." }),
          {
            status: 429,
            headers: {
              ...SECURITY_HEADERS.api,
              "Retry-After": "60",
              "X-RateLimit-Limit": "30",
              "X-RateLimit-Remaining": "0",
              "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 60),
            },
          }
        );
      }

      // Only allow GET requests
      if (req.method !== "GET") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
          status: 405,
          headers: SECURITY_HEADERS.api,
        });
      }

      // Get data from database
      const totalCount = getTotalCount(db);
      const starlinkPlanes = getStarlinkPlanes(db);
      const lastUpdated = getLastUpdated(db);
      const fleetStats = getFleetStats(db);

      // Return response
      return new Response(
        JSON.stringify({ totalCount, starlinkPlanes, lastUpdated, fleetStats }),
        {
          headers: {
            ...SECURITY_HEADERS.api,
            "X-RateLimit-Limit": "30",
            "X-RateLimit-Remaining": String(rateLimit.remaining),
            "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 60),
          },
        }
      );
    },

    // Debug endpoint
    "/debug/files": (req) => {
      // Only allow in development or with special token
      const url = new URL(req.url);
      const token = url.searchParams.get("token");
      const isAuthorized =
        process.env.NODE_ENV !== "production" ||
        token === "starlink-tracker-debug-1a2b3c";

      if (!isAuthorized) {
        return new Response("Unauthorized", { status: 401 });
      }

      // Just return basic info
      const debugInfo = {
        environment: {
          nodeEnv: process.env.NODE_ENV,
          staticDir: STATIC_DIR,
        },
        database: {
          planes: getStarlinkPlanes(db).length,
          lastUpdated: getLastUpdated(db),
        },
      };

      return new Response(JSON.stringify(debugInfo, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    },
  },

  // Main request handler for home page and fallbacks
  fetch(req) {
    const url = new URL(req.url);
    const host = req.headers.get("host") || "unitedstarlinktracker.com";

    // Home page
    if (url.pathname === "/") {
      // Apply rate limiting
      const rateLimit = applyRateLimit(req);
      if (!rateLimit.allowed) {
        return new Response("Too many requests. Please try again later.", {
          status: 429,
          headers: { "Content-Type": "text/plain", "Retry-After": "60" },
        });
      }

      // Only allow GET requests
      if (req.method !== "GET") {
        return new Response("Method not allowed", {
          status: 405,
          headers: { "Content-Type": "text/plain" },
        });
      }

      // Get data from database
      const totalCount = getTotalCount(db);
      const starlinkPlanes = getStarlinkPlanes(db);
      const lastUpdated = getLastUpdated(db);
      const fleetStats = getFleetStats(db);

      // Render React component to HTML
      const reactHtml = ReactDOMServer.renderToString(
        React.createElement(Page, {
          total: totalCount,
          starlink: starlinkPlanes,
          lastUpdated,
          fleetStats,
        })
      );

      // Get domain-specific content
      const metadata = getDomainContent(host);

      // Fill template with variables
      const htmlVariables = {
        ...metadata,
        html: reactHtml,
        host,
      };

      const html = renderHtml(HTML_TEMPLATE, htmlVariables);
      return new Response(html, { headers: SECURITY_HEADERS.html });
    }

    // Try to serve static files with direct path mapping
    if (url.pathname.startsWith("/static/")) {
      const subPath = url.pathname.replace(/^\/static\//, "");
      const filePath = path.join(STATIC_DIR, subPath);

      try {
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const ext = path.extname(filePath).toLowerCase().substring(1);
          const contentType = CONTENT_TYPES[ext] || "application/octet-stream";

          return new Response(Bun.file(filePath), {
            headers: {
              "Content-Type": contentType,
              "Cache-Control": "public, max-age=86400",
            },
          });
        }
      } catch (error) {
        console.error(`Error serving static file ${filePath}:`, error);
      }
    }

    // 404 page for everything else
    return new Response(getNotFoundHtml(host), {
      status: 404,
      headers: SECURITY_HEADERS.notFound,
    });
  },
});

console.log(`Server running at http://localhost:${PORT}`);
