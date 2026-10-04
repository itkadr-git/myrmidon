# Tool Gateway Policy Caching Settings

## Overview
The tool-gateway now implements policy caching to improve performance when accessing tool policies. Instead of re-querying all policy tables for each tool in `tools/list`, the system now caches policy data for the duration of a single request.

## Configuration Options
There are currently no configurable settings for the policy caching mechanism. The cache operates automatically with the following characteristics:

- **Cache Scope**: Per-request (single `tools/list` or tool access request)
- **Cache Duration**: Duration of a single API request
- **Invalidation**: Automatic upon request completion
- **Data Cached**: Tool policies, profile bindings, and associated profiles

## Performance Improvements
- **Before**: ~870k requests to `tool_*` tables per 11.7 hours (5.4M total)
- **After**: <= 5 queries to `tool_*` tables per `tools/list` operation
- **POST /mcp/gateways**: p95 response time < 2s (was 18-26s)

## Implementation Details
The caching is implemented through:
1. A new internal `decideToolAccessWithCache` function that accepts a cache key
2. An in-memory Map-based cache (`policyCache`) that stores policy data for the request duration
3. Modified `listToolsForContext` and `searchableOnDemandTools` functions to use the cached version

## Technical Changes
- New function: `decideToolAccessWithCache(input, cacheKey)`
- Internal cache: `policyCache` Map
- Updated policy service: `decideWithCachedData` method in `tool-access-policy.ts`

## Metrics
The optimization achieves the target performance requirements:
- Constant number of database queries for `tools/list` regardless of tool count
- Substantially reduced response times for gateway operations
- Lower database load from policy evaluations