# Self-organization: castes, nests, pheromones

> Русская версия: [swarm-self-organization.ru.md](swarm-self-organization.ru.md)

How the board hands unassigned tasks to free agents on its own. Since 1.6.5
the swarm is a shipped feature, not a pilot: one switch, and the board
matches every ready task with a free agent of the right caste.

## How it works in one paragraph

A task with no assignee waits in its caste's swarm queue. The board watches
for events (a run finishes, a pause lifts, a task is created or updated, a
lease expires) and after each one checks: is there a ready task and a free
agent of its caste? If so, the board assigns the task to the agent and wakes
it with that task in hand. There are no "wake up and look for work" wakeups:
every automatic run starts with a concrete task. A periodic safety pass on
the scheduler tick picks up anything the events might have missed.

## The three concepts

**Caste** — the agent's profession (the role key: `engineer`, `reviewer`,
`lead`, and so on). The company's caste directory lives in **Company
Settings → Castes**: you can create your own castes, exclude a caste from
the swarm ("Takes part in the swarm" switch), set a per-caste active-task
ceiling, and pick the default caste (the "Default" radio) — tasks without a
caste land there.

**Nest** — the list of projects an agent works in (the agent card, "Nests"
field). An empty list means "all projects". A task from a project only
reaches agents whose nests include that project.

**Pheromone strength** — a number on the task: the higher it is, the higher
the task sits in the swarm queue. If you don't set it, it comes from the
priority mapping in settings (defaults: critical 100, high 30, medium 10,
low 1). While the task waits, the strength grows — the default aging step is
+1 for every 24 hours of waiting, capped at +5. A failed run on the task
(failed/blocked/needs follow-up/timed out) with no task change after it cuts
the strength by a penalty (default −10 per such run in a row). Any change to
the task (a comment, an edit, a status move) clears the penalty and the
cooldown. A `critical` task goes first regardless of strength when P0
preemption is on.

## How to turn it on (one action)

**Instance → General → "Self-organization (swarm)" → the "Enabled" switch**.

In 1.6.5 the swarm is on by default. Turning it off applies immediately:
live leases are released (the save response says how many), assignees are
not stripped from tasks — assignments simply stop being made automatically.
Every change lands in the journal on the same panel (who, what, when).

## How to put a task into the swarm

Three actions:

1. Create the task **without an assignee**.
2. Set its **caste** (the "Caste" field on the task card). If you don't —
   the project default caste applies, and without one the company default
   caste.
3. Optionally adjust the **pheromone strength** (a number) — by default it
   comes from the priority.

From there the board assigns the task to the first free agent of the caste
in the project's nest and wakes that agent with the task. There is no need
to set an assignee by hand — the swarm decides.

## How to check the swarm is working

1. Put a test task into the swarm (no assignee, a caste that has a free
   agent).
2. Open the **"Swarm"** screen (`/swarm-claim`): the task should sit in its
   caste's queue with a visible effective strength; as soon as an agent of
   the caste frees up, the task gets a lease and an assignee, and the agent
   gets a `swarm_matched` wakeup.
3. The status line of the "Self-organization (swarm)" panel shows live
   numbers: how many castes, how many free agents, how many tasks wait, how
   many matched in the last hour, and the average wait. You can double-check
   against the database: `SELECT count(*) FROM issues WHERE status='todo'
   AND assignee_agent_id IS NULL AND hidden_at IS NULL` — with free agents of
   the right caste around, a healthy swarm drives that queue to zero within
   one safety-pass interval, with no manual assignments.

## Why a task is waiting

A task sits in the queue without being assigned when at least one of these
holds:

- **No free agent of the caste in the project's nest.** Every agent of the
  caste is busy (a live run or the active-task ceiling), paused or in error,
  or none of the free agents of the caste has the task's project in their
  nests. The Swarm screen shows it per caste: the queue is there, free
  agents — zero.
- **The task is cooling down.** The last run on the task failed
  (failed/blocked/needs follow-up/timed out) and the task hasn't changed
  since. Such a task is not matched for the cooldown: 30 minutes after the
  first failed run, doubling for every next one (60 min, 120 min …), capped
  at 24 hours. The cooldown breaks the "run → failure → run again" loop. Any
  change to the task (a comment, an edit) lifts the cooldown at once. The
  list of cooling tasks with the reason and the next retry time lives on the
  Swarm screen (the "Cooldown" section) and in `GET
  /api/myrmidon/companies/{companyId}/swarm/cooling`.
- **The task has no caste and no defaults are set.** The matcher looks at
  the task caste first, then the project default caste, then the company
  default caste (always present — the built-in `engineer` until the owner
  picks another) — so a caste-less task normally just joins the default
  caste's queue.
- **The caste is excluded from the swarm** (the "Takes part in the swarm"
  flag is off in the caste directory) — tasks of that caste are never
  matched.
- **The swarm is off** — by the switch or by the forced
  `MYRMIDON_SWARM_CLAIM_ENABLED=0`.

The exact reasons surface as warnings on the "Self-organization (swarm)"
panel: "tasks with no agents of the caste: …", "tasks cooling down: N",
"runs without a task in the last day: N" (the healthy value of the last one
is 0).

## Removed in 1.6.5

- **The pilot.** The "Pilot roles" / "Pilot companies" fields and the
  `MYRMIDON_SWARM_CLAIM_ENABLED_ROLES` / `MYRMIDON_SWARM_CLAIM_ENABLED_COMPANY_IDS`
  variables are gone — the swarm is either on or off, no pilot lists.
- **`MYRMIDON_SWARM_IDLE_WAKE_BATCH`.** The "wake a batch of free agents"
  pass is removed: matching happens on events, not batch wakeups.
- **The supervisor pilot report** and `MYRMIDON_SWARM_PILOT_BASELINE_DOC` —
  baseline comparison lives on the "Quality" screen.

## Settings

Every knob lives on the **Instance → General → "Self-organization (swarm)"**
panel and applies without a restart. The full field and environment-variable
reference is in [SETTINGS.md](../SETTINGS.md), section "1.6.5 —
Self-organization (swarm)".
