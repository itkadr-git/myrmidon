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
Swarm self-organization parameters (starting pheromone strength per
priority, waiting bonus, penalty for a failed run without a task change,
cooldown, lease TTL, per-agent active-task ceiling, P0 preemption) are
edited live in **Instance → General → Self-organisation (swarm)** — the
swarm is off by default and is turned on with the "Enabled" switch; how to
switch the swarm on and verify it in three steps —
[swarm-self-organization](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/swarm-self-organization.md).
Lower-level queue details —
[swarm-claim-settings](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/swarm-claim-settings.md).

## Agent castes (the company role directory)

**Company Settings → Agent castes** — the company's own directory of agent
roles. It starts from the twelve built-in castes and the owner can create,
edit, and delete castes; the role on the agent card is a key from this
directory, and changes are visible to the swarm at once, without a restart
([custom-castes](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/custom-castes.md)).

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

## Also in the interface

- **Host disk threshold** — Instance → General, "Host disk" (default 85 %);
  the board measures the host disk fill on every scheduler tick and raises
  an attention signal.
- **Per-bot disk quotas** — the "Per-bot disk quota" panel on the general
  instance settings page, with overrides on the agent card.
- **Budget enforcement** — signal only, pause with a card to the owner, or
  hard refusal of new runs; set live for the instance
  ([budget-enforcement](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/budget-enforcement.md)).

## Attention screen: cache and failed-run window

The **Attention** screen is served from a per-company in-process cache, so a
poll from every open tab shares one feed build instead of rebuilding the list
on each request. Two keys of `instance_settings.general` tune it. They are set
through the instance settings API (`PATCH /api/instance/settings/general`,
fields of the general settings object) and apply live, within a few seconds,
without a restart; there are no fields for them on the settings page yet:

- `attentionFeedCacheTtlSeconds` — how long a built snapshot is served
  (default 60 seconds, accepted 0–300, `0` disables the cache; a value past
  the bounds is clamped to the nearest one). A snapshot older than the TTL
  (and up to `2 × TTL`) is still served at once while one background rebuild
  refreshes it, so a read inside that window never waits for the rebuild and
  never receives a snapshot older than `2 × TTL`. Dismiss and snooze actions
  become visible on the next read — a write inside the TTL drops the stored
  snapshot and any rebuild that started before it.
- `attentionFailedRunHorizonDays` — how far back the failed-run window of the
  feed reaches (default 7 days, accepted 1–365, clamped the same way). Runs
  that exhausted their retries older than the horizon never enter the feed,
  which keeps the screen fast on a board with a long failure history; fresh
  failures are unaffected.

## Model shown for a gateway run

The run detail on the agent page names the model that actually answered.
For `hermes_gateway` runs the value comes from a three-step fallback: the
model the gateway returns in its response, then the LiteLLM `model_group`
the request was routed to, then the model configured on the launch. Empty
strings and the sentinel `unknown` are dropped at each step, so the field is
either a real model name or absent.
