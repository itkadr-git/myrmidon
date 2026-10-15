# LLM tracing: how the pipeline works, where the data lives, how to verify it (TRACING-HEALTH)

> Russian version: [tracing.ru.md](tracing.ru.md)

Myrmidon traces every LLM call that agents make through the platform's LLM
gateway (LiteLLM) into Langfuse v4. This guide is the map of the whole tracing
surface: how the events flow, where they are stored, and the four
independent checks that prove the pipeline is alive. It links the per-part
docs together: the board surfaces live in
[tracing-health.md](tracing-health.md), the deploy-time guard in
[../deploy.md](../deploy.md) (step 7b), the live contract test in
[../../docker/tracing/README.md](../../../docker/tracing/README.md), and the
`MYRMIDON_TRACING_*` variables in [../SETTINGS.md](../SETTINGS.md).

## How tracing works

The pipeline is one direction, no second path:

```
agent run → LiteLLM gateway → OTLP export → Langfuse v4 (events_only mode)
            → ClickHouse table `events_core`
```

- The gateway exports every completion over **OTLP** (OpenTelemetry protocol)
  to Langfuse. The only accepted gateway callback is `langfuse_otel`; the
  accepted list lives in one place — `tracing_intended_callbacks()` in
  `scripts/myrmidon/deploy/lib.sh` — and the gateway config, the deploy guard
  and the contract test all render from it.
- Langfuse v4 runs in the `events_only` write mode: it accepts OTLP events and
  writes them to ClickHouse. The **legacy** `/api/public/ingestion` endpoint
  is rejected by design. The legacy `langfuse` callback keeps sending exactly
  that rejected format: on a v4 server this produces ~12k "Bad request"
  rejections per hour and burns gateway CPU while everything else looks
  healthy — that is the incident class (02.10) the whole track exists to
  catch. The deploy guard refuses a legacy callback on a v4 server; it does
  not merely warn.

## Where the data lives

In ClickHouse, table `events_core` — **not** in the Langfuse `traces` /
`observations` tables. Those stay empty in v4 `events_only` mode *by design*:
a naive "the traces table is empty, so tracing is broken" conclusion is the
exact mistake of the 02.10 incident. The companion table
`langfuse_ingestion_rejections` counts rejected legacy-format events; any
value above zero in a window means a legacy producer is still talking to the
stack.

## How to verify it

Four surfaces answer "is tracing alive", each at its own layer. They agree
because they all read the same two counts: OTEL events in `events_core` and
gateway requests in the LiteLLM spend log.

### The health endpoint (board server)

`GET /api/myrmidon/tracing/health` computes the state from five evidence
probes over a sliding window (`MYRMIDON_TRACING_WINDOW_SEC`, default 900 s —
15 min): `eventsInWindow`, `gatewayRequestsInWindow`, `deliveryRatio`
(events per request), `callbackErrorRate`, `legacyRejections`. The report is
cached for `MYRMIDON_TRACING_HEALTH_TTL_SEC` (default 60 s), and any probe
failure degrades to the state `unknown` with a reason — never a 500. The
endpoint answers 503 with `enabled: false` until the tracing settings
(`MYRMIDON_TRACING_CLICKHOUSE_*` plus the two `MYRMIDON_LITELLM_*` gateway
settings) are all set.

| State | Meaning |
|---|---|
| `ok` | Traffic flowed in the window, events landed in `events_core`, the callback error rate is below 0.02 |
| `idle` | The gateway served no traffic in the window — a quiet period, not an alarm |
| `degraded` | Tracing is lost while traffic flowed: no events at all, a delivery ratio below 0.5, any legacy ingestion rejection, or a callback error rate at or above 0.02 |
| `unknown` | A probe failed — the check itself cannot see the pipeline |

### The board surfaces

The same report feeds two operator surfaces: the read-only "LLM tracing" card
in Company settings, and the attention signal — one deduplicated card
(`tracing_health:llm-tracing`) raised on the operator desk by a periodic sweep
(`MYRMIDON_TRACING_SIGNAL_INTERVAL_SEC`, default 300 s). The signal goes to
the operator role, never the task owner; a steady state writes one activity
row per transition only. States, severity mapping and the journal are in
[tracing-health.md](tracing-health.md).

### The deploy guard

`scripts/myrmidon/deploy/tracing-check.sh` runs as step 7b of the deploy
([../deploy.md](../deploy.md)) and refuses the deploy on three checks, each
skipped only when its own settings are absent:

1. **Callback set** — the effective gateway callbacks (config file plus the
   live command, their union) must equal the intended OTLP-only list; a
   legacy callback is refused while the server is v4 or its version cannot be
   proven.
2. **Delivery ratio** — `MYRMIDON_TRACING_DELIVERY_COMMAND` prints the
   `events_core` OTEL count and the gateway request count over the window;
   zero events with traffic, a ratio below 50 %, or unreadable counts are
   refused.
3. **Image pins** — `MYRMIDON_TRACING_LANGFUSE_IMAGE` and
   `MYRMIDON_TRACING_GATEWAY_IMAGE` must carry a full `X.Y.Z` tag or a digest;
   a major/minor tag such as `langfuse/langfuse:4` is refused.

A refusal fails the deploy like a failed health check; there is no skip flag.
The variable-by-variable contract is in [../SETTINGS.md](../SETTINGS.md)
(sections 1.5 and TRACING-HEALTH).

### The live contract test

`docker/tracing/tracing-contract-check.sh` starts the real stack from
`docker/tracing/docker-compose.contract.yml` (LiteLLM + Langfuse v4 +
ClickHouse, exact pinned images), sends exactly one completion through the
gateway and asserts the contract from both sides: exactly one trace with one
model call in `events_core` (one `SPAN` + one `GENERATION` row), zero
ingestion rejections in the Langfuse logs, and every event arrived with
`source = 'otel'`. The live lane is opt-in — it needs `TRACING_CONTRACT_LIVE=1`
and a reachable docker daemon; without either it skips cleanly. The static
assertions (pins, loopback-only ports, OTLP-only callback list) run in CI; the
dedicated live CI job is not wired yet, so the live lane currently runs
wherever the variable and a daemon are provided. Details:
[../../docker/tracing/README.md](../../../docker/tracing/README.md).

## The pinned pair

Langfuse web, the Langfuse worker and the LiteLLM gateway ship as **one
tested pair**, pinned in
`scripts/myrmidon/tracing/tracing-image-pins.json`. That file is the single
source of truth: the release-support check resolves the `langfuse`,
`langfuse-worker` and `litellm` components from it
(`check-release-support.sh --tracing-pins`), and
`scripts/myrmidon/tracing/tracing-release-pins.myrmidon.test.mjs` keeps the
pins equal to the contract compose. A bump of any one side alone ships a
Langfuse/LiteLLM combination the contract test never ran — the 02.10
mismatch class. The rule: bump the pin, re-run
`docker/tracing/tracing-contract-check.sh` before the release, keep the file
equal to the contract compose. The registry tracks the same components'
upstream releases; see the `langfuse` / `litellm` / `clickhouse` entries in
[stack-registry.md](stack-registry.md).

## Related

- [tracing-health.md](tracing-health.md) — the status card, the operator
  signal and the activity journal.
- [../SETTINGS.md](../SETTINGS.md) — every `MYRMIDON_TRACING_*` variable.
- [../deploy.md](../deploy.md) — deploy step 7b (the tracing guard) and the
  pin rule.
- [../../docker/tracing/README.md](../../../docker/tracing/README.md) — the
  contract test, its compose stack and the red-proof procedure.
- [stack-registry.md](stack-registry.md) — upstream release tracking for the
  tracing components.
