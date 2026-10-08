# Operations and maintenance

> Русская версия: [Server-maintenance.ru](Server-maintenance.ru)

Running Myrmidon is not only installing it. This page covers what keeps a
deployment healthy day to day: backups, disk, monitoring and the board's own
maintenance surface.

## Backups

The deploy script refuses to touch anything before a database dump exists:
`deploy.sh` runs the configured `DUMP_COMMAND` into `DUMP_DIR` before the
image switch, and a missing or suspiciously small dump (`DUMP_MIN_BYTES`)
refuses the deploy outright. The same dump is the restore path for a
rollback with data — see [Upgrading and rollback](Upgrading-and-rollback).

One caveat worth knowing: the vendor's config backups inside bot volumes are
wiped by the board. The vendor's runner copies the resolved config — with
secrets — into `hermes/backups/config/` on every successful config load; a
bot's volume backup could hold the resolved values, so the board removes
`hermes/backups` as a best-effort step on profile rebuild. Treat any older
host-backup copies accordingly.

## Disk

On 03.10.2026 the host disk filled to 100 % and the board fell over before
anything warned about it. The BOT-DISK parts are the layered answer:

- every bot container has exactly one writable volume with a **per-bot disk
  quota**, so one runaway clone cannot take the host down;
- shared **package caches** (pnpm, Go modules, git objects) are mounted
  read-only into every bot, so downloads are kept once per host;
- the board measures the fill level of its own host disk on every scheduler
  tick and raises an attention signal with the numbers and the biggest
  consumers when it crosses the threshold (85 % by default);
- a **workspace reaper** archives git working copies after their issue tree
  becomes terminal, with a short cooldown for copies whose branch is already
  merged.

## Monitoring

- The board serves its own `/metrics` endpoint in Prometheus text format
  (0.0.4). Access is one bearer token from a company secret or
  `MYRMIDON_METRICS_TOKEN`; without a configured token the endpoint answers
  401 for everyone — it never falls open.
- The **stack registry** is the board's single list of the components the
  deployment runs on — the board itself, its upstream, the shared services —
  with what the server process can see locally: a version, a commit, an
  image digest, or an honest «unknown».
- The **LLM tracing health** check makes a silent break of the
  LiteLLM → Langfuse pipeline visible as a status card and an operator
  signal instead of empty tables discovered days later.
- The team-liveness stand scenario is the check that lets the operator
  watchdog be switched off: the board brings the team back by itself after
  the gateway dies mid-run.

## The maintenance surface

- A **maintenance window** shows a banner at the top of the board saying
  what is under maintenance and what it means for runs; per-agent windows
  aggregate into the banner.
- The **server console** opens a terminal of a fleet server right in the
  owner's browser for the moments something needs hands.
- **Automatic rollback by health** protects every deploy: when the
  post-switch health check fails, the host executor switches the image back
  to the remembered one without waiting for a human.

## In detail

- [Deploy: backups and the preflight dump](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/deploy.md)
- [Per-bot disk quota](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/bot-disk-quota.md)
- [Shared package cache and git objects](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/bot-disk-cache.md)
- [Host disk usage signal](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/host-disk.md)
- [Workspace cleanup after merge](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/workspace-cleanup.md)
- [Stack registry](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/stack-registry.md)
- [Maintenance banner](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/maintenance-banner.md)
- [Server console](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/server-console.md)
- [Automatic rollback by health](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/deploy-auto-rollback.md)
- [Stand scenario: kill the gateway mid-run](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/team-liveness-stand-scenario.md)
- `/metrics`: [SETTINGS.md](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/SETTINGS.md), section «METRICS»
