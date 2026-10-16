# ADR-0002: No automatic wake-up without a task

- Status: accepted
- Date: 2026-10-09
- Deciders: repository owner
- Scope: swarm queue, wake-ups, heartbeat scheduling

## Context

Agents can be woken automatically (idle wake, sweep, pause-drain, rebalance, monitors, cron).
A wake-up that is not bound to a concrete task causes empty runs: the agent wakes, finds
nothing to do, and burns a run slot and model budget. Such "orphan" wake-ups also produce
noise in run history and make capacity accounting wrong.

## Decision

Every `enqueueWakeup` call must bind the target task: a `taskKey` or `issueId` derived from a
real source (comment, interaction, monitor, or a cron entry that itself points at a task).
Forwarding wrappers and adapter ports that merely pass the binding through are fine; a call
with no binding in its surrounding window is a violation.

## Enforcement

INV-10, checked by `scripts/myrmidon/ci/arch-invariants-gate.mjs`
(`checkWakeTaskBinding`): scans wake-up call sites in the swarm-queue and scheduling code and
fails on calls with no task binding in the call window.

## Alternatives considered

- Runtime check (log a warning when a bound-less wake runs): rejected — the cost is paid in
  empty runs before anyone notices; CI catches it before merge.
- Manual review only: rejected — this exact class of divergence survived review twice.

## Consequences

- Wake-ups are auditable: each has a reason in the queue record.
- New wake paths must carry a task binding from day one; the gate has a red-side selftest to
  keep that honest.
