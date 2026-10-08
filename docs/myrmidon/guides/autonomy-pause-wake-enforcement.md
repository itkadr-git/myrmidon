# Autonomy Matrix — Pause, Resume, Wake Enforcement

## What

The autonomy matrix (introduced in 1.6) now enforces the `pause_wake_agents` action class at the three agent lifecycle routes:

- `POST /api/agents/:id/pause`
- `POST /api/agents/:id/resume`
- `POST /api/agents/:id/wakeup`

An agent that attempts to pause, resume, or wake another agent is checked against the stored matrix. If the caller's role (or the caller's per-agent override) maps `pause_wake_agents` to `forbidden`, the request is refused with 403 and code `autonomy_forbidden`. If the verdict is `approval_required`, the request is refused with 403 and code `autonomy_approval_required` until the held-action conveyor ships (a separate task).

## Scope

- **Gated**: agent callers acting on a *different* agent (`req.actor.agentId !== :id`).
- **Not gated**: board users, instance admins, and agents acting on themselves (`req.actor.agentId === :id`).
- **Matrix source**: `instance_settings.general.myrmidonAutonomy` (same JSON store as 1.6 Part A). Edits take effect on the next request — no restart required.

## Errors

| Verdict | Status | Code |
|---|---|---|
| `forbidden` | 403 | `autonomy_forbidden` |
| `approval_required` | 403 | `autonomy_approval_required` |
| `allowed` | — | request proceeds |

## Tests

`server/src/myrmidon/autonomy/routes-1.6.2.myrmidon.test.ts` covers:

- forbidden agent → 403 `autonomy_forbidden`, handler never runs
- allowed agent → 200, handler runs
- board caller → 200 regardless of matrix
- self-action → 200 regardless of matrix
- approval_required → 403 `autonomy_approval_required`

## Removal

The gate is a single call in each route; remove the three `if` blocks and the `AUTONOMY_APPROVAL_REQUIRED_CODE` export from `gate.ts`. The matrix itself stays (Part A/B).
