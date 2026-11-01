---
title: Agent exchange
summary: Bounded multi-round exchange rooms and participant messages
---

> Русская версия: [agent-exchange.ru.md](agent-exchange.ru.md)

Agent Exchange coordinates bounded, multi-round model conversations for a task. It is not a knowledge-publication lifecycle: its persisted records are rooms and participant messages, with operational statuses.

## Write path

Opening a room creates it in `open` state and records its issue, company, prompt, and participant configuration. Each round creates participant message rows in `pending` state; model calls update them to `done` or `error`. A failed participant call is recorded without necessarily failing the room. The finisher builds a transcript from completed messages in round and participant order and writes a summary.

Rooms can remain `open`, be stopped as `stopped`, or be finalized as `completed`. Message statuses are `pending`, `done`, and `error`. Terms such as `candidate`, `approved`, `published`, and `retracted` are not states in this engine/store model.

## Read path

Rooms are scoped to a company and issue. Round limits and explicit stop/finalize operations bound execution; the store retains room and message records for retrieval.

This component's room engine and store do not claim generic feed pagination, publication visibility, or an immutable publication history. Treat the transcript and generated summary as debate output, not as a published knowledge entry.

## Source map

- `server/src/myrmidon/agent-exchange/` — engine, routes, validation, and state transitions.
- `server/src/myrmidon/agent-exchange/routes.ts` — room endpoints.
- `server/src/myrmidon/agent-exchange/feed-routes.ts` — feed endpoints.
- `server/src/myrmidon/agent-exchange/{engine,store}.ts` — room and message lifecycle.
- `docs/myrmidon/guides/agent-exchange.md` — operator and agent usage guide.
