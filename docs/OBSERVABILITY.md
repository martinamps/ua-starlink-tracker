# Observability

This document describes the Datadog APM integration for the UA-Starlink-Tracker application.

## Overview

The application uses [dd-trace](https://github.com/DataDog/dd-trace-js) to provide:
- **JSON structured logging** with trace correlation
- **Custom metrics** (counters and gauges) via DogStatsD
- **APM tracing** with manual spans for background jobs and HTTP requests

## Bun Compatibility

dd-trace works with Bun v1.1.6+ but with important limitations:

| Feature | Status | Notes |
|---------|--------|-------|
| Manual tracing (`tracer.trace()`) | ✅ Works | Use the `withSpan` helper |
| DogStatsD metrics | ✅ Works | Use `metrics.increment()`, `metrics.gauge()` |
| Log injection | ✅ Works | Automatic trace ID injection in JSON logs |
| Automatic instrumentation | ❌ Does not work | ESM import hooks not supported |
| Profiling | ❌ Must disable | Set `profiling: false` |
| Runtime metrics | ❌ Must disable | Set `runtimeMetrics: false` |

## Configuration

### Docker (Production)

The Dockerfile pre-configures most Datadog settings. You only need to enable tracing:

```bash
docker run -e DD_TRACE_ENABLED=true ...
```

The Dockerfile sets these automatically:
- `DD_ENV=production`
- `DD_SERVICE=ua-starlink-tracker`
- `DD_VERSION=<git-hash>` (from Coolify's `SOURCE_COMMIT` build arg)
- `DD_TRACE_AGENT_HOSTNAME=host.docker.internal`

**Agent Setup:** The container connects to the Datadog agent on the Docker host via `host.docker.internal`. Run one agent on the host machine - no need for a sidecar per container.

### Coolify Setup

1. Enable `SOURCE_COMMIT` in your app settings (it's excluded from Docker builds by default to preserve cache)
2. Add `DD_TRACE_ENABLED=true` to your environment variables

See [Coolify Environment Variables](https://coolify.io/docs/knowledge-base/environment-variables) for all available build args.

**Manual builds:** If not using Coolify, pass the commit hash manually:
```bash
docker build --build-arg SOURCE_COMMIT=$(git rev-parse --short HEAD) -t ua-starlink-tracker .
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DD_TRACE_ENABLED` | `false` | **Set this to `true` to enable tracing** |
| `DD_ENV` | `development` | Environment tag (set by Dockerfile in prod) |
| `DD_SERVICE` | `ua-starlink-tracker` | Service name (set by Dockerfile) |
| `DD_VERSION` | `unknown` | Version tag (set automatically from Coolify's `SOURCE_COMMIT`) |
| `DD_TRACE_AGENT_HOSTNAME` | `localhost` | Agent hostname (set by Dockerfile to `host.docker.internal`) |
| `DD_TRACE_AGENT_PORT` | `8126` | APM trace agent port |
| `DD_DOGSTATSD_PORT` | `8125` | DogStatsD metrics port |

## Metrics Reference

All metrics are prefixed with `starlink.` for easy filtering in Datadog.

### Counters (Low Cardinality Tags)

| Metric | Tags | Description |
|--------|------|-------------|
| `starlink.scraper.sync` | `source:spreadsheet\|fr24` | Sync operation completed |
| `starlink.planes.discovered` | `source:spreadsheet\|fr24` | New plane discovered |
| `starlink.planes.starlink_detected` | - | Starlink WiFi detected on a plane |
| `starlink.verification.check` | `result:success\|error` | Verification attempt |
| `starlink.verification.mismatch` | - | Spreadsheet/United.com WiFi mismatch |
| `starlink.vendor.request` | `vendor:flightaware\|fr24\|united`, `type:flights\|fleet\|verification`, `status:success\|rate_limited\|error` | External API call |
| `starlink.http.request` | `method`, `route`, `status_code` | HTTP request served (known routes only) |

### Route Allowlist (Important for `http.request` Metric)

To prevent cardinality explosion from bots and scrapers hitting random URLs, the `http.request` metric only emits for known routes. Unknown routes (404s) are traced but **not** counted in metrics.

**Allowlisted routes (max 25):**
- `/` - Home page
- `/api/data` - Main data API
- `/api/check-flight` - Flight check API
- `/api/mismatches` - Verification mismatches API
- `/api/fleet-discovery` - Fleet discovery stats API
- `/sitemap.xml` - Sitemap
- `/robots.txt` - Robots file
- `/debug/files` - Debug endpoint
- `/static/*` - Static assets (grouped)

To add a new route, update the `KNOWN_ROUTES` set in `server.ts`. Keep the total under 25 to maintain reasonable cardinality.

### Gauges

| Metric | Description |
|--------|-------------|
| `starlink.planes.total` | Total tracked planes |
| `starlink.planes.verified_starlink` | Verified Starlink-equipped count |
| `starlink.planes.pending` | Planes pending verification |

## Tracing

### Span Names

Background job spans:
- `scraper.update_data` - Hourly spreadsheet scrape and database update
- `flight_updater.run` - Flight data update cycle (trickle, every 30s)
- `flight_updater.update_tail` - Single tail number update
- `flight_updater.check_new_planes` - Check flights for newly discovered planes
- `starlink_verifier.run` - Verification batch cycle
- `starlink_verifier.verify_plane` - Single plane verification
- `fleet_sync.run` - FR24 fleet sync cycle (daily)
- `fleet_sync.fr24` - FR24 scrape operation
- `fleet_discovery.run` - Discovery batch cycle
- `fleet_discovery.verify_plane` - Single plane discovery check

HTTP spans:
- `http.request` - All incoming HTTP requests (API routes and home page)

### Common Tags

All spans include these tags where applicable:
- `tail_number` - Aircraft tail number
- `flight_number` - Flight number (e.g., UA123)
- `route` - Origin-destination (e.g., SFO-LAX)
- `result` - Outcome (success, error, starlink, not_starlink)
- `error` - Error flag on failures

## Local Development

### Testing Without Datadog Agent

The tracer gracefully handles missing agents. To verify the integration works:

1. Enable tracing temporarily:
   ```bash
   DD_TRACE_ENABLED=true bun run dev
   ```

2. Look for startup logs:
   ```
   dd-trace initialized (not connected to agent)
   ```

3. Check JSON logs have trace fields:
   ```json
   {
     "timestamp": "2024-01-01T00:00:00.000Z",
     "level": "info",
     "logger": "server",
     "message": "Server running at http://localhost:3000",
     "dd": {
       "trace_id": "1234567890",
       "span_id": "0987654321"
     }
   }
   ```

4. Set back to false:
   ```bash
   DD_TRACE_ENABLED=false
   ```

### Viewing Logs

Logs are written to `logs/app.log` in JSON format:

```bash
tail -f logs/app.log | jq .
```

## Usage Examples

### Adding Metrics

```typescript
import { metrics, COUNTERS } from "../observability";

// Increment a counter
metrics.increment(COUNTERS.VERIFICATION_CHECK, { result: "success" });

// Set a gauge
metrics.gauge("planes.total", 150);

// Record a histogram value
metrics.histogram("request.duration", 125);
```

### Adding Spans

```typescript
import { withSpan } from "../observability";

// Wrap async operations with tracing
async function fetchData() {
  return withSpan("my_operation.fetch", async (span) => {
    span.setTag("custom_tag", "value");
    const result = await doWork();
    span.setTag("result.count", result.length);
    return result;
  });
}

// For background jobs, use withSpan with job.type tag
async function runBackgroundJob() {
  await withSpan(
    "my_job.run",
    async (span) => {
      span.setTag("job.type", "background");
      await doWork();
      span.setTag("result", "success");
    },
    { "job.type": "background" }
  );
}
```

## Troubleshooting

### "Cannot connect to agent" Errors

This is expected when `DD_TRACE_ENABLED=true` but no agent is running. The tracer continues to work and logs traces, but they won't be sent anywhere. This is safe for local development.

### High Memory Usage

If you see memory issues with dd-trace:
1. Ensure `profiling: false` is set
2. Ensure `runtimeMetrics: false` is set
3. Consider reducing sampling rate in production

### Logs Not Showing Trace IDs

Trace IDs only appear when there's an active span. Background logs during startup won't have trace context.

### Bun Crash on Import

If Bun crashes when importing dd-trace:
1. Update Bun to v1.1.6 or later: `bun upgrade`
2. Ensure the tracer is imported first in `server.ts`
3. Check that profiling and runtimeMetrics are disabled
