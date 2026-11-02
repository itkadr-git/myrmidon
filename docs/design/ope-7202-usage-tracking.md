# OPE-7202 Provider Usage Runtime Slice

## Event source

`provider.usage_reported` version 1 is the ingestion contract for adapter work in ch.A/ch.B. It carries opaque `credentialRef` (never a secret), provider, event id, observation time, window kind and boundaries, and provider-reported `used`/`limit` values for requests and/or tokens. Only metrics directly reported by the provider may populate these values; percentage-to-absolute conversion and inference from cost events are prohibited.

The current quota pollers are not valid producers for this event yet. Claude's subscription endpoint exposes utilization percentages and reset times for its 5-hour/weekly windows; its optional `extra_usage` exposes monetary `used_credits`/`monthly_limit` in cents, not token/request counts or a subscription-window limit. Codex WHAM exposes `used_percent`, window duration and reset time for primary/secondary windows, not absolute consumption. Neither poller has an established mapping from its local account to company-scoped `credentialRef` and owner issue in the report contract. Therefore no synthetic reports should be emitted from these pollers; usage remains unavailable until ch.A/ch.B supplies provider-authoritative absolute counters and the identity mapping.

A conforming producer must provide a stable opaque credential reference, company scope, event idempotency key, provider-defined window start/reset instants, and absolute used/limit values with documented units. It should omit unsupported metric dimensions rather than estimate them.

## Storage and aggregation

`provider_usage_event_receipts` deduplicates `(company_id, event_id)`. `provider_usage_snapshots` retains the latest provider-reported value for a `(company, provider, credentialRef, window kind, startedAt)` period. Incoming older snapshots do not overwrite newer ones. A reset creates a distinct period; reads only expose periods whose reset is in the future. Raw secrets and OAuth values are never stored.

## Warning behavior

The default threshold is 80% and is configurable per company: `instance_settings.general.providerUsageWarningThresholdPercent` holds `{ companyId: percent }` (key `*` is the instance default); vendor writes of `general` keep the key (`preserveProviderUsageThresholdGeneralKey`). A warning fires before `resetsAt` for one of two reasons, reported in `trigger`: `usage` (the consumed share of a metric reached the threshold) or `time` (the window is past the threshold share of its length and the metric has a known limit, so a stale snapshot still warns before the package or window runs out). The text names the actual trigger: a `time` warning says how much of the window has elapsed and how much was used, never "usage reached N%". Reports at or after reset do not warn.

The aggregate API returns usage, limits, remaining and reset time. A same-company `ownerIssueId` (uuid or identifier such as OPE-1) stores the owner on the snapshot; the warning comment on that issue is delivered only by the durable outbox (`provider_usage_warning_deliveries`, one row per warning key), swept by the server background loop, which also re-evaluates stored snapshots as time passes.

## Registry widget

The secrets registry shows the remaining value for a secret whose key or id equals the reported `credentialRef`; an explicit `providerMetadata.usageCredentialRef` takes precedence. No extra configuration is needed for the usual case: the adapter reports under the secret key.

## Remaining scope

Adapter production remains an explicit ch.A/ch.B integration contract: the current quota pollers do not give absolute counters and emit no reports. The poller stays separate and does not provide token/request totals.
