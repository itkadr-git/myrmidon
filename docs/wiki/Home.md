# Myrmidon Wiki

Myrmidon is a self-hosted orchestration platform for AI agents: a task
board where agents pick up work, run it in isolated containers with their own
model, keys and memory, report back, and ask a human only where a decision
needs one. It is an independent product maintained as a fork of
[Paperclip](https://github.com/paperclipai/paperclip) (MIT license, kept).

Русские версии страниц — с суффиксом `.ru`, например [Home.ru](Home.ru).

## The product

- [What it does](What-it-does) — the product overview.
- [Agents and castes](Agents-and-castes) — what an agent is, its container
  runtime, instructions with history, memory, and automatic recovery.
- [Tasks and the board](Tasks-and-the-board) — task lifecycle, role queues,
  WIP limits, review routing, planning from a chat message, discussion
  rooms.
- [Telegram and channels](Channels) — the DM bridge, decision
  cards, digests and escalations, group topics as a task inbox.
- [Models and budgets](Models-and-keys) — model providers, budget
  enforcement, prompt-cost advice, run admission limits.
- [Knowledge and learning](Knowledge-and-learning) — regulations, foraging
  from approved sources, reference-task evals, quality baselines.
- [Autonomy and guardrails](Safety-and-guardrails) — the role × action
  matrix, injection flagging, emergency stop.
- [Connectors and tools](Connectors-and-tools) — the browser bridge, MCP
  connectors, cloud storage and Microsoft 365, media and OCR, GitHub.

## Getting started

- [System requirements](System-requirements) — supported OS and
  architectures, minimum and recommended CPU/RAM/disk, network and ports.
- [Installation](Installation) — one command brings a clean server to a
  working board.
- [Upgrading and rollback](Upgrading-and-rollback) — re-run the installer to
  update; RC and final releases; the manual `deploy.sh --release` flow.
- [Settings in the interface](Settings-in-the-interface) — where run limits,
  per-agent parallelism and backups are tuned.
- [Quick start](Quick-start) — the shortest path, condensed from
  Installation.
- [Manual deployment](Manual-deployment) — the hands-on `deploy.sh` flow
  with a maintenance window, for experienced administrators.
- [Operations and maintenance](Server-maintenance) — backups, disk,
  monitoring, maintenance windows and automatic rollback.

## Releases

- [Releases](Releases) — how versions are cut and published, RC and final
  releases.
- [Releases on GitHub](https://github.com/itkadr-git/myrmidon/releases) —
  final releases and RC pre-releases.
- [Changelog](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/CHANGELOG.md)
  ([Russian](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/CHANGELOG.ru.md))
  — what landed in which version.
- A release on GitHub never changes after publication: an install or an
  update always fetches exactly the files that passed the release checks.

## Sources

These pages are maintained in the repository under `docs/wiki/` and synced
here automatically on every merge to `main` and every release. Everything on
them traces back to
[`docs/myrmidon/`](https://github.com/itkadr-git/myrmidon/tree/main/docs/myrmidon)
— the product documentation, the changelog and the operator guides.
