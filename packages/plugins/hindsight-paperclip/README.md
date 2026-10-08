# hindsight-paperclip (local fork)

Local fork of the upstream `@vectorize-io/hindsight-paperclip` 0.3.0 memory
plugin, carried in this repository instead of `node_modules` so bank routing
can follow the memory-isolation rules. Not published; installed from this
path (the host's `POST /api/plugins/install` local-path mode auto-builds
packages under `packages/plugins/`).

## What changed from upstream

Upstream derives the memory bank two ways — one static shared bank, or
`paperclip::<company>::<agent>` — and knows nothing about per-agent bank
routing. This fork routes per agent and is **closed by default**:

1. `adapterConfig.hindsight.bankId` on the agent card (read through the
   plugin SDK's `ctx.agents.get`, authorized by the manifest's `agents.read`
   capability);
2. otherwise `bankByAgentId[<agentId>]` from the plugin configuration — the
   map an operator keeps synchronized from the agent cards;
3. otherwise the agent is closed: **retain is skipped with a warning in the
   plugin log, recall returns nothing.** There is no fallback to a shared
   bank.

The same resolution (`src/bank.ts`) is applied in every memory path:

- `issue.comment.created` — an agent's comment waits in run-scoped plugin
  state; a comment outside a run (a human's, or an event with no run id) is
  retained immediately into the author's (or, for a human comment, the ticket
  assignee's) bank;
- `agent.run.finished` — one consolidated digest document per bank is retained
  for the run's buffered comments: duplicates collapse, bodies under 200
  characters and board-machinery comments (milestone headings, status
  transitions, wake notices, review verdicts) are dropped, and the buffer is
  cleared afterwards. A retention failure is warned about, never fatal;
- `agent.run.started` — recall into the running agent's bank, cached in
  run-scoped plugin state, and gated by `recallOnRunStart` (`new-issue` by
  default: once per ticket this agent picks up);
- the `hindsight_recall` tool — reads the same bank;
- the `hindsight_retain` tool — writes the same bank.

Retain metadata now carries `agentName` (the agent card's name) next to
`agentId`, so memory can be classified by author without touching the
board's database; a run digest additionally carries `kind: "run-digest"`,
`runId`, `agentIds`, `issueIds` and `commentCount`.

The per-user `bankGranularity` mode and the static/dynamic `bankId` modes of
upstream are removed: every agent must resolve through the sources above.

## Configuration

| field | meaning |
| --- | --- |
| `hindsightApiUrl` | Hindsight API base URL (required) |
| `hindsightApiKeyRef` | secret ref for the API key (self-hosted: leave empty) |
| `recallBudget` | `low` / `mid` / `high` (default `mid`) |
| `autoRetain` | retain a run's comments as one digest when the run finishes (default `true`) |
| `recallOnRunStart` | `always` / `new-issue` (default) / `never` — run-start recall policy |
| `bankByAgentId` | agent id → bank id map, the card-less fallback |
| `enabledAgentIds` | optional allowlist of agent ids |

## Tests

`pnpm --filter @myrmidon/hindsight-paperclip test` — vitest, no network: the
HTTP transport is injected as a mock and the plugin runs on the SDK's
in-memory test harness.
