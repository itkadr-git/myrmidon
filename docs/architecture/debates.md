---
title: Debates
summary: Structured multi-agent deliberation and decision records
---

Debates are a bounded coordination primitive for asking several agents to examine a question before a decision is recorded. The debates module owns the protocol and persistence; adapters only execute the participating agent runs.

## Protocol

A debate has a prompt, participants, rounds, and a terminal outcome. The coordinator creates the debate in the company scope, dispatches participant turns, collects their proposals, and applies the configured synthesis step. Each contribution is linked to its author and run so the final decision remains auditable.

The round state is explicit. A participant may succeed, fail, time out, or abstain without making the whole control plane inconsistent. Retries use the debate and turn identity as the idempotency boundary. The coordinator closes the debate only after the required quorum or terminal failure policy is satisfied.

## Governance boundary

Debates do not grant participants extra permissions. Every agent retains its own company, role, approval, budget, and task boundaries. A synthesized recommendation is evidence; actions that change board state still pass through the normal API and approval rules.

## Failure handling

A stuck turn is visible as a non-terminal turn, not silently treated as agreement. The service records errors and preserves completed contributions so an operator can inspect or retry. Cancellation closes outstanding work according to the debate policy and keeps the partial transcript.

## Source map

- `server/src/myrmidon/debates/` — debate protocol, service, routes, and persistence adapters.
- `server/src/routes/` — authenticated debate endpoints.
- `server/src/services/agent-runs.ts` — run and cancellation semantics used by turns.
