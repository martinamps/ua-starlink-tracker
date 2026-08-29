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
- `DD_VERSION=<git-hash>` (from the `SOURCE_COMMIT` build arg)
- `DD_TRACE_AGENT_HOSTNAME=host.docker.internal`

**Agent Setup:** The container connects to the Datadog agent on the Docker host via `host.docker.internal`. Run one agent on the host machine - no need for a sidecar per container.

### Building

Pass the commit hash as a build arg so `DD_VERSION` is tagged correctly:

```bash
docker build --build-arg SOURCE_COMMIT=$(git rev-parse --short HEAD) -t ua-starlink-tracker .
```

Most container platforms can inject the git SHA as a build arg automatically; set `DD_TRACE_ENABLED=true` in the runtime environment to enable APM.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DD_TRACE_ENABLED` | `false` | **Set this to `true` to enable tracing** |
| `DD_ENV` | `development` | Environment tag (set by Dockerfile in prod) |
| `DD_SERVICE` | `ua-starlink-tracker` | Service name (set by Dockerfile) |
| `DD_VERSION` | `unknown` | Version tag (from `SOURCE_COMMIT` build arg) |
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

### Data freshness & deadman monitoring

`src/scripts/data-freshness.ts` derives two gauges every 5 minutes from
`MAX(timestamp)` in the DB itself (not a ran-at heartbeat, so a loop that is
alive but writing nothing still ages):

- **`starlink.data.freshness_seconds`** — seconds since the last write, tagged
  `{job, dataset, airline}` (dataset mirrors job). Always emitted per airline;
  never monitor a cross-airline rollup of this gauge — the stalest airline
  masks the rest, and healthy cadences differ by orders of magnitude.
- **`starlink.data.freshness_ratio`** — the same age divided by a per-(job,
  airline) *deadman budget* (`DEADMAN_BUDGET_SEC` in data-freshness.ts).
  `> 1` means the pipeline is past the point where its loop must be dead.

The ratio exists because of cadence asymmetry: Hawaiian's verifier re-checks
each tail on a deliberate ~168h defer, so its healthy `freshness_seconds`
sawtooths up to ~604,800s — that sawtooth is *healthy*. A seconds threshold
tight enough for United (writes every few minutes) pages weekly on healthy
Hawaiian; one loose enough for Hawaiian hides a dead United verifier for a
week. Budgets encode each pipeline's own "definitely dead" age (verifier:
24h default, 14d for HA), so a single monitor covers everything:

```
max:starlink.data.freshness_ratio{*} by {dataset,airline} > 1
```

Creating that monitor is a Datadog-side task; the code guarantees the series
exist (tests/jobs.test.ts pins that every freshness query has a budget and
that every enabled airline surfaces in some freshness job).

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
