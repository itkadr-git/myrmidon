# Tool Gateway Policy Caching (OPE-4129)

## Overview
The tool-gateway evaluates tool access from a per-request **policy snapshot**
instead of re-querying all policy tables for each tool in `tools/list`.

For one `tools/list` (or tool call) the gateway loads the company-scoped
snapshot exactly once:

- `tool_profiles` — filtered by `company_id`
- `tool_profile_bindings` — filtered by `company_id`
- `tool_policies` — filtered by `company_id`

Every per-tool decision (`decideWithCachedData`) then runs against this
in-memory snapshot: a constant number of `tool_*` queries per request,
independent of the tool count.

## Snapshot cache and invalidation
A short-lived in-memory snapshot cache (`policyCache` in
`server/src/services/tool-gateway.ts`) is keyed by
`{companyId}:{agentId}`.

Invalidation is **event-based, not TTL-based**:

- Every mutation of `tool_profiles` / `tool_profile_bindings` /
  `tool_policies` (profile CRUD, entries, bindings, ask-first policies,
  MCP gateway profile bindings) calls `emitToolPolicyChanged()` from
  `server/src/services/tool-policy-cache-events.ts` after a successful write.
- The tool-gateway subscribes with `onToolPolicyChanged()` and drops all
  cached snapshots immediately — a policy edit becomes visible on the very
  next request.
- The remaining 30-second TTL is only a cross-process safety net: a mutation
  performed in a different board process cannot fire an in-process event, so
  other processes converge within ≤ 30s. Single-process deployments see
  changes with zero delay.

## Configuration
No configuration is introduced; the cache operates automatically. The only
tuning constant is the cross-process safety TTL
(`CACHE_TTL_MS = 30 * 1000` in `tool-gateway.ts`).

## Performance (measured on 2026-10-04)

- Before: `decide()` per tool re-read the full `tool_*` tables — ~870k
  queries per table per 11.7 hours (~5.4M total); `POST /mcp/gateways`
  averaged 18–26s across 12 gateways.
- After: exactly 3 company-scoped `tool_*` queries per `tools/list` (≤ 5
  budget), regardless of tool count. See the pinned regression test
  `server/src/services/tool-gateway.perf.test.ts` (constant query count for
  10/50/100 tools).

## Files

- `server/src/services/tool-gateway.ts` — `getCachedPolicyData`,
  `decideToolAccessWithCache`, snapshot cache + event invalidation
- `server/src/services/tool-access-policy.ts` — `decideWithCachedData`
- `server/src/services/tool-policy-cache-events.ts` — event bus
  (`emitToolPolicyChanged` / `onToolPolicyChanged`)
- `server/src/services/tool-access.ts` — mutation sites emit the event
- `server/src/services/tool-gateway.perf.test.ts` — regression test

DIVERGENCE: snapshot is company-scoped and event-invalidated; cross-process
staleness is bounded by a 30s safety TTL instead of minutes of TTL-only
caching.
