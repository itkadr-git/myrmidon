# Swarm (self-organisation) settings

> Russian version: [swarm-claim-settings.ru.md](swarm-claim-settings.ru.md)

The swarm gives a ready task to a free agent of the task's caste on its own, with
no human assigning it and no "go and look for work" wake. It is controlled from
the interface, without restarting the board. There is **one switch for the whole
instance**; which agents take part is decided by the caste directory and an
agent's own card, not by lists in this screen.

## Where the settings live

Instance → General → **Self-organisation (swarm)**. The screen writes
`instance_settings.general.swarmClaim` through `GET`/`PATCH /api/myrmidon/swarm-claim`
(any board member reads; an instance admin writes). A value saved by an older
build with the pilot fields is still read (the leftover fields are dropped).
`general.swarm` is a different block — the F-26 wake guard (the
run-only-with-a-task gate and the cooling window). The server
re-resolves the row on every event — nothing is cached at startup, no restart is
ever needed.

## What to switch on, and who takes part

1. **Swarm enabled** — the only switch. Off by default; with it off the board
   behaves as before (a task goes to whoever it is assigned to) and no lease is
   written.
2. **Which agents take part** is set elsewhere:
   - the caste directory (Company settings → castes): a caste with
     `swarmEligible` on takes tasks, a caste with it off never does — its ready
     tasks wait for a caste that may take them;
   - the switch in an agent's card (`swarmQueueEligible`, an agent's own switch
     wins in both directions).
   Whether an agent has direct reports does **not** matter. A lead takes tasks
   if its caste is `swarmEligible`; to keep leads out, put them in a caste with
   the flag off, or turn their card switch off.

There is no list of roles or companies and no "pilot": the swarm is on for every
company of the instance, and the castes narrow it.

## The fields

| Field | What it bounds | Default |
|---|---|---|
| Swarm enabled | The switch of the whole swarm | off |
| Lease TTL, seconds | How long one lease lives without a heartbeat; the run refreshes it on every checkout pass | `900` |
| Max active tasks per agent | The ceiling of live leases per agent; empty = no ceiling. A caste can set its own ceiling, which wins for its agents | `3` |
| Sweep interval, seconds | How often the safety-net pass runs; read live, the startup value stays the floor | `30` |
| P0 preempts the queue | On — a `critical` task is first in line. Off — strictly oldest-first | on |

## Where each value comes from

Every field shows its origin next to it — "Saved here", "Environment override"
or "Default" — and the Swarm supervisor screen (/swarm-claim) shows the same.
The `MYRMIDON_SWARM_*` environment variables are **forced overrides**: a variable
set in the process environment beats the stored value for its key only (see
[SETTINGS.md](../SETTINGS.md)). Unset a variable to give control back to the UI.

## What the swarm does when it is on

A ready task meets a free agent of its caste: the board assigns the task to the
agent, writes a lease in the same step and only then starts the agent's run on
that task. The agent therefore never wakes without a task of its own. There is no
queue of wakes, no batch size and no rotation: a free agent gets its task at
once; with several free agents the pick is the same for the same facts (the
scent, then the smallest agent id). When no agent of the caste is free, nobody is
woken and the task waits for the first one that frees up. The same pass runs when
a task becomes ready, when an agent finishes a run, and as a safety net on every
sweep tick.

An agent counts as free when it has no live lease and no live run, is under its
active-task ceiling and is not paused or in error. Every start still goes through
the ordinary admission, so pause, maintenance and the host memory/CPU floors
apply: while a floor is closed nobody is woken. An agent may also pull the top
task itself through
`POST /api/myrmidon/companies/{companyId}/swarm-claim/claim`.

## How to check that it works

1. Switch *Swarm enabled* on and save. With several castes, check in the caste
   directory that the castes you want working have `swarmEligible` on.
2. Watch the status line under the switch: waiting
   unassigned tasks, claimed in the last hour and cancelled in the last hour. A
   minute after switching on, with a non-empty queue, "claimed in the last hour"
   should reach 1 or more while "cancelled in the last hour" does not grow.
3. Or by the task: a ready task gains an assignee with no human action, a live
   lease sits in `issue_claims`, and the agent's run starts with reason
   `swarm_matched` instead of `skipped`.
4. The Swarm supervisor screen (/swarm-claim) totals include
   **freeAgentsWithQueue** — free agents of a caste whose queue is not empty. A
   healthy swarm keeps it at 0; a value that stays above 0 means tasks cannot be
   handed out (agents paused, ceilings reached, an admission floor closed, the
   caste not `swarmEligible`), and the queue is waiting on the operator.

## Turning the swarm off

Switching *Swarm enabled* off (or forcing `MYRMIDON_SWARM_CLAIM_ENABLED=0`) takes
effect at once: the live leases are released synchronously — the save response
reports how many (`releasedClaims`) — and the sweep repeats the pass on its next
tick with the release reason `swarm_disabled`, covering anything the synchronous
pass could not reach. Runs holding released leases finish on their own; tasks
return to ordinary assignment behavior.

## The change journal

Every save appends a journal entry — who changed what, and when, newest first —
shown at the bottom of the section and kept under `general.swarmClaimJournal`
(capped at 50 entries). The same change also writes an
`instance.swarm_claim.updated` row into the activity log, which stays the audit
trail.
