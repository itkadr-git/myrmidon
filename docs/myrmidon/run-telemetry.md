# Run telemetry

Heartbeat runs expose an aggregate `resultJson.runTelemetry` snapshot in both run detail and list responses. It records run/agent/issue identifiers, the wake source/reason, the issue revision captured at wake admission (`eventRevision`), parent/retry IDs, model-call count and token totals, and the categorized work outcome. Prompts, model responses, raw wake payloads, credentials, and secret values are not stored in this snapshot.

## Model call attribution and costs

`gateway_call_ids` and `litellm_request_ids` are retained in separate bounded lists (up to 500 IDs each); their truncation flags show when a list exceeded the bound. Explicit `model_call_count` supplied by the gateway takes precedence over the lists. The gateway ID fields do not include arbitrary `call_ids` or `model_call_ids`; those aliases are ambiguous. When no explicit count is supplied, the larger unique-ID count across the two namespaces is used as a fallback estimate. Token usage is aggregated from recorded run usage.

API-equivalent prices are operator-managed at Instance → General → Model API pricing. Set input, cached-input, and output USD prices per million tokens for each model. Defaults are `gpt-6-luna` = $0.10 / $0.01 / $0.50 and `gpt-6.1-sol` = $2.00 / $0.10 / $10.00. Models without a configured price are reported as unpriced; pool spend is not written into LiteLLM.

## Outcome and revision semantics

The event revision is read from the wake receipt, not reconstructed from the issue's later state. Outcome is inferred from work products registered for that run: artifact, commit/push, or another work product. Without a work product, a run-linked status decision is labeled `status`; a run-linked issue comment is `comment_only`; otherwise the category is `nothing`. Issue-wide status or comments from other runs do not count as this run's outcome.

## Validation

For reconciliation, compare the run's distinct gateway call IDs and LiteLLM request IDs with the gateway records for that run, then compare token totals and paid-channel spend independently. A capped identifier list is incomplete evidence; use the explicit model-call count and its truncation flags.
