# Self-organization: castes, nests, pheromones

Русская версия — [swarm-self-organization.ru.md](swarm-self-organization.ru.md).

Since 1.6.5 the board itself picks a free agent for every ready task: you
file a task — the swarm finds who should take it and wakes that agent with
the task already in hand. There are no more "wake up and look for work"
passes: an agent wakes only when a task is waiting for it.

## How it works

**Castes.** Every task and every agent belongs to a caste. A task's caste is
resolved in three layers: the caste tag in the task card → the default caste
of the task's project → the company default caste. An agent takes part in the
swarm when its caste is swarm-eligible (a flag in the caste directory). The
board only matches a task with a free agent of the same caste.

**Pheromones.** Every waiting task carries a pheromone strength — a number.
The starting strength comes from the priority (critical 100, high 30,
medium 10, low 1 — the values live in settings, and the task card can set its
own number from 0 to 1000000). While the task waits, its strength slowly
grows: +1 for every 24 hours of waiting, capped at +5 in total. The queue
order inside a caste: critical (P0) tasks first, then by effective strength
(strength + waiting bonus − penalty), and on a tie the task that has waited
longest.

**Penalty and cooldown.** If an agent takes a task and the run fails
(failed, blocked, timed out) without the task itself changing, the strength
drops by the penalty (10 by default) and the task cools down: 30 minutes
after the first such run, 60 after the second, 120 after the third, and so
on, capped at 12 hours. Any change to the task — an edit, a new comment —
lifts both the penalty and the cooldown: the board treats the task as a new
one.

**Leases.** An agent holds a task on a lease: 15 minutes by default, renewed
while the run is alive, with at most three tasks per agent. If the agent goes
silent past the lease, it expires and another free agent picks the task up.

## How to enable

One action: **Instance → General → "Self-organisation (swarm)" → the
"Enabled" switch**. The swarm is off by default — turning it on stays a
deliberate decision of the contour owner.

Fine-tuning lives in the "Pheromones" block of the same panel (starting
strength per priority, waiting bonus, penalty, cooldown); every value and
where it comes from is documented in SETTINGS — section "1.6.5 —
Self-organisation (swarm)".

## How to verify

Three steps:

1. Flip the "Enabled" switch in the "Self-organisation (swarm)" panel.
2. Create a task without an assignee. Its caste comes from the project or
   from the caste tag in the task card — the project needs at least one free
   agent of that same, swarm-eligible caste.
3. Wait a minute and open the Swarm screen: the task shows up in the caste
   queue and gets a lease to a free agent right away — the agent wakes with
   that task and starts working on it.

## Why a task is waiting

- **No free agent of its caste.** The task stays visible in the Swarm
  screen queue and is picked up as soon as an agent of that caste frees up.
- **The task is cooling down** after a failed run without changes. Edit the
  description or add a comment — the cooldown and the penalty lift at once.
- **The swarm is off.** Check the switch in "Instance → General →
  Self-organisation (swarm)" — the journal on the same panel shows the last
  change and who made it.
