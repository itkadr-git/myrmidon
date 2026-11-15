> Русская версия: [Agent-execution-architecture.ru](Agent-execution-architecture.ru)


---
title: Agent and execution architecture pages
summary: Map of the five Myrmidon execution architecture components
---

Below is a summary of the five core architecture pages. Links point to `docs/architecture/`, which holds detailed technical specifications and source file paths.

## Components

- [Agent Adapters](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/../architecture/agent-adapters.md) — the server selects an adapter, forwards launch requests and cancellations, and stores normalized status, usage, cost, and continuation state. `hermes_gateway` connects to a running API, reads the event stream, and translates the final outcome; policies and budgets remain the server's responsibility.
- [Execution Workspaces](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/../architecture/execution-workspaces.md) — the driver prepares a directory or worktree and passes the path to the runtime. A hygiene service measures size and enforces quotas; limits come from stored settings, environment variables, or defaults.
- [Agent Chat](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/../architecture/agent-chat.md) — addressing resolves agent mentions, identity distinguishes web and Telegram conversations, and the bridge links messages and commands to a conversation and thread. Bounded neighbor-channel context may be included; universal event deduplication and strict delivery ordering are not guaranteed.
- [Debates](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/../architecture/debates.md) — a generator and critic from different model families start independently; the exchange runs up to three rounds and stops on agreement or token ceiling. An independent judge from a third family issues the verdict; the outcome and cost are recorded on the issue.
- [Agent Exchange](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/../architecture/agent-exchange.md) — manages rooms and round messages rather than knowledge publishing: rooms have statuses `open`, `stopped`, `completed`; messages have statuses `pending`, `done`, `error`. An individual participant failure is recorded and does not necessarily close the room.

## Shared boundary

Across all five components, runtime and transport remain separated from authority: the server enforces company boundaries, tasks, approvals, and budget rules. Workspaces do not grant extra permissions; Chat links addressing to a conversation, Debates bounds model disagreement, and Agent Exchange tracks the room progression and each message's state.

## Sources

Component source code lives in `server/src/myrmidon/`; exact paths are listed on each main page. The [system architecture](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/../start/architecture.md) page describes the overall request flow.
