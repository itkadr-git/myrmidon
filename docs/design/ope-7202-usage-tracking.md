# OPE-7202 Provider Usage Runtime Slice

## Event source

`provider.usage_reported` version 1 is the ingestion contract for adapter work in ch.A/ch.B. It carries opaque `credentialRef` (never a secret), provider, event id, observation time, window kind and boundaries, and provider-reported `used`/`limit` values for requests and/or tokens. Only metrics directly reported by the provider may populate these values; percentage-to-absolute conversion and inference from cost events are prohibited.

The current quota pollers are not valid producers for this event yet. Claude's subscription endpoint exposes utilization percentages and reset times for its 5-hour/weekly windows; its optional `extra_usage` exposes monetary `used_credits`/`monthly_limit` in cents, not token/request counts or a subscription-window limit. Codex WHAM exposes `used_percent`, window duration and reset time for primary/secondary windows, not absolute consumption. Neither poller has an established mapping from its local account to company-scoped `credentialRef` and owner issue in the report contract. Therefore no synthetic reports should be emitted from these pollers; usage remains unavailable until ch.A/ch.B supplies provider-authoritative absolute counters and the identity mapping.

A conforming producer must provide a stable opaque credential reference, company scope, event idempotency key, provider-defined window start/reset instants, and absolute used/limit values with documented units. It should omit unsupported metric dimensions rather than estimate them.

## Storage and aggregation

`provider_usage_event_receipts` deduplicates `(company_id, event_id)`. `provider_usage_snapshots` retains the latest provider-reported value for a `(company, provider, credentialRef, window kind, startedAt)` period. Incoming older snapshots do not overwrite newer ones. A reset creates a distinct period; reads only expose periods whose reset is in the future. Raw secrets and OAuth values are never stored.

## Warning behavior

The default threshold is 80% used and is configurable. Usage at or above the threshold warns only when `observedAt < resetsAt`; reports at or after reset do not warn. The aggregate API returns usage, limits, remaining and reset time. An optional same-company `ownerIssueId` causes a warning comment on that issue.

## Remaining scope

Adapter production remains an explicit ch.A/ch.B integration contract. No registry UI widget consumes the aggregate API yet. The current quota-window poller remains separate and does not provide token/request totals. End-to-end delivery, full package verification and UI integration remain outstanding.
