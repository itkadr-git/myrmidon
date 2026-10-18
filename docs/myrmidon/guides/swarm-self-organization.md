# Self-organization: castes, nests, pheromones

Russian version — [swarm-self-organization.ru.md](swarm-self-organization.ru.md).

Since 1.6.5 the board itself picks a free agent for every ready task:
you file a task — the swarm finds who takes it and wakes the agent with that
task in hand. No more "wake up and look for work" passes: an agent wakes
only when there is a task for it.

## How it works

**Castes.** Every task and every agent belongs to a caste. The task's caste
resolves in three layers: the "Caste" field in the task card → the task
project's default caste → the `role:<key>` label (compatibility). Whether an
agent joins the swarm queue is decided by two switches: its own
(`swarmQueueEligible` in the agent card — it wins), and if unset, the
`swarmEligible` flag of its caste in the caste directory. A supervisor takes
tasks when its caste is swarmEligible — there is no hard-coded "whoever has
subordinates never takes tasks" rule. The board matches a task only with a
free agent of its caste.

**Pheromones.** Every waiting task has a pheromone strength — a number. The
starting strength depends on priority (critical 100, high 30, medium 10,
low 1 — tunable in settings, and the task card can carry its own number).
While a task waits, its strength slowly grows: +1 for every 24 hours of
waiting, capped at +5 total. Queue order inside a caste: critical (P0) tasks
first, then by effective strength (strength + aging − penalty), ties broken
by who waited longer.

**Penalty and cooldown.** If an agent takes a task and the run ends badly
(failed, blocked, timed out) while the task itself did not change, the
strength drops by the penalty (10 by default). Separately, the task cools
down: a run that moved nothing postpones the next attempt by 30 minutes,
then 60 after the second such run, 120, and so on, capped at 24 hours. Any
movement on the task — an edited description, a new comment, a status
change — lifts both the penalty and the cooldown at once: the board sees the
task is different now.

**Lease.** Once an agent takes a task, it holds it on a lease: 15 minutes by
default, renewed while the run is alive, no more than three tasks at a time.
If the agent stays silent past the lease, the lease expires and another free
agent takes the task.

## How to turn it on

One action: **Instance → General → "Self-organization (swarm)" → "Enable the
swarm"** switch. The swarm is off by default — turning it on stays a
deliberate decision of the instance owner.

Fine-tuning lives in the "Pheromones" block of the same panel (starting
strength per priority, aging, penalty); every value and its source is listed
in SETTINGS, section "1.6.5 — Self-organization (swarm)".

## How to verify

Three actions:

1. Turn on the "Enable the swarm" switch in the "Self-organization (swarm)"
   panel.
2. Create a task without an assignee. Its caste comes from the project or
   the "Caste" field in the card — for this to work the company needs at
   least one free agent of that caste admitted to the swarm.
3. Wait a minute and open the "Swarm: queues" screen: the task shows up in
   the queue and immediately gets a lease on a free agent — the agent wakes
   with that task and starts working on it.

## Why a task is waiting

- **No free agent of its caste.** The task is visible in the queue on the
  "Swarm: queues" screen and will be picked up as soon as an agent of that
  caste frees up.
- **The task is cooling down** after a run that moved nothing. Edit the
  description or add a comment — the cooldown and the penalty lift at once.
- **The agent is out of the queue.** Check the switch in its card and the
  `swarmEligible` flag of its caste in the caste directory.
- **The swarm is off.** Check the switch in "Instance → General →
  Self-organization (swarm)" — the journal on the same panel shows the last
  settings change and who made it.
