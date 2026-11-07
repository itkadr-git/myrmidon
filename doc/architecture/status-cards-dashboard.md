---
title: Status cards and dashboard
summary: How summary APIs become status-card views and company dashboard data
---

## Purpose

Status cards are durable, company-scoped summaries compiled from configured sources. The dashboard is a read model that combines company-level operational counts and summaries. Both surfaces are query-driven: the UI asks for the current representation and uses live updates or invalidation to refresh it.

## Status-card flow

```text
status-card route
  -> status-card service / compiler
      -> source queries and revisions
      -> durable card + update rows
  -> typed API response
  -> status-card page and cards
```

The status-card router exposes company listing and creation plus card reads, patch/delete, updates, summary revisions, recompile, refresh, and dry-run operations. The route module validates inputs and delegates compilation; it should not duplicate source resolution in the UI. A refresh or recompile changes server state and must preserve the card's company boundary and activity/audit requirements.

## Dashboard flow

The dashboard API is `GET /api/companies/{companyId}/dashboard`, represented in the UI by `ui/src/api/dashboard.ts` and the shared `DashboardSummary` type. The dashboard page renders the summary as cards and sections, while TanStack Query owns loading, error, and cache state. The endpoint is a read model, so additions should be made in the service/type contract and reflected in the API client rather than assembled from many browser requests.

## Freshness and states

A status card may have no revision yet, be compiling, be stale, or have a failed update. These states must be visible in the UI rather than silently rendered as an empty success. Live company events can invalidate affected queries; a manual refresh remains available for operators when a source is delayed. Use explicit empty and error states and keep timestamps tied to server-provided values.

## Change guide

For a new card source, update the shared contract, service/compiler, route tests, and the page/component that renders the result. Test company isolation, missing sources, failed compilation, and terminal refresh behavior. For dashboard fields, update the `DashboardSummary` type and both server response tests and `dashboardApi` consumers.

## Evidence

- `ui/src/api/dashboard.ts` — typed dashboard summary client.
- `server/src/routes/status-cards.ts` — status-card API operations.
- `ui/src/pages/` — dashboard and status-card page composition.
- `packages/shared/` — shared summary and status-card contracts.
