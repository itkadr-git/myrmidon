# Run telemetry

Heartbeat runs expose an aggregate `resultJson.runTelemetry` snapshot in both run detail and list responses. It records run/agent/issue identifiers, the wake source/reason, the issue revision captured at wake admission (`eventRevision`), parent/retry IDs, model-call count and token totals, and the categorized work outcome. Prompts, model responses, raw wake payloads, credentials, and secret values are not stored in this snapshot.

## Model call attribution and costs

The adapter caps each retained ID list at 500 and sets a truncation flag; an explicit gateway `model_call_count` remains authoritative even when only a partial ID list is available. Without an explicit gateway count, ID counts from gateway-call and LiteLLM-request namespaces are combined using the maximum when both sets exist; this is an estimate, not a gateway-reported count. Token usage is aggregated from recorded run usage. Paid-channel LiteLLM spend remains separate from API-equivalent cost estimates for subscription-pool usage.

API-equivalent prices are operator-managed at Instance → General → Model API pricing. Set input, cached-input, and output USD prices per million tokens for each model. Defaults are `gpt-6-luna` = $0.10 / $0.01 / $0.50 and `gpt-6.1-sol` = $2.00 / $0.10 / $10.00. Models without a configured price are reported as unpriced; pool spend is not written into LiteLLM.

## Outcome and revision semantics

The event revision is read from the wake receipt, not reconstructed from the issue's later state. Outcome is inferred from work products registered for that run: artifact, commit/push, or another work product. Without a work product, a run-linked status decision is labeled `status`; a run-linked issue comment is `comment_only`; otherwise the category is `nothing`. Issue-wide status or comments from other runs do not count as this run's outcome.

## Validation

For reconciliation, compare the run's distinct gateway call IDs and LiteLLM request IDs with the gateway records for that run, then compare token totals and paid-channel spend independently. A capped identifier list is incomplete evidence; use the explicit model-call count and its truncation flags.
