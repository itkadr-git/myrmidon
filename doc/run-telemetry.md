# Run telemetry snapshot

The server stores a bounded, prompt-free aggregation snapshot at
`heartbeat_runs.result_json.runTelemetry`. This is a local database record; it
is distinct from the `agent.task_run` first-party Telemetry event and from rows
in `heartbeat_run_events`.

The snapshot is refreshed after terminal presentation/finalization and exposed
as `runTelemetry` on heartbeat-run detail and list responses. It includes the run
and agent IDs, issue ID, wake source/reason/trigger detail, retry/parent IDs,
source event revision/ID/sequence when the durable wake receipt supplies them,
run-event sequence, model, token totals, model-call count and bounded gateway
request IDs, separate LiteLLM and adapter-reported spend, API-equivalent price
estimate for subscription-included usage, and an outcome category with evidence
counts.

`eventRevision` and `eventRevisionId` are null when no actual source revision
is present. `runEventSequence` is the local run-log sequence and is not an issue
event revision. `modelCallCountSource` states whether the count came from
LiteLLM request IDs, an explicit gateway count, or is unknown. At most 80
call IDs are retained per run; `gatewayCallIdsTruncated` marks overflow. The
aggregate call count remains separate from that capped list.

`outcomeCategory` is one of `artifact`, `status`, `commit_push`, `comment_only`,
or `nothing`, derived only from run-linked work products, document revisions,
status activity, and comments. `commitCount` and `pullRequestCount` expose the
registered commit/PR evidence separately. A missing commit/PR work product does
not prove that no unregistered repository push occurred.

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
