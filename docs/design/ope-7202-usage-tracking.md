# OPE-7202 Provider Usage Runtime Slice

## Event source

`provider.usage_reported` version 1 is the ingestion contract for adapter work in ch.A/ch.B. It carries opaque `credentialRef` (never a secret), provider, event id, observation time, window kind and boundaries, and provider-reported `used`/`limit` values for requests and/or tokens. The current adapters do not expose universal request/token totals; do not infer tokens from cost events. Until each provider adapter emits this contract, UI data is unavailable for that credential.

## Storage and aggregation

`provider_usage_event_receipts` deduplicates `(company_id, event_id)`. `provider_usage_snapshots` retains the latest provider-reported value for a `(company, provider, credentialRef, window kind, startedAt)` period. Incoming older snapshots do not overwrite newer ones. A reset creates a distinct period; reads only expose periods whose reset is in the future. Raw secrets and OAuth values are never stored.

## Warning behavior

The default threshold is 80% used and is configurable. Usage at or above the threshold warns only when `observedAt < resetsAt`; reports at or after reset do not warn. The aggregate API returns usage, limits, remaining and reset time. An optional same-company `ownerIssueId` causes a warning comment on that issue.

## Remaining scope

Adapter production remains an explicit ch.A/ch.B integration contract. No registry UI widget consumes the aggregate API yet. The current quota-window poller remains separate and does not provide token/request totals. End-to-end delivery, full package verification and UI integration remain outstanding.
