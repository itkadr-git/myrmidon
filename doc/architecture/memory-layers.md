---
title: Memory layers
summary: How Hindsight banks, agent configuration, and run memory fit together
---

This page describes the memory path from an agent run to the Hindsight bank. It complements [[wiki]] and the operator-facing [agent memory guide](../../docs/myrmidon/guides/agent-memory-card.md).

## Components

- The local `hindsight-paperclip` plugin owns recall and retention tools and talks to the configured Hindsight API.
- The bank resolver first reads `adapterConfig.hindsight.bankId` from the agent card, then `bankByAgentId` from the plugin configuration. If neither exists, the agent has no memory bank.
- The server memory service uses the same resolution rule for the Runtime > Memory card, so operators inspect the bank the agent actually uses rather than an arbitrary bank.
- The Hindsight client is the network boundary. The API URL is required by the plugin; the API key is optional and is resolved through the configured company secret reference.

## Run lifecycle

At run start, `recallOnRunStart` controls automatic recall: `new-issue` (the default) recalls once per issue, `always` recalls every run, and `never` disables automatic recall. The `hindsight_recall` tool remains available on demand in every mode.

Comments are buffered during a run. With `autoRetain` enabled, the plugin writes one `Run <runId> digest` per bank at run completion. The digest carries run, agent, issue, and comment-count metadata; duplicate comment ids and short or board-machinery comments are excluded. A failed retention is logged as a warning and does not fail the run.

## Isolation and operations

Banks are resolved per agent and are not operator-selectable in the Memory card. Company authorization is enforced before reading or changing a bank. Export, soft removal, and clear operations write activity-log events without storing memory text in the log.

The Memory card pages 50 entries, exports at most 5000 entries, and requires a typed agent-id confirmation before clearing a bank. Settings are read per request, so changing the instance memory address takes effect without a restart.

## Failure boundaries

No Hindsight address means the Memory routes return 503 and the UI explains that memory is not enabled. A missing bank is a valid agent state, not a server error. Hindsight failures are isolated from the heartbeat: the plugin warns and lets the run continue.

## Source map

- `packages/plugins/hindsight-paperclip/src/bank.ts` — bank selection.
- `packages/plugins/hindsight-paperclip/src/plugin.ts` — run hooks, tools, digest retention, and recall policy.
- `server/src/myrmidon/agent-memory/` — operator read/write routes and settings.
- `server/src/myrmidon/agent-memory/hindsight-client.ts` — Hindsight HTTP client.
