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
the review-routing sweep picks the least-loaded eligible reviewer agent
(never the task's author or its assignee), assigns the review and wakes it.
A review that stays without a verdict past the configured hours is signalled
and moved to another reviewer. With no eligible reviewer at all, the task is
signalled on the attention desk.

## Planning from a chat message

The Commander chat is the board's planning entry: the owner writes what is
wanted in one free-text message, the board proposes an epic with child
tasks, and approving the proposal is what creates the tasks. The same
planner is reachable from Telegram.

## Pull-request sync

A development task can settle itself: when the pull requests linked to a
task merge, the task moves on, and a task whose pull requests all merged
does not wake its agent for nothing.

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
