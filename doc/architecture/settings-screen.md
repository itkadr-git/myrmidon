---
title: Settings screen architecture
summary: How settings navigation, instance configuration, and guarded mutations fit together
---

## Purpose

Settings are split by scope. Company settings describe one selected company's behavior; instance settings describe the board installation and may require an instance administrator. The UI reflects that boundary in navigation and API clients instead of treating settings as one unscoped form.

## Screen flow

```text
settings route
  -> scope-aware settings layout
  -> section page / form
      -> typed API module
          -> authenticated route
              -> settings service
                  -> persisted setting
```

`ui/src/App.tsx` maps settings and legacy settings paths through the settings route boundary. Legacy URLs redirect to the canonical settings surface. The active company context is used for company-scoped forms; instance-level pages are not allowed to infer a company from a stale URL.

## Read and write behavior

A settings page loads the current server representation through a typed API module, renders controls from the returned value, and submits an explicit patch. The server validates the body, checks the actor and scope, persists the change, and returns the canonical value. Do not rely on browser defaults or local storage as the source of truth for installation settings.

Mutations should show pending, success, and failure states. After a successful write, replace the form state with the response or invalidate the exact settings query. Settings that affect background workers or runtime behavior must document whether they take effect on the next request, next run, or process restart; never imply that a restart happened when it did not.

## Security and operability

Settings can contain sensitive configuration. Keep secrets out of rendered summaries, logs, query strings, and error messages. Server authorization is authoritative even when the navigation hides an admin-only section. A read route must apply the same scope boundary as a write route and must not expose another company's settings through an ID or prefix.

When adding a setting, update the shared schema/type, server settings service and route, UI API client/form, and the relevant operator documentation. Include the setting's default, source of its value, effective-time semantics, and whether a restart is required. Add tests for unauthorized reads/writes and invalid values.

## Evidence

- `ui/src/App.tsx` — canonical and legacy settings route boundaries.
- `ui/src/api/` — typed settings clients.
- `server/src/services/instance-settings.ts` — instance-setting persistence and defaults.
- `server/src/routes/` — authenticated settings endpoints.
- `docs/myrmidon/SETTINGS.md` — operator-facing setting registry.
