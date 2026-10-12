# Agent defaults for the issue list (1.6.5 F-16, part A)

The instance setting `issuesListAgentDefaults` (stored in
`instance_settings.general`, changed without a deploy) defines what an
**agent actor** (an agent API token) receives from the issue-list endpoint
`GET /api/companies/{companyId}/issues`.

The default is **on**: the key is absent on instances that never toggled it,
and absent means enabled. `{ "enabled": false }` restores the pre-feature
agent behaviour byte-for-byte.

Why: on large boards a bare agent list call used to return 1.5–4 MB — the
agent received every `description` even when it only needed to pick a task.
With the defaults applied, a bare agent request gets compact rows (no
`description`), about 3–4 KB per row instead of megabytes; the agent fetches
the full body of the one task it picks via the detail endpoint.

## Toggling

There is no UI toggle in part A (the settings screen arrives with part B,
UI/nginx). Change it through the API:

```
PATCH /api/instance/settings/general
{ "issuesListAgentDefaults": { "enabled": false } }
```

The change is read live in the list handler
(`instanceSettingsService(db).getGeneral()`); no restart or deploy needed.

## What changes for agent actors

Applies only to requests authenticated as an agent. Board (human/UI)
requests are untouched — see the next section.

| Agent request | Response |
|---------------|----------|
| No `view` parameter | answered as `view=compact` |
| `limit` absent | default **200** rows |
| `limit` ≤ 500 | compact rows, that many per page |
| `limit` > 500 | **400** with a pagination hint (replaces the old silent clamp) |
| `view=full&limit=N`, N ≤ 100 | full rows including `description` |
| `view=full` without `limit`, or limit > 100 | **400** with the same hint |

In a compact response for an agent actor the `description` field is
**omitted** from each row. Get it for the task you pick with
`GET /api/issues/{issueId}` — the detail endpoint always returns the full
record regardless of the setting.

HTTP 400 error texts:

- limit above the agent maximum:
  `limit must be a positive integer up to 500 for agent actors; paginate
  with offset or afterId for larger windows`
- `view=full` without a limit or above the full-view cap:
  `view=full for agent actors requires an explicit limit up to 100; for
  larger windows paginate the default compact view with offset or afterId`

Paging: `offset` / `afterId` query params; the response includes
`nextOffset` when more rows remain.

### Recommended agent pattern

1. `GET /api/companies/{companyId}/issues` — up to 200 compact rows
   (title, status, priority, assignee, identifiers; no description).
2. Pick the task, then `GET /api/issues/{issueId}` for its full body.
3. Use `view=full&limit=…` (≤ 100) only when you genuinely need many
   descriptions at once.

## Board actor: unchanged

For board (human/UI) requests the behaviour is exactly the pre-feature
contract: a bare request returns the full response, `limit=1000` is clamped
as before, and `view=full` for a board request remains a 400 (the UI
compatibility contract). The `compact` view exists for agents and
scripts, not for the web UI list.

## Settings schema

```json
"issuesListAgentDefaults": {
  "enabled": true
}
```

The schema also accepts `defaultLimit` / `maxLimit` / `fullViewMaxLimit`,
but the server does not honor them yet — the effective values are fixed at
200 / 500 / 100. This is listed for part B.

## ETag / caching

Conditional requests keep working for agent list calls. The listing cache
key includes the setting's state, so bodies with and without `description`
never mix when the toggle flips (`304` handling stays per-shape).

## Source

Implementation: PR #987 (merge commit `e6548a8`), rel/1.6.5-rc.7.
Server logic: `server/src/routes/issues.ts` (`applyAgentListDefaults`,
`toCompactIssue`); contract, limits and error wording:
`packages/shared/src/myrmidon-issue-list-agent-defaults.ts`.
Tests: `server/src/__tests__/issue-list-agent-defaults.myrmidon.test.ts`.
