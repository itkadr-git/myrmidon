# Run telemetry

Heartbeat runs expose an aggregate `resultJson.runTelemetry` snapshot in both run detail and list responses. It records run/agent/issue identifiers, the wake source/reason, the issue revision captured at wake admission (`eventRevision`), parent/retry IDs, model-call count and token totals, and the categorized work outcome. Prompts, model responses, raw wake payloads, credentials, and secret values are not stored in this snapshot.

## Model call attribution and costs

`gateway_call_ids` and `litellm_request_ids` are retained in separate bounded lists (up to 500 IDs each); their truncation flags show when a list exceeded the bound. Explicit `model_call_count` supplied by the gateway takes precedence over the lists. The gateway parser accepts `call_ids` and `model_call_ids` metadata as gateway-call IDs. When no explicit count is supplied, gateway metadata and bounded output-call lines provide a fallback estimate; token usage is aggregated from recorded run usage.

API-equivalent prices are operator-managed at Instance → General → Model API pricing. Set input, cached-input, and output USD prices per million tokens for each model. Defaults are `gpt-6-luna` = $0.10 / $0.01 / $0.50 and `gpt-6.1-sol` = $2.00 / $0.10 / $10.00. Models without a configured price are reported as unpriced; pool spend is not written into LiteLLM.

## Outcome and revision semantics

The event revision is read from the wake receipt, not reconstructed from the issue's later state. Outcome is inferred from work products registered for that run: artifact, commit/push, or another work product. Without a work product, a run-linked status decision is labeled `status`; a run-linked issue comment is `comment_only`; otherwise the category is `nothing`. Issue-wide status or comments from other runs do not count as this run's outcome.

## Validation

For reconciliation, compare the run's distinct gateway call IDs and LiteLLM request IDs with the gateway records for that run, then compare token totals and paid-channel spend independently. A capped identifier list is incomplete evidence; use the explicit model-call count and its truncation flags.

Representative live reconciliation snapshot:
```json
{
  "runId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "agentId": "9dd8c4e8-04ed-44bf-9efe-0bbe3a337190",
  "issueId": "cf294dcc-1f62-4c07-8762-64993eb6d26a",
  "wakeReason": "issue_commented",
  "eventRevision": "2026-10-29T16:44:25.870Z",
  "sourceEventId": "3da7ee61-d395-4a26-83bc-27afb374a85a",
  "model": "gpt-6-luna",
  "billingType": "subscription_included",
  "modelCallCount": 2,
  "modelCallCountSource": "gateway_count",
  "gatewayCallIds": ["gw-call-01", "gw-call-02"],
  "litellmRequestIds": ["litellm-req-01", "litellm-req-02"],
  "inputTokens": 1500,
  "cachedInputTokens": 200,
  "outputTokens": 450,
  "gatewaySpendCents": 0,
  "apiEquivalentCostUsd": 0.000377,
  "apiEquivalentCostStatus": "estimated",
  "commitCount": 1,
  "pullRequestCount": 1,
  "branchCount": 1,
  "outcomeCategory": "commit_push"
}
```
