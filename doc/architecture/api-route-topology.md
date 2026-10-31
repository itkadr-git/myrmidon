---
title: API route topology
summary: How Express composes the server API and protects route access
---

## Purpose

The Express application in `server/src/app.ts` is the composition root for HTTP middleware and API routers. Domain behavior belongs in route modules and services, not in a giant route handler inside the app factory.

## Request path

```text
HTTP request
  -> proxy/hostname and body handling
  -> request logging and API compression
  -> actor resolution (session or API key)
  -> board-key scope enforcement
  -> cloud-control identity handling
  -> /api router stack
  -> route module -> service -> database
  -> JSON response or normalized error
```

The app installs JSON parsing before the main API stack, with special handling for signed provider webhooks and portable company-import bodies. Actor middleware runs before protected API routes; the board API-key scope middleware then applies the key's allowed operation set. Route modules remain responsible for company membership, resource visibility, and actor-specific permissions.

## Router composition

Routers are mounted on the shared `api` Express router, generally at the `/api` prefix. Feature modules export router factories that receive database and service dependencies. `app.use("/api", api)` mounts the finished stack, followed by a JSON 404 for unknown API paths. Operational readiness routes are mounted separately at the root because load balancers probe them without an actor.

WebSocket upgrade routes are not ordinary Express handlers: `server/src/index.ts` binds dedicated realtime servers to the underlying HTTP server. In particular, live company events use `/api/companies/{companyId}/events/ws` and perform their own upgrade authorization.

## Security and errors

Keep authorization at the narrowest domain boundary and check the company scope before returning or mutating records. Mutations should validate request bodies, enforce the appropriate board/agent permission, and record activity where the domain requires it. Return consistent status codes and avoid leaking cross-company existence through error detail.

The global fallback responds with `{ error: "API route not found" }` and HTTP 404. Route-level failures should use the shared error conventions so the application error middleware can serialize them consistently.

## Change guide

Add an endpoint to the feature router closest to its resource, use shared schemas/types for the contract, and expose it through a typed UI API module when needed. Add route tests for authorization as well as the success path; include agent-vs-board and cross-company cases whenever applicable.

## Evidence

- `server/src/app.ts` — middleware order and router mounting.
- `server/src/routes/` — feature route factories.
- `server/src/index.ts` — HTTP server and realtime upgrade wiring.
- `server/src/middleware/auth.ts` — request actor resolution.
- `server/src/middleware/board-key-scope.ts` — API-key scope enforcement.
