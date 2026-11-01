---
title: Debates
summary: Asymmetric generator-critic debates with an independent judge
---

> Русская версия: [debates.ru.md](debates.ru.md)

Debates are a bounded, asymmetric exchange about one task question. The engine assigns a constructive generator and an adversarial critic from different model families, then asks an independent judge from a third family to assess the transcript and deliver a verdict and answer. The debate service owns the task-scoped run, settings, gateway calls, and result document.

## Protocol

The generator and critic give independent first answers; the critic does not see the generator's position before forming its own. They then exchange up to three rounds. The engine stops early when the critic signals `[AGREE]`, or stops when the shared token ceiling is reached. A judge outside both debater families reads the transcript and produces the verdict; it is not a quorum or a synthesis of arbitrary agent votes.

The model-family constraint is validated before calls or persistence: generator and critic must differ, and the judge must differ from each. A family collision is rejected rather than silently accepted. See the [asymmetric debate guide](../myrmidon/guides/debate-asym.md) for configuration, endpoints, and cost behavior.

## Governance boundary

Debates do not expand agent permissions. Agent-initiated runs are gated by the autonomy matrix; board-initiated runs follow board authority. Role/model usage and cost are included in the result document, and agent-initiated spend is recorded in task cost events for budget enforcement. The call that crosses the token ceiling is recorded separately and excluded from charged total.

## Failure handling

Configuration errors, missing gateway credentials, and gateway failures have distinct API outcomes. The service writes the debate result document on success and records role-level cost. The result captures rounds, stop reason, tokens, and model cost breakdown.

## Source map

- `server/src/myrmidon/debates/service.ts` — task-scoped debate orchestration and result persistence.
- `server/src/myrmidon/debates/routes.ts` — debate HTTP endpoints.
- `packages/shared/src/myrmidon-debate.ts` — asymmetric protocol and stop rules.
- `docs/myrmidon/guides/debate-asym.md` — configuration, API, family constraint, and cost details.
