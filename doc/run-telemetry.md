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

The snapshot uses the revision captured in the durable wake receipt as
`eventRevision`; it is not reconstructed from the issue's later state.
`sourceEventId` and `sourceEventSeq` are separate and are included only when the
durable wake payload carries them. They identify the source event, not the issue
revision. `modelCallCountSource` states whether the
count came from an explicit gateway count, gateway call IDs, LiteLLM request
IDs, or is unknown. At most 500 gateway call IDs and 500 LiteLLM request IDs are
retained; separate truncation flags mark overflow. The aggregate call count
remains separate from those capped lists.

`outcomeCategory` prioritizes registered work products (`artifact`,
`commit_push`, or `other_work_product`). Without a work product, a run-linked
applied status decision is `status`, a run-linked issue comment is
`comment_only`, and a completed run with neither is `nothing`. Pending runs
without an observable outcome remain null. Issue-wide status and comments from
other runs are not attributed to this run. The snapshot reports artifact,
document, commit, pull-request, branch, and other work-product counts.

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

## Representative Reconciled Run Telemetry Example

The following sample illustrates the reconciled aggregation snapshot as stored under `heartbeat_runs.result_json.runTelemetry`:

```json
{
  "runId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "agentId": "9dd8c4e8-04ed-44bf-9efe-0bbe3a337190",
  "issueId": "cf294dcc-1f62-4c07-8762-64993eb6d26a",
  "wakeReason": "issue_commented",
  "wakeSource": "automation",
  "wakeTriggerDetail": "callback",
  "eventRevision": "2026-10-29T16:44:25.870Z",
  "sourceEventId": "3da7ee61-d395-4a26-83bc-27afb374a85a",
  "sourceEventSeq": 1,
  "model": "gpt-6-luna",
  "billingType": "subscription_included",
  "modelCallCount": 2,
  "modelCallCountSource": "gateway_count",
  "gatewayCallIds": ["gw-call-01", "gw-call-02"],
  "gatewayCallIdsTruncated": false,
  "litellmRequestIds": ["litellm-req-01", "litellm-req-02"],
  "litellmRequestIdsTruncated": false,
  "inputTokens": 1500,
  "cachedInputTokens": 200,
  "outputTokens": 450,
  "gatewaySpendCents": 0,
  "apiEquivalentCostUsd": 0.000377,
  "apiEquivalentCostStatus": "estimated",
  "commitCount": 1,
  "pullRequestCount": 1,
  "branchCount": 1,
  "artifactCount": 0,
  "documentCount": 0,
  "otherWorkProductCount": 0,
  "outcomeCategory": "commit_push"
}
```

This structure reconciles model calls directly against gateway call IDs and LiteLLM request IDs, keeps separate counts for commit and push (`commitCount`, `pullRequestCount`, `branchCount`), and exposes all fields for aggregation queries.
