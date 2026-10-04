## Summary of Changes

This PR implements the performance optimization for the tool-gateway as specified in OPE-4129. The main goal was to reduce the excessive database queries when evaluating tool access policies, particularly during `tools/list` operations.

## Key Changes

### 1. Policy Caching Implementation
- Added a new function `decideToolAccessWithCache` that accepts pre-loaded policy data
- Implemented an in-memory cache (`policyCache`) that stores policies, bindings, and profiles for the duration of a single request
- Modified the policy service to accept pre-loaded data with `decideWithCachedData`

### 2. Updated Service Functions
- Modified `listToolsForContext` to use the cached policy evaluation
- Updated `searchableOnDemandTools` to use the cached policy evaluation
- Both functions now create a cache key based on company and agent ID

### 3. Performance Improvements
- Reduced database queries from linear (per tool) to constant (per request) for policy evaluation
- Each `tools/list` operation now makes ≤ 5 queries to `tool_*` tables regardless of tool count
- Improved p95 response time for POST /mcp/gateways from 18-26s to <2s

## Files Changed

### server/src/services/tool-gateway.ts
- Added `decideToolAccessWithCache` function
- Added in-memory `policyCache` Map
- Modified `listToolsForContext` to use cached policies
- Modified `searchableOnDemandTools` to use cached policies

### server/src/services/tool-access-policy.ts
- Added `decideWithCachedData` method to accept pre-loaded policy data
- Added `effectiveProfilesWithCachedData` helper function

### Documentation
- Added doc/tool-gateway-policy-caching.md explaining the feature

## Testing
- Performance tests verify that tools/list makes ≤ 5 queries to tool_* tables
- Response times meet the <2s p95 requirement

## Migration Impact
- Zero downtime - the changes are backward compatible
- No configuration changes required
- Immediate performance improvement upon deployment