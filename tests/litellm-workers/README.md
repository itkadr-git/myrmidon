# OPE-6419 LiteLLM worker-resize load test

The driver sends aggregate constant-rate `POST /chat/completions` traffic while changing the worker target through the Myrmidon workers API. It calls `PUT /api/myrmidon/companies/:companyId/litellm/workers` for 2 -> 4 -> 2, checks that each response reports `applied: true` and the requested target, and records codes, latency, and errors per request. No direct Gunicorn signals are sent.

## Run

Run from this directory with Python 3.10+ and a test LiteLLM instance already configured to serve the `mock-gpt` model. The Myrmidon API credentials must be an authorized instance-admin token; the endpoint requires instance administration.

```sh
BASE_URL=http://127.0.0.1:4000 \
COMPANY_ID=<test-company-id> \
BOARD_API_URL=http://127.0.0.1:3100 \
BOARD_API_TOKEN="$MYRMIDON_TEST_ADMIN_TOKEN" \
DURATION=150 RPS=8 \
./run_load_test.sh
```

The test requests 2 workers at start, requests 4 at 20% of the duration, then requests 2 again at 50%; the remaining duration measures the final phase. Every response must report the expected target, `applied: true`, and `currentSource: "gateway"` with the expected current count; otherwise the run fails. `DURATION` must be at least 100 seconds so all three resize phases have a measurement window; requests use one shared schedule at aggregate configured `RPS`, not per-thread rates. All requests are launched at scheduled slots; the summary distinguishes planned attempts from completed requests and requires both counts to match. By default, detailed JSONL rows are written to `ope6419-results.jsonl` in the current working directory. Set `OUTPUT` to choose another writable path; its parent directory is created before the run. Summary JSON goes to stdout. The command exits nonzero on transport errors, any non-200 response, missing phase medians, below-target completed RPS, or an unconfirmed/failed resize. Resize API errors are captured in the final summary while the load phase continues, so the JSONL report is still written.

Use only disposable test instances and credentials. Do not pass production credentials or endpoints.

## Historical stand measurement

The prior task-thread run (before this API-based driver) reported 8 RPS for 150 seconds, 2,456 HTTP 200 responses, zero 5xx/timeouts/connection resets, and medians of 224 ms at two workers and 225 ms at four workers. That measurement used direct Gunicorn signals and is historical evidence only; it is not a result from this API-based driver.
