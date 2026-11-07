## settings-en-new

<!-- after: 1.6.6 — MONITORING D: alert recovery -->
### 1.6.6 — AUTH-401-BURST: product-side burst metric and board signal (OPE-11890)

The product-side replacement for the host `paperclip-auth-401-watch` timer:
the error handler records every 401 it emits into an in-process sliding-window
detector (`server/src/myrmidon/auth-401-burst/metrics.ts`); when the per-window
count crosses the threshold the detector latches `tripped`, which the metrics
self-check renders as the `myrmidon_auth_401_burst_*` Prometheus families and
the attention registry surfaces as a board signal
(`server/src/myrmidon/auth-401-burst/attention.ts`). Only the closed
`req.actorNoneReason` taxonomy becomes a label — the raw Authorization header,
token or key never enters the counter, the latch, or any log line.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_AUTH_401_BURST_THRESHOLD` | 1.6.6-AUTH-401-BURST | `20` | How many 401 responses inside one sliding window trip the burst latch (the `myrmidon_auth_401_burst_tripped` gauge goes to 1 and the board signal opens) | A non-integer, `0`, negative or above 100000 — the default |
| `MYRMIDON_AUTH_401_BURST_WINDOW_SEC` | 1.6.6-AUTH-401-BURST | `60` | Width of the sliding window in seconds: 401s older than the window are pruned before the count is compared with the threshold | A non-numeric, `0`, negative value or above 3600 — the default |
