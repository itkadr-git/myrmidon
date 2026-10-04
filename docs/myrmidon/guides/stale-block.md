# Stale-block watchdog (dead blocked reasons)

> Russian version: [stale-block.ru.md](stale-block.ru.md)

## Blocking a task: the reason reference is required

A PATCH that moves a task into `blocked` must say what the task is blocked
ON: either a non-empty `blockedByIssueIds` list or a `reasonRef` inside the
task's unblock descriptor. A transition without any reason is rejected with
HTTP 422 ("Entering blocked requires a reason reference"). The rule went live
at the rollout moment `STALE_BLOCK_ROLLOUT_AT` (2026-10-03T12:00:00Z, in
`server/src/services/routable-blocked.ts`): tasks blocked earlier are not
re-validated, and the `reasonRef` field itself stays optional on the type for
backward compatibility — only the transition into `blocked` is guarded.

The reference lives in the existing `unblock_descriptor` JSON column as
`IssueUnblockDescriptor.reasonRef`:

| `kind` | Required payload | The reason is a … |
|---|---|---|
| `issue` | `issueId` | task whose closure unblocks this one |
| `event` | `eventKey` | gate/event that must stay set |
| `date` | `dueAt` (ISO 8601) | date after which the block is stale |

The kind must carry its identifying payload (an `issue` without `issueId` is
rejected by validation), so the liveness sweep described below can actually
resolve the reference. The guard exists so that a blocked reason is
machine-checkable: the watchdog (part B) reads `reasonRef` to tell a live
reason from a dead one — without a reference there is nothing to check.

The same rule is enforced twice, on the same contract: the shared validator
(`requireReasonRefForBlockedTransition` on `updateIssueSchema`) and the route
guard in `server/src/routes/issues.ts` next to the existing entering-blocked
check. Callers that extend the update schema must derive from
`updateIssueShapeSchema` (or use `.safeExtend()` on the route schema): the
refined schema no longer supports plain `.extend()`/`.partial()`.

A blocked task holds its assignee to a reason: a blocker task, a date, or a
gate/event. Two of those reasons can die silently: a cancelled blocker never
fires the blockers-resolved path, and a due date or a cleared gate has no
wake path at all. The task then sits in `blocked` forever with a dead
reason. The stale-block watchdog is the periodic sweep that lifts such
blocks itself.

The feature is opt-in: it ships disabled and the operator turns it on with
`MYRMIDON_STALE_BLOCK_ENABLED=1`. Unblocking work automatically is a routing
decision the machine makes, so the default is the vendor behavior — a dead
reason holds the task until a person intervenes. Settings are the
`MYRMIDON_STALE_BLOCK_*` variables, listed with defaults and ranges in
[../SETTINGS.md](../SETTINGS.md).

## What the sweep inspects

Each pass reads the blocked tasks (at most 50 per pass, the least recently
updated first) and judges every reason a task cites. A blocked task's
reasons come from two places: the `reasonRef` reference inside the task's
unblock descriptor, or — when there is no `reasonRef` — the task's
blocked-by relations. A reason is dead when:

- the blocker task is `done` or `cancelled` (a cancelled blocker never fires
  the blockers-resolved wake, so it would hold the task forever);
- the `reasonRef.dueAt` date has passed;
- the gate/event the `reasonRef` points at is no longer set (an unwired gate
  key is judged still-set, so a missing wiring never silently unblocks a
  task).

A task whose every reason is dead gets unblocked. A task with at least one
live reason, and a task with no recognizable reason at all, is left
untouched — the sweep never guesses.

## What unblocking does

The sweep re-reads and re-judges the task under a row lock immediately
before writing, so a blocker that closed and re-opened, or a due date that
got moved, is respected. Then, through the ordinary issue update path (never
a direct database write):

1. Exactly the dead blocked-by relations are removed.
2. The task returns to `in_progress` and one system comment names each dead
   reason in plain text (for example "the blocking task is cancelled").
3. An activity log row `myrmidon.stale_block.unblocked` is written with the
   actor `stale_block_sweep`, listing every dead reason and why it died.

A task under an open maintenance window is skipped. A task whose unblock
fails stays blocked and is retried by a later pass.

## Cadence

The sweep runs on the heartbeat scheduler tick; the
`MYRMIDON_STALE_BLOCK_INTERVAL_SEC` setting is the minimum spacing between
two passes (300 seconds by default), and one pass never overlaps itself —
a tick that arrives while a pass is still running reuses the running pass.

## The attention-feed card

A routing change the machine made must be visible to the lead and the
operator: each lifted block raises one card on the attention desk, with the
source label "Stale block lifted" (source kind `stale_block`) and medium
severity. The card names the task, lists the dead reasons in plain text, and
offers two verbs: Inspect (open the task) and Dismiss. Cards are computed on
the fly from a process-local signal registry — there is no new store, one
card per task per lift, and a card fades after
`MYRMIDON_STALE_BLOCK_SIGNAL_TTL_MS` (24 hours by default) or when the
operator dismisses it. A server restart also clears the cards; the task's
system comment stays as the durable audit trail either way.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `MYRMIDON_STALE_BLOCK_ENABLED` | `0` (off) | Master switch. Only `1`/`true`/`yes`/`on` enable the sweep; unset, `0`, unrecognized or a typo keep it off (an opt-in feature: a typo must not silently enable it) |
| `MYRMIDON_STALE_BLOCK_INTERVAL_SEC` | `300` (5 min) | Minimum spacing between two sweep passes. Range 15–86400; out of range, non-numeric or fractional — the default |
| `MYRMIDON_STALE_BLOCK_SIGNAL_TTL_MS` | `86400000` (24 h) | How long the attention-feed card stays on the desk after a lifted block. `0` — the card is not shown at all; non-numeric or negative — the default |

Details and the full settings table: [../SETTINGS.md](../SETTINGS.md).
