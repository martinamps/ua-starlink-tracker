import React from "react";
import ReactDOMServer from "react-dom/server";
import path from "node:path";
import fs from "node:fs";
import Page from "./page";

// Import modules
import {
  initializeDatabase,
  updateDatabase,
  getTotalCount,
  getLastUpdated,
  getStarlinkPlanes,
  getFleetStats,
} from "./database";
import {
  getDomainContent,
  SECURITY_HEADERS,
  CONTENT_TYPES,
  isUnitedDomain,
} from "./constants";
import { getNotFoundHtml } from "./not-found";
import { fetchAllSheets } from "./utils";

// Environment configuration
const STATIC_DIR =
  process.env.NODE_ENV === "production"
    ? "/app/static"
    : path.join(path.dirname(import.meta.url.replace("file://", "")), "static");
const PORT = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3000;
const HTML_TEMPLATE = fs.readFileSync(
  path.join(path.dirname(import.meta.url.replace("file://", "")), "index.html"),
  "utf8"
);

// Initialize database
const db = initializeDatabase();

// Log startup info
console.log(
  `Server starting on port ${PORT}. Environment: ${
    process.env.NODE_ENV || "development"
  }`
);

// Data update function
async function updateStarlinkData() {
  try {
    const { totalAircraftCount, starlinkAircraft, fleetStats } =
      await fetchAllSheets();

    updateDatabase(db, totalAircraftCount, starlinkAircraft, fleetStats);

    console.log(
      `Updated data: ${starlinkAircraft.length} Starlink aircraft out of ${totalAircraftCount} total`
    );
    return {
      total: totalAircraftCount,
      starlinkCount: starlinkAircraft.length,
    };
  } catch (err) {
    console.error("Error updating starlink data:", err);
    return { total: 0, starlinkCount: 0 };
  }
}

// Initialize data and schedule updates
updateStarlinkData();
setInterval(() => {
  console.log("Running scheduled update...");
  updateStarlinkData();
}, 60 * 60 * 1000); // 1 hour

// HTML template rendering
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

// Static files configuration
const staticFiles = [
  {
    path: "/favicon.ico",
    filename: "favicon.ico",
    contentType: "image/x-icon",
  },
  {
    path: "/site.webmanifest",
    filename: "site.webmanifest",
    contentType: "application/manifest+json",
  },
  {
    path: "/apple-touch-icon.png",
    filename: "apple-touch-icon.png",
    contentType: "image/png",
  },
  {
    path: "/android-chrome-192x192.png",
    filename: "android-chrome-192x192.png",
    contentType: "image/png",
  },
  {
    path: "/android-chrome-512x512.png",
    filename: "android-chrome-512x512.png",
    contentType: "image/png",
  },
  {
    path: "/favicon-16x16.png",
    filename: "favicon-16x16.png",
    contentType: "image/png",
  },
  {
    path: "/favicon-32x32.png",
    filename: "favicon-32x32.png",
    contentType: "image/png",
  },
  {
    path: "/static/social-image.webp",
    filename: "social-image.webp",
    contentType: "image/webp",
  },
];

// Generate routes
const routes: Record<string, Response | ((req: Request) => Response)> = {};

// Add static file routes
for (const file of staticFiles) {
  routes[file.path] = new Response(
    await Bun.file(path.join(STATIC_DIR, file.filename)).bytes(),
    {
      headers: {
        "Content-Type": file.contentType,
        "Cache-Control": "public, max-age=86400",
      },
    }
  );
}

// API endpoint
routes["/api/data"] = (req) => {
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: SECURITY_HEADERS.api,
    });
  }

  const totalCount = getTotalCount(db);
  const starlinkPlanes = getStarlinkPlanes(db);
  const lastUpdated = getLastUpdated(db);
  const fleetStats = getFleetStats(db);

  return new Response(
    JSON.stringify({ totalCount, starlinkPlanes, lastUpdated, fleetStats }),
    {
      headers: SECURITY_HEADERS.api,
    }
  );
};

// Debug endpoint
routes["/debug/files"] = (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  const isAuthorized =
    process.env.NODE_ENV !== "production" ||
    token === "starlink-tracker-debug-1a2b3c";

  if (!isAuthorized) {
    return new Response("Unauthorized", { status: 401 });
  }

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
};

// Start server
Bun.serve({
  port: PORT,
  routes,

  fetch(req) {
    const url = new URL(req.url);
    const host = req.headers.get("host") || "unitedstarlinktracker.com";

    // Home page
    if (url.pathname === "/") {
      if (req.method !== "GET") {
        return new Response("Method not allowed", {
          status: 405,
          headers: { "Content-Type": "text/plain" },
        });
      }

      const totalCount = getTotalCount(db);
      const starlinkPlanes = getStarlinkPlanes(db);
      const lastUpdated = getLastUpdated(db);
      const fleetStats = getFleetStats(db);

      const reactHtml = ReactDOMServer.renderToString(
        React.createElement(Page, {
          total: totalCount,
          starlink: starlinkPlanes,
          lastUpdated,
          fleetStats,
          isUnited: isUnitedDomain(host),
        })
      );

      const metadata = getDomainContent(host);
      const htmlVariables = {
        ...metadata,
        html: reactHtml,
        host,
      };

      const html = renderHtml(HTML_TEMPLATE, htmlVariables);
      return new Response(html, { headers: SECURITY_HEADERS.html });
    }

    // Static files
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

    // 404 page
    return new Response(getNotFoundHtml(host), {
      status: 404,
      headers: SECURITY_HEADERS.notFound,
    });
  },
});

console.log(`Server running at http://localhost:${PORT}`);