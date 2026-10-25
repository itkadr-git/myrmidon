# Settings in the interface

> Русская версия: [Settings-in-the-interface.ru](Settings-in-the-interface.ru)

Where day-to-day setup happens in the board UI. The UI 2.0 company-settings sidebar
currently lists General, Members, Access, Secrets, Budgets, Autonomy, and
Agent castes, alongside the sections implemented in the UI 2.0 route table.
Guardrails is intentionally not shown: its screen and route are not implemented
in this release. Sources: the
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

## Run queue position and priority

A queued run's chat card shows its position, queue length and wait reason when
the server provides them. The UI uses run metadata first and fills missing
fields from the position endpoint; while the position is unknown, it polls
that endpoint every 30 seconds. On servers that do not serve the endpoint yet,
the line stays hidden rather than guessing.

**Instance → General → Run queue priority** lets an operator edit weights for
review, release, lead, engineer and docs roles, plus the current-release bonus
and queue-aging step/cap. Each field shows whether its value comes from saved
settings, the server environment or defaults. Changes apply on the next
admission pass without a server restart. The panel reports when the server
endpoint is not available instead of implying that a save succeeded.

## Access hub

The access hub is under **Company Settings → Access hub**. Its list endpoints
return access and host arrays when the module is enabled. When the module is
disabled, they return HTTP 200 with `enabled: false` and empty arrays. The UI
shows a "not available yet" notice instead of the access list. This is an
off-feature state, not an API failure. Check `GET
/api/myrmidon/access-hub/status` and `MYRMIDON_ACCESS_HUB_ENABLED` to confirm
whether the module is off. If status says enabled but a list request fails or
returns malformed data, investigate the API/service fault.

See the full [Access hub operator guide](../myrmidon/guides/access-hub.md) for
routes and behavior.

## Per-agent parallelism

### `hermes_local` isolation

Isolation is configured on the agent card in the Hermes adapter's
`adapterConfig`, not in the instance settings UI. It is off unless explicitly
configured. Set `filesystemScope: "workspace"` for a Bubblewrap workspace-only
filesystem boundary; optionally set `filesystemSandboxCommand` (default
`bwrap`) and `filesystemExtraPaths`. Network isolation is independent:
`networkScope: "deny"` disables networking, while `"allowlist"` uses
`networkAllowlist` for permitted hosts/origins. Bubblewrap must be installed on
the agent host. See the operator reference in
[SETTINGS.md](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/SETTINGS.md#hermes_local-process-isolation).

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
lease TTL, per-agent active-task ceiling, P0 preemption) are
edited live in **Instance → General → Self-organization (swarm)** — the
swarm is off by default and is turned on with the "Enable the swarm" switch;
the task cooldown after a run that moved nothing (base 30 min, cap 24 h) is
set by the wake guard (`general.swarm.cooldownBaseMin` /
`cooldownCeilingHours`); how to
switch the swarm on and verify it in three steps —
[swarm-self-organization](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/swarm-self-organization.md).
Lower-level queue details —
[swarm-claim-settings](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/swarm-claim-settings.md).

## Parallel helpers

Agents can split a task across parallel helper subagents
(`delegate_task`). On the card of a `hermes_gateway` agent, the **Parallel
helpers** section turns this on and sets the per-agent limit, the helper
model and an optional per-helper turn budget; **Instance → General →
"Parallel helpers"** sets the company ceiling (default `10`, no built-in
upper bound since HELPERS-NO-CAP (1.6.1) — a saved ceiling above 50 only
shows a host-load warning) and the per-agent default (`2`), and shows a
capacity hint summing the resolved limits against the host's build slots.
Clearing either capacity field and saving sends `null` in the PATCH and removes
the stored hint. Saving applies on every bot's
next reconcile tick, without a restart. Details:
[parallel-helpers](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/parallel-helpers.md).

## Agent castes (the company role directory)

**Company Settings → Agent castes** — the company's own directory of agent
roles. It starts from the twelve built-in castes and the owner can create,
edit, and delete castes; the role on the agent card is a key from this
directory, and changes are visible to the swarm at once, without a restart
([custom-castes](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/custom-castes.md)).

## Budgets (per-level spend limits)

**Company Settings → Budgets** (`/company/settings/budgets`) is where the
owner sets spend limits per level of the agent hierarchy: the whole company
or one project (nest), a caste, the foraging pass, or a single task. Each
limit says how much the scope may spend per period (a calendar UTC month or
a lifetime) and what happens at the limit — hard refusal, or a soft pause
with a card to the owner. The row shows the spend against the limit (for
example `$600.00 / $500.00 (120% used)`, marked **Over the limit**) and is
edited in place: Save, Create and Remove go straight to the running API,
without a restart or a page reload. The switch at the top is the global
"signal only" mode — while it is on, crossing a limit only signals and
blocks nothing; the screen shows where the value comes from (the default,
the owner's saved choice, or the `MYRMIDON_BUDGET_LIMITS_SIGNAL_ONLY`
environment variable, which locks the switch). The bottom table is the
append-only change journal — who, when and what changed, newest first; a
removed limit keeps its rows. Reads need company access, every mutation
needs a board actor. Details:
[budget limits](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/budget-limits.md)
(the API and storage) and
[the owner's screen](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/budget-limits-ui.md).

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

## Attention feed windows

**Instance → General → "Attention feed"** — two windows of the attention
feed, editable live, applied on the feed's next build without a restart:

| Setting | What it bounds | Default |
|---|---|---|
| Failed-run horizon | How far back the feed looks for an unresolved failed or timed-out run | `7` days |
| Feed cache TTL | How long the feed reuses the snapshot it built per company | `45` s |

The horizon accepts whole days from `1` to `365`; the TTL accepts whole
seconds from `0` to `300`, where `0` turns the cache off (the feed is rebuilt
on every read). Each field shows its bounds, the built-in default, and whether
the value in force comes from the saved settings row or from the default.

The panel reads and writes through `GET`/`PATCH`
`/api/myrmidon/attention-feed`, backed by the instance settings row
(`attentionFailedRunHorizonDays`, `attentionFeedCacheTtlSeconds` in the
general block). A save is a partial write: only the window you changed is
written, and the change is audited per company. Neither window has an
environment variable, so the stored row (then the built-in default) is the
only source; a hand-edited value that is not a whole number within the bounds
reads as the default — the same fallback the feed itself applies.

- **Run stall detection** — the "Run stall detection" section on Instance →
  General (since 1.6.5) edits the stalled-run sweep live, without a restart:
  the sweep interval (`checkIntervalSec`, 15 s – 24 h) and the scan page
  size (`pageSize`, 1–200). The master switch and the silence threshold are
  shown read-only with a link to the Team liveness section, which owns them
  (`runStallEnabled`, `runStallThresholdSec` at
  `/api/myrmidon/team-liveness`). Each value shows where it came from — the
  saved settings row (`instance_settings.general.runStall`), the deployment
  environment (`MYRMIDON_RUN_STALL_*`) or the built-in default. Written by
  an instance administrator via `GET`/`PATCH` on `/api/myrmidon/run-stall`.
- **Board process composition** (since 1.6.6) — how many HTTP processes
  (`api`) and how many scheduler processes (`worker`) the deployment runs,
  read once at startup from the instance settings key `general.processes`.
  An absent key means `{ api: 1, worker: 0 }` — the single process, as
  before; a malformed row refuses startup with the fix in the log. With
  several processes, the per-process readiness endpoint
  `GET /internal/ready` and the aggregate `GET /healthz` (200 only when all
  api processes are ready) report the state to the load balancer.
- **Long task context** — a task whose history no longer fits the model
  window is reset automatically instead of failing the run on context
  compression: a session already past `resetPct` (default 70 %) of the
  model window is dropped before the next run resumes it, and the launch
  payload's history is bounded by volume as well as by count. Tuned by
  `MYRMIDON_LONG_TASK_CONTEXT_*` and `MYRMIDON_CONTINUATION_*` (since 1.6.6)
  — details in the
  [long-task-context](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/long-task-context.md)
  guide and in
  [SETTINGS.md](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/SETTINGS.md).

## Also in the interface

- **Host disk threshold** — Instance → General, "Host disk" (default 85 %);
  the board measures the host disk fill on every scheduler tick and raises
  an attention signal.
- **Per-bot disk quotas** — the "Per-bot disk quota" panel on the general
  instance settings page, with overrides on the agent card.
- **Budget enforcement** — signal only, pause with a card to the owner, or
  hard refusal of new runs; set live for the instance
  ([budget-enforcement](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/budget-enforcement.md)).
- **Attention feed windows** — the "Attention feed" panel on Instance →
  General (since 1.6.6) edits how far back the attention feed looks for an
  unresolved failed or timed-out run (1–365 days, default 7) and how long
  the built feed is reused per company (0–300 seconds, default 60; `0`
  turns the cache off; a snapshot older than the TTL, up to twice the TTL, is
  served at once while one background rebuild refreshes it). Each field shows its bounds, the built-in default
  and whether the value in force comes from the saved settings row or from
  the default. Saving applies without a restart: the feed picks the new
  value up on its next build. Read by any board member, written by an
  instance administrator via `GET`/`PATCH /api/myrmidon/attention-feed`
  (stored as `attentionFailedRunHorizonDays` and
  `attentionFeedCacheTtlSeconds` in the instance settings).

## Model shown for a gateway run

The run detail on the agent page names the model that actually answered.
For `hermes_gateway` runs the value comes from a three-step fallback: the
model the gateway returns in its response, then the LiteLLM `model_group`
the request was routed to, then the model configured on the launch. Empty
strings and the sentinel `unknown` are dropped at each step, so the field is
either a real model name or absent.
## Runtime behavior settings (behavior-settings API)

Starting with Myrmidon 1.7 (SETTINGS-TO-UI), runtime behavior settings can be read and modified dynamically without restarting the server:
- `GET /api/myrmidon/behavior-settings/definitions` — list all setting definitions, scopes, types, and defaults.
- `GET /api/myrmidon/behavior-settings` (and `?key=:key` or `/key/:key`) — read effective instance settings and sources (`ui`, `env`, `default`).
- `PATCH /api/myrmidon/behavior-settings` (and `PUT` alias) — update instance-level settings (instance admin only).
- `GET|PATCH /api/myrmidon/behavior-settings/company/:companyId` — read and update company-scoped settings (company access required).

Scope isolation is strictly enforced: instance endpoints reject company-scoped keys, and company endpoints reject instance-scoped keys with HTTP 400. Full API specification and setting catalog: [SETTINGS.md](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/SETTINGS.md#17--behavior-settings-api-runtime-settings-settings-to-ui).

# Agents page live-run refresh

The Agents page refreshes live-run data every 60 seconds. Use the page's manual refresh when an immediate update is needed.
