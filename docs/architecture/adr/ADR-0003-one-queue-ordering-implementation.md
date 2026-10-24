# ADR-0003: One queue-ordering implementation for the agent swarm

- Status: accepted
- Date: 2026-10-09
- Deciders: repository owner
- Scope: swarm claim queue, agent assignment ordering

## Context

Two ordering models coexisted: "priority × wait time" (weight from the task) and "pheromone
strength" (weight from agent-task affinity). When the PRs met at merge, both orderings were
live in different call paths, producing different assignment orders for the same queue —
agents saw a different order than the supervisor computed, and cooldown rules diverged the
same way (two different cooldown rules collided at merge).

## Decision

There is exactly one implementation of swarm-queue ordering: `orderSwarmQueueCandidates` in
`packages/shared/src/myrmidon-swarm-claim.ts`. With `p0Preemption=true` (the default), candidates
are ordered by priority rank first, then by ascending `queuedAt`; with `p0Preemption=false`,
priority is ignored and candidates are ordered oldest-first by `queuedAt`. There is no
priority-times-wait score. Any other module that needs ordering calls this function; ad-hoc
`.sort()` on queue candidates anywhere in swarm code is a violation. Affinity signals may
influence which task is chosen, not the order agents are assigned in.

## Enforcement

INV-11, checked by `scripts/myrmidon/ci/arch-invariants-gate.mjs`
(`checkSingleQueueOrder`): `.sort(` on candidate arrays is allowed only inside
`myrmidon-swarm-claim.ts`.

## Alternatives considered

- Allow a second ordering behind a settings flag: rejected — the divergence that motivated
  this ADR was exactly two orderings coexisting behind different paths.
- Unify by moving ordering into the server service: rejected — the shared package is the one
  place both the queue and the supervisor import from; a service-level helper would still be
  imported by the UI differently.

## Consequences

- Assignment order is predictable and identical across queue, supervisor, and diagnostics.
- A future ordering change is one diff in one function, reviewed as one decision.
