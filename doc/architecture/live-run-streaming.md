---
title: Live run event streaming
summary: WebSocket transport, reconnect behavior, and cache reconciliation for runs
---

## Purpose

Run progress reaches the board through the live company-events WebSocket. This is a WebSocket transport, not Server-Sent Events: the browser connects to `/api/companies/{companyId}/events/ws`, and the server publishes JSON `LiveEvent` messages for the authorized company.

## Flow

```text
run lifecycle / service event
  -> company live-event publisher
  -> authorized WebSocket clients
  -> LiveUpdatesProvider
      -> parse LiveEvent
      -> update TanStack Query caches
      -> notify component subscribers
      -> toast / UI effects where appropriate
```

The server upgrade handler in `server/src/realtime/live-events-ws.ts` authenticates the raw upgrade request, verifies the company scope, and then hands the socket to the live-event publisher. The browser implementation lives in `ui/src/context/LiveUpdatesProvider.tsx`. It opens one socket for the active company, keeps the socket lifecycle outside individual pages, and closes it when the session, company, or page visibility no longer permits a connection.

## Run state

Run lifecycle events patch the live-run cache and related issue/run queries. Terminal statuses remove the run from the active live list so completed work is not displayed as still running. Event handlers are deliberately defensive: malformed or non-JSON frames are ignored, and one subscriber cannot break delivery to the others.

A reconnect uses bounded exponential backoff up to 15 seconds. After reconnecting, the provider invalidates the live-run query because messages during the connection gap cannot be replayed by this transport. The same reconciliation happens when a hidden tab becomes visible again. This makes the event stream an acceleration path while the query API remains the source of truth.

## Operational boundaries

The socket is company-scoped and requires the same actor/session context as the board. Do not put secrets or credentials in the URL. Browser URL construction uses same-origin WebSocket helpers so deployments behind a proxy preserve the correct host and protocol.

When adding a new event, define its shared payload type, publish it from the owning service, handle it in the provider if it changes cache state, and add a focused provider test. Pages should subscribe to the provider or query cache rather than opening their own socket.

## Evidence

- `server/src/realtime/live-events-ws.ts` — upgrade authorization and socket lifecycle.
- `server/src/services/live-events.ts` — company event publication.
- `ui/src/context/LiveUpdatesProvider.tsx` — connection, parsing, cache updates, and reconnect.
- `ui/src/lib/live-runs-cache.ts` — active-run cache transitions.
- `server/src/__tests__/live-events-ws.test.ts` — transport edge cases.
