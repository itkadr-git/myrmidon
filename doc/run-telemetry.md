# Run telemetry snapshot

The server stores a bounded, prompt-free aggregation snapshot at
`heartbeat_runs.result_json.runTelemetry`. This is a local database record; it
is distinct from the `agent.task_run` first-party Telemetry event and from rows
in `heartbeat_run_events`.

The snapshot is refreshed after terminal presentation/finalization and exposed
as `runTelemetry` on heartbeat-run detail and list responses. It includes the run
and agent IDs, issue ID, issue revision (`issues.updatedAt`), wake source/reason/
trigger detail, retry/parent IDs, optional source event ID/sequence, model, token
totals, model-call count and bounded gateway/LiteLLM request IDs, separate
LiteLLM and adapter-reported spend, API-equivalent price estimate for
subscription-included usage, and a result category derived only from registered
work products.

The snapshot uses `issues.updatedAt` as `eventRevision`. It is the issue-state
revision at snapshot time. `sourceEventId` and `sourceEventSeq` are separate and
are included only when the durable wake payload carries them. They identify the
source event, not the issue revision. `modelCallCountSource` states whether the
count came from an explicit gateway count, gateway call IDs, LiteLLM request
IDs, or is unknown. At most 80 gateway call IDs and 80 LiteLLM request IDs are
retained; separate truncation flags mark overflow. The aggregate call count
remains separate from those capped lists.

`outcomeCategory` uses registered work products only. It is `artifact`,
`commit_push`, `other_work_product`, or null when none exist. The snapshot
reports artifact, document, commit, pull-request, branch, and other work-product
counts. It does not classify status changes, comments, or a work-product-free
run as a result.

LiteLLM `gatewaySpendCents` and adapter-reported `reportedCostCents` remain
separate. For `subscription_included` usage, `apiEquivalentCostUsd` is computed
using `instance_settings.general.modelApiPricing` (USD per million uncached
input, cached input and output tokens); `apiEquivalentCostStatus` is
`estimated` or `unpriced`. These estimates do not modify LiteLLM pricing or
actual billing ledger rows. The initial configured defaults are gpt-6-luna
0.10/0.01/0.50 and gpt-6.1-sol 2.00/0.10/10.00. Operators can change the
model-price map under Instance → General.

No prompt, model output, credentials, or raw wake payload is copied into this
snapshot. Trigger and event identifiers are accepted only as bounded
identifier-like strings; source payload contents are not persisted in
`runTelemetry`.
