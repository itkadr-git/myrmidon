# API Load Monitoring and Latency Alerting (1.6.6 OPE-9997)

Myrmidon includes an in-memory request latency journal (`server/src/myrmidon/monitoring/board-load/request-load.ts`) for tracking API route performance without external monitoring overhead.

## Monitored Routes and Middleware

The `boardLoadRequestMiddleware()` middleware captures duration, status code, and HTTP route for incoming requests. It is mounted on performance-critical endpoints:
- `POST /runtime-tools/github/credentials` (GitHub credential broker)
- `GET /api/companies/:companyId/issues` (Issue list endpoint)

## Metrics and Latency Alert

The latency journal computes rolling percentiles over configurable time windows:
- `p50Ms`: 50th percentile (median) duration in milliseconds.
- `p95Ms`: 95th percentile duration in milliseconds.
- `p99Ms`: 99th percentile duration in milliseconds.
- `maxMs`: maximum duration observed in milliseconds.
- `count`: total requests in the window.
- `errorCount`: total error responses (status >= 400).
- **`alert`**: boolean flag. Evaluated as `alert: p95Ms > 2000`. Set to `true` when the 95th percentile latency exceeds **2000 ms (2 seconds)**.

## Inspection API

Operators and health checks can query metrics via:
```http
GET /api/myrmidon/board-load/api-load?windowMs=60000&limit=50
```

### Parameters:
- `windowMs` (optional, default 60000): rolling time window in milliseconds.
- `limit` (optional, default 50): maximum number of route samples returned, sorted by descending `p95Ms`.

### Example Response:
```json
{
  "samples": [
    {
      "method": "GET",
      "route": "/api/companies/:companyId/issues",
      "count": 142,
      "errorCount": 0,
      "p50Ms": 45,
      "p95Ms": 180,
      "p99Ms": 350,
      "maxMs": 420,
      "alert": false
    }
  ]
}
```

## Operator Runbook: Handling Latency Alerts

When a route reports `alert: true` (`p95Ms > 2000`):

1. **Check Issue List Load**:
   - Verify whether callers are using `view=compact` and bounded limits (≤ 200).
   - Ensure the `issuesListAgentDefaults` instance setting is enabled.
2. **Check Credential Broker Load**:
   - Verify whether the in-memory GitHub credentials cache is active. If cache hit rates drop, verify GitHub App connection status.
3. **Database Performance**:
   - Check PostgreSQL CPU and query execution times for locks or table scans on `issues`.
