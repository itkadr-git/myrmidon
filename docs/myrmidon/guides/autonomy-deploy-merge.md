# Autonomy matrix: the deploy action class

The `deploy` class of the autonomy matrix is enforced on the two routes that start a
rollout or enter maintenance:

- `POST /api/myrmidon/deploy-jobs` starts a deploy job.
- `POST /api/myrmidon/maintenance` enters (or leaves) a maintenance window.

The gate runs first, before the instance-admin check, and answers from the stored matrix by
the caller's role:

| Caller | Verdict | Result |
|---|---|---|
| agent | `forbidden` | 403, code `autonomy_forbidden` |
| agent | `approval_required` | 403, code `autonomy_approval_required` (a board-API route has no held-action primitive yet, so the verdict denies instead of passing silently) |
| agent | `allowed` | passes the gate; the routes stay board-only, so an agent key still gets the board-access 403 |
| board user | any | not subject to the matrix; the instance-admin check still applies |

## Defaults

The factory default for `deploy` changed from `allowed` to `approval_required`: an agent without an
explicit `allowed` rule cannot trigger a deploy. A stored document that still has `deploy: allowed`
without an explicit rule is lifted to `approval_required` on read. To allow deploy for a role, add
a rule on Company Settings, Autonomy, for example:

```json
{ "role": "engineer", "actionClass": "deploy", "verdict": "allowed" }
```

## Merge

No route in the board merges pull requests, so the `merge` class has no enforcement point yet.

## Tests

`server/src/myrmidon/deploy-jobs/autonomy.myrmidon.test.ts` and
`server/src/myrmidon/maintenance/autonomy.myrmidon.test.ts` run the routes through the real gate with
an in-memory matrix and role lookup.
