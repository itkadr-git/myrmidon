# Settings in the interface

> Русская версия: [Settings-in-the-interface.ru](Settings-in-the-interface.ru)

Where day-to-day setup happens in the board UI. Sources: the
[README](https://github.com/itkadr-git/myrmidon/blob/main/README.md)
configuration section and the operator guides under
[`docs/myrmidon/guides/`](https://github.com/itkadr-git/myrmidon/tree/main/docs/myrmidon/guides).

## The map in one paragraph

Models and agents are configured on their cards; the autonomy matrix and the
member list live in **Company Settings**; the UI 2.0 shell sits under
**Instance Settings → Experimental**; a per-user board language (RU/EN) is on
the 2.0 "Language and formats" screen. Feature switches that are still
environment variables (`MYRMIDON_*`, all off by default) are listed in
[SETTINGS.md](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/SETTINGS.md).

## Run limits (the instance)

**Instance → General → "Run limits"** — changeable at runtime, without
restarting the server and without interrupting runs in flight
([run-limits](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/run-limits.md)):

| Setting | What it bounds | Default |
|---|---|---|
| `maxConcurrentRuns` | How many runs the server may have in flight at once | off |
| `maxStartsPerMinute` | Start ramp: how many runs may start within a sliding minute | `5` (since 1.6.2) |
| `minFreeMemoryMb` | Free memory in the server cgroup required to start a run | off |
| `runMemoryEstimateMb` | The per-run memory budget | `300` |
| `minFreeHostMemoryMb` | Free host memory (`MemAvailable`) required to start a run | `15360` (15 GB, since 1.6.2) |

Each field shows where its effective value comes from — saved setting,
environment variable, or built-in default.

## Per-agent parallelism

On the agent card, the **Container** section: the scheduling policy
(`runtimeConfig.heartbeat.maxConcurrentRuns`) sets how many runs of this
agent may be active at once; the board normalizes the value into the 1–50
range and writes it to the bot's gateway config. The card compares what the
board asks with what the bot's gateway actually applied and flags a
divergence
([bot-container-card](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/bot-container-card.md)).

Related: the **WIP limit** caps how many tasks one agent holds in flight —
**Company Settings → WIP limit**, with the live load on every agent row
([wip-limit](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/wip-limit.md)).
Role queue parameters (lease TTL, per-agent active-task ceiling, sweep
interval, P0 preemption) are edited live in **Instance → General → Role
queues (SWARM-CLAIM)**
([swarm-claim-settings](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/swarm-claim-settings.md)).

## Parallel helpers

Agents can split a task across parallel helper subagents
(`delegate_task`). On the card of a `hermes_gateway` agent, the **Parallel
helpers** section turns this on and sets the per-agent limit, the helper
model and an optional per-helper turn budget; **Instance → General →
"Parallel helpers"** sets the company ceiling (default `10`, hard cap `50`)
and the per-agent default (`2`), and shows a capacity hint summing the
resolved limits against the host's build slots. Saving applies on every bot's
next reconcile tick, without a restart. Details:
[parallel-helpers](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/parallel-helpers.md).

## Backups

The database backup retention policy lives in the general instance settings
(`instance_settings.general.backupRetention`): the daily/weekly/monthly
tiers, and — since 1.6.5 — the optional **"Keep only the latest backup"**
flag on the general instance settings page. When it is on, a backup run
stream-verifies the new dump and only then deletes the older ones; a dump
that fails verification is deleted, previous backups are kept and the run
fails with the reason
([changelog](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/CHANGELOG.md),
1.6.5 BACKUP-KEEP-LAST).

Backup and restore runs are not bounded by the database's
`statement_timeout`: since 1.6.5 every connection the backup or the restore
opens sets the session `statement_timeout` to `0` — no limit — (a startup
parameter of the JavaScript client, and `PGOPTIONS="-c statement_timeout=0"`
for the pg_dump/psql child processes), so a long `COPY` of a large table is
never aborted by a database-wide limit set with
`ALTER DATABASE ... SET statement_timeout`. All other board connections
keep the database limit unchanged (1.6.5 BACKUP-STATEMENT-TIMEOUT).

## Also in the interface

- **Host disk threshold** — Instance → General, "Host disk" (default 85 %);
  the board measures the host disk fill on every scheduler tick and raises
  an attention signal.
- **Per-bot disk quotas** — the "Per-bot disk quota" panel on the general
  instance settings page, with overrides on the agent card.
- **Budget enforcement** — signal only, pause with a card to the owner, or
  hard refusal of new runs; set live for the instance
  ([budget-enforcement](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/budget-enforcement.md)).
