# Autonomy matrix: execution points

The autonomy matrix maps role × action class to `allowed` / `approval_required` /
`forbidden`, and the gate (`server/src/myrmidon/autonomy/gate.ts`) is consulted at
the action point. This page answers the other half of the question: **where is
each action class actually enforced?**

The registry (`server/src/myrmidon/autonomy/registry.ts`) holds the answer, and
`registry.myrmidon.test.ts` reads every seam back out of the source, so the table
below cannot drift away from the code.

## Enforced on this tree

| Action class | Execution point | Source seam | Gate call |
| --- | --- | --- | --- |
| `delete` | `DELETE /api/issues/:id` and the five sibling DELETE routes | `server/src/routes/issues.ts` | `assertAllowed(req, "delete")` |
| `change_instructions` | `PATCH /api/agents/:id/instructions-path`, `PATCH /api/agents/:id/instructions-bundle`, `DELETE /api/agents/:id/instructions-bundle/file` | `server/src/routes/agents.ts` | `decide(req, "change_instructions")` |
| `change_instructions` | `POST /api/agents/:id/instructions-revisions/:revisionId/rollback` | `server/src/myrmidon/agent-instructions-revisions/index.ts` | `decide(req, "change_instructions")` |

A `forbidden` verdict answers 403 with the stable code `autonomy_forbidden`; an
`approval_required` verdict answers 403 `autonomy_approval_required` at the
invocation-less route seams until the holding-action conveyor lands. A caller
that is not an agent (the board, an instance admin) is not subject to the matrix,
and a denied request never runs the route work.

## How this is tested

- `registry.myrmidon.test.ts`, next to the registry, reads every seam out of the
  source: remove the gate call from a connected route and the suite goes red.
- `gate-deny.myrmidon.test.ts`, next to the gate, pins the deny half of the gate
  itself — `forbidden` becomes 403 `autonomy_forbidden`, `allowed` passes, and a
  caller that is not an agent is not subject to the matrix.
- `server/src/routes/agents-autonomy-e2e.myrmidon.test.ts` is the route-level end
  to end: the real express route, the real gate and a real matrix document (only
  the DB-backed factory is swapped for an in-memory store). An agent caller whose
  instructions demand a forbidden `change_instructions` gets 403
  `autonomy_forbidden`, and the instructions bundle is not rewritten — the route
  does not run its work after a refused verdict.

## Defined, but not enforced on this tree yet

These classes exist in the matrix contract but no route seam consults them here,
so they live in `PENDING_ENFORCEMENT` instead of the registry (the test fails if
a class is in neither place):

| Action class | Why it has no seam yet |
| --- | --- |
| `pause_wake_agents` | Pause, resume and wake are not gated on this tree; the seam ships on its own autonomy branch and moves into the registry when it merges. |
| `merge` | No route consults the merge verdict yet; the tool-gateway held-action path is the documented follow-up. |
| `deploy` | No route consults the deploy verdict yet. |
| `external_message` | No route consults the external-message verdict yet. |

`other` and `spend_above_threshold` are exempt (`REGISTRY_EXEMPT_CLASSES`): the
catch-all has no seam of its own, and the spend class belongs to the budget seam
(1.7).

## What the registry test guarantees

- Every action class the matrix can hold is either enforced at a seam or listed
  in `PENDING_ENFORCEMENT` with a reason — a class cannot silently lose its point.
- An execution point stays listed only while its source still calls
  `assertAllowed(req, "<class>")` / `decide(req, "<class>")`: delete the gate call
  from a connected route and the suite goes red.
- Neither list names a class outside `AUTONOMY_ACTION_CLASSES`, and the two lists
  never overlap.