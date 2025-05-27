import { getDomainContent } from "./constants";

/**
 * Generates a 404 Not Found HTML page with domain-specific content
 */
export function getNotFoundHtml(host: string): string {
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
          margin: 0;
        }
        h1 { color: #0066cc; }
        a { color: #0066cc; text-decoration: none; }
        a:hover { text-decoration: underline; }
        .container {
          max-width: 600px;
          margin: 0 auto;
          padding: 40px 20px;
          background-color: white;
          border-radius: 12px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.1);
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>404 - Page Not Found</h1>
        <p>The page you're looking for doesn't exist.</p>
        <p><a href="/">Return to ${content.siteName}</a></p>
      </div>
    </body>
  </html>
  `;
}