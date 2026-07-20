import type { PageBrand } from "../airlines/registry";

/**
 * 404 for /check-flight/{fn} permalinks with no data behind them. A hard 404
 * (not a soft-404 200) so unknown flight numbers drop out of the index instead
 * of accumulating as thin pages; still helpful for a human who typo'd.
 * flightNumber is pre-validated (^[A-Z]{2}\d{1,4}$) — nothing to escape.
 */
export function getFlightNotFoundHtml(brand: PageBrand, flightNumber: string): string {
  return `
  <!DOCTYPE html>
  <html lang="en">
    <head>
      <title>No data for ${flightNumber} | ${brand.title}</title>
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
        <h1>We don't have data for ${flightNumber}</h1>
        <p>That flight number isn't in our schedule or route history — double-check the number, or look one up:</p>
        <p><a href="/check-flight">Check a flight →</a></p>
        <p><a href="/">Return to ${brand.title}</a></p>
      </div>
    </body>
  </html>
  `;
}

/**
 * Generates a 404 Not Found HTML page with brand-specific content
 */
export function getNotFoundHtml(brand: PageBrand): string {
  return `
  <!DOCTYPE html>
  <html lang="en">
    <head>
      <title>404 - Page Not Found | ${brand.title}</title>
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
        <p><a href="/">Return to ${brand.title}</a></p>
      </div>
    </body>
  </html>
  `;
}
