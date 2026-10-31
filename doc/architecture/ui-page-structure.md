---
title: UI page structure
summary: How the React application composes layouts, routes, pages, and data clients
---

## Purpose

The UI is a Vite-built React application rooted at `ui/src`. `App.tsx` owns the route tree; pages own screen-level composition; components own reusable presentation and interaction; API modules keep HTTP details out of page components.

## Composition

```text
App.tsx
  -> global providers (session, company, query cache, live updates)
  -> board shell / production shell
  -> company-prefixed route
      -> page (`ui/src/pages`)
          -> feature components (`ui/src/components`)
              -> API client (`ui/src/api`)
                  -> /api server route
```

The company prefix is resolved by the router helpers and keeps company-scoped pages addressable from both the canonical board URL and legacy redirects. `Layout` and `Layout.production` provide the navigation frame; pages do not create a second application shell.

## Routing rules

`ui/src/App.tsx` imports page modules and maps paths such as `dashboard`, `agents`, `issues`, `runs`, `status-cards`, and `settings`. Routes that need a company use the active company prefix. Legacy unprefixed paths redirect rather than rendering a second copy of a page. Experimental surfaces are wrapped in feature gates, so a disabled capability fails closed at the route boundary.

Large production surfaces are lazy-loaded with `React.lazy` and rendered through `ProductionSurface`. This keeps initial navigation small while preserving a common loading state. The route tree also distinguishes board routes from global routes such as authentication and instance setup.

## Data and state

Pages use TanStack Query through API modules under `ui/src/api`. Query keys in `ui/src/lib/queryKeys.ts` provide stable cache identity. `CompanyContext` selects the active company, while `LiveUpdatesProvider` applies incoming lifecycle events to the cache and notifies interested components. A page should invalidate or update the relevant query rather than maintain a competing global copy of server state.

The live provider opens one authenticated WebSocket per active company at `/api/companies/{companyId}/events/ws`. It parses `LiveEvent` messages, updates query data, dispatches subscribers, and reconnects with bounded backoff. When the tab becomes visible again, active queries are reconciled because events may have been missed while hidden.

## Change guide

Add a page under `ui/src/pages`, its focused API calls under `ui/src/api`, and a route in `App.tsx`. Keep company authorization and data shaping on the server. Add a query key and a live-event handler when the page depends on mutable run or issue state. Follow an existing page test for loading, empty, error, and permission states.

## Evidence

- `ui/src/App.tsx` — route tree, shells, lazy production surfaces, and gates.
- `ui/src/context/CompanyContext.tsx` — active company selection.
- `ui/src/context/LiveUpdatesProvider.tsx` — shared WebSocket and cache fan-out.
- `ui/src/api/` — typed client modules for server routes.
- `ui/src/lib/queryKeys.ts` — cache identity conventions.
