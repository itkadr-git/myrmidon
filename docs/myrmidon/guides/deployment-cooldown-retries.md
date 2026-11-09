# Deployment cooldown and HTTP 429 retries (bounded retry and wake suppression)

> Russian version: [deployment-cooldown-retries.ru.md](deployment-cooldown-retries.ru.md)

When an upstream model pool is exhausted or undergoing rate limiting, providers return deployment cooldown errors (e.g., LiteLLM router messages such as *"No deployments available"* or *"all deployments are in cooldown"*) or HTTP 429 Too Many Requests.

Previously, transient errors could trigger immediate continuation wakes or tight retry loops, burning run tokens and filling queues (for example, 141 consecutive failed runs during pool cooldown).

The system handles deployment cooldown and 429 errors through unified failure classification, `Retry-After` hint precedence, bounded exponential backoff with jitter and ceiling, and strict suppression of immediate wakeups.

## 1. Error recognition and classification

Errors are classified across the adapter and board retry layers:

### Adapter layer (Hermes Gateway)
- **Deployment pool cooldown:** Checked against `LITELLM_DEPLOYMENT_COOLDOWN_RE`:
  - `No deployments available`
  - `all deployments in cooldown`
  - `all deployments are in cooldown`
  - `All deployments for selected model are in cooldown`
  - `deployments in cooldown`
  When matched, the error is assigned `errorFamily: "provider_quota"`, sets `resultJson.cooldown: true`, and extracts `retryNotBefore` from the error payload or headers.
- **Generic HTTP 429:** When a 429 error occurs without the specific LiteLLM deployment cooldown wording, it is classified as `errorFamily: "transient_upstream"`. It extracts the `Retry-After` hint into `retryNotBefore`, but leaves `resultJson.cooldown` undefined.

### Board retry policy layer (`server/src/myrmidon/run-retry-policy`)
- Pattern `TRANSIENT_ERROR_MESSAGE_RE` detects deployment cooldown phrasing, `HTTP 429`, `too many requests`, and `rate_limit_error`.
- Classified as `classification: "transient"` (`reason: "transient_error_message"`), qualifying the failure for automatic bounded retry.

## 2. Priority of Retry-After hint

When scheduling a retry for a transient failure via `heartbeat.scheduleBoundedRetry`:

1. **Top precedence — explicit hint:** If `retryNotBefore` is provided (parsed from `Retry-After` HTTP header or error body) and represents a future timestamp:
   ```
   dueAt = retryNotBefore
   ```
   The board respects the provider's requested wait window directly instead of guessing.
2. **Fallback — exponential backoff:** If no `retryNotBefore` is present, the backoff schedule determines the delay:
   ```
   delay(attempt) = min(MYRMIDON_RUN_RETRY_MAX_DELAY_SEC, MYRMIDON_RUN_RETRY_BASE_DELAY_SEC × (MYRMIDON_RUN_RETRY_MULTIPLIER ^ (attempt - 1))) ± jitter
   ```

## 3. Bounded backoff, jitter, and ceilings

The retry parameters are governed by instance settings and environment variables:

| Setting / Variable | Default | Description |
|---|---|---|
| `MYRMIDON_RUN_RETRY_ENABLED` | `true` | Master switch for automatic run retries. |
| `MYRMIDON_RUN_RETRY_MAX_ATTEMPTS` | `3` | Maximum attempts for transient failures before giving up. |
| `MYRMIDON_RUN_RETRY_BASE_DELAY_SEC` | `60` | Base delay for the first attempt (in seconds). |
| `MYRMIDON_RUN_RETRY_MULTIPLIER` | `2` | Multiplier for exponential growth per attempt. |
| `MYRMIDON_RUN_RETRY_MAX_DELAY_SEC` | `1800` | Ceiling (cap) for delay (30 minutes). |
| `MYRMIDON_RUN_RETRY_JITTER_PERCENT` | `0` | Symmetric random jitter percentage (`±N%`) to prevent thundering herd. |

## 4. Absence of immediate wakeup

To prevent wake storms:
- The task is **not** immediately re-queued.
- Instead, exactly one run with status `scheduled_retry` is created with `dueAt` set to the future retry time.
- The task status remains `in_progress`, and its `executionRunId` points to the scheduled retry run.
- While the retry is scheduled, subsequent uncoordinated wakes for the same task are suppressed.
- When `dueAt` arrives, the scheduler promotes the run to `queued`.
- Upon successful execution after upstream recovery, normal task progress continues. If attempts are exhausted without recovery, the run is marked failed for operator inspection.
