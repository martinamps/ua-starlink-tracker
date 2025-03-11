import * as fs from "node:fs";
import * as path from "node:path";

// Map file extensions to content types for static files
export const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  webp: "image/webp",
  ico: "image/x-icon",
  webmanifest: "application/manifest+json",
  svg: "image/svg+xml",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

// Determine the static directory based on environment
export const STATIC_DIR = process.env.NODE_ENV === 'production' 
  ? '/app/static'   // Production (Docker) path
  : path.join(path.dirname(import.meta.url.replace('file://', '')), 'static');  // Development path

// Simple handler for static files using the determined static directory path
export function createStaticFileHandler(filename: string, contentType: string) {
  return (req: Request) => {
    const filePath = path.join(STATIC_DIR, filename);
    
    try {
      // Check if file exists
      if (fs.existsSync(filePath)) {
        return new Response(Bun.file(filePath), {
          headers: {
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=86400",
          },
        });
      }
      
      return new Response(`File not found`, { status: 404 });
    } catch (error) {
      console.error(`Error serving ${filename}:`, error);
      return new Response("Error serving file", { status: 500 });
    }
  };
}

// Catch-all handler for static files
export function staticFileHandler(req: Request) {
  // Extract the filename from the URL path
  const url = new URL(req.url);
  const requestPath = url.pathname;
  const subPath = requestPath.replace(/^\/static\//, "");
  
  // Determine full file path in our static directory
  const filePath = path.join(STATIC_DIR, subPath);
  
  // Determine content type based on file extension
  const ext = path.extname(requestPath).toLowerCase().substring(1);
  const contentType = CONTENT_TYPES[ext] || "application/octet-stream";
  
  try {
    // Check if file exists
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return new Response(Bun.file(filePath), {
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=86400",
        },
      });
    }
    
    return new Response(`File not found`, { status: 404 });
  } catch (error) {
    console.error(`Error serving static file:`, error);
    return new Response("Error serving file", { status: 500 });
  }
}

// Static file fallback handler for main fetch method
export function tryServeStaticFile(requestPath: string): Response | null {
  if (requestPath.startsWith("/static/") || 
      requestPath.endsWith(".png") || 
      requestPath.endsWith(".ico") || 
      requestPath.endsWith(".webmanifest")) {
    
    // Determine the file path relative to the static directory
    const fileName = path.basename(requestPath);
    let filePath;
    
    if (requestPath.startsWith("/static/")) {
      const subPath = requestPath.replace(/^\/static\//, "");
      filePath = path.join(STATIC_DIR, subPath);
    } else {
      filePath = path.join(STATIC_DIR, fileName);
    }
    
    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        // Determine content type
        const ext = path.extname(fileName).toLowerCase().substring(1);
        const contentType = CONTENT_TYPES[ext] || "application/octet-stream";
        
        return new Response(Bun.file(filePath), {
          headers: {
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=86400",
          },
        });
      }
    } catch (error) {
      console.error(`Error serving file:`, error);
    }
  }
  
  return null;
}