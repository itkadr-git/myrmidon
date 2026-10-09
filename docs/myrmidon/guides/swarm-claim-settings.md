# Role queues (SWARM-CLAIM) settings

> Russian version: [swarm-claim-settings.ru.md](swarm-claim-settings.ru.md)

The per-role task queues are controlled from the interface, without
restarting the board: who claims from a queue, how long a lease lives, how many
tasks one agent may hold, how often the sweep runs and whether a P0 task jumps
the queue. Since 1.6.1 every value is an instance setting.

## Where the settings live

Instance → General → **Role queues (SWARM-CLAIM)**. The screen writes
`instance_settings.general.swarmClaim` through `GET`/`PATCH /api/myrmidon/swarm-claim`
(any board member reads; an instance admin writes). The server re-resolves the
row on every claim, checkout, sweep tick and supervisor read — nothing is
cached at startup, no restart is ever needed.

## The fields

| Field | What it bounds | Default |
|---|---|---|
| Enable role queues | The master switch of the queues | off |
| Roles in scope | The role scope of the queues: which roles claim. Comma-separated (e.g. `engineer`); **empty = every role** (a scope, not a "pilot"). The queues on the dev team are exactly this field with one role | empty |
| Companies in scope | The company scope of the queues: comma-separated ids; **empty = every company** | empty |
| Idle wake batch | How many tasks one idle pass hands to agents (since 1.6.5 the assignment and its lease come first, the wake second) | `5` |
| Lease TTL, seconds | How long one lease lives without a heartbeat; the run refreshes it on every checkout pass | `900` |
| Max active tasks per agent | The ceiling of live claims per agent; empty = no ceiling | `3` |
| Sweep interval, seconds | How often the expired-lease sweep runs; read live, the startup value stays the floor | `30` |
| P0 preempts the queue | On — a `critical` task is the top of the queue. Off — strictly oldest-first | on |

## Where each value comes from

Every field shows its origin next to it — "Saved here", "Environment override"
or "Default" — and the Swarm supervisor screen (/swarm-claim)
shows the same for the values it renders. The `MYRMIDON_SWARM_*` environment
variables are **forced overrides**: a variable set in the process environment
beats the stored value for its key only (see [SETTINGS.md](../SETTINGS.md)).
Unset a variable to give control back to the UI.

## The queue pass: claim on the server, then wake

The sweep has a third pass, after the release and free passes: the
**idle wake**. Until 1.6.5 the pass woke an agent with the id of a task that
belonged to nobody and expected the claim to happen at the run's checkout — but
the run admission reads that task's assignee as `NULL` while the run carries
another agent, so it cancels the wake (`skipped`, "issue assignee changed before
the queued run could start"). The run never reached checkout and in 7 days not a
single unassigned task was taken into work (the analysis in
`ops/audit/swarmdiag-20261009.md`, OPE-6608).

Since 1.6.5 the order is reversed: for each pair of "role with a ready queue +
free agents of that role" the pass **assigns** the top task to a free agent
itself and immediately writes the same kind of lease a checkout writes; only
then does it wake that agent with the assigned task. There is no "go and look
for work" wake: every wake already has an owner. When the role has no free
agent, nobody is woken. If the lease write fails, the assignment is reverted and
the task goes back to the queue.

An agent counts as free when it has no live claim, is under its active-task
ceiling, is not paused or in error, and has no live run. Whether an agent may
take from the queue at all is a switch of its own (agent metadata
`swarmQueueEligible`): by default it is on only for the executor role, and off
for a lead, a reviewer, the architect and other agents that also carry
`role=engineer` — they answer `agent_excluded`. The sweep also never wakes roles
outside the scope (`enabledRoles`/`enabledCompanyIds`) or `swarmEligible: false`
castes (`caste_excluded`); a caste's own task ceiling overrides the global one
for its agents.

Free agents of a role are ordered by their load (live leases), and among equals
by last activity: the longest idle agent comes first, so the head of the list no
longer sticks between passes. The pass is bounded in two ways:

- at most `Idle wake batch` tasks per role per pass (default `5`, clamped to
  1–25) — a bulk task import cannot burst the whole fleet awake at once;
- every wake goes through the ordinary admission (`enqueueWakeup`), so pause,
  maintenance and the host memory/CPU floors still apply — while a floor is
  closed the pass wakes nobody and logs the reason (at most one line per five
  minutes).

The wakes carry the reason `swarm_claim_queue` and by then the task is already
assigned to the agent, so the run passes admission and reaches checkout. The
self-claim fallback remains: an agent may take the top task of its role's queue
itself through `POST /api/myrmidon/companies/{companyId}/swarm-claim/claim`
(shipped with the agent skill).

## How to check that it works

1. Switch *Enable role queues* on, set *Roles in scope* to `engineer` (empty =
   every role) and, with several companies on the instance, *Companies in
   scope*.
2. Watch the **"Queues right now"** line at the bottom of the panel: queued —
   ready tasks waiting for an owner; claimed in the last hour and cancelled in
   the last hour — by live leases and by cancelled wakes. A minute after
   switching on, with a non-empty queue, "claimed in the last hour" should reach
   ≥ 1 while "cancelled in the last hour" does not grow.
3. Or by the task: an unassigned task gains an assignee with no human action, a
   live lease sits in `issue_claims`, and the agent's run starts with reason
   `swarm_claim_queue` instead of `skipped`.
4. The Swarm supervisor screen (route /swarm-claim) totals include
   **freeAgentsWithQueue** — free agents of a role whose queue is not empty. A
   healthy queue keeps that number at 0; a value that stays above 0 means the
   pass cannot hand work out (agents paused, ceilings reached, an admission
   floor closed, role or agent outside the scope), and the queue is waiting on
   the operator.

## Turning the queues on for one role

The acceptance flow: set *Enable role queues* on, put `engineer` into *Roles in
scope* (and the company id into *Companies in scope* when several companies
share the instance), save. Within a minute a free engineer receives the top task
of the engineer queue: the pass assigns it and writes the lease, then wakes the
engineer, the checkout confirms the lease, and the finishing run releases it and
hands the next one to the next engineer of the role.

## Turning the queues off

Switching *Enable role queues* off (or forcing `MYRMIDON_SWARM_CLAIM_ENABLED=0`)
takes effect at once: the live leases are released synchronously — the save
response reports how many (`releasedClaims`) — and the sweep repeats the pass
on its next tick with the release reason `pilot_disabled`, covering anything
the synchronous pass could not reach. Runs holding released leases finish on
their own; the tasks return to vendor assignment behavior.

## The change journal

Every save appends a journal entry — who changed what, and when, newest
first — shown at the bottom of the section and kept under
`general.swarmClaimJournal` (capped at 50 entries). The same change also
writes an `instance.swarm_claim.updated` row into the activity log, which
stays the audit trail.
