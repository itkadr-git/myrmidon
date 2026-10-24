---
title: Agent adapters
summary: How Myrmidon invokes local and gateway-backed agent runtimes
---

> Русская версия: [agent-adapters.ru.md](agent-adapters.ru.md)

Myrmidon keeps execution behind an adapter boundary. The server selects an adapter from the agent configuration, passes a run request and cancellation hooks to its server implementation, then records the normalized result, usage, cost, and continuation state. UI and CLI modules parse the same result for operators; they do not execute the agent.

## Adapter families

The built-in families are `claude_local`, `codex_local`, `process`, and `http`. The Hermes integration adds `hermes_local` for a child process and `hermes_gateway` for an already-running Hermes API server. The gateway adapter does not start a local CLI: it creates a remote run, consumes its event stream, and maps its terminal state into the Myrmidon run contract.

The deprecated `@paperclipai/adapter-hermes-gateway` package is a compatibility shim. New installs use `@paperclipai/hermes-paperclip-adapter`; the adapter type remains `hermes_gateway`.

## Gateway lifecycle

1. Validate the target URL, authentication, adapter configuration, and request idempotency key.
2. Register cancellation before creating the run. A pre-cancelled request does not create a remote run.
3. Create the Hermes run with a bounded request timeout, then stream events until a terminal result.
4. On operator cancellation, call the remote stop endpoint and wait for final confirmation before acknowledging cancellation.
5. Store status, error code, usage, cost, session state, and diagnostics in the normal run record.

Health checks and connection failures are represented by stable adapter error codes. Plain HTTP to a remote target is denied unless the explicit unsafe-transport policy allows it; credentials are never included in diagnostics.

## Runtime boundaries

The adapter is an orchestration port, not a policy bypass. Company scoping, task checkout, budgets, approval gates, and activity logging remain server responsibilities. The runtime receives the run prompt and Myrmidon environment contract, while the adapter owns transport details, timeouts, event parsing, and cancellation.

## Source map

- `packages/adapters/hermes/src/gateway/` — gateway server implementation and tests.
- `packages/adapters/hermes-gateway/README.md` — compatibility package contract.
- `server/src/adapters/` — adapter registry and common execution contract.
- `docs/start/architecture.md` — system-level request flow.
