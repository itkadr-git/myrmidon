# LiteLLM workers runtime scale test

Part C verification rig for OPE-5391 (1.6.6 LITELLM-WORKERS). It reproduces,
in repository form, the QA stand run from 2026-10-11 (Paperclip comment
`5e2f884c` on OPE-6419): change the LiteLLM worker count from the board UI
while the gateway is under load, and prove there were zero dropped requests.

The rig targets the **Myrmidon runtime services** (the `litellm-gateway`
container and the Myrmidon API),not the Paperclip control plane. Run it on a
disposable stand where the feature branch image is deployed, never against a
shared or production instance.

## Layout

- `run.sh` — end-to-end orchestration: health preflight, baseline load sample
  through the gateway, worker-count change 2 -> N -> 2 through the real API
  the Gateway Workers tab uses, load through the change, median report.
- `load-test.mjs` — paced parallel HTTP load generator against the LiteLLM
  gateway (`/v1/chat/completions` with `--model`, or plain GETs without),
  with per-request latency capture and 5xx/timeout/drop accounting.
  Node 20+, no dependencies.
- `change-workers.mjs` — performs the worker-count change through the same
  REST contract the Gateway Workers tab calls (`GET/PUT
  /api/myrmidon/companies/:companyId/litellm/workers` with `{ target }`),
  polls the view's `current` until the applied pool size matches, and
  reports the settle time.

## Contract under test

The backend contract from part A (server/src/myrmidon/litellm-workers/):

- `GET /api/myrmidon/companies/:companyId/litellm/workers` returns the
  stored target, the two ceilings, and the live pool size (`current`,
  null while no source knows it).
- `PUT` with `{ "target": N }` stores the target and moves the running
  pool to it with TTIN/TTOU signals to the gunicorn master — no restart,
  no dropped request. A target above the memory ceiling is a 400.

## Prerequisites

- A disposable stand running the `rel/1.6.5-rc.7` feature image (or a
  successor) with the LiteLLM gateway enabled.
- `BOARD_URL` reachable from the machine running the rig, e.g.
  `http://127.0.0.1:3100`.
- The LiteLLM gateway reachable at `LITELLM_URL` (default
  `http://127.0.0.1:4000`); export `LITELLM_KEY` and `LITELLM_MODEL` to
  drive real chat-completion load instead of plain GETs.
- An instance-admin board API key, exported as `BOARD_API_KEY` (the rig
  never prints it).
- Node 20+ and curl.

## Run

```sh
BOARD_URL=http://127.0.0.1:3100 \
BOARD_API_KEY=$PAPERCLIP_API_KEY \
STAND_COMPANY_ID=<company-id> \
LITELLM_URL=http://127.0.0.1:4000 \
LITELLM_MODEL=<model-name> \
bash tests/litellm-workers/run.sh
```

Environment knobs:

- `STAND_COMPANY_ID` (required) — company whose LiteLLM workers to drive.
- `LITELLM_URL` / `LITELLM_KEY` / `LITELLM_MODEL` — gateway load target;
  without a model the load is plain GETs to the gateway.
- `TARGET` — worker count to scale to during load. Default `4`.
- `DURATION_S` — seconds of load per phase. Default `60`.
- `CONCURRENCY` — parallel in-flight requests. Default `6`.
- `P95_MS` — per-request latency budget used for the load verdict.
  Default `20000`.
- `LOG_DIR` — where to write run artifacts. Default `./test-results/litellm-workers`.

Exit status is non-zero if any request failed (connection error, timeout,
or HTTP >= 500) or the median of the post-change phase exceeds the
pre-change median by more than `P95_MS` ms (tolerance for slow models).

## Reading the output

`run.sh` prints a phase table and writes the same data to
`$LOG_DIR/report.md` and `$LOG_DIR/report.json`:

- requests, failures (5xx/timeout/connection dropped), failure rate;
- median and p95 latency per phase (baseline / during-change / after);
- the worker settle time for each change (2 -> 4 and 4 -> 2).

The QA stand run of 2026-10-11 produced 2456/2456 HTTP 200, 0 failures,
TTIN/TTOU 2 -> 4 -> 2 confirmed with settle times of 11 s and 8 s, and
medians of 3.1 s / 3.0 s / 3.2 s. Any re-run on a comparable stand should
reproduce zero dropped requests.
