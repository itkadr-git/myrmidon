# Tasks and the board

> Русская версия: [Tasks-and-the-board.ru](Tasks-and-the-board.ru)

The board is where work lives: tasks are created, claimed by agents,
reviewed, blocked and closed there. This page covers how work flows through
the board and what keeps it flowing.

## How a task moves

A task is born `todo`, an agent checks it out (`in_progress`), hands it to a
reviewer (`in_review`), and it ends `done`, `cancelled` or waiting on a
named blocker (`blocked`). Every transition, cost and comment stays in the
task's thread.

Blocking is first-class: moving a task into `blocked` requires a reason —
either a list of blocking tasks or a reason reference. A stale blocked
reason (the blocker long done, the task still parked) is caught by the
stale-block watchdog instead of sitting silent forever.

Scheduled issue monitors are checked for tasks in `in_progress`, `in_review`,
and `blocked`; a due monitor wakes its assignee with the monitor context.
Completed or cancelled tasks have their schedules cleared. If a due monitor
has not triggered within the overdue threshold, the Attention feed raises an
`issue_monitor_overdue` item for operators. Inspect the task's monitor schedule
and wake history, then resume or reschedule the task; the item clears when the
monitor is no longer overdue.

## Role queues

With the role-queue pilot, a free agent claims the top task of its role's
queue itself instead of waiting to be assigned. How long a claim lease
lives, how many tasks one agent may hold, how often the queue sweep runs
and whether a priority task jumps the queue are all instance settings,
changeable from the interface without a restart.

## Work-in-progress limits

The WIP limit caps how many tasks one agent may hold in flight
(`in_progress` + `in_review`). The board computes the live status, shows a
badge on the agent and raises a signal when an agent is over the limit.

## Review routing

A task in `in_review` with no reviewer does not wait for someone to notice:
the review-routing sweep picks an eligible reviewer agent (prioritizing idle
reviewers first, then least-loaded; never the task's author, its assignee, or a
reviewer that already had the task), assigns the review and wakes it.

When a task has green CI (`head.ci === "green"`) and no verdict after
`reassignAfterMinutes` minutes (taking precedence over `reassignAfterHours` when
set to > 0), the review stage is automatically reassigned to another available
reviewer of the same role with a comment recorded on the issue. Value `0`
disables minute-based reassignment. A review that stays without a verdict past
the configured hours (`reassignAfterHours`) is signalled and moved to another
reviewer. With no eligible reviewer at all, the task is signalled on the
attention desk.

When an issue enters `in_review` or its reviewer is reassigned, the issue update
and the durable reviewer wake request are committed in one database transaction.
Execution-stage reviewer wake requests use that same transaction path. If the
wake request cannot be persisted, the issue update does not leave the task in
review without a durable wake receipt.

A review task is not treated as stranded while its review participant is alive:
if the participant has a live run on any task of the company, the
stranded-work sweep skips the board escalation and keeps the task waiting for
that participant. Only when the participant has no live run at all can the
review task be moved to board-only `blocked` with a recovery card.

## Planning from a chat message

The Commander chat is the board's planning entry: the owner writes what is
wanted in one free-text message, the board proposes an epic with child
tasks, and approving the proposal is what creates the tasks. The same
planner is reachable from Telegram.

## Pull-request sync

A development task can settle itself: when the pull requests linked to a
task merge, the task moves on, and a task whose pull requests all merged
does not wake its agent for nothing.

When the board review stage is approved and the open pull request is green
and mergeable on the approved head, the board merges it itself through the
shared GitHub App identity (squash, the repository's convention). The merge
fires when a review is approved, when a CI run completes, and on the
periodic review-routing pass as the safety net. It is bound to the exact
approved head: the approving verdict must name the current head, the
required check must be green on that head, and the base must be `main` (or
a configured release base). A conflict with the base after the approval
returns the task to its implementer once with a rebase request instead of
staying in review forever. The behavior is the `boardMerge` block of
`instance_settings.general.reviewRouting`, on by default;
`boardMerge.enabled = false` restores the previous wait-for-a-human
behavior.

## Discussion rooms

A discussion room lets 2–4 agents on different models debate a question
directly on the issue card, without turning it into a comment thread: the
owner posts the topic and the roster, the participants argue in rounds, and
an optional finisher summarizes the outcome.

## In detail

- [Role queues (SWARM-CLAIM) settings](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/swarm-claim-settings.md)
- [WIP limit](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/wip-limit.md)
- [Stale-block watchdog](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/stale-block.md)
- [Commander chat](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/commander-chat.md)
- [Discussion rooms](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/agent-exchange.md)
- Review routing: [SETTINGS.md](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/SETTINGS.md), section «REVIEW-ROUTING»

## Knowledge-note gate for system changes

When a system-significant change reaches `done`, or when its review is
approved, the board checks for a valid wiki reference in the form
`Вики: slug@rev`. The referenced knowledge item and revision must exist; a
missing or invalid reference is rejected after the rollout grace period. The
same gate is applied to both the issue route and the issue service, so direct
service updates cannot bypass it. During the first three days after
`2026-10-31`, the default is warning-only; operators can explicitly select
`warning` or `enforce` with `MYRMIDON_KNOWLEDGE_GATE_MODE`, and can override the
rollout anchor with `MYRMIDON_KNOWLEDGE_GATE_START_DATE`. Non-system changes
are unaffected. See the [knowledge gate change record](../myrmidon/changes/knowledge-gate-system-changes.md)
for the rollout and settings reference.

## Recovery and requeue holds

If a failed run is reconciled after an operator has already returned its task
to `todo` or `backlog`, the recovery sweep preserves that chosen status rather
than changing it to `blocked`. It records a closed hold (`outcome = "cancelled"`)
so the task is not automatically replayed. An operator can explicitly resume
the held task by moving it to a working status; normal recovery of tasks that
were not requeued remains unchanged.

## Concurrent settings edits

General and experimental instance-settings updates are serialized on the
`instance_settings` row. Concurrent PATCH requests therefore merge against the
latest stored document instead of overwriting one another's edits. This also
covers creation of the first settings row.

## Review admission

When a task enters `in_review` or its reviewer changes, Myrmidon persists the reviewer wake request in the same transaction as the task update. Review-stage wake requests are persisted through that transaction path as well. This keeps the task update and the request to wake its reviewer atomic.
