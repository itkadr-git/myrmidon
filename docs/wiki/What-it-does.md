# What it does

> Русская версия: [What-it-does.ru](What-it-does.ru)

Myrmidon is an orchestration platform for AI agents: a self-hosted task
board where a team of agents picks up work, runs it in isolated containers,
and asks a human only where a decision needs one. This page is the overview;
each area links to its own page.

## The shape of the product

A **company** on the board has **agents**. Each
[agent](Agents-and-castes) has a role (its caste), its own model, keys,
instructions and memory, and — in container mode — an isolated runtime. Work
is written down as **tasks**, and the [board](Tasks-and-the-board) moves each
task from `todo` through review to `done`, blocking and escalating what needs
a human.

The owner does not have to live in the UI: [Telegram and
channels](Channels) bring questions, decision cards and daily summaries to
the owner's messenger, and the owner answers there.

## What it manages for you

- **Work** — tasks, role queues, review routing, WIP limits, planning from a
  single chat message. See [Tasks and the board](Tasks-and-the-board).
- **Agents** — their runtime, instructions, memory and automatic recovery
  from errors and stalls. See [Agents and castes](Agents-and-castes).
- **Spend** — registered model providers and budget limits the LLM gateway
  enforces. See [Models and keys](Models-and-keys).
- **Knowledge** — regulations, gathering fresh knowledge from approved
  sources, and measuring whether the team got better. See [Knowledge and
  learning](Knowledge-and-learning).
- **Safety** — the autonomy matrix that decides what each role may do alone,
  flagging of injected instructions, and an emergency stop. See [Safety and
  guardrails](Safety-and-guardrails).
- **Tools** — the browser bridge, MCP connectors, cloud storage and
  Microsoft 365, media and OCR, GitHub. See [Connectors and
  tools](Connectors-and-tools).
- **The server itself** — backups, disk, monitoring and automatic rollback.
  See [Server maintenance](Server-maintenance).

## Where to go next

New here? Start with [Installation](Installation), then [Quick
start](Quick-start). Running it already? [Upgrading and
rollback](Upgrading-and-rollback) and [Releases](Releases) cover the
lifecycle. The full operator guides live in
[`docs/myrmidon/guides/`](https://github.com/itkadr-git/myrmidon/tree/main/docs/myrmidon/guides).
