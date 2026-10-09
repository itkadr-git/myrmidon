# Myrmidon settings

> Russian version: [SETTINGS.ru.md](SETTINGS.ru.md)

Our settings are environment variables `MYRMIDON_<AREA>_<NAME>`. Vendor `PAPERCLIP_*`
variables remain as they are and are not described here, except where we change their
meaning or default value.

**Default values:**

- defect fix enabled;
- deployment-specific values (windows, limits, addresses) are disabled or neutral.

Our production values live in the private `myrmidon-deploy`, not here.

A track writes only into its own section. A row is added in the same PR as the setting.

**Columns:**

- **Variable** — the name.
- **Function** — the function number (`P1`…).
- **Default** — the value when the variable is unset.
- **What it does** — in one phrase.
- **How to disable / special** — for example, "`0` — no limit".

## Track 1 — platform

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|

## Track 2 — wake and run core

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_MAX_CONCURRENT_RUNS` | C0 | unset (disabled) | Ceiling of concurrent runs started by this server process: beyond it runs stay `queued`, the queue goes from oldest to newest. Counts runs of all agents of the process, not of one agent: the vendor only has a per-agent limit, and on 28.09 a mass wake started about 35 processes per container, the kernel killed the server together with all runs. A triggered limit schedules a repeat queue pass in 15 s instead of waiting for the next scheduler tick. The variable is the default at the FIRST start: afterwards the effective values are stored in settings (`instance_settings.general.runLimits`) and change on the fly on the Instance → General page ("Run limits") or via `GET`/`PATCH /api/myrmidon/runtime-limits` — the queue starts within a minute after the ceiling is raised, no server restart needed. The same `GET` view is the run-load screen of the instance: it carries the queue snapshot (runs in flight against the ceiling, how many wait, the head of the queue with its agent), the host CPU load the ceiling is measured against, and the memory snapshot — the host's available/total memory and the server container's cgroup v2 usage against its limit (`memory.max` − `memory.current`, the reclaimable `inactive_file` cache counted as free). Both settings panels show these lines next to the fields | Unset, empty, `0`, negative or non-numeric — the limit is off. Works together with the two variables below. An empty field in settings — the limit is off (same as `null` in `general.runLimits`); editing the DB row by hand takes effect after a restart |
| `MYRMIDON_MAX_RUN_STARTS_PER_MINUTE` | C0 | unset (disabled) | Ceiling of run starts over a sliding minute: a server restart or mass task approval does not start everything in one salvo. Unused reserved slots do not count. Default at first start, afterwards changed on the fly via settings (see the row above) | Unset, empty, `0`, negative or non-numeric — the limit is off |
| `MYRMIDON_MIN_FREE_MEMORY_MB` | C0 | unset (disabled) | A run starts only if after it the server cgroup (v2) retains this much free memory; each run is budgeted as `MYRMIDON_RUN_MEMORY_ESTIMATE_MB`, and runs started in the last 30 s are counted by budget until they have grown in the cgroup. Inactive page cache (`inactive_file`) counts as free | Unset, empty, `0`, negative or non-numeric — the limit is off. If the cgroup limit is not visible to the process (`memory.max` equals `max`, cgroup v1, process not in a container) — the memory check does not apply, and a warning `run admission cannot read the cgroup memory limit…` is written to the log once: then only the two variables above hold the ceiling. If the warning is present but the container limit is set — check how the server was started. Default at first start, afterwards changed on the fly via settings (see the `MYRMIDON_MAX_CONCURRENT_RUNS` row) |
| `MYRMIDON_RUN_MEMORY_ESTIMATE_MB` | C0 | `300` | How many megabytes are budgeted per run in the free-memory check. Default at first start, afterwards changed on the fly via settings (see the `MYRMIDON_MAX_CONCURRENT_RUNS` row); it cannot be disabled — free memory is computed from it | Unset, empty, `0`, negative or non-numeric — the default. In settings the field is required, `null` is not accepted |
| `MYRMIDON_STALE_LEASE_GRACE_MS` | P1 | `600000` (10 min) | How many milliseconds after a run finishes its active environment lease is left untouched by sweeping | Non-numeric or negative — the default. Sweeping cannot be disabled: this is a defect fix |
| `MYRMIDON_CONTINUATION_HISTORY_LIMIT` | P3 | `30` | How many newest entries of each task history list go into the run continuation context. The original and the last wake requests and comments are always preserved | `0` — no limit. Non-numeric or negative — the default |
| `MYRMIDON_DB_BACKUP_CATCHUP_WINDOW` | P11 | unset (disabled) | Enables catching up a missed dump at startup and anchoring the first scheduled tick to the newest dump. The value is the external backup window into which the catch-up and the first tick must not fall (they are shifted to its end) | Unset — vendor behavior. `none` — catch-up without a window. Window format: `<IANA-zone> HH:MM-HH:MM`, e.g. `UTC 01:00-01:15`; a window across midnight is allowed. An invalid value — catch-up disabled, a warning in the log |
| `MYRMIDON_SKIP_IDLE_HEARTBEATS` | M3 | off | A timer wake without a specific reason on an agent with no work does not start a run: the wake request is `skipped` with reason `heartbeat.timer.no_actionable_work` | `true`/`1`/`yes`/`on` — enable. Off — vendor behavior: skipping only for agents with `runtimeConfig.heartbeat.skipTimerWhenNoActionableWork` |
| `MYRMIDON_PENDING_INTERACTION_WAKE_GRACE_MS` | P12 | `600000` (10 min) | How many milliseconds a deferred wake of the card addressee waits before the sweeper resolves it: finalizes it `cancelled` if the card no longer awaits a reply, or re-admits it through normal admission if the task has no live run | `0` — resolve on the nearest tick; non-numeric or negative — the default value |
| `MYRMIDON_PENDING_INTERACTION_WAKE_RE_ADMISSIONS` | P12 | `1` | How many times the sweeper may re-admit one deferred wake while the addressee has not replied to the card; bounds the wake storm on a task | `0` — do not re-admit, only finalize; non-numeric — the default value |
| `MYRMIDON_PAUSE_DRAINS` | L3 | `1` (on) | An operator pause (`POST /agents/:id/pause`) does not cancel the agent's active runs — lets them finish. Cancellation still happens on a request with `cancelActive: true` or `?force=1` | `0`/`false`/`off`/`no` — restore vendor behavior (pause always cancels runs with code `agent_paused`). System pauses (budget, company archive, import) do not go through this route and are not affected by this setting. The same setting controls L3b: the stranded assigned-issue sweep does not escalate tasks of an agent on operator pause (`pause_reason = "manual"`); disabled — vendor escalation. Runs that a drained pause left to finish are stopped by a separate route `POST /api/myrmidon/agents/:id/emergency-stop` (L3b-ES): it does not depend on this setting and does not read it — see [guides/emergency-stop.md](guides/emergency-stop.md) |
| `MYRMIDON_PAUSE_RESUME_WAKE_BATCH` | L3 | `5` | How many stranded assigned tasks one batch wakes when the operator pause is lifted (`resumeAgentAfterPause`); promotion of the agent's already-queued runs is not batched | `0` — no batching: one batch for all tasks, as before this setting. Non-numeric — the default |
| `MYRMIDON_PAUSE_RESUME_WAKE_BATCH_PAUSE_MS` | L3 | `1000` | Pause between batches of stranded-task wakes when the pause is lifted | `0` — no pause (batching by `MYRMIDON_PAUSE_RESUME_WAKE_BATCH` remains). Non-numeric — the default |
| `MYRMIDON_OUTBOX_SWEEP_AGE_MS` | O1 | `45000` | The backup sweep pass of the continuation-wake outbox takes only intents older than the threshold: a just-created intent belongs to the direct post-commit delivery, an early sweep must not overtake it with a truncated envelope | `0` — immediate sweep (1.1.0 behavior). Non-numeric, negative or fractional — the default. Direct delivery (tryDeliver) is not bounded by the threshold |
| `MYRMIDON_PENDING_INTERACTION_WAKE_GRACE_MS` | P12 | `600000` (10 minutes) | How long a card wake parked for lack of an addressee waits after the last delivery before the backup pass resolves its receipt: the card is still answering, it must not be deferred; too early — the wake is extinguished before the addressee has time to accept it | Smaller — faster extinguishing with a silent addressee (coarser); `0` — resolution on the nearest scheduler tick. Non-numeric/negative — the default |
| `MYRMIDON_PENDING_INTERACTION_WAKE_RE_ADMISSIONS` | P12 | `1` | How many times the backup pass may re-admit a parked card wake (create a deferred run) against the same receipt while the card still awaits the addressee: the wake cannot storm the task every tick | `0` — re-admission disabled (the card waits only for direct delivery); larger — more retries with a silent addressee. The value is rounded down to an integer, non-numeric — the default |
| `MYRMIDON_IDLE_PICKUP_INTERVAL_SEC` | IDLE-PICKUP | `30` | How often (sec) the board itself wakes an agent with assigned `todo`/`in_progress` tasks and no live run: the top ready task by priority gets an `idle_pickup` wake bound to the task (issueId in context, without 403 cross-issue). A wake also fires right after a finished run releases the task execution lock. A ready task = without open blockers (`issue_relations` type `blocks` with an open blocker, including a cancelled one) and not a container (no open children). One run per pass; pause, maintenance mode, admission limits (C0), parallelism and agent daily ceilings are respected — checked by the wake admission path itself, not this pass | Values below 5 — 5. Non-numeric, `0`, negative or fractional — the default |
| `MYRMIDON_IDLE_PICKUP_ENABLED` | IDLE-PICKUP | `1` (on) | Master switch of auto-pickup: off — the board does not wake an idle agent with ready tasks (vendor behavior: only assignment, comment and timer) | `0`/`false`/`off`/`no` — disable (vendor behavior). Unset or unrecognized — enabled: a typo does not silently extinguish the fix |
| `MYRMIDON_IDLE_PICKUP_RECENT_SUCCESS_WINDOW_MS` | IDLE-PICKUP | `900000` (15 min) | How many milliseconds after a successful run on a task idle-pickup does not wake THIS SAME task: a fresh success without disposition is handled by vendor paths (successful-run-handoff, stranded-recovery) — they send an instructive wake, and a duplicate one creates a race. Other tasks of the agent are not delayed by this | `0` — suppression off (wake even after a fresh success). Non-numeric, negative or fractional — the default |
| `MYRMIDON_WORKSPACE_MERGED_COOLDOWN_MS` | WH-B | `1800000` (30 min) | A workspace whose branch is already merged (`deliveryState` = `merged_via_pr`/`merged_by_ancestry`) is archived after this short cooldown instead of the general terminal one (`PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS`, 7 days) — merged workspaces do not linger on disk for a week. The "do not delete unpushed or dirty" protection is not weakened: such workspaces are not archived at any cooldown | `0` — archive on the next pass. Non-numeric or negative — the default of 30 min |
| `MYRMIDON_WORKSPACE_STUCK_SIGNAL_AFTER_MS` | WH-B | `86400000` (24 h) | A terminal workspace that the reaper cannot delete (dirty tree, unpushed or unconfirmed work) longer than this threshold writes a signal to the activity log (`execution_workspace.issue_terminal_archive_blocked`, actorId `workspace_terminality_reaper`); otherwise such workspaces are visible only in pass counters. Dedup — at most once a day per workspace, the fact is stored in the workspace `metadata` (no migration), the record contains no host paths | `0` — signal right after terminalization. Non-numeric or negative — the default |
| `MYRMIDON_HOST_GITHUB_CREDENTIALS` | S2-hostcred | unset (host mode off) | Emergency return of the vendor host mode for GitHub: the run again inherits host credentials (`GH_TOKEN`, `GITHUB_TOKEN`, `GH_CONFIG_DIR`, `SSH_AUTH_SOCK`, `GIT_ASKPASS`, `GIT_SSH*`, `PAPERCLIP_GITHUB_HOST_HOME`, `GIT_CONFIG_*`) and talks to GitHub as the operator's account. By default the run takes the managed branch: the board issues the run token, `git`/`gh` launchers get credentials through the broker (secrets storage, access log entry) | Only exact `1` enables vendor host mode; as with L2, the value is not trimmed — `" 1"` and `"01"` do not count. Any other value (`true`, `yes`, `on`) and the absence of the variable — our behavior: a key from the host environment does not reach the run. Full closure (all GitHub calls through the storage and permissions) awaits S1-A and S6; until then the broker may rely on the server token |
| `MYRMIDON_RUN_STALL_ENABLED` | RUN-STALL | `1` (on) | Master switch of progress-based run liveness: off — a run whose own recorded progress stopped advancing is left running until the hard run timeout (vendor behavior) | `0`/`false`/`off`/`no` — disable (vendor behavior). Unset or unrecognized — enabled: a typo does not silently extinguish the fix |
| `MYRMIDON_RUN_STALL_THRESHOLD_SEC` | RUN-STALL | `1200` (20 min) | How long a running run may go without recorded progress (any appended run event, output flush, or useful action) before the sweep interrupts it as `run_stalled`: the task goes back to `todo` and its assignee is woken, so parts of the team-liveness work pick it up. Never a duration limit: a run working for hours with fresh progress is left alone | From 60 to 86400; values outside the range, non-numeric or fractional — the default |
| `MYRMIDON_RUN_STALL_CHECK_INTERVAL_SEC` | RUN-STALL | `60` | Minimum spacing between two scan passes of the stall sweep; the scheduler queue itself ticks more often | Values below 15 or non-numeric or fractional — the default (60). The interrupt path itself is not rate limited by this |
| `MYRMIDON_RUN_STALL_PAGE_SIZE` | RUN-STALL | `50` | How many running runs one scan pass inspects at most, stalest progress first: the pass stays a bounded read of the runs table | From 1 to 200; values outside the range or non-numeric — the default |
| `MYRMIDON_STALE_BLOCK_ENABLED` | STALE-BLOCK | `0` (off) | Master switch of the stale-block watchdog: every `MYRMIDON_STALE_BLOCK_INTERVAL_SEC` it inspects blocked tasks and lifts a block whose every reason is dead (a blocker task `done` or `cancelled` — cancelled blockers never fire `issue_blockers_resolved` —, a passed `reasonRef.dueAt`, a cleared gate/event). The dead blocked-by edges are removed, the task returns to `in_progress`, and one system comment names the cause. Off (default) — vendor behavior: a dead reason holds the task blocked until a person intervenes | Only `1`/`true`/`yes`/`on` enable; unset, `0`, unrecognized or a typo — off (an opt-in feature, a typo must not silently enable it) |
| `MYRMIDON_STALE_BLOCK_INTERVAL_SEC` | STALE-BLOCK | `300` (5 min) | Minimum spacing between two stale-block sweep passes; the scheduler queue itself ticks more often, the sweep keeps its own throttle | From 15 to 86400; values below 15, non-numeric or fractional — the default |
| `MYRMIDON_STALE_BLOCK_SIGNAL_TTL_MS` | STALE-BLOCK | `86400000` (24 h) | How long the attention-feed card "stale block lifted" stays on the desk after the watchdog unblocked a task: the card fades after the TTL, the task's system comment stays as the durable audit trail. The feed is computed on the fly from a process-local registry, so a server restart also clears the cards | `0` — the card is not shown at all. Non-numeric or negative — the default |
| `MYRMIDON_GUARDRAILS_OUTPUT_ENABLED` | 1.6-GRD | off | flag-only secret/pii detectors on run output write to the guardrail_events journal | unset or 0 |
| `MYRMIDON_GUARDRAILS_OUTPUT_CATEGORIES` | 1.6-GRD | all | csv subset of detector categories (`secret,pii`) that fire | unset |
| `MYRMIDON_IDLE_SKIP_METRICS` | 1.2-COST-CACHING | off | Measures the effect of the idle-skip: every `heartbeat.timer.no_actionable_work` skip bumps process-wide counters (skipped empty wakes / saved model calls, 1:1) and writes one info log line with the running totals. Off — no counters, no log lines; the skip itself is unaffected | `true`/`1`/`yes`/`on` — enable the measurement. Any other value or unset — off |
| `MYRMIDON_PROMPT_CACHE_MIN_COST` | 1.2-COST-CACHING | unset (disabled) | A generic timer wake whose context snapshot is identical to the agent's previous finished run reuses that run's recorded answer instead of a new adapter invocation — but only when the recorded answer cost at least this threshold (USD; `costUsd`, falling back to `cacheAdjustedCostUsd`). Cheap or free answers are always recomputed: caching them saves nothing. The cached wake lands as a `skipped` request with reason `heartbeat.timer.cached_identical_prompt` naming the source run. Wakes with a concrete reason (issue/comment/task) never cache | A positive finite number (USD) — enable. Unset, `0`, negative or non-numeric — the cache is off |
| `MYRMIDON_DATASTORE_CARE_ENABLED` | DBC-4 | `1` (on) | The board watches its own database: once an hour it writes a snapshot (database size, per-table and TOAST bytes, index bytes, the heaviest `pg_stat_statements` queries, the settings the audit criteria watch, the age of the last backup) into `datastore_snapshots`, and on demand an audit report into `datastore_audit_reports`; both live 90 days of their own. Auditing only — no rules, no automatic actions | `0`/`false`/`off`/`no`/`disabled` — off: the hourly job does not start and the `/api/myrmidon/datastores*` routes answer 503 `datastore_care_disabled` |
| `MYRMIDON_DATASTORE_CARE_INTERVAL_SEC` | DBC-4 | `3600` | How many seconds between hourly snapshots | Non-numeric, `0` or negative — the default; the value is clamped to 60…86400 |
| `MYRMIDON_DATASTORE_CARE_RETENTION_DAYS` | DBC-4 | `90` | Own retention of `datastore_snapshots` and `datastore_audit_reports`; older rows are deleted by the same hourly pass | Non-numeric or negative — the default; the value is clamped to 1…3650 |
| `MYRMIDON_DATASTORE_CARE_TOP_QUERIES` | DBC-4 | `25` | How many heaviest queries the snapshot and the markdown export carry | Non-numeric or negative — the default; the value is clamped to 1…100 |
| `MYRMIDON_DATASTORE_CARE_BACKUP_DIR` | DBC-4 | the instance backup dir | Which directory the age of the last dump is read from (the `backup-freshness` criterion: ≤ 24 h) | Unset — the instance backup directory from the shared home-paths helpers |
| `MYRMIDON_DATASTORE_CARE_OPTIONAL_METRICS` | DBC-4 | `1` (on) | Extra metrics that only exist with an extension: pgvector column indexing and the full-text-search dictionary; without the extension the block reports `null`/`available: false` instead of failing | `0`/`false`/`off`/`no`/`disabled` — the optional block is not collected at all |
| `MYRMIDON_IDLE_PICKUP_WAKE_BUDGET_PER_MIN` | IDLE-WAKE-BUDGET | `5` | Company-wide ceiling of idle-pickup wakes inside one minute (batches): the board wakes at most this many ready agents of one company per minute, whichever path emits the wake | From 1 to 60; `0`, negative, fractional or non-numeric — the default. The ceiling is process-local: a restart only ever resets it towards allowing more wakes |
| `MYRMIDON_IDLE_PICKUP_WAKE_BATCH` | IDLE-WAKE-BUDGET | `5` | How many wakes one sweep pass may emit for one company: the minute's allowance arrives in batches spread over passes instead of one burst. Clamped to the minute budget, so a batch above it is the budget | From 1 to 60; `0`, negative, fractional or non-numeric — the default. A company that used its batch waits for the next pass; other companies in the same pass are unaffected |
| `MYRMIDON_RUN_LIVENESS_EVENTS` | N4-RUN-LIVENESS | `0` | Run liveness follows gateway progress instead of the wall clock in the hermes_gateway adapter: on, the fixed `timeoutSec` watchdog is replaced by a silence watch — a run that keeps emitting gateway events past its timeout stays alive, and only a run silent for the whole budget is reported timed out | `1`/`true`/`on`/`yes` turn it on for every card; anything else or unset keeps the vendor's fixed timeout. The card toggle «Liveness by gateway events» overrides the env for its agent |
| `MYRMIDON_PAUSE_GUARD_ENABLED` | 1.6.5 PAUSE-GUARD | `1` (on) | Master switch of the forgotten-pause guard: the board resumes agents the operator paused and left paused longer than the threshold. The pause must be the operator's own (`pause_reason = manual`) — budget, archived-company, import and plugin pauses are never lifted — and the agent's name must not be on the allowlist | `0`/`false`/`off`/`no` — the guard never lifts a pause; an operator resume is the only way back. Unset, empty or any unrecognized value keeps it on (a typo must not silently extinguish a defect fix). Stored in `instance_settings.general.pauseGuard.enabled` and changed on the fly (Instance → General, "Forgotten pauses", `PATCH /api/myrmidon/pause-guard`) |
| `MYRMIDON_PAUSE_GUARD_THRESHOLD_MIN` | 1.6.5 PAUSE-GUARD | `20` | How long an operator pause must have lasted, in minutes, before the guard treats it as forgotten. An agent whose `paused_at` is missing is never resumed ("cannot judge" is not "forgotten") | A whole number of minutes from 1 to 1440; anything else — the default. Stored in `instance_settings.general.pauseGuard.thresholdMinutes` and changed on the fly like the row above |
| `MYRMIDON_PAUSE_GUARD_INTERVAL_SEC` | 1.6.5 PAUSE-GUARD | `600` | How often the guard looks for forgotten pauses, in seconds. The pass rides the existing reconciliation queue and rate-limits itself to this interval; a settings change re-arms the next tick instead of waiting the interval out | A whole number of seconds from 15 to 86400; anything else — the default. Stored in `instance_settings.general.pauseGuard.intervalSec` and changed on the fly like the first row |
| `MYRMIDON_PAUSE_GUARD_ALLOWLIST` | 1.6.5 PAUSE-GUARD | unset (empty) | Comma-separated agent names the guard must never resume — the maintenance allowlist, a window an operator opens on named agents. Matched against `agents.name`, case-insensitively; empty entries and duplicates are dropped | Unset or empty — nothing is exempt. Stored in `instance_settings.general.pauseGuard.allowlist` (one name per line or comma-separated on the settings page) and changed on the fly like the first row |
| `MYRMIDON_PAUSE_GUARD_MAX_RESUMES_PER_PASS` | 1.6.5 PAUSE-GUARD | `20` | The ceiling on one pass: how many agents the guard resumes before it stops and leaves the rest for the following passes. The ceiling is what keeps a fleet-wide resume after a long night from starting every stranded backlog at the same instant; the remainder raises ONE notice per company on the attention desk while it waits | A whole number from 1 to 200; anything else — the default. Stored in `instance_settings.general.pauseGuard.maxResumesPerPass` and changed on the fly like the first row |
| `MYRMIDON_MAX_HOST_CPU_BUSY_PERCENT` | 1.6.5 RUN-ADMISSION | `90` | Host CPU utilisation ceiling of run admission, an ABSOLUTE percent of all cores: a new run starts only while the non-idle share of the CPU over a short recent window stays under this value. The window is the delta of two aggregate `cpu ` readings from `/proc/stat` kept by the admission (at least 250 ms apart); idle counts as the `idle + iowait` fields. Unlike the deprecated load-average ceiling this subtracts no background floor — utilisation already measures real work. When set (default), it decides ahead of `maxHostLoadPercentPerCore`: the load average then only fills the report fields. `0`/`off`/`false`/`no`/`none` switches it off; unset or garbage keeps the default. Readable paths: the file is the host's inside a plain Docker container (the kernel does not namespace `/proc/stat`); override the path with `MYRMIDON_HOST_PROCSTAT_PATH`. Unreadable counters leave the gate `unknown`, the ceiling inactive, and log the reason once. Stored in `instance_settings.general.runLimits.maxHostCpuBusyPercent` and changed on the fly without a restart (Settings → Runs & queue, `PATCH /api/myrmidon/runtime-limits`); a row saved before rc.3 lacks the key, which means off — that row keeps the old load-average rule. |
| `MYRMIDON_MAX_HOST_CPU_PSI_SOME_AVG10` | 1.6.5 RUN-ADMISSION | off | PSI cpu ceiling of run admission: the gate closes when the `some avg10` field of `/proc/pressure/cpu` — the percent of the last ten minutes in which at least one task stalled on the CPU — reaches this value. Default off: only an explicitly set value makes pressure close the gate (pressure rises on oversubscribed CPU, not on slow disk, so it guards a different failure than the busy ceiling). An unreadable pressure file while this ceiling is set makes the gate `unknown` rather than pretending zero. Override the path with `MYRMIDON_HOST_PRESSURE_CPU_PATH`. Stored in `instance_settings.general.runLimits.maxHostCpuPsiSomeAvg10`, changed on the fly like the other run limits. |
| `MYRMIDON_MAX_HOST_LOAD_PERCENT_PER_CORE` | 1.6.5 RUN-ADMISSION | `90` | Host CPU-load ceiling of run admission, counted ABOVE the host's own background load: a new run (any wake source) starts only while the host's 1-minute load average per core is under this many percent of one core more than the floor the host shows (100 = one core fully busy). The floor is learned from the readings themselves — the lower of the 1- and 15-minute load averages per core, kept as the lowest value seen and allowed to rise by 1 % of a core per minute — so the services a bot host runs for its own reasons (RAGFlow, hindsight and Langfuse held 100–145 % of a core per core on 05.10) do not close the ceiling, while a burst of runs, which raises the 1-minute average within seconds, cannot open it. Otherwise the run stays `queued` (not failed) and the queue pass retries it every 15 s. The 05.10 incident: 43+ runs started while the host memory floor was still open — load average 95 on 16 cores (~594 % of a core per core) starved the board's own API (3+ s answers, then timeouts); a saturated CPU queue is invisible to every memory reading. The load is read from `/proc/loadavg` and the visible core count from `os.cpus()`: inside a Docker container both are the host's (the kernel does not namespace them), so no mount and no Docker API call are needed. When either reading fails (no `/proc/loadavg`, lxcfs, no visible CPUs) the ceiling is inactive and `run admission cannot read the host CPU load…` is logged once. The swarm idle-wake pass wakes nobody while the ceiling is closed (log line `swarm idle wake pass skipped…`, at most once per 5 min). When the ceiling holds runs back for more than 10 minutes, an attention card «Runs held: host CPU load» appears for the operator; it disappears on the first admitted run. Stored in `instance_settings.general.runLimits.maxHostLoadPercentPerCore` and changed on the fly like the other run limits (Instance → General «Run limits», Settings → «Runs & queue», `PATCH /api/myrmidon/runtime-limits`); a row saved before 1.6.5 lacks the key and takes the environment value or the default | `0`, `off`, `false`, `no`, `none` — the ceiling is off. Unset, empty, negative or non-numeric — the default. An empty field / `null` in settings — off. A positive integer percent: 150 allows a run queue of one and a half cores' worth of demand. The path is overridable with `MYRMIDON_HOST_LOADAVG_PATH` (read once when the admission is created, a restart applies a change). The ceiling covers the host the board runs on: bots placed on other hosts (fleetd) are not measured. An instance that raised the absolute 90 to 200 by hand during the rc.1 standstill keeps 200, which under this rule means two cores' worth of load added by the runs. The settings page shows the reading, the background floor, the load above it and the open/closed verdict next to the field (`hostLoad` on `GET /api/myrmidon/runtime-limits`) |
| `MYRMIDON_MAX_PER_AGENT_START_SHARE_PERCENT` | 1.6.5 RUN-FAIRNESS | `15` | Single-agent start share of run admission: the most starts one agent may take in a 10-minute window, in percent of all starts. Past its share the agent's new runs stay `queued` (`waitReason: agent_fair_share`) until the other agents have had their turns, so a hot agent cannot occupy the queue while the global ceiling is full. Editable on the fly like the other run limits (Instance → General «Run limits», Settings → «Runs & queue», `PATCH /api/myrmidon/runtime-limits`); a row saved before 1.6.5 lacks the key and takes the default | `0`, `off` or `100` — the share limit is off. Unset, empty or unreadable — the default 15 |
| `MYRMIDON_RUN_PRIORITY_ENABLED` | 1.6.5 RUN-PRIORITY | `on` | Master switch of the queue priority core. With it off, both sweeps keep the pre-feature ordering (global oldest-first fairness, per-agent readiness rank + issue-priority rank + createdAt). `0`, `off`, `false` turn it off; anything else (or unset) keeps it on. Stored as `instance_settings.general.runPriority.enabled` and flipped live on `PATCH /api/myrmidon/run-priority` | unset — on. The sweeps re-read the in-force settings every pass, so the next sweep after a settings change uses the new value without a restart |
| `MYRMIDON_RUN_PRIORITY_ROLE_WEIGHTS` | 1.6.5 RUN-PRIORITY | `review=90,release=90,lead=80,engineer=50,docs=50` | Weight per agent role (`agents.role`, compared case-insensitively). The run of a review agent at a closed admission starts ahead of an engineer's older run. Pairs `role=weight` separated by commas; a role with no entry falls back to the default role weight. Stored in `general.runPriority.roleWeights`; a settings write merges over the environment, then over the defaults | malformed pair — skipped with a log; negative/NaN — the whole map falls back to defaults. Weights are integers 0..1000 |
| `MYRMIDON_RUN_PRIORITY_DEFAULT_ROLE_WEIGHT` | 1.6.5 RUN-PRIORITY | `30` | The weight of any role not named in the role weights (including the built-in `general`). Stored in `general.runPriority.defaultRoleWeight` | non-integer/out of 0..1000 — default |
| `MYRMIDON_RUN_PRIORITY_ISSUE_WEIGHTS` | 1.6.5 RUN-PRIORITY | `critical=100,high=80,medium=60,low=40,none=20` | Weight per issue priority (`issues.priority`); the `none` key also covers unknown priorities and runs whose issue is missing. The issue priority orders the runs *inside* that band: a critical issue puts a run ahead of its lighter band mates, and never ahead of the role — or the current release — of another run. Stored in `general.runPriority.issuePriorityWeights` | malformed entry — skipped; the map needs at least the `none` key to survive a write |
| `MYRMIDON_CURRENT_RELEASE` | 1.6.5 RUN-PRIORITY | unset (off) | The release tag that earns the bonus, e.g. `1.6.5-rc.6`. A queued run whose issue carries a label with this name (or whose execution workspace branch contains it) is lifted one whole role band above the heaviest role, `releaseBonus` on top of the lane, so current-release work starts before every other role whatever its issue priority. Comparison is substring-either-way, case-insensitive; candidates shorter than 3 characters never match. Stored in `general.runPriority.currentRelease`; null/empty disables the lane | unset — the current-release dimension is off, no run is lifted |
| `MYRMIDON_RUN_RELEASE_BONUS` | 1.6.5 RUN-PRIORITY | `20` | Added on top of the lane a run matched by the current release is lifted by: the matched run starts one whole role band above the heaviest role. Stored in `general.runPriority.releaseBonus` | non-integer/out of 0..1000 — default |
| `MYRMIDON_RUN_AGING_STEP_MIN` / `MYRMIDON_RUN_AGING_STEP_WEIGHT` / `MYRMIDON_RUN_AGING_MAX_BONUS` | 1.6.5 RUN-PRIORITY | `10` / `5` / `50` | Anti-starvation aging: the effective weight grows by the step weight for every step minutes the run has waited in `queued`, capped at the maximum bonus — inside the run's own role band, so aging never lifts a run into another role's band. With the defaults a two-hour-old routine run scores +50 over a fresh one of the same role. Stored in `general.runPriority.agingStepMinutes/agingStepWeight/agingMaxBonus` | step minutes or step weight `0` — aging off; out-of-range values fall back to the defaults |
| `MYRMIDON_RUN_STARVATION_LIMIT_MIN` / `MYRMIDON_RUN_STARVATION_TOP_WEIGHT` | 1.6.5 RUN-PRIORITY | `90` / `10000` | The starvation escape: a run waiting in `queued` past the limit minutes takes the top weight outright, whatever its role or issue — it cannot stay behind the queue forever. Stored in `general.runPriority.starvationLimitMinutes/starvationTopWeight` | limit `0` — the escape is off, aging alone decides |
| `attentionFeedCacheTtlSeconds` (`instance_settings.general`) | ATTENTION-FEED-SWR | `60` | Per-company in-process TTL of the built attention feed snapshot. A snapshot older than the TTL (and up to `2 × TTL`) is served at once while one background rebuild refreshes it | From 0 to 300; `0` — the cache is off. Missing or out of bounds — the default |
| `attentionFailedRunHorizonDays` (`instance_settings.general`) | ATTENTION-WINDOW-CACHE | `7` | Horizon in days of the failed-run window of the attention feed: exhausted runs older than `now − horizon` stay out of the feed and the follow-up run lookup is bounded by `created_at > greatest(oldest failed run, now − horizon)` | From 1 to 365; missing or out of bounds — the default. No migration, no restart |
| `attentionFeedCacheTtlSeconds` (`instance_settings.general`) | ATTENTION-WINDOW-CACHE | `45` | Per-company in-process TTL of the built attention feed snapshot. Writes are visible with up to this delay | From 0 to 300; `0` — the cache is off. Missing or out of bounds — the default |
| `backupRetention.keepLastOnly` | 1.6.5-BACKUP-KEEP-LAST | absent (off) | Keep-only-the-last mode of the database backup retention. When `true`, a backup run ignores the daily/weekly/monthly tier presets: after writing the new `<prefix>-<timestamp>.sql.gz` dump it stream-verifies it (full gunzip pass plus a dump completion marker on the decompressed tail — the JavaScript dump's closing `COMMIT;` or the pg_dump trailer `-- PostgreSQL database dump complete`, 64 KiB tail buffer) and only then deletes every other `<prefix>-*` backup file in the backup directory. A new dump that fails verification is deleted, previous backups are kept and the run fails with the reason (`BackupVerificationError`, never retried on the other engine; a JavaScript fallback after a pg_dump child failure writes into a fresh dump writer). Independently of the flag, unfinished plain `.sql` leftovers older than 1 hour (orphans of interrupted runs) are pruned first and counted in `prunedCount` | Absent or `false` — the tiered retention works as before. The flag rides the existing `backupRetention` object on `PATCH /api/instance/settings/general`; payloads saved before 1.6.5 parse unchanged |
| `MYRMIDON_INPUT_LIMIT_PRECHECK` | 1.6.5-INPUT-LIMIT | on | Checks the model input limit before a run is sent: a task session that would overflow starts a fresh session generation, and an oversized single request is trimmed by the `hermes_gateway` adapter | `0` turns the whole check off; any other value keeps it on |
| `MYRMIDON_INPUT_LIMIT_CHARS_PER_TOKEN` | 1.6.5-INPUT-LIMIT | `3` | Characters-per-token ratio used to estimate prompt size against the input limit (accepted range 1 to 10) | An out-of-range or non-numeric value falls back to the default |
| `MYRMIDON_INPUT_LIMIT_SAFETY` | 1.6.5-INPUT-LIMIT | `0.9` | Share of the model input limit the estimate may fill before a fresh session is started (accepted range above 0 up to 1) | An out-of-range or non-numeric value falls back to the default |
| `MYRMIDON_INPUT_OVERFLOW_MAX_FAILURES` | OPE-6168 | 3 | Number of consecutive input-overflow failures of one agent on one issue after which automatic retries stop and the issue is escalated with an attention comment. Integer ≥ 1 | Unset for the default; invalid or `0` falls back to 3 |

## Track 3 — tool gateway and Hermes adapter

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_HERMES_RUNTIME_MCP_URL_BASE` | P4 | unset — the gateway address is not changed (as with the vendor) | The origin of the `hermes_local` run MCP gateway address is replaced with this base address (e.g. `http://127.0.0.1:3100`), path, query and token are preserved; only the origin pair is written to the log | Do not set. Per agent: `adapterConfig.runtimeMcpUrlBase` — its own base address, `adapterConfig.runtimeMcpUrlRewrite: false` — no rewriting. The field `adapterConfig.includeConfiguredMcpServers: false` — do not append servers from the profile into `-t` |
| `MYRMIDON_TOOL_BREAKER_FAILURES` | P9 | `3` | How many calls of one tool without a response (timeout, network, 5xx/408/429, non-JSON-RPC response) in the window put it on pause | `0` — breaker disabled |
| `MYRMIDON_TOOL_BREAKER_COOLDOWN_MS` | P9 | `60000` | Duration of the tool pause; after it one trial call passes | — |
| `MYRMIDON_TOOL_BREAKER_WINDOW_MS` | P9 | `600000` | Window in which failures of one tool are counted | — |
| `MYRMIDON_TOOL_TIMEOUT_MAX_MS` | P9 | `180000` | Ceiling of one tool call budget (vendor: 60 s) | — |
| `MYRMIDON_TOOL_TIMEOUT_SLOW_MS` | P9 | `45000` | Default budget for navigation tools (`navigate`, `goto`, `click`, `type`, `fill`, `press`, `reload`, `wait` in the name); the rest — 10 s, as with the vendor | At connection: `config.toolTimeouts` — budget by tool name |
| `MYRMIDON_WRITE_LOCK_REQUIRES_LIVE_RUN` | L5 | `1` | 409 `issue_write_assignee_run_lock` requires that the task's `checkoutRunId`/`executionRunId` point to a run in status `running`, `queued` or `scheduled_retry` (the vendor "non-terminal" trio, see `EXECUTION_PATH_HEARTBEAT_RUN_STATUSES`/`CANCELLABLE_HEARTBEAT_RUN_STATUSES`), not only at task status `in_progress` | `0`/`false` — the previous lock on `in_progress` status alone, run liveness is not checked. How to grant `tasks:manage_active_checkouts` (lock bypass) via config — `docs/myrmidon/design/issue-write-lock.md` |
| `MYRMIDON_CROSS_ISSUE_INFLUENCE_LIMIT` | P5 | `20` | Ceiling on the number of records of one run into tasks other than its own: comment, update, card decision; one counter per run | Unset, empty, non-numeric, `0`, negative or non-integer — the default of 20. The ceiling is a guard against record multiplication, there is no "no limit". Read on every record — no restart needed |
| `MYRMIDON_BOT_CENTRAL_HISTORY` | MEMORY-CENTRAL-B | off | Turns on central session history for the Hermes gateway adapter: the run's final output is saved to the bot's hindsight bank and the last turns are restored into the wake input of the same session. Needs a resolvable store address and bank (card fields `centralHistoryUrl`/`centralHistoryBankId`/`centralHistoryApiKey`, or `MYRMIDON_BOT_HINDSIGHT_API_URL`/`MYRMIDON_BOT_HINDSIGHT_BANK`/`HINDSIGHT_API_KEY`; the bank falls back to the card's `hindsight.bankId`) — a truthy flag without address or bank stays disabled. `1`/`true`/`yes`/`on` enables | Do not set, or `0`/`false`/`off`/`no`. Disabled = byte-identical vendor behavior: no requests, no restored block, no save. Per card instead of env: `adapterConfig.centralHistory: "0"` is not a kill switch for the env flag — clear the env instead. `adapterConfig.centralHistoryMaxTurns` (1–200, default 20) bounds how many turns are restored |
| `general.sessions` | PERF-DIET-K | unset (400 messages / 14 days) | Thresholds of an issue-scoped session generation of a container bot: `maxMessages` (a generation that recorded more runs than this rolls over) and `maxDays` (a generation older than this many days rolls over), plus `enabled: false` to turn the whole feature off. Read from the instance settings at every run dispatch, so a change needs no restart; edited in the Task session generations panel of the instance general settings page (the switch there is the operator's way to turn the feature off) | `{ "enabled": false }` — the session key stays unsuffixed, exactly as before this feature. An unreadable value reads as unset (defaults apply, the feature stays on) |
| `MYRMIDON_SESSION_GENERATIONS` | PERF-DIET-K | unset (on) | Environment fallback of the enable flag: `general.sessions.enabled` wins, this one applies when the row says nothing. Any value except `0`/`false`/`no`/`off` keeps the feature on, so a typo never silently disables it | `0`, `false`, `no`, `off` (or `general.sessions.enabled: false`) — no generation suffix is ever added |
| `MYRMIDON_SESSION_GENERATIONS_MAX_MESSAGES` | PERF-DIET-K | 400 | Environment fallback of the activity threshold: a generation that recorded more runs (wakes) than this rolls over. `general.sessions.maxMessages` wins over it. The board counts runs, not model messages: the transcript itself is not in the database, `heartbeat_runs.usage_json` is kept for observability only | Raise it, or turn the feature off — the generation then simply lives longer |
| `MYRMIDON_SESSION_GENERATIONS_MAX_DAYS` | PERF-DIET-K | 14 | Environment fallback of the age threshold: a generation whose first recorded run is older than this many days rolls over. `general.sessions.maxDays` wins over it | Raise it, or turn the feature off |

## Track 4 — chats and skills

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_TELEGRAM_DM_STATUS` | U1 | off | For a bridged Telegram DM (`MYRMIDON_TELEGRAM_DM_CONVERSATIONS`, X8b): the run gets one editable status message instead of milestone silence. `queued` and `working` coalesce into one durable status row (`run:<id>:dmstatus:<endpoint>`) — the delivery lane posts it once and edits the same provider message in place as the phase changes; the run's final answer replaces that message (the vendor's existing replace lane). Failure, admin-attention and completion milestones still publish as before, and the `/stop` terminal milestone stays suppressed (X8h) | Any value other than `1`/`true`/`yes`/`on` — the vendor path unchanged: routine milestones stay suppressed in the bridged DM (X8h). Read on every sweep, no restart. Groups and topics are unaffected |
| `MYRMIDON_TELEGRAM_DM_PROGRESS` | DM-PROGRESS | follows `MYRMIDON_TELEGRAM_DM_STATUS` | Forces the live progress steps in the bridged Telegram DM status message on or off, over the value saved in Instance settings → General | `1`/`true`/`yes`/`on` or `0`/`false`/`no`/`off`; anything else — the saved value. Read on every status update, no restart |
| `MYRMIDON_TELEGRAM_DM_PROGRESS_INTERVAL_SEC` | DM-PROGRESS | `45` | Forces the minimum spacing between two progress edits of the status message, seconds (15–300, clamped) | A non-integer value — the saved value. Read on every status update, no restart |
| `MYRMIDON_TELEGRAM_SPLIT_MAX_PARTS` | U1 | `0` (off) | How many parts a long structured Telegram answer may be split into inline, by paragraph/line/word boundaries, instead of the vendor's single `telegram_markdown_attachment` file. `0` keeps the vendor behavior byte for byte. Applies to answers the vendor already sends inline (plain prose) only for the structured case: plain-prose splitting continues to work without this setting | Unset, `0`, non-numeric or not a non-negative integer — the vendor's single attachment. Read at delivery time, no restart. Parts are capped: a document needing more parts stays an attachment |
| `MYRMIDON_TELEGRAM_FILE_LIMIT_BYTES` | P8 | unset — 25 MB (as with the vendor) | Ceiling on the size of a single file the Telegram adapter downloads, in bytes. For your own Bot API — up to `2147483648` (2 GB) | Unset, `0`, negative or non-numeric — the vendor's 25 MB. The effective limit is the lesser of this value and `PAPERCLIP_ATTACHMENT_MAX_BYTES`; the cloud Bot API itself does not serve files over 20 MB. Read at adapter creation — a restart is needed after a change |
| `MYRMIDON_TELEGRAM_DM_CONVERSATIONS` | X8a/X8b/X8c/X8e | empty (off) | Comma-separated Telegram endpoint ids, or `*` — all. For enabled endpoints: the bot's DM becomes a permanent Agent Chat conversation (key `telegram:<user id>`), not a new `chat_channel` task per session (bridge X8b; also requires `enableAgentChat` enabled; read on every message, no restart); in this DM, OpenClaw-style commands work: `/help /new /model /think /stop /status /close /task` (X8c); Telegram shows the DM its own main command list (menu X8e: `setMyCommands`, scope `all_private_chats`; set when the bot connects or reconnects). Groups and topics are unaffected — they keep the previous vendor menu. The contract is X8a | Empty (unset, only whitespace or only commas) — the vendor path unchanged: no bridge, no commands, no Bot API calls beyond the vendor's (the private-chat menu is neither set nor removed). Set but the endpoint is not in the list — its DM follows the vendor path, and on the next bot connection its private-chat menu is removed (`deleteMyCommands`, scope `all_private_chats`); when an endpoint is removed the private-chat menu is always removed while the variable is non-empty. To give the bot back the vendor private-chat menu, reconnect the bot before clearing the variable, leaving someone else's id in it — a cleared variable does not itself remove the menu in Telegram. Parts X8b (#104), X8c (#103) and X8e (#101) merged together with this row |
| `MYRMIDON_CHAT_CROSS_CHANNEL_MESSAGES` | X8d | `12` | How many newest messages of the same person's adjacent conversation (web ↔ Telegram) with the same agent are quoted into the turn prompt | `0` — the digest is off. Non-numeric or negative — the default |
| `MYRMIDON_CHAT_CROSS_CHANNEL_MESSAGE_CHARS` | X8d | `600` | Truncation of one quoted message, characters, with a `[truncated]` mark | Non-numeric or negative — the default |
| `MYRMIDON_CHAT_CROSS_CHANNEL_TOTAL_CHARS` | X8d | `4000` | Total character limit on the quote block; the oldest lines are dropped first, the skipped counter is a `(k earlier messages not shown)` line | Non-numeric or negative — the default |
| `MYRMIDON_CHAT_CROSS_CHANNEL_LOOKBACK_HOURS` | X8d | `168` (a week) | How old adjacent-conversation messages are still quoted | Non-numeric or negative — the default |
| `MYRMIDON_CHAT_RECONCILE_INTERVAL_MS` | D1 | unset | Minimum interval between run-milestone sweep runs (`enqueueChatRunMilestones`); replaces the standard coalescing-trigger interval (100 ms) rather than adding to it. The publication sweep (delivering messages to the provider) is untouched — it keeps its usual pace | Unset, `0`, negative or non-numeric — today's pace (the fix of the D1 queries themselves is always on, this is not a defect switch). Set (e.g. `15000`) if after D1 the milestone sweep is still noticeable in load when chats are idle |
| `MYRMIDON_CHAT_RECONCILE_FALLBACK_INTERVAL_MS` | 1.6.3 | `30000` | How often the full chat reconciliation pass (provider runtimes, deliveries, webhook recovery, Slack syncs) runs when no publication or milestone event wakes it; publication and milestone lanes are woken by commit events directly, and one full pass still runs at startup. Replaces the former once-per-second timer | Unset, `0`, negative or non-numeric — 30 seconds. Lower it if deliveries or provider recovery feel slow after the change |
| `MYRMIDON_TELEGRAM_VOICE_STT` | 1.6.5 VOICE-STT A | off | Transcribe an inbound Telegram voice/audio message at intake: the bytes are prefetched (bounded, 20 MB, 45 s), recognized through the shared STT core and the transcript is written into the task comment next to the kept attachment — the bot reads it as user input on the same wakeup. Speaker segments render as «Говорящий N [mm:ss]: …». An STT failure is a skip: the comment keeps the vendor body, the redacted `stt_skipped` code lands in the comment metadata, and the delivery is unaffected | Any value other than `1`/`true`/`yes`/`on` — the vendor path byte for byte: no byte prefetch, zero calls to the transcription core. Read per delivery, no restart. Set here it is the instance master switch and wins over the company setting in both directions; unset (or an unrecognized value), the company's own switch saved on the STT settings screen decides, so the feature can be enabled per company without a restart. Until the recognition model and the key secret are named (see the STT settings), an enabled turn records the stable `stt_unconfigured` skip |
| `MYRMIDON_TELEGRAM_DM_LANGUAGE` | TG-LOCALE | unset — the linked board user's Settings → Language choice, English default | Forces one language (`en` or `ru`) for every bridged Telegram DM service text (commands, statuses, refusals, notices) and for the Telegram private-chat command menu, instance-wide. A forced-override knob for the operator: the user's own choice is decided in the interface without a restart (read per message); this variable overrides it everywhere. The Settings → Language screen shows this source when it is set | Unset, blank or not `en`/`ru` (case-insensitive) — no force. Read on every message and every menu registration — no restart |

## Track 5 — operations

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_MAINTENANCE_DRAIN_TIMEOUT_SEC` | R3 | `900` | Maintenance-window drain timeout if the request has no `drainTimeoutSec` | `0` — immediate timeout; ceiling 86400 |
| `MAINTENANCE_ON_TIMEOUT` | DRAIN-INTERRUPT | `interrupt_and_retry` | Deploy-script setting (`deploy.env`): what the maintenance window does at the drain deadline. `interrupt_and_retry` drains for `MAINTENANCE_DRAIN_GRACE_SEC` and then interrupts the runs still going; each is retried when the window closes, so a planned deploy does not wait for long runs. Read by `scripts/myrmidon/deploy/{lib,deploy}.sh`, not by the server | `wait` — keep admission closed and wait out `MAINTENANCE_DRAIN_TIMEOUT_SEC` (the behaviour before drain-interrupt). Any other value — the deploy refuses before it touches anything |
| `MAINTENANCE_DRAIN_GRACE_SEC` | DRAIN-INTERRUPT | `300` | Deploy-script setting (`deploy.env`): how long the window drains before it interrupts the remaining runs (the `drainTimeoutSec` of the enter request in interrupt mode) | Ignored with `MAINTENANCE_ON_TIMEOUT=wait`, which uses `MAINTENANCE_DRAIN_TIMEOUT_SEC` |
| `MYRMIDON_MAINTENANCE_TICK_SEC` | R3 | `5` | How often the mode service recomputes windows: `entering → on`, timeouts, exit completion | From 1 to 3600 |
| `MYRMIDON_MAINTENANCE_CACHE_TTL_SEC` | R3 | `5` | How many seconds the admission gateway caches maintenance windows and the org structure (department membership) | `0` — no cache, DB read on every check. Transitions made by this process are visible at once |
| `MYRMIDON_MAINTENANCE_HOOK_TIMEOUT_MS` | R3 | `15000` | Upper bound for one maintenance integration hook call (`onEntered`/`onExited`, the Zabbix client). A hook that exceeds it is abandoned (it keeps running detached) and the window lifecycle continues; the timeout is logged and audited. Introduced after a hung `onExited` pinned `leaving` windows until every card change on the agent was blocked | From 1000 to 300000; a value outside the range falls back to the default |
| `MYRMIDON_ZABBIX_URL` | R3 | unset | Address of the Zabbix API (`…/api_jsonrpc.php`) for the instance maintenance window | Unset — the integration is off, no calls |
| `MYRMIDON_ZABBIX_TOKEN_REF` | R3 | unset | Reference to the Zabbix API token: `env:<NAME>` (variable) or `file:<path>` (a file, e.g. a Docker secret). The value is not logged | Unset — the integration is off |
| `MYRMIDON_ZABBIX_HOST_GROUPS` | R3 | unset | Comma-separated names of Zabbix host groups that are put into maintenance when the instance window is entered | Unset — the integration is off |
| `MYRMIDON_ZABBIX_MAX_WINDOW_SEC` | R3 | `14400` | Length of the Zabbix maintenance period; if the exit never happens, Zabbix closes the period itself | — |
| `MYRMIDON_SETTLED_HOLDS_BLOCK_EXPLICIT_WAKES` | L2 | `0` (off) | Restores vendor behavior: a settled (resolved/cancelled) resolution record with `evidence.automaticRecovery.replay = "blocked"` blocks even explicitly human-authorized wakes (comment, assignment, on_demand/manual, unpause, interaction), not only an automatic retry of the same run; a wake also does not cancel the same agent's run waiting in the queue (this cancellation is needed only when bypassing the lock, PR #91 review round 3). "Explicitly authorized" — only `requestedByActorType: "user"` (PR #91 review round 1: an automated collector with the same `reason`/`source` as a human — does not count) | `1` — enable (vendor behavior). Any other value or the absence of the variable — off (our default behavior: the lock passes explicitly human-authorized wakes and is replaced by them) |
| `MYRMIDON_STRANDED_AUTO_RETRIES_PER_DAY` | L4 | `2` | How many times over a sliding 24 hours `escalateStrandedAssignedIssue` sends the assignee a continuation asking to set the outcome before handing the task to `in_review` of the direct manager (`agents.reportsTo`) instead of a card to the owner. Counts only reasons `stranded_assigned_issue`/`successful_run_missing_state` with a successful last run. Only for `stranded_assigned_issue` is it exactly N attempts; for `successful_run_missing_state` the vendor `successful-run-handoff.ts` already sends its own (not ours, without our mark) correcting run before the task even reaches this counter — in total for this reason it comes to up to N+1 attempts, not exactly N (see `DIVERGENCE.md`, `L4`) | `0` — straight to the manager (if there is none or inactive — vendor escalation to the owner, unchanged). Non-numeric or negative — the default |
| `MYRMIDON_STRANDED_AUTOPOLICY_ENABLED` | L4 | `true` | Master switch of the whole L4 policy (steps 1 and 2 from the row above) — a quick rollback during an incident without a code change and without removing `reportsTo` from agents | `false` or `0` — straight to vendor escalation to the owner unchanged, `MYRMIDON_STRANDED_AUTO_RETRIES_PER_DAY` is not read. Unset or unrecognized — enabled (a typo does not silently extinguish the protection) |
| `MYRMIDON_ACCESS_HUB_ENABLED` | SEC1 | `false` | Включает раздел «Доступы»: API `/api/myrmidon/access-hub/*` (типизация секретов, генерация ssh-ключей, реестр хостов, журнал, выдача/отзыв доступов). Выключен — чтения отвечают `enabled: false`, мутации 409, хранилище не трогается | `1`/`true`/`yes`/`on` — включить. Значение выката задаётся отдельно, в закрытом `myrmidon-deploy` |
| `MYRMIDON_ACCESS_HUB_SSH_TIMEOUT_MS` | SEC1 | `30000` | Потолок времени одной ssh-операции access-hub (deploy/revoke/dryRun: чтение и запись authorized_keys) на один хост, включая connect и drain команды; по истечении процесс ssh завершается, операция отвечает `not_deployed` с человеческой причиной (значений ключа в ней нет) | Нечисловое, меньше 1000 или больше 300000 — умолчание |
| `MYRMIDON_ACCESS_HUB_SSH_ADMIN_KEY_SECRET` | SEC1 | не задана | Имя существующего секрета компании (админский root-ключ), значением которого доска ходит по ssh на хосты реестра при раскладке/отзыве ключей. Не задана — ssh-операции отвечают `not_deployed` с причиной «admin ssh key secret is not configured», остальной access-hub работает | Имя секрета; значением должен быть приватный ключ в PEM (PKCS#8). Значение секрета не логируется и не возвращается |
| `MYRMIDON_BASELINE_COMPARE_ENABLED` | BASELINE | `1` (on) | Enables the baseline comparison API endpoint (`GET /api/myrmidon/companies/:companyId/baseline/compare`) | `0`/`false`/`off`/`no` — disables the endpoint, it will return 503 |
| `MYRMIDON_DEPLOY_ENABLED` | R5-A | `0` (off) | Allows board deploys from the UI: without it write routes answer 503, reads work | `1` — enable. The default is off |
| `MYRMIDON_DEPLOY_HEALTH_URL` | R5-A | unset | Address of the board's own `/api/health` as the board container sees it: the job uses it to verify the version/commit after the switch | Unset — the final health check is impossible, the job will not close as successful |
| `MYRMIDON_DEPLOY_REPORTS_DIR` | R5-A | unset | Directory of host-runner reports (the deploy `$STATE_DIR`), mounted into the board container read-only | Unset — the board does not see runner reports, the job does not move past `maintenance_on` |
| `MYRMIDON_DEPLOY_STEP_TIMEOUT_SEC` | R5-A | `1800` | How many seconds a job may stand in one status before it cancels itself and closes the window | From 10 to 86400 |
| `MYRMIDON_DEPLOY_TICK_SEC` | R5-A | `5` | How often the job service reconciles state with the maintenance window, the runner report and health | From 1 to 3600 |
| `MYRMIDON_DEPLOY_VERIFY_TIMEOUT_SEC` | R5-A | `30` | Timeout of network digest checks (registry, GitHub) at job creation and preview | From 1 to 300 |
| `MYRMIDON_RELEASE_COMPONENTS` | RELEASE-GATE | `dockergate,fleetd` | Which release components `deploy.sh` rolls together with the board in one run (the 01.10 incident: the board moved, dockergate stayed). Digest resolution order: the `myr-vX.Y.Z` tag from the board image version label, else the `sha-<short sha>` tag of its commit. A release whose components are missing from the registry is refused before anything changes | `none` — deploy the board alone (not for a release: the incident was exactly that split). Components as a comma list; known names: `dockergate`, `fleetd` |
| `MYR_DOCKERGATE_HEALTH_URL` | RELEASE-GATE | unset | REQUIRED health probe of dockergate in the joint rollout: the value goes to curl verbatim (URL + arguments, e.g. `--unix-socket /run/myrmidon-dockergate/engine.sock http://localhost/_ping`) | Unset — the component rollout refuses after the switch (fail-closed): no success is reported without a check |
| `MYR_FLEETD_HEALTH_URL` | RELEASE-GATE | unset | The same for fleetd (e.g. `http://127.0.0.1:8080/v1/bots` with the auth header) | Unset — refuses after the switch, like dockergate |
| `MYR_DOCKERGATE_COMPOSE_SERVICE` / `MYR_DOCKERGATE_OVERRIDE_FILE` | RELEASE-GATE | `dockergate` / `docker-compose.myrmidon-dockergate.yml` | Service name and override file of dockergate in `$COMPOSE_DIR` when an installation differs | Override variables; for fleetd the same with `FLEETD` |
| `MYR_DOCKERGATE_HOST` / `MYR_FLEETD_HOST` | RELEASE-GATE (02.10 follow-ups) | `local` | Where the component actually runs: `local` — this host's compose project (the rollout proves the service is part of it via `docker compose config --services` and refuses before pulling or writing anything when it is not, fail-closed); `remote:<user>@<host>` — the service runs on another host (fleetd on the second host): docker/compose through ssh (key auth), the override is written there, the health URL is probed from the deploy host; `skip` — the component is not managed by this deploy (its own procedure rolls it out elsewhere), the rollout logs a loud SKIP and still CI-checks the digest | The 1.4.0 rollout created `paperclip-fleetd-1` on the board host (no config there, exited, removed by hand): point fleetd at the host it really runs on |
| `MYRMIDON_DEPLOY_SMOKE` | RELEASE-GATE | `1` (on) | Post-deploy smoke: within the timeout at least one bot container must re-apply (its status is `running`), else the deploy reports DEGRADED and prints the rollback commands | `0` — the smoke does not run at all (not for a release) |
| `MYRMIDON_DEPLOY_SMOKE_COMPANY` | RELEASE-GATE | unset | UUID of the company whose agents the smoke polls (the agents list is per-company) | Unset — the smoke is skipped with a warning in the `deploy.sh` output |
| `MYRMIDON_DEPLOY_SMOKE_AGENT` | RELEASE-GATE | unset | UUID of one specific agent for the smoke instead of polling all bots of the company | Unset — all `hermes_gateway` agents of the company are polled |
| `MYRMIDON_DEPLOY_SMOKE_TIMEOUT_SEC` | RELEASE-GATE | `300` | How long the smoke waits for a bot container to re-apply (the incident asked for 5 minutes) | From 10 to 1800 |
| `MYRMIDON_DEPLOY_SMOKE_INTERVAL_SEC` | RELEASE-GATE | `10` | Poll interval of the container statuses in the smoke | From 1 to 60 |
| `MYRMIDON_BOT_IMAGE_ROLLOUT` | BOT-IMAGE-ROLLOUT | `1` (on) | The bot runtime images (hermes, hermes-dev, hermes-node) of the same release roll out with the board (deploy.sh step 9.5, `bot-image-rollout.sh`): digests resolved from the same release, pulled, added to dockergate's `images` (config re-read by SIGHUP), the fleet enrolled in `bots[]`, the bot cards switched one at a time (canary first, a running run is never interrupted — a deferred bot retries), the superseded images removed after the fleet moved, every switch journalled | `0` — the manual path (the deploy warns: that is the 03.10 split by choice) |
| `MYRMIDON_BOT_IMAGE_ROLLOUT_CANARY` | BOT-IMAGE-ROLLOUT | unset | Agent id switched first, before the rest of the fleet (canary) | Unset — plain order |
| `MYRMIDON_BOT_IMAGE_ROLLOUT_BOT_TIMEOUT_SEC` | BOT-IMAGE-ROLLOUT | `900` | How long one deferred bot is retried (it keeps its old image; the periodic sweep applies the release image later) | From 10 to 86400 |
| `MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_CONFIG` | BOT-IMAGE-ROLLOUT | unset | Path of the dockergate `config.json` this rollout edits (`images[]`, `bots[]`): structural jq edits, verified by `dockergate check-config` when the command below is set | Unset — the rollout refuses (fail-closed): the images and enrollment are its job |
| `MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_CHECK_CONFIG_COMMAND` | BOT-IMAGE-ROLLOUT | unset | Command run after each config edit with `MYR_BOT_CFG_FILE` naming the edited file, e.g. `docker exec dockergate /dockergate check-config --config "$MYR_BOT_CFG_FILE"` | Unset — a warning: the edits are not verified by the real binary |
| `MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_SIGNAL_COMMAND` | BOT-IMAGE-ROLLOUT | unset | How dockergate is told to re-read its config (SIGHUP), e.g. `docker exec dockergate kill -HUP 1` | Unset — a warning: the file changed but dockergate keeps the old config until reloaded |
| `MYRMIDON_BOT_IMAGE_ROLLOUT_FLEET_HOSTS` | BOT-IMAGE-ROLLOUT | unset | Fleet hosts the bots run on (comma-separated, `remote:<user>@<host>` each, the `MYR_<COMPONENT>_HOST` shape): the images are pulled there and the fleetd `bots[]` is enrolled | Unset — everything bot-side happens on the local host |
| `MYRMIDON_BOT_IMAGE_ROLLOUT_FLEET_CONFIG` | BOT-IMAGE-ROLLOUT | `/etc/myrmidon-fleetd/config.json` | fleetd config.json on a fleet host (the rollout enrolls the same `bots[]` there) | Any readable path on the fleet hosts |
| `MYRMIDON_BOT_IMAGE_ROLLOUT_LOG` | BOT-IMAGE-ROLLOUT | `STATE_DIR/bot-image-rollout.log` | The rollout journal: `UTC agent-id old-image -> new-image (outcome)` per line | Any writable path |
| `MYRMIDON_BOT_IMAGE_ROLLOUT_BATCH_SIZE` | ONE-DEPLOY | `5` | Bot cards switched per batch; hard cap 5 (a larger value is clamped). A bot is switched only while its agent is paused or idle | 1 to 5 |
| `MYRMIDON_COMPONENT_AUTO_ROLLBACK` | ONE-DEPLOY | `1` | A component failure inside the deploy window rolls the changed components, the dockergate config and the board back together | `0` — manual contract: nothing rolls back, maintenance stays on |
| `MYRMIDON_RELEASE_MANIFEST_FILE` | ONE-DEPLOY | unset | An offline copy of the release manifest `release-components.json` used instead of the GitHub release (`release-manifest.sh --from-file`) | A readable file |
| `MYRMIDON_DEPLOY_HEALTH_POLL_SEC` | R5-A | `5` | Reserved: health poll interval in the verification phase | From 1 to 300 |
| `MYRMIDON_DEPLOY_HEALTH_TIMEOUT_SEC` | R5-A | `300` | Reserved: budget of the health verification phase | From 10 to 3600 |
| `MYRMIDON_DEPLOY_REGISTRY_INSPECT_URL` | R5-A | unset | Read-only inspect endpoint of the registry for digest verification, answers `?ref=<reference>` with JSON like `imagetools inspect`; for cases when the board container cannot see ghcr.io | Unset — the board reads ghcr.io directly |
| `MYRMIDON_DEPLOY_GITHUB_HEADERS_JSON` | R5-A | unset | JSON object of headers for GitHub API calls at commit verification (for rate limits); values are not logged | Unset — anonymous calls |
| `MYRMIDON_BUILD_DATE` | ABOUT | unset | Build date of the image shown in "About Myrmidon" (Instance → General and the sidebar footer): the image CI passes it as a build argument to the `Dockerfile`. Non-ISO or non-date value — the `buildDate` field of `GET /api/myrmidon/about` stays `null` | Unset or wrong format — the field is hidden, a local build without a stamp |
| `MYRMIDON_BASE_PAPERCLIP` | ABOUT | unset | Release of the vendor Paperclip base (e.g. `2026.916.1`) the image was cut from: the image CI passes it as a build argument; shown in "About Myrmidon" next to the Myrmidon version | Unset or a format other than `YYYY.N.N` — the `basePaperclipVersion` field stays `null` |
| `MYRMIDON_IMAGE_DIGEST` | ABOUT | unset | Digest of the running image (`sha256:…`) when the deployment pinned it (a full reference of the form `repo@sha256:…` is also accepted — the digest is taken after the `@`). Shown in "About Myrmidon" | Unset or not `sha256:<64 hex>` — the `imageDigest` field stays `null` |
| `MYRMIDON_DEPLOY_AUTO_ROLLBACK` | R5-C | `1` (on) | Health-based automatic rollback of the board: when the post-deploy health check fails, the host executor immediately runs the same `rollback.sh` against the locally remembered previous image (the emergency path: the CI check of the rollback target only warns), the job ends `auto_rolled_back` with the window closed; a failed rollback itself ends `failed_rollback`, the window stays on for the operator | `0`/`false`/`no`/`off` — the old contract: `failed_health`, the window stays on, the rollback is manual. The host side of the same switch is `AUTO_ROLLBACK` in deploy.env; both sides must agree |
| `MYRMIDON_DEPLOY_AUTO_UPDATE` | R5-C | `0` (off) | Allows board deploys without a confirmation in the interface. While off (the default) every deploy waits for an explicit human confirmation. Enable only after the release scenario has run on the staging stand (STAND, 1.1.2): auto-update without a stand is the risk the plan names | `1`/`true`/`yes`/`on` — enable (not before the STAND run) |
| `MYRMIDON_TRACING_LANGFUSE_URL` | TRACING-HEALTH | unset | Deploy-script setting (`deploy.env`), read by `scripts/myrmidon/deploy/tracing-check.sh`, which `deploy.sh` runs as step 7b/8: base URL of the Langfuse server. The check reads the public route `GET /api/public/health`, whose `version` is the v4 marker (v4 in `events_only` mode rejects the legacy `/api/public/ingestion`); the probe needs no credentials | Unset together with every other `MYRMIDON_TRACING_*` setting — the check logs a skip and the deploy continues. Set — the callback set must be verifiable, otherwise the check refuses |
| `MYRMIDON_TRACING_LANGFUSE_VERSION` | TRACING-HEALTH | unset | The Langfuse version pinned in the release bundle: the documented fallback when the health route is unreachable, guarded or answers without a version. A legacy `langfuse` callback with an unproven version is refused as well (a silent install is the incident this check exists for) | Unset with an unreadable probe — the version stays unproven and a legacy callback is refused. Not the same value as the Langfuse image tag |
| `MYRMIDON_TRACING_GATEWAY_CONFIG` | TRACING-HEALTH | unset | Path of the deployed LiteLLM gateway config: the `callbacks:` list under `litellm_settings:` is read as one of the effective callback sources (inline `[a, b]` and block `- a` forms) | Unset together with the command below — the check refuses: the effective set cannot be read, and nothing is assumed clean |
| `MYRMIDON_TRACING_CALLBACKS_COMMAND` | TRACING-HEALTH | unset | Deploy-script setting: command printing the effective callbacks of the live gateway (or its database), one per line or comma/space separated. Read together with the config file and the union is checked, because the file and the gateway database disagree and the database only adds callbacks | Unset together with the config file — refuses like above. To stop checking tracing at all, unset every `MYRMIDON_TRACING_*` setting |
| `MYRMIDON_TRACING_CALLBACKS_FILE` | TRACING-HEALTH | `$STATE_DIR/tracing-callbacks.txt` | The generated file with the callback list the bundle installs — the ONE source of truth, written from `tracing_intended_callbacks()` in `lib.sh` (`tracing-check.sh --write-intended`); the check reads the same file | Missing file — the function itself answers. The file is never a hand-written second list: the gateway config and the check are rendered from it |
| `MYRMIDON_TRACING_TOKEN_FILE` | TRACING-HEALTH | unset | Token file for a Langfuse deployment whose health route is behind auth. The value is not logged | Unset — the probe is anonymous |
| `MYRMIDON_TRACING_DELIVERY_COMMAND` | TRACING-HEALTH | unset | Deploy-script setting: command printing two integers for the delivery window — the OTEL event count in `events_core` (ClickHouse) and the LiteLLM SpendLogs request count. The installer sends a test request and waits for an event, so **zero events with traffic is a refusal, not a silent success**; a delivery ratio below 50 % and unreadable counts are refused too. The window is exported to the command as `MYRMIDON_TRACING_DELIVERY_WINDOW_SEC` | Unset — the delivery check is skipped with a log line. Part C measures the same ratio live on the board, same semantics |
| `MYRMIDON_TRACING_DELIVERY_WINDOW_SEC` | TRACING-HEALTH | `900` (15 min) | The window those two counts cover, in seconds, and the value the delivery command receives | Unset or empty — the default. The value is passed to the delivery command as-is; no validation is performed |
| `MYRMIDON_TRACING_LANGFUSE_IMAGE` | TRACING-HEALTH | unset | Image reference of the Langfuse server the bundle pins: it must carry a full `X.Y.Z` tag or a digest. A major or minor tag (for example `langfuse/langfuse:4`) moves under the deployment and is not a pin | Unset — the pin check is skipped. Set to a major/minor tag, `latest` or an untagged name — refused |
| `MYRMIDON_TRACING_GATEWAY_IMAGE` | TRACING-HEALTH | unset | The same pin rule for the gateway (LiteLLM) image of the bundle: full `X.Y.Z` tag or digest | Unset — skipped; anything that is not a full version or a digest — refused |
| `MYRMIDON_VENDOR_SHARE_THRESHOLD` | VENDOR-SHARE-METRIC | unset (0.5) | Forces the line-similarity threshold of the vendor-share script: a file is inherited when the share of matching lines against the vendor base commit is at or above it. The `--threshold` flag wins over this variable, which wins over the built-in 0.5; the printed report shows `thresholdSource` | A value outside 0..1 fails the run with a clear message instead of silently falling back. Unset — the built-in 0.5 and a `default` source in the report |
| `MYRMIDON_BOT_IMAGE_ROLLOUT_APPLY_WAIT_SEC` | BOT-IMAGE-ROLLOUT | `300` | How long the bot image rollout waits for one async apply job (202 + applyId) to reach succeeded or failed; a bot not finished in time is deferred and the periodic sweep completes it | From 0 up; whole seconds |
| `MYRMIDON_BOT_IMAGE_ROLLOUT_APPLY_POLL_SEC` | BOT-IMAGE-ROLLOUT | `4` | How often the rollout reads the apply job status | A positive integer (seconds) |
| `datastoreCare.retention.heartbeatRunsDays` | 1.6.5-DB-RETENTION | 90 | Retention of finished heartbeat runs (with their run events) in whole days; runs referenced by open work (open issues, retry parents of live runs, unresolved failed-run attention sources) or by any decision-making/native completion record (decisions, decision bundles, status decisions, work assessments, native run results) are kept regardless of age | Set to `0` to keep runs forever; changed from `PATCH /api/myrmidon/data-retention` |
| `datastoreCare.retention.activityLogDays` | 1.6.5-DB-RETENTION | 0 | Retention of activity-log rows in whole days; rows of a surviving run are kept so its audit trail stays complete | Set to `0` to keep the activity log forever |
| `datastoreCare.retention.accessAuditDays` | 1.6.5-DB-RETENTION | 180 | Retention of tool-access audit events and secret access events in whole days | Set to `0` to keep the access audit forever |
| `MYRMIDON_DB_BACKUP_FILE_PREFIX` | 1.6.5-DB-RETENTION | `paperclip` | The filename prefix the backup gate looks for: a backup counts as fresh only when the newest `<prefix>-*.sql.gz` in the configured backup directory is younger than 24 h; otherwise the sweep deletes nothing and writes a throttled `data.retention_waiting_for_backup` activity line | Unset or empty — the default `paperclip`. Set it to match the prefix of the dump tool that actually writes into the backup directory |
| `DB_TUNE_COMMAND` | DB-TUNING | unset (step skipped) | Deploy-script setting (`deploy.env`): the shell command applying the declarative PostgreSQL settings of the audit (runs `scripts/myrmidon/deploy/db-tuning.sql`); after the apply deploy verifies every `DB_TUNE_EXPECTED` pair through `DB_TUNE_SHOW_COMMAND` | Empty — the whole DB-TUNING step is skipped with a log line. Read by `scripts/myrmidon/deploy/{lib,deploy,rollback}.sh`, not by the server |
| `DB_TUNE_SHOW_COMMAND` | DB-TUNING | unset (check skipped) | Deploy-script setting: the command that must print the `SHOW` value of the parameter named in the exported `DB_TUNE_PARAM` (e.g. `docker compose … exec -T db psql -tAc "SHOW $DB_TUNE_PARAM"`) | Empty — the SHOW verification is skipped with a log line (the apply still runs when `DB_TUNE_COMMAND` is set) |
| `DB_TUNE_EXPECTED` | DB-TUNING | unset (check skipped) | Deploy-script setting: `name=value` pairs, one per line, the values the audit expects (`jit=off`, `work_mem=16MB`, `wal_compression=lz4`, `autovacuum_vacuum_scale_factor=0.05`); `rollback.sh` verifies the same parameters against the values recorded in `$STATE_DIR/db-tuning-previous` before the first apply | Empty — no pairs, no verification |
| `DB_TUNE_ROLLBACK_COMMAND` | DB-TUNING | unset (rollback skipped) | Deploy-script setting: the command returning the previous settings (runs `scripts/myrmidon/deploy/db-tuning-rollback.sql`); called by `rollback.sh` and by deploy when the DB-TUNING step fails after the apply | Empty — the settings rollback is skipped with a WARNING: the database keeps the tuned values |
| `PAPERCLIP_HEARTBEAT_RUN_CONTEXT_RETENTION_DAYS` | DBC-1 | 7 | Whole days after a terminal run's `created_at` before its `context_snapshot` is compacted (O1a key list stripped, `_compactedAt` stamped); overridden by `general.datastoreCare.retention.heartbeatRunContextDays`, `0` disables the compaction | Set `general.datastoreCare.retention.heartbeatRunContextDays: 0` via `PATCH /api/myrmidon/datastore-care` |
| `MYRMIDON_DB_BACKUP_FILE_PREFIX` | DBC-1 | paperclip | Filename prefix of the database backups the retention backup gate looks for (`<prefix>-*.sql.gz`, younger than 24 h); the same knob `runDatabaseBackup` writes under | Unset it to fall back to `paperclip`; disable the compaction entirely with `heartbeatRunContextDays: 0` |
| `MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_RELOAD_TIMEOUT_SEC` | DEPLOY-HARDENING | `30` | After the SIGHUP the deploy waits this long for dockergate to log the hash of the new config (`config_reloaded`); otherwise it fails loudly (the old config is still in memory) | A larger value for a slow host; the check itself cannot be turned off |
| `MYR_DOCKERGATE_HEALTH_URL` | DEPLOY-HARDENING | unused | No longer read: the host cannot ping dockergate (its socket answers only the board's main process, `403 caller_not_board_main`). dockergate is proven by its log (running container, newest `self-check ok` / `config_reloaded` line with the new version and config hash); `DOCKERGATE_LOGS_COMMAND` names the log when dockergate is not a compose service of the host. Supersedes the earlier `MYR_DOCKERGATE_HEALTH_URL` row | — |
| `MYRMIDON_PREDEPLOY_PG_COMPAT` | PREDEPLOY-PG-COMPAT | `check` | Deploy-script setting (`deploy.env`): after the throwaway copy starts, the predeploy check compares the copy with the production dump — same server major (dump header vs the copy's `SHOW server_version`) and every extension the dump restores available in the copy image, installed after the restore (`pg_extension`). A mismatch stops the deploy before the window | `off` — skip the comparison; a hard incompatibility still fails the restore itself |
| `DATABASE_URL` | SHARED-PG | unset | board database connection string; set by the installer or by hand, anchors the shared-PostgreSQL `DUMP_COMMAND` / `RESTORE_COMMAND` shape | keep the default container-embedded commands |
| `PAPERCLIP_PG_DUMP_PATH` | SHARED-PG-BACKUP | `pg_dump` (в `PATH`) | Путь к клиент-бинарнику `pg_dump` для движка бэкапа; на общем сервере 18 укажи клиент major 18+ — иначе плановый `auto` бэкап предупреждает и дампит JavaScript-путём | Не задана — клиент из `PATH`; поведение до 1.6.5, если клиент не старше сервера |
| `PAPERCLIP_PSQL_PATH` | SHARED-PG-BACKUP | `psql` (в `PATH`) | Путь к `psql` для восстановления бэкапа; при общем сервере 18 — клиент major 18+ | Не задана — `psql` из `PATH` |
| `MYRMIDON_DB_IMAGE` | SHARED-PG | `docker.io/pgvector/pgvector:pg18` | image of the shared PostgreSQL 18 + pgvector server of the internal profile (a `repo@sha256:...` digest pin is honoured) | set it to another image; `MYRMIDON_DB_PROFILE=external` drops the local server entirely |
| `MYRMIDON_DB_TOTAL_MEMORY_MB` | SHARED-PG | host `MemTotal`, capped at 16384 | the RAM budget the sizing below is computed from — sized for ALL services sharing the cluster | export it before running the installer |
| `MYRMIDON_DB_SHARED_BUFFERS` | SHARED-PG | total/4 MB | `shared_buffers` of the shared server | set an explicit value (e.g. `2GB`) |
| `MYRMIDON_DB_EFFECTIVE_CACHE_SIZE` | SHARED-PG | total*3/4 MB | `effective_cache_size` of the shared server | set an explicit value |
| `MYRMIDON_DB_MAINTENANCE_WORK_MEM` | SHARED-PG | total/64 MB (>= 64 MB) | `maintenance_work_mem` (index builds, the pgvector indexes included) | set an explicit value |
| `MYRMIDON_DB_WORK_MEM` | SHARED-PG | `16MB` | per-sort-node `work_mem` shared by every backend of the four services | set an explicit value |
| `MYRMIDON_DB_SHM_SIZE` | SHARED-PG | total/8, clamped 128 MB..1 GB | the container's `/dev/shm` for the parallel workers | set an explicit value or `MYRMIDON_DB_PROFILE=external` |
| `MYRMIDON_SHARED_SERVICES` | SHARED-PG | `litellm langfuse hindsight` | the extra databases/roles the shared cluster provisions next to the board's own; each service needs `MYRMIDON_<NAME>_PASSWORD` in the install environment | shrink or extend the list; the init script provisions exactly it |
| `MYRMIDON_INSTALL_DATABASE_URL` / `--database-url` | SHARED-PG | unset | external profile: point the board at the operator's shared PostgreSQL server; no db container, no pgdata volume is created | unset it and the installer falls back to the internal profile |
| `telegramNotify.errors.enabled` | 1.6-TG-NOTIFY-C | `false` | Master switch. Only when `true` does the sweep (see `MYRMIDON_TG_NOTIFY_INTERVAL_SEC`) read the attention feed of each company, filter error-class cards and stage notifications | `false` or missing — silence: no feed read, no publication, no rate-limit bookkeeping |
| `telegramNotify.errors.chatId` | 1.6-TG-NOTIFY-C | `null` | Target Telegram chat id. Notifications go to the existing chat publication path (conversation of that chat), never to a new Telegram client | Missing while enabled — the sweep is a no-op (nothing is sent until a target is configured) |
| `telegramNotify.errors.topicId` | 1.6-TG-NOTIFY-C | `null` | Topic thread id inside a forum chat. When set, notifications pick the conversation of that topic thread instead of the chat-level one | `null` — the chat-level conversation |
| `telegramNotify.errors.minSeverity` | 1.6-TG-NOTIFY-C | `"error"` | Severity threshold: `fatal` admits critical cards only, `error` admits high/critical, `warn` also admits medium ones. Cards below the threshold are skipped, not queued | Anything other than `warn`/`error`/`fatal` — the default (`error`) |
| `telegramNotify.errors.maxPerHour` | 1.6-TG-NOTIFY-C | `10` | Per-hour rate limit per company. Cards above the limit are dropped — never queued, never retried | Integer 0..1000; `0` sends nothing; anything else — the default (10) |
| `MYRMIDON_TG_NOTIFY_INTERVAL_SEC` | 1.6-TG-NOTIFY-C | `300` | Period of the periodic pass, in seconds. A pass whose previous run is still going is skipped, not queued. The timer itself always runs; every tick checks the per-company master switch first | 60..86400; non-integer or out of bounds — `300` |

## BOT-ROLLOUT — release bot-image rollout status and settings (1.6.5, part B)

| Variable / key | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_BOT_RELEASE_IMAGE` | BOT-ROLLOUT | unset | The release's bot image reference the board knows (any of the three bot image repositories, digest-pinned): the status API (`GET /api/myrmidon/agents/:id/bot-container/status`, field `imageRollout`) reports a real on/off-the-current-image verdict only when this is set | Unset — a tracking bot reports `no release image configured`; the rollout script keeps resolving the exact release image from the registry at deploy time |
| `MYRMIDON_BOT_IMAGE_ROLLOUT_BUSY_SOFT_PAUSE_SEC` | BOT-ROLLOUT | `0` | Soft pause after a busy bot before the batch moves on (part of the rollout settings) | `0` — off; the UI override cannot exceed the env value |
| `instance_settings.general.myrmidonBotImageRollout` | BOT-ROLLOUT | unset | The rollout settings edited from the instance settings page (`GET`/`PATCH /api/myrmidon/bot-image-rollout`): `botTimeoutSec` (busy-bot wait, 10..86400), `batchSize` (1..5), `busySoftPauseSec` (0..3600). Each env variable stays the default AND the upper bound — a stored value past the env cap reads as the cap | Unset/absent — the env value (or the module default) applies; an unreadable object reads as absent |

## Track 6 — security and models

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_RUN_ENV_ALLOW` | S2 | empty | Additional names of server environment variables (comma-separated, without values) that are passed into the run process beyond the base list | Base list: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TZ`, `TERM`, `TMPDIR`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `HTTP(S)_PROXY`, `NO_PROXY` (and lowercase), Windows: `SYSTEMROOT`, `WINDIR`, `COMSPEC`, `PATHEXT`. Non-secret server pointers: `PAPERCLIP_RUNTIME_API_URL`, `PAPERCLIP_LISTEN_HOST`, `PAPERCLIP_LISTEN_PORT`, `PAPERCLIP_RUNTIME_API_CANDIDATES_JSON`. CLI directory pointers: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `CURSOR_HOME`, `GROK_HOME`, `HERMES_HOME`, `KIMI_CODE_HOME`, `PI_CODING_AGENT_DIR`, `GH_CONFIG_DIR`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR`. Plus the credential variables of the adapter's own provider (`MYRMIDON_RUN_ENV_PROVIDER_ALLOW` in `myrmidon-run-env.ts`): `claude_local` — `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`; `codex_local` — `OPENAI_API_KEY`, `OPENROUTER_API_KEY`; `cursor` — `CURSOR_API_KEY`; `gemini_local` — `GEMINI_API_KEY`, `GOOGLE_API_KEY`; `grok_local` — `XAI_API_KEY`; `kimi_local` — `KIMI_API_KEY`, `KIMI_MODEL_API_KEY`; `opencode_local` — `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`; `pi_local` — `ANTHROPIC_API_KEY`, `XAI_API_KEY`; `hermes_local` — `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `KIMI_API_KEY`, `MINIMAX_API_KEY`, `ZAI_API_KEY`. Full inheritance — only via the agent flag `adapterConfig.inheritProcessEnv: true` |

## WORKSPACE-HYGIENE — shared pnpm store for workspaces

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_WORKSPACE_PNPM_STORE_DIR` | WORKSPACE-HYGIENE | unset — `<repository root>/.paperclip/pnpm-store` | Absolute path of the shared pnpm store into which `provision-worktree.sh` installs packages and from which they are imported into the workspace `node_modules` with hard links (`--config.package-import-method=hardlink`): one store for all workspaces of one repository instead of a full copy of packages per branch. The repository root is taken from `PAPERCLIP_WORKSPACE_REPO_ROOT` (then `PAPERCLIP_WORKSPACE_BASE_CWD`) — the default path lies on the same volume as the workspaces, so hardlink import works | A relative path in this variable is resolved from the same anchor. Store and workspace on different filesystems — installation falls back to vendor behavior (pnpm's own default store) with a warning to stderr |
| `MYRMIDON_WORKSPACE_PNPM_STORE` | WORKSPACE-HYGIENE | `1` (enabled) | Master switch of the shared store: `0`/`false`/`no`/`off` — `provision-worktree.sh` runs `pnpm install` with vendor argv without store flags | Disabling returns the previous disk usage (a full copy of `node_modules` per workspace) |
## BOT-DISK E — host disk usage signal

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_HOST_DISK_USAGE_THRESHOLD_PERCENT` | BOT-DISK E | `85` | The fill level of the host disk that raises the attention signal. The sweep measures the disk of the server data root (`MYRMIDON_HOST_DISK_DATA_ROOT`) on every scheduler tick, keeps a sample ring for the growth rate per hour, and when usage crosses this level the attention queue gets one row with the numbers and the biggest consumers. The value is the default at FIRST start only; the effective threshold lives in the instance settings (`instance_settings.general.hostDisk`) and changes live on the Instance → General page («Host disk») or through `GET`/`PATCH /api/myrmidon/host-disk` — the sweep re-reads it on every measurement, no restart | A non-integer or a value outside 1–99 — the default (85). A stored row that does not validate is ignored as a whole |
| `MYRMIDON_HOST_DISK_DATA_ROOT` | BOT-DISK E | `/data` | Directory whose filesystem usage is measured: `statfs` of this path reports the disk the board's database, workspaces and container volumes live on | Must exist and be readable by the server process; unreadable — the sweep logs one error per tick and no signal is raised |
| `MYRMIDON_HOST_DISK_CONSUMER_PATHS` | BOT-DISK E | the data root | Comma-separated directories ranked as «biggest consumers» in the signal: each is walked with a bounded depth/entry/time cap, biggest first | Unset — the data root itself is the one consumer listed |

### Task workspaces, the `myr-ws` CLI and the bot disk report (1.6.5 BOT-DISK-H, contract H0)

Inside the bot container the layout is fixed by the contract
(`docs/myrmidon/bot-disk-contract/README.md`):
`<HERMES_HOME>/.myrmidon/` holds `git-base/<owner>/<repo>.git` (bare bases),
`archive/<KEY>-<ts>.{bundle,patch,untracked.tar}` plus `manifest.json`
(archives of removed copies with unpushed work), `ws-registry.json` (the open
copies: `{version:1, entries:[{key, repo?, path, class:'E'|'G', branch?,
openedAt}]}`) and `disk-state.json` (disk pressure `{quotaPercent,
partitionPercent, pressure:'none'|'soft'|'hard'}`, written by botd on every
pass, read by `myr-ws open`; a file older than two botd ticks reads as
`pressure:"none"`). Task copies are `/workspace/<ISSUE-KEY>` worktrees on
branch `bot/<KEY>`; scratch copies live at `/scratch/<name>`.

`myr-ws` commands: `open <KEY> [owner/repo] [--base <ref>] [--scratch]`,
`list`, `close <KEY> [--force]`, `restore <KEY>`, `migrate`; global `--json`
(`{ok:true, …}` per command, any error `{ok:false, error, exitCode}` with the
human-readable message on stderr). Exit codes: `0` ok, `2` invalid arguments,
`3` quota/disk refusal (message starts with `BOT_DISK_QUOTA_EXCEEDED:`), `4`
repository over the base limit (8), `5` network/fetch, `6` no such
copy/archive, `7` unpushed work without `--force`. Environment:
`MYRMIDON_TASK_WORKSPACE` (the opened copy's absolute path, exported into the
run), `MYRMIDON_WS_BIN` and `MYRMIDON_WS_HOME` (test-only overrides).

The board side is two routes, called with the bot's own `PAPERCLIP_API_KEY`:
`GET /api/myrmidon/bots/me/workspaces` returns the desired state
(`{generatedAt, grace:{closingMinutes, scratchTtlHours, orphanHours},
pressure, workspaces:[{key, repo, state:'active'|'closing', since, prState,
branch}]}`; on 401/403/503 botd is fail-safe and deletes nothing), and
`POST /api/myrmidon/bots/me/disk-report` accepts the bot's disk snapshot
(bases, copies with `clean`/`pushed` and sizes, archives, at most 200 recent
actions, foreign copies with their sign, self-check results; body ≤ 1 MiB)
and answers `{ok:true, nextReportSec}` as the next tick's tempo.

dockergate gains two routes: `GET /myrmidon/disk` (partition statfs plus the
per-project `xfs_quota report -p` parse; without prjquota mounted —
`projects:[]`, `quotaEnabled:false`) and
`PUT /myrmidon/disk/<botKey>/quota` with body `{bytes}` (64 MiB…1 TiB) →
`{ok:true, projectId, hardBytes}`; deny codes `route_not_allowed`,
`quota_unavailable`, `bad_quota`. The board executes the existing per-bot
quota setting `general.botDiskQuota` through them.

Bot-facing instruction (to paste into the bot's system prompt or its task
message, 1.6.5 BOT-DISK-H design §2.2(4)):

> Your task's working copy is opened for you: `git clone <owner>/<repo>`
> becomes a worktree of a shared base (no own objects, no token in
> `.git/config`). Never pass `--filter`, `--depth`, `--mirror` or `--bare` —
> they are ignored. If you see `BOT_DISK_QUOTA_EXCEEDED:`, the bot partition is
> over quota: stop cloning, commit and push what you have, tell the board, and
> do not retry in a loop. Work inside the opened copy; the board archives and
> removes it when the task ends — do not delete `/workspace/<KEY>` yourself.

A `/v1/runs` request may carry `workspace: {key, repo, baseRef?}`: before the
model starts, the gateway runs `myr-ws open <key> <repo> [--base <baseRef>]
--json` and the run starts with `MYRMIDON_TASK_WORKSPACE=/workspace/<key>` as
cwd. Exit codes 3/4/5 do not fail the run silently: it starts in `/scratch`
with a warning event.

Attention cards (payload always carries `botKey` and `at`):
`bot_disk_lifecycle/agent-silent` (botd report older than 30 min in a running
container), `bot_disk_lifecycle/drift` (desired ≠ actual past grace + 15
min), `bot_disk_lifecycle/foreign` (a copy outside the base: promisor /
token in URL / no remote / `.trash-*` / full clone), `bot_disk_lifecycle/ws-cli`
and `bot_disk_lifecycle/reflink` (failed self-checks), `bot_image_stale` (bot
on a non-current image generation for over 24 h), `bot_disk_archive` (an
archive was created for the task; gone on restore or expiry).

Instance settings `general.botDisk.*` (changed on Instance → General,
`PATCH /api/myrmidon/bot-disk`; applied without a restart):

| Key | Default | What it does | Range / special |
|---|---|---|---|
| `general.botDisk.graceClosingMinutes` | `30` | Grace period (minutes) between a task turning `closing` in the desired state (terminal / reassigned / PR merged) and botd removing its worktree | 5–1440; out of range — the default. While the partition pressure is `hard` (quota ≥ 100 %) the effective grace is 0 |
| `general.botDisk.scratchTtlHours` | `24` | Idle TTL (hours, by mtime/ctime) of a scratch copy (class G): past it botd archives it if it holds unpushed commits, then removes it — the one place a timer is legitimate | 1–720; out of range — the default. Under hard partition pressure the effective TTL is 1 hour |
| `general.botDisk.partitionThresholdPercent` | `85` | Fill level of the bot partition (physical, from dockergate `GET /myrmidon/disk`) at which the instance card `host_disk_alert` is raised with the partition's figures | 50–100; out of range — the default |
| `general.botDisk.partitionRefuseOpenPercent` | `90` | Fill level of the bot partition at which `myr-ws open` refuses **every** bot with `BOT_DISK_QUOTA_EXCEEDED:` (exit 3) and every botd runs with grace 0 | 50–100; must be ≥ `partitionThresholdPercent`; out of range — the default |
| `general.botDisk.partitionCriticalPercent` | `95` | Fill level of the bot partition at which the critical instance card is raised and the owner gets a Telegram signal | 50–100; must be ≥ `partitionRefuseOpenPercent`; out of range — the default |
| `general.botDisk.pnpmStoreDir` | unset (per-bot store in the workspace mount) | Directory of the shared pnpm store; per contract it must sit **on the bot partition** (one store per partition), so a reflink import from it into the bot volumes works (reflink does not cross filesystems) | Unset — previous behaviour. When set, pair it with `pnpmImportMethod: clone` and a working reflink self-check (card `bot_disk_lifecycle/reflink` on failure) |
| `general.botDisk.pnpmImportMethod` | unset (image default `hardlink`) | pnpm `package-import-method`: `hardlink`, `clone`, `clone-or-copy` or `copy`. `clone` is reflink-only: a failure is loud, never a silent copy; a file edit inside `node_modules` cannot corrupt the store (unlike a hardlink) | Unset — previous behaviour. An unknown value is rejected by the settings schema |
| `general.botDisk.defaultRepo` | 1.6.5-BOT-DISK-H | unset (empty) | Repository `owner/repo` used when a task has neither a project repository nor a pull request: the run's `workspace` field and the desired state of the bot workspaces then point at it; without it such a task works in `/scratch` with a warning | `owner/repo` only (letters, digits, `_ . -`); `""`/`null` in `PATCH /api/myrmidon/bot-disk` clears it |
| `MYRMIDON_BOT_KEY` | 1.6.5-BOT-DISK-H | written by the board into every bot's `.env` (the bot's agent id) | Not a switch and not an operator setting: the bot's own key (an id, not a secret) that botd signs its disk report with (`botKey`), so the report is accepted under the caller's key; a body naming another bot is refused with 403 | Not set by hand; rewritten from the profile on every apply |
| `MYRMIDON_HOST_DISK_DATA_ROOT` | 1.6.5-F-03 | `/data` | Directory whose filesystem usage the host-disk sweep measures. Point it at the path actually mounted into the server container | change the value |
| `MYRMIDON_HOST_DISK_CONSUMER_PATHS` | 1.6.5-F-03 | the data root | Comma-separated list of directories, each measured on its own filesystem and returned in `measurements` | change the value |
| `POST_BOOT_CHECK_HOST_DISK` | 1.6.5-F-03 | `on` | post-boot-check.sh fails red when the host-disk sweep reports `measuredPath: null` | `off` |
| `MYRMIDON_GIT_LOCAL_MIRROR` | 1.6.5 BOT-DISK-G | `<HERMES_HOME>/.myrmidon/git-objects` (a scope member: `/bot-scope/.git-objects`, written by the profile compiler) | Bot-side directory of the bot's (or the scope's) bare git mirrors; the image's git wrapper clones GitHub repositories against it with `--reference-if-able`, so task clones store only their working tree. Must live inside the bot's single mount (or the scope instance's). Read by the wrapper from the environment or the profile's `.env` | `""` — off (every clone copies objects; the board's `/cache/git` mirror, when set, still applies). Related bot-side knobs: `MYRMIDON_GIT_LOCAL_MIRROR_REFRESH_SEC` (default 900; `0` never refetches), `MYRMIDON_GIT_LOCAL_MIRROR_MAX` (default 8 repositories per store), `MYRMIDON_GIT_OBJECTS_CHECK` (`0` skips the start-time self-check) |
| `general.botDisk.graceClosingMinutes` | 1.6.5-BOT-DISK-H | `30` | Grace period (minutes) between a task turning `closing` in the desired state (terminal / reassigned / PR merged) and botd removing its worktree; while the partition pressure is `hard` (quota ≥ 100 %) the effective grace is 0 | From 5 to 1440; unset or out of range — the default. Changed on Instance → General (`PATCH /api/myrmidon/bot-disk`), botd picks it up with the next desired-state fetch, no restart |
| `general.botDisk.scratchTtlHours` | 1.6.5-BOT-DISK-H | `24` | Idle TTL (hours, by mtime/ctime) of a scratch copy (class G): past it botd archives it if it holds unpushed commits, then removes it — the one place a timer is legitimate | From 1 to 720; unset or out of range — the default. Under hard partition pressure the effective TTL is 1 hour |
| `general.botDisk.partitionThresholdPercent` | 1.6.5-BOT-DISK-H | `85` | Fill level of the bot partition (physical, from dockergate `GET /myrmidon/disk`) at which the instance card `host_disk_alert` is raised with the partition's figures | From 50 to 100; unset or out of range — the default |
| `general.botDisk.partitionRefuseOpenPercent` | 1.6.5-BOT-DISK-H | `90` | Fill level of the bot partition at which `myr-ws open` refuses **every** bot with `BOT_DISK_QUOTA_EXCEEDED:` (exit 3) and every botd runs with grace 0 | From 50 to 100; must be ≥ `partitionThresholdPercent`; unset or out of range — the default |
| `general.botDisk.partitionCriticalPercent` | 1.6.5-BOT-DISK-H | `95` | Fill level of the bot partition at which the critical instance card is raised and the owner gets a Telegram signal | From 50 to 100; must be ≥ `partitionRefuseOpenPercent`; unset or out of range — the default |
| `general.botDisk.pnpmStoreDir` | 1.6.5-BOT-DISK-H | unset (per-bot store in the workspace mount) | Directory of the shared pnpm store; per contract it must sit **on the bot partition** (one store per partition), so a reflink import from it into the bot volumes works (reflink does not cross filesystems) | Unset — previous behaviour. When set, pair it with `pnpmImportMethod: clone` and a working reflink self-check (card `bot_disk_lifecycle/reflink` on failure) |
| `general.botDisk.pnpmImportMethod` | 1.6.5-BOT-DISK-H | unset (image default `hardlink`) | pnpm `package-import-method`: `hardlink`, `clone`, `clone-or-copy` or `copy`. `clone` is reflink-only: a failure is loud, never a silent copy; a file edit inside `node_modules` cannot corrupt the store (unlike a hardlink) | Unset — previous behaviour. An unknown value is rejected by the settings schema |
| `MYRMIDON_BOT_SCOPE_ROOT` | BOT-DISK-F | `<MYRMIDON_BOT_VOLUME_ROOT>/.scopes` | Host directory of shared isolation-scope instances: one subdirectory `<kind>-<id>` per instance (one pnpm store plus a subdirectory per member bot). Keep it on the same filesystem as the volume root. The same path as `scopeRoot` in the dockergate configuration | Leave unset (the default) and set no scope to *shared root*: every bot stays isolated |
| `general.botDisk.pnpmStoreDir` | BOT-DISK-D | `/workspace/.pnpm-store` | The pnpm store of bots: a path under `/workspace`, `/data`, `/scratch` or `/bot` (inside the bot's single mount, so hard links work). A path elsewhere (`/cache/...` included) is refused. Replaces `pnpmStore` (removed; a stored value is ignored) | `null` — the default. The image itself defaults to the same path |
| `general.botDisk.pnpmImportMethod` | BOT-DISK-D | `hardlink` | How pnpm puts a package into a clone: `hardlink` (only hard links are tried; pnpm 9 still copies silently where the kernel refuses a link, see the self-check), `clone-or-copy` or `copy` (explicit opt-outs; every clone then holds full copies) | `null` — `hardlink` |
| `MYRMIDON_GIT_STORE_STATE_MAX` | 1.6.5 BOT-DISK-G | `200` | Ceiling on the number of mirrors the start-time self-check lists in `storeState.repos[]` of `git-objects-check.json` (facts for the board and the lead). A full store is not an error: `mirrorCount` still reports the total, the list stops at the ceiling. `0` is not a disable switch — set `MYRMIDON_GIT_OBJECTS_CHECK=0` to skip the self-check itself | — |


## 1.6.1 — BOT-DISK B: shared package cache for bot containers

Not an environment variable: an instance setting, `instance_settings.general.botDisk.sharedPackageCachePath`,
changed on Instance → General («Shared package cache for bots») or through
`GET`/`PATCH /api/myrmidon/bot-disk` (GET is any board member, PATCH is
instance-admin only). It applies without a restart: the local driver and the
profile compiler re-read it on every reconcile pass, and every bot on the
default host is recreated with the new binds on the next pass. Full guide:
[bot-disk-cache.md](bot-disk-cache.md).

| Setting | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `general.botDisk.sharedPackageCachePath` | 1.6.1-BOT-DISK-B | unset (no shared cache) | Absolute host directory whose `pnpm`, `go-mod`, `go-build` and `gradle` subdirectories every bot on the default host mounts read-write at `/cache/…`; the profile compiler points `npm_config_store_dir`, `GOMODCACHE`, `GOCACHE` and `GRADLE_USER_HOME` at the mounts (pip is not covered: the image's `PIP_NO_CACHE_DIR` cannot be unset). Bots on a fleetd host are not affected (logged once) | `null` or empty — off. **Operator step:** dockergate must allow the same directory as `packageCacheRoot` ([dockergate.md](dockergate.md)), otherwise every cache bind is refused with `mount_source_not_allowed`; the four subdirectories must exist and belong to uid/gid 10001 |
| `general.botDisk.gitMirrorRepos` | 1.6.2-BOT-DISK-C | `[]` (no mirrors) | `owner/repo` names of GitHub repositories the board keeps a bare mirror of under `<sharedPackageCachePath>/git/<owner>/<repo>.git`, refreshed by `git fetch --prune`; bots mount `<cache>/git` read-only at `/cache/git` and the image's git wrapper clones with `--reference-if-able`, so clones borrow objects instead of duplicating them. Needs `sharedPackageCachePath`. Applies on the next reconcile pass / maintenance tick, no restart | `null` or `[]` — off (the bind goes away). **Operator step:** create `<cache>/git` owned by the board's user, mode 0755 (dockergate already accepts it read-only under `packageCacheRoot`); a private repository needs a `GITHUB_TOKEN` on the server. Do not delete a mirror while a clone borrows it. See [bot-disk-cache.md](bot-disk-cache.md) |
| `general.botDisk.gitMirrorRefreshMs` | 1.6.2-BOT-DISK-C | `900000` (15 min) | How often each git mirror is fetched (60 000 ms to 86 400 000 ms; one refresh at a time, a failed fetch waits a full interval) | `null` — the default |
| `general.botDisk.pnpmStore` | 1.6.2-BOT-DISK-C | `workspace` | Where bots with the shared cache keep the pnpm store: `workspace` — `/workspace/.pnpm-store`, the same mount as the clones, so pnpm hard-links `node_modules` (a store on another mount makes pnpm copy); `shared` — `/cache/pnpm`, one copy per host, imported by `clone-or-copy` (reflink on XFS with reflink or btrfs, a copy on ext4) | `null` — the default. The image itself defaults to the workspace store, with or without the cache |
| `general.botDisk.sharedCacheRoles` | 1.6.2-BOT-DISK-C | `engineer`, `reviewer`, `devops`, `release`, `qa` | Agent roles (`agents.role`) whose bots get the shared package cache and git mirror mounts and variables. Every other bot (marketing, support, …) gets none, so enabling the cache does not recreate it or show profile drift. Applies without a restart: a change recreates exactly the bots whose membership changes | `null` — the default list; `[]` — no bot gets the cache |
| `MYRMIDON_CLONE_IDLE_TTL_SEC` | 1.6.2-BOT-DISK-C | written by the board (the lifecycle's `idleTtlMs` in seconds) | A bot-side variable, not an operator input: the profile compiler writes it into the `.env` of bots of the `sharedCacheRoles` roles, and the in-container `bot-clone-hygiene` reads it to decide when a clean, fully pushed, idle clone is removed (`0`: lifecycle off, report only). Set the policy through `general.botDisk.idleTtlMs` / `enabled`, not here (a card value of this name is dropped) | `general.botDisk.enabled: false` writes `0`. Optional bot-side `MYRMIDON_CLONE_HYGIENE_INTERVAL_SEC` (default 900) sets the reporter's pass interval |
| `general.botDisk.partitionThresholdPercent` | 1.6.5-BOT-DISK-H10 | 85 | Fill level of the bot partition (measured via dockergate `GET /myrmidon/disk`) at which the `host_disk_alert` card appears. Must be below `partitionRefuseOpenPercent` | `MYRMIDON_BOT_PARTITION_THRESHOLD_PERCENT` |
| `general.botDisk.partitionRefuseOpenPercent` | 1.6.5-BOT-DISK-H10 | 90 | From this fill level the workspace desired state reports `pressure.level = "hard"` and `myr-ws open` refuses new copies (grace 0). Must be below `partitionCriticalPercent` | `MYRMIDON_BOT_PARTITION_REFUSE_OPEN_PERCENT` |
| `general.botDisk.partitionCriticalPercent` | 1.6.5-BOT-DISK-H10 | 95 | From this fill level the card is critical and the owner gets a Telegram message through the owner-cards channel, once per crossing | `MYRMIDON_BOT_PARTITION_CRITICAL_PERCENT` |
| `MYRMIDON_DOCKERGATE_URL` | 1.6.5-BOT-DISK-H10 | unset | Base URL of dockergate on the bot host (e.g. `http://host.docker.internal:3399`). Unset disables the partition measurement: the sweep keeps the statfs behaviour and the partition is reported as not measured | env only |
| `general.botDisk.sharedBotRuntimePath` | 1.6.5-BOT-DISK-H11 | unset (every bot has its own runtime) | Absolute host directory whose `bin`, `lazy-packages` and `lsp` subdirectories every bot on the default host mounts read-only over its own runtime paths in the container (`/bot/hermes/…`), so one host copy replaces one copy per bot (5–7 GiB per copy on the production fleet). The board adds the three binds itself and checks them against the mounts of a card: a card cannot take one of the three paths over. Applies on the next reconcile pass, no restart. Bots on a fleetd host are not affected (logged once) | `null` or empty — off (every bot keeps its own copies). **Operator step:** create the three subdirectories, move one bot's `bin`, `lazy-packages` and `lsp` from its volume into them (they are the same files for every bot), own them by the image's user (uid/gid 10001) and set the same directory as `botRuntimeRoot` in the dockergate configuration ([dockergate.md](dockergate.md)), otherwise every runtime bind is refused with `mount_source_not_allowed`. Do not delete a bot's own copies before the setting is saved. See [bot-extra-mounts.md](bot-extra-mounts.md) |
| `general.botDisk.pnpmStoreDir` | 1.6.5-BOT-DISK-H8a | `/cache/pnpm-store` | Where pnpm keeps its store inside the bot container. The default is the shared store of the partition (host `<sharedPackageCachePath>/pnpm-store`, bound read-write to every bot of `sharedCacheRoles`). A path inside the bot's own tree (`/workspace`, `/data`, `/scratch`, `/bot`) is accepted with a warning in the log: it is a store per bot, not shared, counted in the bot's quota. Any other path is refused: a reflink only works within one filesystem | `null` — the default. **Operator step:** `install -d -o 10001 <sharedPackageCachePath>/pnpm-store` on the partition of the bot volumes, before the settings are saved. A stored `/workspace/.pnpm-store` of an earlier release reads as the default |
| `general.botDisk.pnpmImportMethod` | 1.6.5-BOT-DISK-H8a | `clone` | How pnpm puts a package into a clone: `clone` (reflink, strictly: a refused reflink fails loudly) or `copy` (an explicit full copy). `clone-or-copy` (silent copy) and `hardlink` (cannot cross the bind mounts of the shared store) are refused with a message | `null` — the default. A stored `hardlink` or `clone-or-copy` of an earlier release reads as `clone` |
| `general.botDisk.uvCacheDir` | 1.6.5-BOT-DISK-UV-A | `/cache/uv` | Where uv keeps its cache inside the bot container. By default this is the shared cache of the partition (on the host `<sharedPackageCachePath>/uv`, bound read-write to every bot of `sharedCacheRoles`). A path inside the bot's own tree (`/workspace`, `/data`, `/scratch`, `/bot`) is accepted with a log warning: it is a cache per bot, not shared, and it counts against the bot's quota. Any other path is refused: reflink works only inside one filesystem | `null` — the default. **Operator step:** `install -d -o 10001 <sharedPackageCachePath>/uv` on the bot-volumes partition, before saving the settings |
| `general.botDisk.uvLinkMode` | 1.6.5-BOT-DISK-UV-A | `clone` | How uv puts a wheel into the environment: `clone` (reflink on a CoW filesystem), `hardlink` (documented uv value; across the shared bind it fails loudly with EXDEV), or `copy` (explicit full copy). `symlink` is refused with a message — site-packages behind symlinks in the shared cache break bot isolation | `null` — the default. uv's own clone→hardlink→copy fallback stays in uv and is accepted |
| `general.botDiskQuota` | 1.6.1-BOT-DISK-C | unset (quota off) | Per-bot disk quota in MB: `defaultQuotaMb` for every bot, `perCaste[]` (`{casteKey, quotaMb}` matched against `agents.role`) and `perAgent[]` (`{agentKey, quotaMb}`, wins over the caste entry); a bot card's `container.diskQuotaMb` wins over all of them. The measured usage is the bot's own volume `<MYRMIDON_BOT_VOLUME_ROOT>/<botKey>` (hermes, workspace, scratch). A bot at >=80% of its quota raises an attention card (`bot_disk_quota`); over it, a NEW workspace clone is refused before the directory is created with the `BOT_DISK_QUOTA_EXCEEDED:` message. Saved in the instance settings (`PATCH /api/myrmidon/bot-disk-quota`, instance admins only, audited as `instance.bot_disk_quota.updated`); the settings panel is on the instance general settings page. Applies without a restart: the sweep re-reads the values at the top of every maintenance tick and the admission check reads them per request | `null`/`{}` — off; `defaultQuotaMb: null` with empty lists — off even if overrides existed. An invalid stored value reads as off (fail-closed, no card can be raised by a broken setting). No-op without `MYRMIDON_BOT_VOLUME_ROOT` on the board's host |

## P12 — the deferred addressee-wake sweeper

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_PENDING_INTERACTION_WAKE_GRACE_MS` | P12 | `600000` (10 min) | Waiting window of an addressee-wake request (`interaction-pending:<card>`): while the window has not expired, the sweeper does not touch the request on a task with a live run; on expiry the request is resolved (finalized or re-admitted through the normal admission path). An invalid value falls back to the default | A value below zero — as the default; the sweeper itself is limited to 50 requests per scheduler tick |
| `MYRMIDON_PENDING_INTERACTION_WAKE_RE_ADMISSIONS` | P12 | `1` | How many times the sweeper may re-admit an addressee-wake request (create the addressee's run queue with the saved card context); afterwards the request is finalized `cancelled` with a reason | `0` — no re-admissions, the request is resolved on the very first pass |

## L1 — infrastructure interruptions

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_INFRA_INTERRUPT_CODES` | L1 | `agent_paused,process_lost,server_shutdown_interrupted,issue_reassigned` | List of run error codes (comma-separated) for which `legacyExecutionNeedsReconciliation` does not set the `legacy_execution_requires_reconciliation` lock, an agent pause does not escalate the task immediately, and the periodic stranded-task resolution does not escalate it while the agent is merely paused — all within the shared retry budget (2, the same as the rest of the function's content) and **only when the run was claimed by a conversation adapter** (`CONVERSATION_ADAPTER_TYPES`, `conversation-continuation.ts`) **or an adapter with its own idempotency key** (`IDEMPOTENT_INFRA_INTERRUPT_ADAPTER_TYPES`, currently empty; `hermes_gateway` is relieved through the conversation-adapter route instead — its own predecessor overlap guard stops a still-live previous run before creating a new one, so it needs no idempotency key of its own) — and only while the provider stop is not in the "requested, unconfirmed" state (`resultJson.executionCancellation.state === 'requested'`: the vendor lock remains). For the rest (`process`, `http`, `openclaw_gateway`, unknown adapter) this list of codes does not apply — the vendor lock remains, their run must not be retried blindly (risk of executing an external action twice) | Empty or `off` — vendor behavior (the lock is always set). A custom list replaces the default entirely, does not add to it. The adapter filter cannot be disabled by the list itself |

## G1 — bot container image (bot runtime image)

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_BOT_YOLO` | G1 | `1` (enabled) | The `docker/bot-runtime` image: `1` is translated into `HERMES_YOLO_MODE=1` for the `hermes gateway run` process — approvals on dangerous commands are skipped, because this gateway has no connected human who could answer the request | `0`/`false`/`no`/`off` — approvals follow `approvals.mode` in the profile's `config.yaml` (hermes default is `smart`); on unmanaged platforms (`api_server` — this case) unanswered approvals default to `deny`. Useful only for a testbed where someone can answer |

## Vendor settings that matter for Myrmidon

Here are the vendor switches you need to know when deploying Myrmidon: for example, how
to enable plan mode (X2). Tracks fill it in, the section is shared.

| Where | What | Value for Myrmidon | Function |
|---|---|---|---|
| Task: the `workMode` field (`POST/PATCH /api/issues…`, `"planning"`); in the UI — the "Plan mode" toggle in the task input field | Task plan mode: the wake prompt gets a `planning directive` — the agent only composes or updates a plan, does not write code. After the plan is accepted — only child tasks | Works with `hermes_local` without changes: plan directives reach the run prompt (test `server/src/__tests__/hermes-planning-mode.myrmidon.test.ts`). Enabled per task, no separate instance switch needed | X2 |
| `PATCH /api/instance/settings/experimental`: `enableIssuePlanDecompositions` (in the UI — Instance Settings → Experimental, "Task Plan Decomposition") | Shows on the task page the history of accepted-plan decomposition into child tasks | Optional, off by default. Does not affect plan-mode work in the run | X2 |
| `PATCH /api/instance/settings/experimental`: `enableFirstTaskPlanProposal` ("First task: propose with a plan document") | For the first single task of a new organization the manager writes a short plan document and a card with options instead of one confirmation card | Optional, off by default. Applies only to organizations created after enabling | X2 |
| `PATCH /api/instance/settings/experimental`: `enableMyrmidonUi2` (in the UI — Instance Settings → Experimental, "Myrmidon UI 2.0 Shell") | Renders the board route tree in the Myrmidon 2.0 frame (rail, top bar, phone bottom bar); pages, routes, data and access stay shared with the 1.x shell. Fails closed: off while loading, on a read error, and for stored rows written before the flag existed. A per-browser `?ui=1|2` override (localStorage `myr.ui2.personal`) wins over the flag in both directions | Off by default; apply and revert on the next page load, no restart. Guide: [guides/ui2-shell.md](guides/ui2-shell.md) | UI-2.0 |
| `TELEGRAM_API_BASE_URL` | Bot API address for the Telegram adapter (vendor variable) | Address of your own Bot API if files larger than 20 MB are needed; unset — cloud Bot API | P8 |
| `PAPERCLIP_ATTACHMENT_MAX_BYTES` | Overall board attachment size limit (vendor, 10 MB by default) | Also limits Telegram files: raise together with `MYRMIDON_TELEGRAM_FILE_LIMIT_BYTES` | P8 |
| Instance configuration file, `telemetry.enabled` | Telemetry flag. Vendor default is `true`, ours is `false` | Do not enable. Enabling also requires `PAPERCLIP_TELEMETRY_ENDPOINT` (your own ingestion address) | TEL |
| `PAPERCLIP_TELEMETRY_ENDPOINT` | Telemetry ingestion address. With us, telemetry does not work without it even with the flag, there are no default addresses | Do not set | TEL |
| `PAPERCLIP_ANNOUNCEMENTS_ENABLED`, `PAPERCLIP_ANNOUNCEMENTS_FEED_URL` | Announcement feed. The vendor has it enabled by default with the vendor address; with us it is enabled only by `PAPERCLIP_ANNOUNCEMENTS_ENABLED=true` plus your own feed address | Do not set | TEL |
| `PAPERCLIP_FEEDBACK_EXPORT_BACKEND_URL` (or `PAPERCLIP_TELEMETRY_BACKEND_URL`) | Where feedback the user chose to share goes. With us there is no default address: without it feedback stays local, the export is marked "not configured" | Do not set | TEL |
| `PAPERCLIP_UPDATE_CHECK_URL` | Address where the CLI checks for a new version (npm registry response format). The vendor — `registry.npmjs.org/paperclipai` always; with us, without the variable there is no check | Do not set | TEL |
| `PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS` | Terminal cooldown of the workspace reaper (vendor, 7 days). With WH-B it no longer determines the term for merged workspaces: a workspace with a merged branch goes to the archive by `MYRMIDON_WORKSPACE_MERGED_COOLDOWN_MS` (30 min). The reaper does not delete unmerged workspaces anyway (unpushed protection), so in practice the variable now prolongs the life of no archivable workspace; kept as a vendor fallback | May be left unset | WH-B |

## Bot containers (G-series, the 28.09 "option B" plan)

Settings of the pilot local container driver (`server/src/myrmidon/bot-containers/`).
Decision register — `containers-plan-senior-2026-09-28.md`.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_BOT_CONTAINERS` | G3 | off | Enables bot container reconciliation: both the periodic pass (`startBotContainerReconciliation`) and "apply now" for one agent (`applyBotContainerNow`) | `1`/`true`/`yes`/`on` — enable. Disabled — both entries do nothing (`applyBotContainerNow` returns `not_applicable`), and at server startup no driver is created and the agents table is not read. Enabled — at server startup (`startBotContainers`, W2a) the runtime is assembled and the pass starts; this happens in the process where the wake scheduler is enabled, in another process "apply now" answers 503. A runtime that cannot be assembled (e.g. `MYRMIDON_BOT_VOLUME_ROOT` is unset) is written to the server log as an error, the pass does not start, the board works. Enable only after running the full cycle on a testbed with real Docker and a bot image that declares the contract (see `MYRMIDON_BOT_IMAGE_ALLOWLIST`) |
| `MYRMIDON_BOT_DOCKER_SOCKET` | G3 | `/var/run/docker.sock` | Unix socket of the Docker Engine through which the local driver (`docker-driver.ts`) talks to the daemon | On a production host — the dockergate socket `/run/myrmidon-dockergate/engine.sock` (a proxy with an allowlist of calls, see [dockergate.md](dockergate.md)); the raw daemon socket is not mounted into the board: access to it equals host root for any process with the board's uid. The default is suitable only for a testbed without terminal bots. Read at server startup (W2a) |
| `MYRMIDON_BOT_IMAGE_ALLOWLIST` | G3 | empty (nothing allowed) | Comma-separated list of images that may be launched as a bot container; `*` does not cross `/` | Without a value `create()`/`recreate()` refuse to create any container — this is a deliberate fail-closed, not a defect. The image must already lie on the host: the driver does not pull it. In addition, the image must declare the bot environment contract with the label `myrmidon.bot-runtime.contract=1` (including: it takes `API_SERVER_KEY` and other secrets from `$HERMES_HOME/.env`, does not require them from the container environment); an image without the label or with a different version is rejected before anything is created |
| `MYRMIDON_BOT_VOLUME_ROOT` | G3 | unset (required) | Directory on the host under which bot volumes live: `<root>/<botKey>/{hermes,workspace,scratch}` | Without a value `dockerBotContainerDriver()` (without an explicit config) throws an exception when the driver is used |
| `MYRMIDON_BOT_MOUNT_SOURCES` | BOT-VOLUMES | empty (nothing allowed) | Comma-separated list of absolute host directories that a card may mount to a bot as an additional volume (`adapterConfig.container.extraMounts`) — read-only only. A source not in the list is rejected before Docker is called; only a directory named here in full can be mounted (exact match, no prefix rule), and the mount point inside the container cannot occupy `/data/hermes`, `/workspace`, `/scratch`, `/tmp` or a path under them. The directory does not have to be under `MYRMIDON_BOT_VOLUME_ROOT` | Empty or unset — no additional volume is allowed (fail-closed). Read once at server startup (W2a); a change requires a board server restart. After the restart, a bot whose mount set no longer matches its card is recreated (the bind list is part of the container template). dockergate calls the same list `mountSources` (see [dockergate.md](dockergate.md)); on the dockergate side the change applies without a restart, via `SIGHUP` |
| `MYRMIDON_BOT_NETWORK` | G3 | `myrmidon-bots` | The only docker network a bot container joins; a card cannot specify another | — |
| `MYRMIDON_LITELLM_BASE_URL` | M2-A | unset (off) | Address of the LLM gateway (OpenAI-compatible, e.g. LiteLLM) from which the board server assembles the spend log and model prices: `http(s)://…`, read at startup and at every collection pass. The address is not stored in the open repository — the value is set by the deployment | Set together with `MYRMIDON_LITELLM_KEY_SECRET`; without both, collection is off: the periodic pass does not start, and `/api/myrmidon/…/litellm/*` answers 503 `enabled: false`, and the Costs "Gateway" tab writes "collection is not enabled" |
| `MYRMIDON_LITELLM_KEY_SECRET` | M2-A | unset (off) | Name of the company secret holding the gateway key with access to `/spend/logs/v2` and `/v1/model/info` (for LiteLLM this is a virtual key with the right to read the spend log). The key must see ALL models: an empty model list (no restriction). A key created with a restricted model list makes `/v1/model/info` answer 0 models on a successful request, leaving the catalog empty and silently disabling prices, model lists and entry limits — the board raises an attention card when this happens | The value is read only for the duration of the pass, is not written to the log and is not stored; spend rows are attributed to agents by sha256 of bot key values — the values themselves do not leave the process. If the card appears, re-create the key with an empty model list |
| `MYRMIDON_LITELLM_COST_INTERVAL_SEC` | M2-A | `300` | Collection pass period (in seconds): reads `/spend/logs/v2` since the last collected event (first pass — a 24 h window), refreshes the model catalog `/v1/model/info` | From 30 to 86400; non-integer or out of bounds — `300` is taken. An overlapping pass skips the tick instead of queueing up |
| `MYRMIDON_LITELLM_FIRST_LOOKBACK_DAYS` | HERMES-USAGE-COST | `1` | How far back a FIRST collection pass reads when nothing has been collected yet: the whole unpriced month can be collected by setting this to its length in days. After the pass, the reconcile step fills the unpriced `hermes_gateway` rows of the vendor cost ledger with the collected prices, so the dashboard and Costs screens stop showing $0 | From 1 to 90; non-integer or out of bounds — `1` is taken. A one-off backfill can instead pin the window start with `POST /api/myrmidon/companies/:id/litellm/sweep` body `{ "from": "2026-10-01" }` (board only) |
| `MYRMIDON_LITELLM_ADMIN_KEY_SECRET` | M2-B | unset (key management off) | Name of the company secret holding the gateway ADMIN key (for LiteLLM — the master key): it manages the agents' virtual keys and is never handed to an agent. It is used only to read key names and to issue or rotate one agent's key; the value is not written to the log. Without it, together with `MYRMIDON_LITELLM_BASE_URL`, the keys API answers 503 `enabled: false` | — |
| `MYRMIDON_BUDGET_SIGNAL_MODE` | M3 | on | When a budget hard-stop is reached, the owner gets a signal: a system-notice comment in the thread of every open issue the stop interrupted (cause, limit, observed spend, how to continue — raise the budget or keep the scope paused), written once per incident per issue. Without this the stop is silent in the issue thread: runs are cancelled and queued wakeups dropped, and the only trace is the decision inbox card the owner must open on their own | `off` (case-insensitive) — disable the signal entirely; any other value or unset — on. The vendor pause/cancel/incident mechanics are not affected by this switch, only the delivery of the signal |
| `MYRMIDON_LITELLM_AGENT_KEY_ENV` | M2-B | unset | Name of the environment variable in which the bot profile compiler substitutes THIS agent's key (`llm.apiKeyEnv` of the resulting `config.yaml`): the key comes from the agent's secret rather than from a single company-wide value, so spend arrives in the gateway log under the agent's key. Unset — the previous behaviour. The name may not be `HOME`, `PATH`, `HERMES_HOME`, `API_SERVER_KEY`, `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`; an invalid name reads as "not set" | — |
| `MYRMIDON_BOT_EGRESS_MODE` | EGRESS-A | `off` | Mode of bot egress to the outside. `off` — as before, no proxy variables in the profile; `log` — the bot container gets the fleet proxy address, all outbound traffic is visible in the proxy log, nothing is blocked (see [egress.md](egress.md)) | A value other than `off` and `log` — an error, the profile is not assembled (a typo must not look like "left as it was"), as is `log` without `MYRMIDON_BOT_EGRESS_PROXY`. Read at every profile build; changing the value restarts bot containers (`.env` is a "restart"-class file), no board restart needed |
| `MYRMIDON_BOT_EGRESS_PROXY` | EGRESS-A | unset | Address of the outbound proxy as the bot container sees it (`http://egress-proxy:3128`); goes into `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` in `hermes/.env`, the address's user is the bot key (by it the proxy names the bot in the log) | Required with `MYRMIDON_BOT_EGRESS_MODE=log`; only an `http://` URL is accepted (the proxy speaks plain HTTP and tunnels TLS via `CONNECT`) — otherwise the profile is not assembled |
| `MYRMIDON_BOT_EGRESS_NO_PROXY` | EGRESS-A | unset | Comma-separated hosts the bot visits directly, bypassing the proxy; `localhost`, `127.0.0.1`, `::1` and the `MYRMIDON_BOT_BOARD_URL` host are always added to them | Empty — only the built-in list. Patterns (`*`) are supported by none of the usual clients: a host is specified exactly |
| `MYRMIDON_BOT_EGRESS_TOKEN` | EGRESS-B | unset | Shared token of the board and the proxy: the proxy presents it when fetching the allowlists (`GET /api/myrmidon/bot-egress/policy`), and the board — when reading the proxy refusal feed | Unset — the board gives the lists to no one (503), the proxy remains only a log: this is the "EGRESS-B not enabled" state. Comparison is constant-time value-to-value; the token is a secret, not stored in the repository or settings |
| `MYRMIDON_BOT_EGRESS_REFUSALS_URL` | EGRESS-B | unset | Address of the proxy as the board sees it (`http://<proxy>:3128`); the board reads `/refusals` through it and shows the latest refusals in the "Egress" section of the project | Unset — the refusal feed answers 503, lists and blocking work. Long-term refusal storage is the proxy log (`docker logs`), the feed is only a tail for the UI. Read on every request |
| `MYRMIDON_BOT_RECONCILE_INTERVAL_SEC` | W2a | `60` | How often (in seconds) the pass reconciles containers of all bots with their cards: `hermes_gateway` agents with `adapterConfig.container.enabled`, except terminated ones | From 5 to 3600; empty, non-integer or out of bounds — `60` is taken. Read at server startup, a change requires a restart. The pass runs one at a time: a slow pass does not accumulate a queue. Applies only while `MYRMIDON_BOT_CONTAINERS` is enabled |
| `MYRMIDON_BOT_COMPRESSION_THRESHOLD_TOKENS` | BOT-RUNTIME-TUNING-B (the setting), BOT-RUNTIME-TUNING-A (the default and the card field) | `100000` | Absolute token cap for context compression, written to `compression.threshold_tokens` in every bot's `hermes/config.yaml`: Hermes compresses at the LOWER of the ratio threshold and this count, so on a large-window model a session no longer grows to half the window before compacting. It is an override of the company default now: unset (or unusable) means `100000`, and the agent card's own **Compression threshold (tokens)** field (`adapterConfig.models.compressionThresholdTokens`) wins over it. A card's value outside 10 000–2 000 000 is dropped with a profile warning and the instance value is NOT substituted for it | An explicit `0` — no cap: nothing is written and Hermes's own 256 000 applies. A non-integer value is reported and the company default `100000` is used. Read on every profile build; a change restarts bot containers (part of `config.yaml`) |
| `MYRMIDON_BOT_MODEL_CONTEXT_LENGTH` | BOT-RUNTIME-TUNING-B | unset (no map) | Explicit context window per model alias: `alias=tokens,alias=tokens`, e.g. `model-a=131072`. When a card's model matches an alias, the value is written to `model.context_length` in that bot's `config.yaml`, overriding Hermes's per-model detected window. A card's own `models.contextLength` in its "Additional models" block wins over this map. Until the model registry exists, only this explicit map is consulted | Read on every profile build; a change restarts the affected bot containers. Entries without `=` or with a non-integer token count are skipped with a profile warning; the valid entries still apply. Compile-time range 8 000–10 000 000, out-of-range values are dropped with a warning |
| `MYRMIDON_BOT_AUX_TITLE_MODEL` | BOT-RUNTIME-TUNING-B | unset | Gateway model alias written to `auxiliary.title_generation.model` for bots whose card sets no title model: the title generator then stops using the main (expensive) model and its LiteLLM fallback chain. The value must be a model alias the gateway actually knows — the operator names it; the setting has no default precisely because a hard-coded "free" model the gateway does not know would silently break title generation | Read on every profile build; a change restarts bot containers. The card's `models.titleGeneration` entry wins over this setting |
| `MYRMIDON_BOT_AUX_COMPRESSION_MODEL` | BOT-RUNTIME-TUNING-B | unset | Same for `auxiliary.compression.model`: the model that summarizes a session during context compression. The operator names a gateway alias; no default for the same reason | Read on every profile build; a change restarts bot containers. The card's `models.compressionSummary` entry wins over this setting |
| `MYRMIDON_BOT_CONTAINER_GITHUB_ENV_ALLOWLIST` | FLEETD-VMEXEC | unset (empty) | Names of agents (comma-separated) whose cards may hold board-managed GitHub tokens (`env.GITHUB_TOKEN`, `GH_TOKEN` and relatives) as `secret_ref` for the container profile: the value is resolved with a check of the secret's binding to the agent and lands only in the container's `hermes/.env` (0600, secret), never in the container `Env` | Empty/unset — GitHub tokens from container cards are dropped with a warning, as before. The list is read at every resolution (once a minute per bot): emptying the setting restores default behavior on the next pass, without a restart. A fallback for development bots on a machine where the board's GitHub broker address is genuinely unreachable: since the run-bound broker capability reaches bot containers (CONTAINER-GITHUB-WRITE), most dev bots no longer need it — see the "Bot containers" section note below the table |
| `MYRMIDON_FLEET_HOST_URL` / `MYRMIDON_FLEET_HOST_TOKEN` | FLEETD-VMEXEC | unset | Address of the fleetd service (`http://host:port`, http only — internal network) and its token for the client driver `fleetd-driver.ts`; these are named wrappers over a host entry from the per-host map `MYRMIDON_FLEET_HOSTS` (see the next step of the branch), until the map is introduced the pair is read directly | Without both values the fleetd driver is not instantiated (configuration error), the local docker driver and default behavior are unchanged. The token is a value only in myrmidon-deploy, it is not in the repository or logs |
| `MYRMIDON_FLEET_HOSTS` | FLEETD-VMEXEC | unset (empty) | Map of named fleetd hosts for placing container bots: JSON array of entries `[{"name":"…","url":"http://…","tokenSecret":"…"}]` — host name (the bot card references it in `adapterConfig.container.host`), fleetd service address (only `http://`), name of the company secret with the fleetd token | Empty/unset — only the local driver, named hosts are impossible, a card with `container.host` gets an error. Invalid JSON, unknown key, duplicate name, non-http url or empty `tokenSecret` — an error, settings are not applied partially. Read at server startup |
| `MYRMIDON_BOT_HINDSIGHT_API_URL` | W2a | unset (required when containers are enabled) | Address of the shared hindsight service as the bot container sees it; goes into `hermes/hindsight/config.json` (`api_url`). The memory mode is always `local_external`, a card cannot switch a bot to a cloud address | Without a value the profile is not assembled: the pass over a bot ends with an error in the activity log, the container is neither created nor changed. Address `http(s)://…`; the host's `localhost` from inside the container is not the same |
| `MYRMIDON_BOT_HINDSIGHT_BANK` | W2a | unset | Default memory bank for a bot whose card has no `adapterConfig.hindsight.bankId` | No bank either in the card or here — the profile is not assembled (an error, not a "default" bank at hindsight) |
| `MYRMIDON_BOT_HINDSIGHT_ALLOWED_BANKS` | W2a | unset (no check) | Comma-separated list of allowed banks; a bank in the card or from `MYRMIDON_BOT_HINDSIGHT_BANK` that is not in the list — a compilation error. Protection against a typo in `bankId` that would silently create a new bank | Empty or unset — no check (current behavior). Duplicates and empty list elements are ignored. The error names the bank and the setting. The card's `adapterConfig.hindsight.observationScopes` block is carried into the profile's `observation_scopes` (the same format as live hermes_local profiles: a list of tag lists) |
| `MYRMIDON_BOT_LLM_BASE_URL` | W2a | unset; required for a card whose provider is not "own" | Address of the shared LLM gateway (OpenAI-compatible, e.g. LiteLLM) as the container sees it; goes into `model.base_url` and into every fallback model of the profile, but only of a card that talks through the gateway (provider empty, `auto`, `custom`, `custom:<name>`). A card with its own provider is not given the address: Hermes takes `model.base_url` for a named provider too, and the provider key would go to the gateway address | Needed by every card whose `provider` is empty, `auto`, `custom` or `custom:<name>`: without the address Hermes would go to the default OpenRouter address, so such a bot's profile is not assembled, and the error names this setting. A card with its own provider (`anthropic`, `gemini` and the like) does not need the setting: such a bot talks to its provider's address. Address `http(s)://…` |
| `MYRMIDON_BOT_LLM_API_KEY_ENV` | W2a | unset; required for a card whose provider is not "own" | Name of the variable in `hermes/.env` in which the bot holds the LLM gateway key (name only, not the value). The value is taken from the card's env under this name, and if absent there — from the company secret (`MYRMIDON_BOT_LLM_API_KEY_SECRET`) | Needed by the same cards as `MYRMIDON_BOT_LLM_BASE_URL` (provider empty, `auto`, `custom`, `custom:<name>`): without the name Hermes would send the gateway the placeholder key `no-key-required`, so the profile is not assembled, and the error names this setting. A card with its own provider does not need it: the gateway key does not go into its profile. Set but the value exists nowhere — the profile is not assembled (an empty key is not written). The name cannot be `HOME`, `PATH`, `HERMES_HOME`, `API_SERVER_KEY`, `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY` |
| `MYRMIDON_BOT_LLM_API_KEY_SECRET` | W2a | the value of `MYRMIDON_BOT_LLM_API_KEY_ENV` | Name of the company secret holding the LLM gateway key | The secret is created by the operator in the company's "Secrets" section; the system neither creates nor changes it. The secret value is read only for a card that talks through the gateway (a card with its own provider does not read it), and without an entry in the secret-usage log (the pass runs once a minute) |
| `MYRMIDON_BOT_BOARD_URL` | W2a | unset (required when containers are enabled) | Address of the board as the bot container sees it, without `/api` (e.g. `http://board.example.com:3100`); goes into `PAPERCLIP_API_URL` in `hermes/.env` | Without a value the profile is not assembled. The system creates the bot's key on the board itself (`PAPERCLIP_API_KEY`): an agent key `myrmidon-bot-container` and a company secret `myrmidon-bot-<agentId>-paperclip-api-key` |
| `MYRMIDON_BOT_MCP_SERVERS` | W2a | unset (no servers) | Shared MCP servers that every bot in a container gets (ragflow and the like): JSON array `[{"name":"ragflow","url":"http://ragflow.example.com/mcp","tokenSecret":"<company secret name>"}]`. The token is not stored in the setting: `tokenSecret` names a company secret, the value is read at every build and lands only in `hermes/.env` (in `config.yaml` — a `${VARIABLE_NAME}` reference). Optional: `header` (default `Authorization`), `scheme` (default `Bearer`; an empty string sends the token as-is), `noAuth: true` instead of `tokenSecret` for a server without a token. The server address, unlike the address of the board's tool gateway, is not rewritten by `MYRMIDON_HERMES_RUNTIME_MCP_URL_BASE` | Strict validation: invalid JSON, a repeated name, an entry without `tokenSecret` and without `noAuth`, a missing or empty secret — the bot's profile is not assembled, the error names the entry and the field, but not the value (the server on which the "ragflow via MCP" acceptance depends must not silently disappear). The name `paperclip-assigned` is reserved for the bot's board gateway: an entry with this name — the same error, the profile is not assembled (each bot's gateway is issued by the board, one shared token cannot replace it). Changing the value restarts bot containers (MCP is part of `config.yaml` and `.env`) |
| `MYRMIDON_BOT_BOARD_GATEWAY` | W2a | `1` (enabled) | Each bot in a container gets its own board tool gateway: the `paperclip-assigned` server in the profile's `config.yaml` (same name as `hermes_local`), with the connections and tools assigned to this agent. The gateway belongs to the agent and is created separately for each set of assignments; the gateway token (30 days) is stored as company secret `myrmidon-bot-<agentId>-board-gateway-token`, goes into the profile only into `hermes/.env`, is rotated when less than 10 days remain; the previous token is revoked after a day. One bot's token does not open another bot's gateway and does not coincide with tokens from `MYRMIDON_BOT_MCP_SERVERS` | `0`/`false`/`no`/`off` — bot gateways are not issued, and already issued ones are disabled, tokens are revoked, the `paperclip-assigned` server leaves the profile (the bot restarts). A change is read at every profile build, no server restart needed. The gateway address is built from `MYRMIDON_BOT_BOARD_URL` (without `/api`) and rewritten by the same `MYRMIDON_HERMES_RUNTIME_MCP_URL_BASE` as for `hermes_local`. No assignments for the agent — no server, the gateway is not created. Likewise a gateway is not issued to an agent with status `terminated` or `pending_approval` (issued ones are disabled, tokens revoked), and gateways of agents the reconciliation does not collect (deleted, terminated, adapter changed, container disabled) each pass releases itself; with `MYRMIDON_BOT_CONTAINERS` off there is no pass. One bot's gateway can be disabled manually (status `disabled` on the gateway itself): reconciliation does not re-enable it, there is no delivery, a warning in the log; it re-enables only a gateway it disabled itself. The server name `paperclip-assigned` cannot be declared in `MYRMIDON_BOT_MCP_SERVERS`. Calls through this gateway are bound to the agent's single active run (A2): the audit shows run_id, responsible, task and project, and the task/project tools (`create_project`, `list_projects`, `list_project_repositories`, `create_task`) go through the same gateway by the same path as with `hermes_local`; zero or more than one active run — no binding, agent tools work, task/project tools are rejected |
| `MYRMIDON_BOT_CANARY` | R5-B | off | Enables the canary rollout of the bot image: the `/api/myrmidon/bot-canary` routes, the job tick and resumption of an open job at server startup. The rollout itself does not touch containers until the operator creates a job | `1`/`true`/`yes`/`on` — enable. Off — read routes work, writes answer 503, the tick does not start, nothing is read at server startup. Container reconciliation (`MYRMIDON_BOT_CONTAINERS`) must be enabled alongside it |
| `MYRMIDON_BOT_CANARY_SELECTOR` | R5-B | unset | botKey of the canary agent (agentId): the new image is applied to this one bot first, with the health check and the smoke run, before any waves | Unset — a job cannot be created (503 with a hint): the canary is chosen explicitly, not guessed. The canary must be a container bot that reconciliation collects (otherwise the job cancels with a reason). Read at job creation |
| `MYRMIDON_BOT_CANARY_WAVE_SIZE` | R5-B | `4` | How many bots are in one wave after the canary succeeds (one bot at a time inside a wave, each through its own agent maintenance window) | From 1 to 32; the default of 4 is the same limit as the reconciliation concurrency (`RECONCILE_CONCURRENCY`), so a wave does not take more memory than a regular pass |
| `MYRMIDON_BOT_CANARY_STEP_TIMEOUT_SEC` | R5-B | `1800` | How many seconds a job may stand in one status before it cancels itself | From 60 to 86400 |
| `MYRMIDON_BOT_CANARY_HEALTH_SETTLE_SEC` | R5-B | `90` | How many seconds the canary container must stay healthy (Docker HEALTHCHECK) before the smoke run | From 0 to 3600; 0 — no settle wait, starts at once |
| `MYRMIDON_BOT_CANARY_SMOKE_TIMEOUT_SEC` | R5-B | `300` | Budget of the smoke run: one `POST /v1/runs` to the canary gateway, polled to a terminal status | From 10 to 3600. A run that does not finish in time — canary failure (`canary_smoke_failed`) |
| `MYRMIDON_BOT_CANARY_TICK_SEC` | R5-B | `5` | How often the tick reconciles the open job with the facts (container status, smoke, waves) | From 1 to 3600 |
| `MYRMIDON_BOT_CANARY_VERIFY_TIMEOUT_SEC` | R5-B | `30` | Timeout of network digest checks (registry, GitHub) at job creation and preview | From 1 to 300 |
| `MYRMIDON_BOT_CANARY_AUTO_ROLLBACK` | R5-C | `1` (on) | Health-based automatic rollback of the bot fleet: a canary failure (health or smoke) or a wave-bot failure moves the rollout to `rolling_back` — every bot that received the new image (the canary once its switch started, plus the applied wave bots) gets its own card image re-applied through the same `applyBotContainerNow`, one bot at a time; the rollout then ends `rolled_back` with the original failure reason kept. An apply error during the rollback ends the rollout loudly (`aborted` with the reason): the sweep re-applies the card image on its next pass anyway | `0`/`false`/`no`/`off` — the older R5-B behavior: the failure ends the rollout with a terminal status (`canary_failed`/`canary_smoke_failed`/`failed_health`), the canary stays on the new image for inspection, the rollback is manual |
| `MYRMIDON_DEVBUILD_HOST` | BUILD-OFFLOAD-C | unset (off) | Hostname of the build server on which dev-variant bots (`myrmidon-hermes-dev` images) run builds, tests and caches instead of the board host (BUILD-OFFLOAD A/B). When set, every NEW dev-variant bot container gets `DEVBUILD_HOST`/`DEVBUILD_USER`/`DEVBUILD_BASE` in its container env (internal hostname and paths, not secrets) plus a read-only mount of the build server's ssh key at `/opt/devbuild-ssh`; the key's host directory is taken from `MYRMIDON_BOT_MOUNT_SOURCES` — an entry ending in `devbuild-ssh`. The mount point `/opt/devbuild-ssh` is reserved: a card's own `extraMounts` cannot take it over | Unset — the feature is off: containers get no DEVBUILD env and no key mount |
| `MYRMIDON_DEVBUILD_USER` | BUILD-OFFLOAD-C | `devbuild` | ssh user on the build server, written as `DEVBUILD_USER` into dev-variant bot containers | Read together with `MYRMIDON_DEVBUILD_HOST`; without it the value is not used at all |
| `MYRMIDON_DEVBUILD_BASE` | BUILD-OFFLOAD-C | `/srv/devbuild` | Base directory of per-task build workspaces on the build server, written as `DEVBUILD_BASE` into dev-variant bot containers | Read together with `MYRMIDON_DEVBUILD_HOST`; without it the value is not used at all |
| `MYRMIDON_BOT_ROLLOUT_DEFERRED_MAX_WAIT_SEC` | BOT-ROLLOUT | `3600` | How long (in seconds) a deferred bot image rollout waits for the bot to free itself before the retry drops the busy gate: past this wait the apply runs through the reconciler's own pause-and-apply path — it opens the agent's maintenance window, drains the in-flight run to its end (runs are never interrupted) and recreates the container right after the current turn | From 60 to 86400; empty, non-integer or out of bounds — `3600` is taken. Read on every watcher pass (each reconciliation sweep), a change applies without a restart. The backstop retires a record that never converged within 4× this wait. Applies only while `MYRMIDON_BOT_CONTAINERS` is enabled |
| `MYRMIDON_BOT_ROLLOUT_DEFERRED_MAX_WAIT_SEC` | BOT-ROLLOUT | `3600` | Сколько (в секундах) отложенный выкат образа бота ждёт, пока бот освободится, прежде чем повтор снимет проверку занятости: сверх этого ожидания применение идёт собственным путём pause-and-apply реконсайлера — открывает окно обслуживания агента, дренит идущий прогон до конца (прогоны не прерываются) и пересоздаёт контейнер сразу после текущего хода | От 60 до 86400; пусто, не целое или вне пределов — берётся `3600`. Читается на каждом проходе наблюдателя (каждый свип сверки), изменение применяется без перезапуска. Страховка ретирает запись, не применившуюся за 4× этого ожидания. Действует, только пока включён `MYRMIDON_BOT_CONTAINERS` |
| `MYRMIDON_BOT_LOCAL_MEMORY_OFF` | MEMORY-CENTRAL-A | unset (off) | Turns every bot container's Hermes LOCAL memory off: the compiled `hermes/config.yaml` gets `memory.memory_enabled: false` and `memory.user_profile_enabled: false` (the built-in MEMORY.md/USER.md stores), so durable memory lives only in the shared hindsight service; `memory.provider: "hindsight"` and its `local_external` mode are unchanged. Read at every profile build — a change restarts bot containers (`config.yaml` is a "restart"-class file) | `1`/`true`/`yes`/`on` — disable local memory. Unset, empty, `0`, `false` or a typo — local memory stays on (the pre-feature config byte for byte, so the restartHash reverts) |
| `MYRMIDON_BOT_AUX_FALLBACK_MODELS` | BOT-RUNTIME-TUNING-AUX-CEILING | unset | The cheap ceiling of the auxiliary fallback chains: comma-separated gateway model aliases the profile compiler writes as `auxiliary.title_generation.fallback_chain` and `auxiliary.compression.fallback_chain` for every auxiliary task it configures. Hermes walks these entries before the main chain (the card's `models.fallbacks`, then the gateway's own LiteLLM ladder), so an auxiliary call whose own model refuses the request — the fact of 02.10: the title call's `response_format: json_schema` was rejected and a paid model served the title — is answered by another model of the same cheap class. Each entry is written with its route: the card's provider when it names one, otherwise the instance gateway endpoint with `base_url` and `key_env` spelled out. An entry that repeats the task's own model is dropped (it is not a fallback), duplicates are folded away, and when no route can be resolved the chain is dropped with a compile warning while the auxiliary model itself is still written. The ceiling never covers `auxiliary.vision` — those entries must be vision-capable models | Read on every profile build; a change restarts bot containers. Unset or blank = no chain is written (Hermes's own policy: an auxiliary task on `provider: auto` follows the main chain). The card's `models.titleGeneration` / `models.compressionSummary` still pin the task's model; the ceiling is instance-wide and deliberately has no default — the operator names aliases the gateway actually knows |
| `MYRMIDON_MEDIA_BOTS_FILE` | MEDIA-PROVISION B | `/config/bots.json` | Path where the board's media ACL exporter (media-acl-export.ts, one pass per reconciliation sweep while `MYRMIDON_BOT_CONTAINERS` is on) rewrites the media MCP bot registry from the fleet's cards: one entry per bot with a non-empty `MEDIA_TOOLS_TOKEN` in its card env — `{token_sha256, peer_host, tools}` — atomic temp+rename write, mode 0600, sorted keys, rewritten only when the text or mode changed. The default equals the facade's own `MEDIA_BOTS_FILE` default, so binding the same path into the media-mcp container needs no second setting. Raw tokens never enter the file or the log | Unset keeps `/config/bots.json`. To stop board-side generation entirely, disable `MYRMIDON_BOT_CONTAINERS` (the exporter rides the same flag) — while the flag is on the exporter owns the file: hand edits are reverted on the next sweep pass |
| `MEDIA_BOTS_RELOAD_INTERVAL_S` | MEDIA-PROVISION B | `1` | Facade service (media-mcp): shortest interval between two `bots.json` stamp checks (mtime_ns+size) done before each authentication; the file is re-read only when the stamp changed, so a board rewrite reaches the running facade without a restart. A failed reload (broken/vanished file) keeps the last valid registry and logs a warning | Empty or non-integer — `1`. Larger values trade propagation delay for fewer stats. Never drops below zero checks: with the watcher absent (library use of `Authenticator`) the registry behaves as before, read once at startup |
With `MYRMIDON_BOT_CONTAINERS` enabled, W2a assembles the profile from the `hermes_gateway` card, and after a successful pass over a bot writes into the card `adapterConfig.apiBaseUrl` (`http://myrmidon-bot-<botKey>:8642`), `adapterConfig.apiKey` (a reference to the company secret `myrmidon-bot-<agentId>-api-server-key`, the bot's gateway key, created at the first build) and `adapterConfig.dangerouslyAllowInsecureRemoteHttp: true`. The third field is needed because the Hermes gateway adapter refuses to send the key over plain http to a remote address, and the container address is exactly that (`http://myrmidon-bot-<botKey>:8642`, not loopback). Traffic does not leave the bots' docker network (`MYRMIDON_BOT_NETWORK`): this is the board's path to its own container, so encryption on it is not needed; the field applies only to this card. A narrower variant (the adapter itself trusts `myrmidon-bot-*` hostnames) requires an adapter change and is not part of this PR, see DIVERGENCE. These three fields in container mode belong to the system: whatever is entered into them by hand will be replaced. The MCP gateway address for the profile is rewritten by the same `MYRMIDON_HERMES_RUNTIME_MCP_URL_BASE` and the same card fields (`runtimeMcpUrlBase`, `runtimeMcpUrlRewrite`) as for `hermes_local` (P4). The `adapterConfig.hindsight` block (`bankId`, `tags`, `mission`, `recallBudget`, `memoryMode`, `autoRetain`) is optional. The bot's instructions reach the model once, and only in the `/v1/runs` request: the adapter (G4) sends the agent instruction-pack entry file, then `adapterConfig.instructions` (or `payloadTemplate.instructions`, or the adapter's standard string) after a `---` separator, exactly as for a card outside a container. The profile does not write `workspace/AGENTS.md`: Hermes checks `AGENTS.md`, `CLAUDE.md`, `.cursorrules` and `.hermes.md` with the injection scanner and on a match (e.g. the text has a `curl` command with `$PAPERCLIP_API_KEY`) replaces the whole file with a stub, while the request `instructions` field it does not scan. The remaining text files of the pack (`HEARTBEAT.md`, `SOUL.md`, the `docs/` folder) are placed into `workspace/` under the same relative paths, because the entry file references them; a file under a name that Hermes loads as project context (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.cursor/rules/*.mdc`, `.hermes.md`, in any directory and any case) is skipped with a log entry. Pack limits: at most 50 files, a file at most 256 KiB, a path no longer than 200 characters; a binary, oversized or extra file is skipped with a log entry, not truncated. Editing any pack file rewrites the files in the container without a restart. The card's `env` variables are read the same way as when running the card on the board: names reserved by the board (`PAPERCLIP_API_KEY`, the GitHub bridge and runner network-access variables) and GitHub tokens (`GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `PAPERCLIP_GIT_TOKEN`: the run drops them under board-managed GitHub credentials, and the bot container has no "host credentials" mode) are dropped with a warning; a secret must be bound to this agent at `env.<NAME>` (otherwise the profile is not assembled); the value is read once and held in memory, re-read only when bindings or the secret's version/status change, so that the once-a-minute pass does not write to the secret-access log. The board tool gateway enters the bot's profile as MCP server `paperclip-assigned`: each bot has its own gateway and its own token (see `MYRMIDON_BOT_BOARD_GATEWAY`); agent connections that need the run's identity (a user's personal OAuth) do not enter the container, and a warning about this is written to the container activity log (once per change). Shared servers from `MYRMIDON_BOT_MCP_SERVERS` work independently of the gateway. The bot's key on the board (`myrmidon-bot-container`) is created and stored atomically: the token in the secret must belong to the active key; if the secret write failed, the just-created key is revoked; surplus active keys with the same name are revoked after success. The key is issued to the responsible user: the board rejects an agent key without one (403 `RESPONSIBLE_USER_UNAVAILABLE` on every call). The user is taken by the same rule as a board job without an active person (routines): the company's default user (`defaultResponsibleUserId`), otherwise its oldest active owner; neither — the key is not issued and the profile build fails with an error, the container is not created. A key without a user issued by a previous driver version is fixed in place on the nearest pass: the empty field is filled by the same rule with one conditional UPDATE (only the active `myrmidon-bot-container` key and only while the field is empty), token and secret are unchanged, the container is not restarted; an already filled field (e.g. by hand) is not touched. If there is no user to take or the update failed, a warning is written to the container activity log and the pass repeats on the next tick.

**Managed GitHub credentials reach the container per run (CONTAINER-GITHUB-WRITE).**
When a run's GitHub identity is board-managed (the default; see
`MYRMIDON_HOST_GITHUB_CREDENTIALS` above), the heartbeat mints a run-bound
`github_credentials` capability and the gateway adapter carries it inside the
`/v1/runs` request body (`github_broker`). The gateway binds it to that run
alone — contextvars, never the process env shared by concurrent runs — and
bridges the pair into every terminal and `execute_code` subprocess of the run
as `PAPERCLIP_GITHUB_BROKER_URL`/`PAPERCLIP_GITHUB_BROKER_TOKEN`. While a
capability is bound, the bridge also blanks inherited `GH_TOKEN`/
`GITHUB_TOKEN` (and the related token names) in those subprocesses, so a
static token from the image profile cannot shadow the broker credential. The
dev image's `git` credential helper (URL-scoped to `github.com` over https;
`ssh://git@github.com/…` remotes are rewritten to https) and its `gh` wrapper
resolve the credential per invocation through the board's broker
(`POST /runtime-tools/github/credentials`) and exec the real `git`/`gh`,
walking up to 6 broker address candidates
(`PAPERCLIP_GITHUB_BROKER_URL` → `PAPERCLIP_API_URL` →
`PAPERCLIP_RUNTIME_API_URL` → `PAPERCLIP_RUNTIME_API_CANDIDATES_JSON` items)
and never printing the token. A run without a capability gets both env names
stripped; the wrappers then fail open (the real `git`/`gh` runs with the
environment unchanged). The broker URL the board sends is its own
`PAPERCLIP_API_URL`, so the container must be able to reach that address —
that reachability, not a delivery gap, is what `MYRMIDON_BOT_CONTAINER_GITHUB_ENV_ALLOWLIST`
above remains for.

The "Container" section of the agent card (W2b) introduces no new variables. It reads
`MYRMIDON_BOT_CONTAINERS` and `MYRMIDON_BOT_IMAGE_ALLOWLIST` through
`GET /api/myrmidon/agents/:id/bot-container/status` (a hint "which images are allowed",
a verdict on the saved image) and through `POST .../apply` ("Apply now"). A disabled
`MYRMIDON_BOT_CONTAINERS` gives status "off" and a 409 refusal on "apply". Until the instance
has connected the reconciler runtime (driver and G2 profile compiler), `apply` answers 503, and status
does not ask the container. The runtime is connected by server startup (`startBotContainers`, W2a) with
`MYRMIDON_BOT_CONTAINERS` enabled: the same runtime as the periodic pass. The card field limits (memory 128–262144 MB, CPU 0.1–128, processes
16–65536) are UI rules against typos; the server requires only positive numbers.

## 1.3 — WORKSPACE-HYGIENE (agent workspaces)

## 1.4 — live browser screen (BROWSER-CONSOLE)

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_BROWSER_FLEET` | BROWSER-CONSOLE | unset (fleet empty) | The live browser registry: a JSON array `[{"id":"browser-a","displayName":"Live browser A","egress":{"ru":"socks ru1","ig":"socks nd1"}}]`. The list, screen, journal and site-data cleanup in the Settings → Browsers section read this registry; "who is using it" comes from live sessions. Identifiers are lowercase slugs, up to 16 browsers, up to 8 egress keys. Read on every request, no restart needed | Invalid JSON, not an array, a bad id or a duplicate identifier — the registry is read as empty, a warning goes to the server log; the section answers with an empty list, not an error |
| `MYRMIDON_BROWSER_CONSOLE_HOST` | BROWSER-CONSOLE | unset | Base address of the screen node HTTP API (x11vnc+websockify, a separate deployment). Read in `server/src/myrmidon/browser-console/screen-console-client.ts` | Unset or empty — calls to the node are impossible: "Open screen" answers 502 (the node "did not answer"). The value is not logged |
| `MYRMIDON_BROWSER_CONSOLE_TOKEN` | BROWSER-CONSOLE | unset | The screen node token, sent as Bearer. Read in the same place | Unset — same as without the host. The value is not logged |
| `MYRMIDON_BROWSER_IDLE_TIMEOUT_MIN` | BROWSER-CONSOLE | `30` | After how many minutes without activity (POST `/screen/heartbeat` with `activity: true`) the screen session closes on its own: bots resume, the journal gets `closedBy: idle_timeout` | From 1 to 1440; unset, non-numeric or out of range — the default |
| `MYRMIDON_BROWSER_MAX_DURATION_MIN` | BROWSER-CONSOLE | `120` | A hard session ceiling: closes even with constant activity (`closedBy: max_duration`) | From 5 to 1440; unset, non-numeric or out of range — the default |

The screen session, "who is using it" and the journal (the last 50 entries: who/when/duration/closed-by)
are stored in `instance_settings.general.myrmidonBrowserConsole` — no migrations. The owner (role owner
in the company, instance admin, local implicit) opens the screen, closes it ("Done"), cleans site data
and reads the journal; any authenticated panel user reads the registry; agents get 403 for everything
except the registry. While a session is open, the screen node receives `pause` for bots (the contract) and
the board server rejects MCP calls into that browser (423, a safeguard). Site-data cleanup takes a
domain typed in (bare domain); cookies+storage are cleaned on the node via CDP.

Flow end to end: [guides/browsers.md](guides/browsers.md).

## 1.3 — WORKSPACE-HYGIENE (agent workspaces)

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_WORKSPACE_QUOTA_MB` | WH-C | unset (disabled) | Disk ceiling per workspace: a pass from the scheduler tick measures each workspace's directory (a walk bounded by depth, entries and time; sums over hardlink inodes are not duplicated) and on excess writes a "clean up" signal to the activity log — at most once a day per workspace. The variable is the default at first start: afterwards the effective values are stored in settings (`instance_settings.general.workspaceHygiene`) and change on the fly via `GET`/`PATCH /api/myrmidon/workspace-hygiene` (read — board, write — instance-admin). The pass deletes nothing — deletion remains with terminal-workspace resolution | Unset, empty, `0`, negative or non-numeric — the ceiling is off (no signals). Only workspaces with a local directory (`providerType = local_fs`) are measured; a workspace whose walk hit the bound is counted by the lower bound, and its report has `truncated` |
| `MYRMIDON_WORKSPACE_TOTAL_QUOTA_MB` | WH-C | unset (disabled) | Ceiling on the sum of measured workspaces of one company: a separate signal in the activity log, at most once a day per company. Catches the case "many workspaces, each within its own ceiling" | Unset, empty, `0`, negative or non-numeric — the ceiling is off |

## 1.3 — STACK-UPDATES stack registry (SUA, parts A and B)

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_STACK_DOCKER_SOCKET` | SUA | `/var/run/docker.sock` | Path to the Docker unix socket the stack registry image probes use to read digests and component labels with the `docker-image` probe (Docker API `GET /images/{ref}/json`, 10s timeout) | Socket unavailable on `POST /api/myrmidon/stack/refresh` — 503, the previous cache is kept; an individual missing image is an honest «unknown» with a reason, not an error. Read on every refresh, no server restart needed |
| `MYRMIDON_STACK_CHECK_INTERVAL_SEC` | SUB | unset (off) | How often (sec) the scheduled stack release check runs: for `github-releases`/`github-tags` components it reads the anonymous release/tag list, records the latest, our lag and the notable release-note lines (security/breaking/CVE, top-5) into the stack cache, and evaluates the "is our carried patch closed upstream" rule through the compare API. `POST /api/myrmidon/stack/check` (instance-admin) runs the same code on demand | Unset, empty, `0`, negative or non-numeric — the sweep is off and the board touches the network only through the manual route. Values below 60 are lifted to 60. A transport failure answers 503 and keeps the previous cache; an HTTP error status is recorded per component |

## EXTCASE-B — мост браузера расширению клиента

Настройки серверного модуля `server/src/myrmidon/browser-bridge/` (первый сторонний кейс: браузерные
действия выполняются в браузере клиента, доска туда не дотягивается). Настройки моста задаются не
переменной окружения, а записью `instance_settings.general.browserBridge`
(`GET`/`PATCH /api/myrmidon/browser-bridge/settings`, чтение — board, запись — instance-admin):
`domains` — домены ТП (allowlist), `signing` — политика подписи клиента
(`enabled` — аварийное выключение, `mode` — `auto`/`manual`/`types`, `types` — типы действий,
которые требуют человека при `mode: types`). Аварийное выключение одной кнопкой —
`POST /api/myrmidon/browser-bridge/signing/disable`; после него шлюз отклоняет любое sign-действие
(fail-closed), а факт выключения пишется в журнал компании.

| Переменная | Функция | По умолчанию | Что делает | Как выключить / особое |
|---|---|---|---|---|
| `MYRMIDON_BROWSER_BRIDGE_PEPPER` | EXTCASE-B | не задана | Перец HMAC для pairing-кодов и bridge-токенов моста: в базе лежат только дайджесты, по ним проверяются предъявленный код (обмен на токен устройства) и токен при подключении расширения к `/bridge/v1` | Не задана — процесс берёт случайный перец на свой старт и пишет предупреждение: всё выданное до перезапуска перестаёт проверяться, устройства парируются заново (панель выдаёт новый код). Задаётся в окружении доски, значение — секрет, в репозитории и логах не хранится. Перец общий на инстанс, поэтому он не лежит в настройках, которые панель читает и правит |

При включённом `MYRMIDON_BOT_CONTAINERS` W2a собирает профиль из карточки `hermes_gateway`, а после успешного прохода по боту прописывает в карточке `adapterConfig.apiBaseUrl` (`http://myrmidon-bot-<botKey>:8642`), `adapterConfig.apiKey` (ссылка на секрет компании `myrmidon-bot-<agentId>-api-server-key`, ключ шлюза бота, создаётся при первой сборке). Флага небезопасного http в карточке больше нет (H3, выпуск 1.1.2): адаптер шлюза Hermes сам доверяет именам контейнеров ботов (`myrmidon-bot-<botKey>`) для plain http — трафик не выходит из docker-сети ботов (`MYRMIDON_BOT_NETWORK`), это путь доски к своему же контейнеру, а сгенерированное системой имя не может быть занято произвольным хостом. Остаточный `dangerouslyAllowInsecureRemoteHttp: true` от прежней проводки сверка контейнеров удаляет с ближайшего прохода; все остальные удалённые хосты — по-прежнему HTTPS или dev-only escape hatch из сырого JSON конфига.Эти три поля в контейнерном режиме принадлежат системе: то, что в них введено руками, будет заменено. Адрес MCP-шлюза для профиля подменяется тем же `MYRMIDON_HERMES_RUNTIME_MCP_URL_BASE` и теми же полями карточки (`runtimeMcpUrlBase`, `runtimeMcpUrlRewrite`), что и у `hermes_local` (P4). Блок `adapterConfig.hindsight` (`bankId`, `tags`, `mission`, `recallBudget`, `memoryMode`, `autoRetain`) необязателен. Инструкции бота приходят в модель один раз, и только в запросе `/v1/runs`: адаптер (G4) отправляет файл-вход пакета инструкций агента, затем `adapterConfig.instructions` (или `payloadTemplate.instructions`, или стандартную строку адаптера) через разделитель `---`, ровно как для карточки вне контейнера. `workspace/AGENTS.md` профиль не пишет: Hermes проверяет `AGENTS.md`, `CLAUDE.md`, `.cursorrules` и `.hermes.md` сканером инъекций и при совпадении (например, в тексте есть команда `curl` с `$PAPERCLIP_API_KEY`) заменяет весь файл заглушкой, а поле `instructions` запроса он не сканирует. Остальные текстовые файлы пакета (`HEARTBEAT.md`, `SOUL.md`, папка `docs/`) кладутся в `workspace/` под теми же относительными путями, потому что файл-вход ссылается на них; файл под именем, которое Hermes загружает как контекст проекта (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.cursor/rules/*.mdc`, `.hermes.md`, в любом каталоге и любом регистре), пропускается с записью в журнал. Пределы пакета: не больше 50 файлов, файл не больше 256 КиБ, путь не длиннее 200 знаков; бинарный, слишком большой или лишний файл пропускается с записью в журнал, а не обрезается. Правка любого файла пакета перезаписывает файлы в контейнере без перезапуска. Переменные `env` карточки читаются так же, как при прогоне карточки на доске: имена, зарезервированные доской (`PAPERCLIP_API_KEY`, переменные моста GitHub и сетевого доступа раннера), и токены GitHub (`GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `PAPERCLIP_GIT_TOKEN`: прогон их отбрасывает при управляемых доской учётных данных GitHub, а контейнер бота режима «учётные данные хоста» не имеет) отбрасываются с предупреждением; секрет должен быть привязан к этому агенту на `env.<ИМЯ>` (иначе профиль не собирается); значение читается один раз и держится в памяти, повторно читается только при смене привязок или версии/статуса секрета, чтобы проход раз в минуту не писал в журнал доступа к секретам. Шлюз инструментов доски входит в профиль бота как MCP-сервер `paperclip-assigned`: у каждого бота свой шлюз и свой токен (см. `MYRMIDON_BOT_BOARD_GATEWAY`); подключения агента, которым нужна личность прогона (личный OAuth пользователя), в контейнер не попадают, а в журнале активности контейнеров об этом пишется предупреждение (один раз на изменение). Общие серверы из `MYRMIDON_BOT_MCP_SERVERS` работают независимо от шлюза. Ключ бота на доске (`myrmidon-bot-container`) заводится и хранится атомарно: токен в секрете должен принадлежать действующему ключу; если запись секрета не удалась, только что созданный ключ отзывается; лишние действующие ключи с тем же именем отзываются после успеха. Ключ выдаётся на ответственного пользователя: доска отвергает ключ агента без него (403 `RESPONSIBLE_USER_UNAVAILABLE` на каждый вызов). Пользователь берётся по тому же правилу, что у работы доски без действующего лица (рутины): пользователь по умолчанию компании (`defaultResponsibleUserId`), иначе её старейший действующий владелец; нет ни того ни другого — ключ не выдаётся и сборка профиля падает с ошибкой, контейнер не создаётся. Ключ без пользователя, выданный прежней версией драйвера, исправляется на месте на ближайшем проходе: пустое поле заполняется тем же правилом одним условным UPDATE (только действующий ключ `myrmidon-bot-container` и только пока поле пусто), токен и секрет не меняются, контейнер не перезапускается; уже заполненное поле (например, руками) не трогается. Если пользователя взять не из чего или обновление не удалось, в журнале активности контейнеров пишется предупреждение и проход повторяется на следующем тике.
## 1.4 — EXT-CASE-OCR (the OCR path: PDF -> text in the bot workspace)
| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_OCR_BASE_URL` | EXT-CASE-OCR | unset (path closed) | Address of the company's OCR contour as the board sees it: the MCP address of RAGFlow or an OpenAI-compatible gateway address (LiteLLM). Together with `MYRMIDON_OCR_KEY_SECRET` it opens the path; without either of the two settings the bot gets a stable `ocr_disabled` refusal and not a single request goes out | Empty/unset — the path is closed. The address may end with `/v1` (then it is not duplicated) |
| `MYRMIDON_OCR_KEY_SECRET` | EXT-CASE-OCR | unset | **Name** of the company secret holding the OCR contour key (not the value). The value is read on every call for the task's owning company; it never appears in the setting, logs or journal | Empty/unset — the path is closed. The secret is created by the company's operator in the "Secrets" section |
| `MYRMIDON_OCR_BACKEND` | EXT-CASE-OCR | `ragflow` | Which adapter is called: `ragflow` (MCP JSON-RPC `tools/call`, DeepDOC parsing) or `litellm` (chat request with the PDF as a file part). An unknown value — `ragflow` (a typo must not close the path) | With `litellm` and no `MYRMIDON_OCR_MODEL` the profile is not assembled: the call answers `ocr_disabled` |
| `MYRMIDON_OCR_MODEL` | EXT-CASE-OCR | unset | For `litellm` — the name of the model that reads the PDF; for `ragflow` — the name of the parsing MCP tool (RAGFlow versions name it differently), `parse_document` by default | Empty — `litellm` refuses `ocr_disabled`, `ragflow` takes `parse_document` |
| `MYRMIDON_OCR_MAX_BYTES` | EXT-CASE-OCR | `33554432` (32 MiB) | PDF size ceiling: above it — a `document_too_large` refusal before the backend is contacted (and before base64 is decoded in the tool) | Non-numeric, `0`, negative — the default is taken |
| `MYRMIDON_OCR_MAX_PAGES` | EXT-CASE-OCR | `500` | Page-count ceiling (the page count is read from the PDF bytes); above it — a `too_many_pages` refusal before the backend | As above |
| `MYRMIDON_OCR_MAX_CHARS` | EXT-CASE-OCR | `2000000` | Ceiling on the recognized text: the remainder is cut, the metadata gets `truncated: true` | As above |
| `MYRMIDON_OCR_TIMEOUT_SEC` | EXT-CASE-OCR | `120` | Timeout of the request to the OCR backend (from 5 to 600; below 5 is raised to 5) | As above |
| `MYRMIDON_OCR_WORKSPACE_DIR` | EXT-CASE-OCR | unset | Directory where a copy of the recognized text is placed (`<name>-<hash>.txt`, mode 0600). Without the setting the text lives only in the tool's response (a container bot writes it into its workspace itself) | Empty — no copy on disk |

The bot's tool is `ocr.pdf` (input: `name`, `base64`, optional `origin`, `sourceId`; output: `text`,
`pages`, `structure`, `metadata`). Served to the company at `POST /api/myrmidon/companies/:companyId/ocr/mcp`
(JSON-RPC: `initialize`, `tools/list`, `tools/call`); only metadata goes to the activity journal
(`name`, `sizeBytes`, `pages`, `origin`, `sourceId`, `backend`, `chars`, `truncated`) — the text and bytes
never enter the journal.

## 1.6 — EVALS-A (reference tasks and the LLM judge)

Settings of the module `server/src/myrmidon/evals/` (the 1.6 evals path: a seeded corpus of neutral
reference tasks for the pilot role, an LLM judge behind the company's LLM gateway, scores stored in
`myrmidon_eval_runs`, a threshold+repeat regression verdict). Reads are company-scoped; run mutations
need a board actor. While the contour below is not configured, reads still work and mutations answer
`503` with the names of the missing settings instead of guessing.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_EVALS_BASE_URL` | EVALS-A | unset (judge disabled) | Address of the company's LLM gateway contour (OpenAI-compatible, e.g. LiteLLM). Together with `MYRMIDON_EVALS_KEY_SECRET` it opens the judge path; without either the evals mutations answer `503` with the reason | Empty/unset — the judge is disabled (reads still work). The address may end with `/v1` (then it is not duplicated) |
| `MYRMIDON_EVALS_KEY_SECRET` | EVALS-A | unset | **Name** of the company secret holding the gateway key (not the value). The value is read per company on every run; it never appears in the setting, logs or journal | Empty/unset — the judge is disabled |
| `MYRMIDON_EVALS_MODEL` | EVALS-A | `qwen-plus-free` | The judge model behind the gateway. The 1.6 wave rule applies: a free DashScope model by default; paid models stay a deploy-repo concern | Any value the gateway serves |
| `MYRMIDON_EVALS_TIMEOUT_SEC` | EVALS-A | `120` | Timeout of one judge chat-completions call (valid range 5 to 600) | Non-numeric, `0`, negative — the default is taken |
| `MYRMIDON_EVALS_LANGFUSE` | EVALS-A | unset | Master flag for the Langfuse score export: `true` enables exporting run scores to Langfuse when the contour below is configured. Scoring is written locally (eval_runs) regardless of this flag | Empty/unset/anything but `true` — no Langfuse export, local scoring only |
| `MYRMIDON_EVALS_LANGFUSE_BASE_URL` | EVALS-A | unset | Langfuse ingestion base URL (the `/api/public/ingestion` suffix is appended). Used only when `MYRMIDON_EVALS_LANGFUSE=true` | Empty — the export is a no-op |
| `MYRMIDON_EVALS_LANGFUSE_KEY` | EVALS-A | unset | Langfuse public ingestion key. Used only when `MYRMIDON_EVALS_LANGFUSE=true` | Empty — the export is a no-op |
| `MYRMIDON_EVALS_LANGFUSE_TIMEOUT_SEC` | EVALS-A | `30` | Timeout of the Langfuse ingestion request (from 1 to 600) | Non-numeric, `0`, negative — the default is taken |
| `MYRMIDON_EVALS_JUDGE_PRIORITY_MODELS` | EVALS-JUDGE-FAMILY | `qwen-plus-free,qwen-plus,qwen-max` | Comma-separated ordered list of judge models to try in priority order for evaluation | Invalid format — the default list is used |

The board API is `GET/POST /api/myrmidon/companies/:companyId/evals/{tasks,seed,runs,runs/:runId,runs/:runId/confirm,verdict}`.
The judge never executes code: for `code`-kind reference tasks the CI pass rate arrives as a request
parameter and is folded into the aggregate as a separate score line.

The operator guide for the whole path — seeding the corpus, running a subject,
the promote/confirm/regress verdict with its threshold+repeat rule, the
journal rows and the Langfuse export — is
[guides/reference-task-evals.md](guides/reference-task-evals.md).

## EXTCASE-B — browser bridge to the client's extension

Settings of the server module `server/src/myrmidon/browser-bridge/` (the first third-party case: browser
actions run in the client's browser, the board cannot reach it). The bridge is configured not by an
environment variable but by the `instance_settings.general.browserBridge` record
(`GET`/`PATCH /api/myrmidon/browser-bridge/settings`, read — board, write — instance-admin):
`domains` — the allowlist of support domains, `signing` — the client signing policy
(`enabled` — emergency off, `mode` — `auto`/`manual`/`types`, `types` — action types that require
a human under `mode: types`). The one-button emergency off is
`POST /api/myrmidon/browser-bridge/signing/disable`; after it the gateway rejects any sign action
(fail-closed) and the fact is written to the company journal.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_BROWSER_BRIDGE_PEPPER` | EXTCASE-B | unset | HMAC pepper for pairing codes and bridge tokens of the bridge: only digests live in the database; the presented code (exchanged for a device token) and the token at the extension's `/bridge/v1` connection are verified against them | Unset — the process takes a random pepper at its startup and logs a warning: everything issued before the restart stops validating, devices re-pair (the panel issues a new code). Set in the board's environment; the value is a secret, never stored in the repo or logs. The pepper is per-instance, which is why it is not kept in the settings the panel reads and edits |

## Settings in the agent record (not environment variables)

| Field | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `permissions.toolAccess` | S6 | `{ "mode": "all" }`, written into the agent record explicitly | The agent's permission for tools and connections. `mode: "listed"` — only tools from `tools` and connections from `connections` are allowed, other calls are rejected (403, `deny_agent_permission`, a line in the call log). Set by the operator in the agent card (Permissions tab, "Tool and connection access" section) or `PATCH /api/agents/:id/permissions` with the `toolAccess` field | `{ "mode": "all" }` — previous behavior. An agent without the field and a record with an unreadable value are read as `all` |
| `recallOnRunStart` (plugin instance configuration, not an environment variable) | PERF-DIET-HS | `new-issue` | Run-start recall policy of the hindsight plugin (`packages/plugins/hindsight-paperclip`): `new-issue` — search the agent's bank only when the agent has not already searched for this ticket; `always` — search on every run start (the previous behaviour); `never` — no run-start search. The `hindsight_recall` tool is unaffected. Set in the plugin's instance configuration, not in env; a value absent or outside the enum reads as `new-issue`. What the plugin writes into the bank — [guides/agent-memory-card.md](guides/agent-memory-card.md) | `always` restores the previous behaviour; `never` turns run-start recall off |

## SC1 — server console (SERVER-CONSOLE, 1.4)

The "Server console" section in company settings (`server/src/myrmidon/fleet-console/`,
contract — [design/server-console.md](design/server-console.md)). One variable: the address
of the Guacamole client. The signing key and node passwords are company secrets, not
environment variables.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_FLEET_CONSOLE_URL` | SC1 | unset (off) | Base address of the Guacamole client for which the panel signs the auth-JSON (e.g. `https://guac.example.com`, no trailing `/`). It also goes into the token-issuing response and the `consoleUrl` address | Unset or empty — token issuance answers `503 console_not_configured`, the node registry and the log keep working. The company secret with the shared key is `guacamole-json-secret-key` (the value is read by the server, never appears in a response or the log); a registry row may reference a secret with the node password. Read at route assembly on server startup |

Operator guide: [guides/server-console.md](guides/server-console.md) — the registry, the one-time token, the journal and the error codes.

## CLOUD-CONNECTOR — cloud storage connector (1.4)

The "Clouds" module (`server/src/myrmidon/cloud-connector/`, contract —
`packages/shared/src/myrmidon-cloud-connector.ts`). The connector state lives in
`instance_settings.general.myrmidonCloudConnector`; the owner's token never does — it is a company
secret of the instance secret store (`myrmidon-cloud-<provider>`), written by the connect flow and
rotated on every automatic refresh. A provider with no client credentials here cannot be connected;
a folder whose company has no connected account answers a cloud call with `409 not connected`.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_CLOUD_CONNECTOR_REDIRECT_BASE` | CLOUD-CONNECTOR | unset (off) | Public base address of the panel the cloud providers send the owner back to (e.g. `https://board.example.com`, no trailing `/`). The connectors' callback is `<base>/api/myrmidon/cloud-connector/oauth/callback` and must be registered in each provider's OAuth app | Unset or empty — the callback address stays relative and every connect start answers `409 the connector callback address is not configured`; the folder/grant/journal surface keeps working |
| `MYRMIDON_CLOUD_ONEDRIVE_CLIENT_ID` | CLOUD-CONNECTOR | unset (off) | OAuth client id of the Microsoft (OneDrive) app. Scopes requested: `Files.ReadWrite.All offline_access User.Read`; the account is a personal Microsoft account (`consumers`) | Unset — OneDrive cannot be connected (`409 not configured`); everything else keeps working |
| `MYRMIDON_CLOUD_ONEDRIVE_CLIENT_SECRET` | CLOUD-CONNECTOR | unset | Client secret of the same app. Read by the server only, never returned in a response or written to a log | — |
| `MYRMIDON_CLOUD_GOOGLE_DRIVE_CLIENT_ID` | CLOUD-CONNECTOR | unset (off) | OAuth client id of the Google Drive app. Scope requested: `https://www.googleapis.com/auth/drive` with `access_type=offline` (the connector confines every call to the granted folder) | Unset — Google Drive cannot be connected; the provider itself is registered by default |
| `MYRMIDON_CLOUD_GOOGLE_DRIVE_CLIENT_SECRET` | CLOUD-CONNECTOR | unset | Client secret of the same app | — |
| `MYRMIDON_CLOUD_YANDEX_DISK_CLIENT_ID` | CLOUD-CONNECTOR | unset (off) | OAuth client id of the Yandex Disk app. Scopes requested: `cloud_api:disk.read cloud_api:disk.write`; Yandex does not support PKCE, so none is sent | Unset — Yandex Disk cannot be connected; the provider itself is registered by default |
| `MYRMIDON_CLOUD_YANDEX_DISK_CLIENT_SECRET` | CLOUD-CONNECTOR | unset | Client secret of the same app | — |

Agent surface: the connector also serves the cloud tools over MCP at
`POST <board>/api/mcp/cloud-tools` (JSON-RPC; `initialize`, `tools/list`,
`tools/call` with `cloud_list`, `cloud_search`, `cloud_read`, `cloud_download`,
`cloud_upload`, `cloud_move`). It needs no variable of its own: the caller is the
agent's own run key, and every call is confined to the folders granted to that
agent. To let agents see the tools, register the board address as a tool
connection and assign it — the endpoint itself is always on.

Two things the agent surface relies on that are worth knowing when a call is
refused. A `caste` grant matches the agent's board role (`agents.role`), read
per call; an agent whose role is empty has no caste and only matches grants to
the agent itself or to everyone. And the root name `personal` is reserved: it
always means the calling agent's own folder, which the connector creates on
first use and grants `rw` to that agent alone. The owner cannot create a folder
with that name (`400 reserved`), and an agent asking for it is told what to do
when the answer is not obvious — no account connected for its company, or
several clouds connected (`409`, naming the providers).

## 1.4 — agent memory card (MEMORY-UI)

The "Memory" tab of the agent card (`server/src/myrmidon/agent-memory/`):
view, export and remove the entries of the agent's memory bank (the same
service the memory plugin writes to). Two variables, both required to enable;
the key itself is a company secret, not an environment variable.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_HINDSIGHT_API_URL` | MEMORY-UI | unset (falls back to `MYRMIDON_BOT_HINDSIGHT_API_URL`) | Base address of the shared memory (hindsight) service as the board server sees it; the tab's list, export, delete and clear calls go there. Address precedence: the instance setting `general.agentMemory.apiUrl` (Instance settings → General → Agent memory), then this variable, then `MYRMIDON_BOT_HINDSIGHT_API_URL` (the same service as the bots see it) | No address at all, or not an `http(s)://` URL — the section is off: status answers `enabled: false`, data routes answer 503. The setting `general.agentMemory.enabled = false` switches the section off even with an address. The setting is re-read on every request, no restart needed. The address is not logged |
| `MYRMIDON_HINDSIGHT_KEY_SECRET` | MEMORY-UI | unset (no key) | Name of the company secret holding the memory service API key; optional. The key is sent only when a secret name is set (setting `general.agentMemory.keySecretName`, then this variable); a service without authentication needs none. A named secret that does not exist means calls without a token | Unset or empty — no key is sent (the section stays on if an address is known). The key value is read only for the duration of a call, never written to the log or an API response |

## 1.4 — agent instructions revisions (H2)

The revision history of an agent's instructions bundle
(`server/src/myrmidon/agent-instructions-revisions/`): every bundle edit is
snapshotted into the `agent_instructions_revisions` table and any earlier
revision can be restored from the agent card. No new variables: the feature is
always on and needs no configuration. Recorded here per the registry rule.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| — | H2 | — (always on) | Instructions bundle revisions are recorded on every file put/delete and bundle patch, and `POST /api/agents/:id/instructions-revisions/:revisionId/rollback` restores a revision (the restore itself becomes a new revision). No settings | Not configurable: this is a corrective feature with no deployment-specific values. Rollback of an external bundle is refused (422) until the agent switches to a managed bundle |

## 1.4 — automatic resume from `error` (AUTO-RESUME)

An agent left in `error` by a failed run is resumed by the board itself with a
backoff of 1, 5 and 15 minutes, reusing the L3 pause/resume wake chain (the
resumed agent also wakes the work it was stranded on). After the attempt cap the
board stops and escalates the agent's `agent_error_alert` card on the attention
desk to "the board gave up; an operator must intervene". The failure counter and
the give-up mark live in `agents.metadata.myrmidon_auto_resume`; an agent record
change after the give-up (an operator action) re-arms the counter.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_AUTO_RESUME_ENABLED` | AUTO-RESUME | `1` (on) | Master switch: the board resumes an agent left in `error` on its own | `0`/`false`/`off`/`no` — disable (vendor behaviour: `error` until an operator resumes by hand). Unset or unrecognized — enabled |
| `MYRMIDON_AUTO_RESUME_BACKOFF_MS` | AUTO-RESUME | `60000,300000,900000` (1/5/15 min) | Comma-separated backoff steps in milliseconds per resume attempt; the last step repeats. The first attempt is due one step after the agent entered `error` | Only positive integers are read; invalid entries are dropped; an empty or all-invalid list falls back to the default |
| `MYRMIDON_AUTO_RESUME_MAX_ATTEMPTS` | AUTO-RESUME | `3` | Failed resumes in one streak before the board gives up and raises the operator card; the agent is then left in `error` until an operator acts | Non-numeric, `0`, negative — the default |
| `MYRMIDON_AUTO_RESUME_INTERVAL_SEC` | AUTO-RESUME | `60` | How often (sec) the sweep looks for due agents; the sweep runs on the scheduler tick and this gate keeps it per-minute | Values below 10 — 10. Non-numeric, `0`, negative — the default |
| `MYRMIDON_AUTO_RESUME_WINDOW_MS` | AUTO-RESUME | `3600000` (1 h) | A streak whose last failure is older than this is treated as a new episode (the attempt counter restarts) | Non-numeric, `0`, negative — the default |

## 1.5 — TRACING-HEALTH: LLM tracing health check

Settings of `server/src/myrmidon/tracing-health/` — `GET /api/myrmidon/tracing/health`.
The check shares the gateway address and key with the M2-A cost collection
(`MYRMIDON_LITELLM_BASE_URL` + `MYRMIDON_LITELLM_KEY_SECRET`, see the Bot
containers section above); only the Langfuse ClickHouse endpoints are new rows.
All off by default.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_TRACING_CLICKHOUSE_URL` | TRACING-HEALTH | unset (off) | Address of the Langfuse ClickHouse HTTP interface (`http(s)://…:8123`) over which the health check counts the trace events of the window in `events_core` (Langfuse v4 `events_only` mode: the `traces`/`observations` tables stay empty, the data lives in ClickHouse — counting them is wrong by design). The address is not stored in the open repository; the value is set by the deployment | Set together with the two `MYRMIDON_LITELLM_*` gateway settings; without all three the check is off and `GET /api/myrmidon/tracing/health` answers 503 `{enabled: false}` |
| `MYRMIDON_TRACING_CLICKHOUSE_USER` | TRACING-HEALTH | unset | ClickHouse user for the health check queries | Unset — the query goes without user/password parameters |
| `MYRMIDON_TRACING_CLICKHOUSE_PASSWORD` | TRACING-HEALTH | unset | ClickHouse password of that user | Sent as a request parameter of the ClickHouse HTTP interface and never logged, stored or returned in the response |
| `MYRMIDON_TRACING_CLICKHOUSE_DATABASE` | TRACING-HEALTH | `default` | Database of the Langfuse tables (`events_core`, `langfuse_ingestion_rejections`) | — |
| `MYRMIDON_TRACING_WINDOW_SEC` | TRACING-HEALTH | `900` (15 min) | Length of the health check window: events in ClickHouse and gateway requests are counted over the last N seconds | From 60 to 3600; non-integer or out of bounds — the default. A window with no gateway traffic is the state `idle` (OK with a reason), not an alarm: the check must not cry wolf on quiet periods |
| `MYRMIDON_TRACING_HEALTH_TTL_SEC` | TRACING-HEALTH | `60` | Cache TTL of the report: the probes run at most once per TTL; inside it the previous report is served (checkedAt shows when it was actually measured) | From 5 to 3600; non-integer or out of bounds — the default. Any probe failure is the state `unknown` with a reason in the JSON contract, never a 500 |
| `MYRMIDON_TRACING_SIGNAL_INTERVAL_SEC` | TRACING-HEALTH | `300` | Period (sec) of the operator-signal sweep (part D): the board itself polls the tracing health report and records the attention signal + the state-transition journal row, so the operator desk is fresh even when nobody has the status card open. A steady state writes nothing — one row per transition only | From 60 to 86400; non-integer or out of bounds — the default. Off together with the check itself: no tracing settings — no timer, no query |

Health semantics (the operator's 02.10 findings, baked into the domain):
`idle` without gateway traffic; `degraded` when events are missing while traffic
flowed, when the delivery ratio (OTEL events in `events_core` per gateway
request) is below 0.5, when any "Rejected … legacy" ingestion rejection landed
in the window (the incident signature), or when the callback error rate is at
or above 0.02; `unknown` on probe failure. The evidence fields `deliveryRatio`
and `legacyRejections` are additive parts of the JSON contract for the part D
dedup key; fields without a source stay null and never block the computation.

The check has two board surfaces, both reading the same report — see
[guides/tracing-health.md](guides/tracing-health.md): the "LLM tracing" status
card in Company settings and the operator attention signal that runs even when
nobody has the card open.


## 1.6 — WIKI-CORTEX: company regulations in the wiki

Regulation pages of `server/src/myrmidon/wiki-cortex/` — draft → approved
lifecycle, revisions, rollback, the role resolver, and the delivery of
`REGULATIONS.md` into the compiled bot profile. See
`docs/myrmidon/guides/wiki-regulations.md` for the API and the wiki-maintainer
runbook. No new variables: the feature is always on and needs no configuration.
Recorded here per the registry rule.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| — | WIKI-CORTEX | — (always on) | `PUT /api/myrmidon/companies/:id/wiki-regulations/:slug` saves a draft revision; `POST …/approve` (board only) makes the newest revision the delivered text; `POST …/rollback` (board only) restores an earlier revision as a new one; `GET …/approved/:role` is the resolver the bot profile compile reads and renders into the agent's workspace `REGULATIONS.md` | Not configurable: no deployment-specific values. The delivered file never shadows a `REGULATIONS.md` the agent's own bundle ships (a warning is recorded instead) |

## TASK-PR-SYNC — a task settles once its pull requests merge

A task whose `work_product` of type `pull_request` merged used to stay busy
until someone noticed. The scheduler tick now runs a pass that refreshes each
PR's state through the existing GitHub resolver and closes the task (`done`,
one comment with the PR refs / merge sha / time, an activity row) when every
PR has reached a terminal state and at least one merged and no post-deploy
gate is still open. When none of them merged, the task goes back to its
assignee (`in_progress` plus a comment) unless a newer comment already
answered the closure. The sweep reads the same work-products surface the
board uses; it adds no token or credential. Operator guide:
[guides/task-pr-sync.md](guides/task-pr-sync.md).

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_TASK_PR_SYNC_ENABLED` | TASK-PR-SYNC | `1` (on) | Master switch of the delivering-PR sweep: on — a task is linked to its PRs and settled when they all merge | `0`/`false`/`off`/`no` — disable (tasks stay busy until closed by hand). Unset or unrecognized — enabled: a typo does not silently extinguish the fix |
| `MYRMIDON_TASK_PR_SYNC_POLL_SEC` | TASK-PR-SYNC | `60` | Minimum spacing between two passes; the scheduler queue itself ticks more often | Values below 15 or non-numeric or fractional — the default (60) |
| `MYRMIDON_TASK_PR_SYNC_BATCH_MAX` | TASK-PR-SYNC | `50` | How many candidate tasks one pass inspects at most (each task costs one GitHub resolve per PR) | From 1 to 500; values outside the range or non-numeric — the default |
| `MYRMIDON_TASK_PR_SYNC_SETTLE_DISABLED` | TASK-PR-SYNC | unset (settling on) | Instance-wide lever to make the sweep read and log but never flip a task to `done` — for a deliberate post-deploy hold on every task at once. A task with its own post-deploy gate is already deferred per task (a pending card, a pending approval, or a monitor scheduled for the future) | `1`/`true`/`on`/`yes` — settling off; anything else — settling on. The per-task gate check cannot be disabled by this switch |

## TASK-PR-SYNC WAKE-GUARD — no run for a task whose pull requests all merged

The admission-side half of TASK-PR-SYNC: before the board dispatches a run for
an event-free wake, it checks whether the task's pull_request work products are
all terminal with at least one merged and the task is not settled yet. When so,
the wake is skipped with the vendor skip mechanism (a skipped wakeup request
with reason `wake_skipped_pr_settle_pending`) and the task PR sync sweep closes
the task on its next tick. Human comment and interaction wakes are never
suppressed. The decision is cached per issue so the admission path pays no
database hit per wake.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_TASK_PR_SYNC_WAKE_GUARD_ENABLED` | WAKE-GUARD | `1` (on) | Master switch of the wake guard: on — an event-free wake to a settle-pending task is skipped instead of dispatching a run | `0`/`false`/`off`/`no` — disable (wakes dispatch runs as before). Unset or unrecognized — enabled: a typo does not silently extinguish the fix |
| `MYRMIDON_TASK_PR_SYNC_WAKE_GUARD_TTL_SEC` | WAKE-GUARD | `60` | How long a suppress decision stays cached for one task (matches the sweep's default poll); the cache holds at most 1000 issues, least-recently-used eviction | From 1 to 3600; non-numeric, non-positive or above the cap — the default (60) |
| `MYRMIDON_SWARM_CLAIM_ENABLED` | 1.6-SWARM | `0` (off) | Master switch of the per-role task queues: on — an agent claims the top task of its own role's queue behind a lease (TTL + heartbeat), an expired lease returns the task to the queue and the sweep wakes the next agent of the role; the checkout writes the run's claim, the finishing run releases it. Off — no claim is written and the sweep is a no-op (vendor behavior) | `1`/`true`/`on`/`yes` — enable. Unset or unrecognized — off: the swarm must be turned on deliberately |
| `MYRMIDON_SWARM_LEASE_TTL_SEC` | 1.6-SWARM | `900` | How long (sec) a claim's lease stays valid without a heartbeat; the run refreshes it on every checkout pass. The acceptance window (idle agent with a non-empty queue of its role) is one TTL plus one sweep interval | From 60 to 86400; below 60 — 60, above 86400 — 86400. Non-numeric, `0`, negative or fractional — the default |
| `MYRMIDON_SWARM_MAX_ACTIVE_TASKS` | 1.6-SWARM | `3` | The per-agent ceiling of live claims; a capped agent is not handed new work until a lease finishes, expires or is released. `none` — no ceiling (all queue work claimable) | From 1 to 100; `none`/`0` — no ceiling. Non-numeric or fractional — the default |
| `MYRMIDON_SWARM_CLAIM_SWEEP_INTERVAL_SEC` | 1.6-SWARM | `30` | How often (sec) the expired-claim sweep runs on the scheduler tick: it releases expired leases, releases claims whose task left the queue, and wakes the next agent of the released task's role | From 5 to 3600; below 5 — 5. Non-numeric, `0`, negative or fractional — the default |


## 1.6 — BASELINE: frozen metric snapshots

The server part of BASELINE computes, for an arbitrary window and per project
and per agent role, the cycle time, the time in review, the return rate, the
blocked time with its top causes, the runs per task and the LLM cost per task
from the board's own history
(`GET /api/myrmidon/companies/:companyId/baseline/metrics?from&to`). The
periodic job below freezes the last 14 days into `baseline_metric_snapshots`,
so a pilot after the autonomy changes can be compared against the number the
board produced before them.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_BASELINE_INTERVAL_SEC` | 1.6-BASELINE | unset (off) | Period (sec) of the snapshot job: every tick recomputes the last 14 days per company and appends one frozen row to `baseline_metric_snapshots` | Unset or empty — no timer, no query. Set to an integer from 60 to 604800; an unreadable or out-of-range value keeps the job on with the daily default (86400) |

## 1.6 — SKILL-LIFECYCLE: company skill lifecycle

Settings of `server/src/myrmidon/skill-lifecycle/`. A company skill is
`candidate`, `verified` or `deprecated`; only a verified revision is delivered
to agents by default, a candidate goes to the pilot agent set, a deprecated
skill reaches nobody. A skill with no lifecycle row keeps the pre-feature
behaviour and reaches everyone. Promotion needs an approved approval of type
`skill_promotion`; a rollback restores the previous verified revision on the
next compile of every agent that uses the skill. The lifecycle API lives under
`GET/POST /api/myrmidon/companies/:companyId/skill-lifecycle`.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_SKILL_PILOT_AGENTS` | SKILL-LIFECYCLE | unset (empty set) | Comma-separated agent ids that receive `candidate` skills. Any other agent gets a candidate withheld, with a profile warning; `verified` skills reach everyone regardless | Unset or blank — the pilot set is empty, so a candidate reaches nobody (the safe reading of "no pilot configured"). Only agent ids are matched; whitespace around an entry is trimmed |

## 1.6 — AUTONOMY-MATRIX (Part A: matrix, enforcement, regulations API)

The "Autonomy matrix" module (`server/src/myrmidon/autonomy/`, contract —
`packages/shared/src/myrmidon-autonomy.ts`). The matrix maps role x action class to
allowed / approval_required / forbidden; per-role regulations live in the same
JSON store with draft -> approved revisions. Storage: no new DB table — the whole
state sits under `instance_settings.general.myrmidonAutonomy` (the instance-settings
JSON pattern), so vendor writes of `general` must preserve our key
(`preserveAutonomyGeneralKey`, mounted in `server/src/services/instance-settings.ts`).

API surface (company resolved by the access-hub rule: query `companyId`, else the
caller's single active membership, 422 on ambiguity; reads company access,
mutations board):

- `GET /api/myrmidon/autonomy` -> `{ matrix, regulations, changeLog }`
- `PATCH /api/myrmidon/autonomy/matrix` body `{ expectedVersion?, rules, defaults }` -> `{ matrix }` (409 on version mismatch)
- `POST /api/myrmidon/autonomy/regulations` `{ role, title, bodyMarkdown }` -> regulation (draft, revision 1)
- `PATCH /api/myrmidon/autonomy/regulations/:id` `{ title?, bodyMarkdown? }` -> new revision
- `POST /api/myrmidon/autonomy/regulations/:id/approve` -> draft -> approved
- `POST /api/myrmidon/autonomy/regulations/:id/revisions/:rev/restore` -> re-promote a past revision

Change log: `activity_log` rows with actions `myrmidon.autonomy.*`, served as a ready
array in the GET response. Factory default: every cell `allowed` (zero behavior change
until an operator edits; a conservative preset is a follow-up). Enforcement seam:
`server/src/myrmidon/autonomy/gate.ts` (`autonomyGate`) consults `resolveAutonomy` at the
action point — forbidden refuses with a clear error, approval_required maps to the
existing toolActionRequests + approval-card conveyor, allowed passes. Regulations UI
(Part B) edits the matrix through this API.

Enforced routes (1.6.2, `change_instructions` action class — see
`docs/myrmidon/guides/autonomy-matrix-instructions.md`): `PATCH /agents/:id/instructions-path`,
`PATCH /agents/:id/instructions-bundle`, `DELETE /agents/:id/instructions-bundle/file`,
`POST /agents/:id/instructions-revisions/:revisionId/rollback`. Verdicts at these seams:
`forbidden` -> 403 `autonomy_forbidden`; `approval_required` -> 403
`autonomy_approval_required` (deny until the holding-action conveyor for
invocation-less routes lands); board/admin callers are not subject to the matrix;
denied requests never rewrite instructions or create revisions. The matrix is read
from `instance_settings.general.myrmidonAutonomy` on every request, so a matrix edit
in the UI takes effect without a restart (no env override, no new settings keys).

1.6.2 enforcement: `POST /agents/:id/pause`, `POST /agents/:id/resume`, and
`POST /agents/:id/wakeup` call `dbAutonomyGate(db).assertAllowed(req, "pause_wake_agents")`
when the caller is an agent acting on another agent (self-actions are not gated).
The verdict `approval_required` is denied with 403 `autonomy_approval_required`
until the held-action half ships (a separate task). Board and admin callers are
not subject to the matrix.

No environment variables, no new secrets. Remove: the autonomy tree, the export line in
`packages/shared/src/index.ts`, the two marker lines in `app.ts`/`instance-settings.ts`
and this section.

## 1.6.2 — AUTONOMY-MATRIX deploy and merge action classes

Extension of the autonomy matrix to enforce deploy and merge actions. The system now
checks the autonomy matrix for `deploy` and `merge` action classes before allowing
deployment and merge operations.

- `merge` action class: Controls pull request merge operations — enforced in the
  tool gateway for agent tool calls (see the gateway half of the change)
- `deploy` action class: Controls deployment operations and maintenance mode transitions

By default, the `deploy` action class is set to `approval_required` for all roles,
meaning that any deployment or maintenance operation initiated by an agent will
require explicit approval unless specifically allowed in the matrix configuration.

The following routes now enforce the `deploy` action class:
- `POST /api/myrmidon/deploy-jobs` - Initiates a deployment job
- `POST /api/myrmidon/maintenance` - Enters maintenance mode

Enforcement is implemented through `assertDeployClassAllowed`
(`server/src/myrmidon/autonomy/deploy-class.ts`), which resolves the stored matrix
through the autonomy gate (`autonomyGate.assertAllowed`) for the calling agent
before the route does anything else.

## 1.6.2 — AUTONOMY-MATRIX: the matrix in the tool gateway (tool -> action class mapping)

The gateway enforcement half of the autonomy matrix (`server/src/myrmidon/autonomy/tool-mapping{,-store}.ts`,
integration in `server/src/services/tool-gateway.ts`). Before an agent's tool call is
executed, the tool is mapped onto an action class and the matrix verdict is resolved:
`forbidden` → 403 `autonomy_forbidden`; `approval_required` → the existing
`tool_action_requests` holding conveyor; `allowed` (and every non-agent caller) → the
ordinary policy path. A tool with no action class is not governed. Full guide:
[guides/autonomy-matrix-tool-gateway.md](guides/autonomy-matrix-tool-gateway.md),
[guides/autonomy-matrix-tool-gateway.ru.md](guides/autonomy-matrix-tool-gateway.ru.md).

The mapping is configurable per instance without a restart: it lives under
`instance_settings.general.myrmidonAutonomyToolMapping` and changes take effect on the
next gateway call (the resolver reads the row per call). The env variable below is only
the forced override for an instance that never saved the setting; precedence:
stored settings → env → built-in defaults (the three classes of the design with their
default tool-name lists: merge / deploy / external_message — see the guide). The matrix
settings screen does not edit this mapping yet; it is written from the API or the env
override.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_TOOL_AUTONOMY_MAPPING_JSON` | 1.6-AUTONOMY-GW | unset (built-in defaults) | A JSON array of `{ "tool": "<name>", "actionClass": "<class>" }` entries used when nothing is stored in `instance_settings.general.myrmidonAutonomyToolMapping`. Full gateway tool names win over bare upstream tool names; `_` and `-` compare equal | Any non-array / unparsable value is ignored (the built-in defaults apply). Once a mapping is saved from the settings key, the environment stops mattering |
## 1.6 — CTO-CHAT B (the board chat planner: owner text -> proposed epic)

The planner behind the CTO chat (the 1.6 CTO-CHAT epic, part B): the owner's free text
(`POST /api/myrmidon/cto-chat/plan`, body `{ "text": "..." }`, or the same call
from the Telegram DM bridge) becomes a proposed epic with child tasks and
per-task acceptance criteria. The proposal is a plan only: it validates against
the shared zod contract before any card, and nothing is created until the
owner accepts the `suggest_tasks` card on the standing Agent Chat conversation
task. Off unless both the address and the key secret are set: with either
missing the route answers a stable 503 `planner_disabled` with the names of the
missing settings (names only, never values), and not a single request goes out.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_CTO_CHAT_BASE_URL` | 1.6-CTO-CHAT-B | unset (planner closed) | Address of the OpenAI-compatible LLM gateway (e.g. LiteLLM) the planner calls for one completion. Together with `MYRMIDON_CTO_CHAT_KEY_SECRET` it opens the path; without either the route answers 503 `planner_disabled` naming the missing settings | Empty/unset — the path is closed |
| `MYRMIDON_CTO_CHAT_KEY_SECRET` | 1.6-CTO-CHAT-B | unset | **Name** of the company secret holding the gateway API key (not the value). The value is read on every call for the calling company; it never appears in the setting, logs, errors or the journal | Empty/unset — the path is closed. The secret is created by the company's operator in the "Secrets" section |
| `MYRMIDON_CTO_CHAT_MODEL` | 1.6-CTO-CHAT-B | `dashscope-qwen-flash` | The model name sent to the gateway for the planning completion | Empty/unset — the default; an unknown name fails at the gateway and the route answers 400 `backend_failed` |
| `MYRMIDON_CTO_CHAT_TIMEOUT_SEC` | 1.6-CTO-CHAT-B | `90` | Timeout of the planning request (raised to at least 5, capped at 600) | Non-numeric, `0`, negative or above the cap — the default (90) |
| `MYRMIDON_CTO_CHAT_MAX_TASKS` | 1.6-CTO-CHAT-B | `8` | Ceiling on child tasks in one proposal (a proposal can never be unbounded work); the hard absolute cap is 20 | Non-numeric, `0`, negative or above 20 — the default (8) |

The flow end to end — how the owner asks from the portal or the Telegram DM,
what the proposal and the approval card look like, and what acceptance
creates — is the operator guide
[guides/cto-chat-planner.md](guides/cto-chat-planner.md).
## 1.6 — SWARM-CLAIM supervisor (part B)

Settings of `server/src/myrmidon/swarm-claim-supervisor/` — the lead's supervisor
view over the per-caste claim queues and the rebalance action
of the SWARM-CLAIM epic, part B (`GET /api/myrmidon/companies/:companyId/swarm-claim/supervisor/overview`,
`POST .../supervisor/release-lease`). The claim table
`issue_claims` and its write path belong to part A
(`server/src/myrmidon/swarm-claim/`); this module only reads them, so while part
A is unmerged the supervisor answers `{ enabled: false }`.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_SWARM_SUPERVISOR_TASK_MAX` | 1.6-SWARM-CLAIM-B | `500` | Row cap of queue candidates reported per role in the supervisor overview; a ceiling, not a page size | Positive integer from 1 to 5000; anything else — the default (500). Values above the 5000 ceiling are clamped to it, so a typo cannot ask for an unbounded scan |
| `MYRMIDON_SWARM_CLAIM_ENABLED` | 1.6-SWARM-CLAIM-B | unset (on when part A's claim table exists) | Master switch of the swarm claim supervisor view: the overview reports the claim/lease state. Read as enabled unless the value is exactly `0`, `false`, `off` or `no`; with any other value the module still checks that part A's `issue_claims` table exists before answering enabled | Exact `0`/`false`/`off`/`no` — the supervisor answers `{ enabled: false }`; any typo or other value is treated as enabled, so an error cannot silently kill the supervisor |
| `MYRMIDON_SWARM_LEASE_TTL_SEC` | 1.6-SWARM-CLAIM-B | unset (module default) | Lease time-to-live, in seconds, reported for each active claim in the supervisor overview and reported by the supervisor overview. A positive integer env value wins over everything else | Unset, empty or not a positive integer — falls back to `instance_settings.general.swarmClaim.MYRMIDON_SWARM_LEASE_TTL_SEC` when present, else the module's own default |
| `MYRMIDON_SWARM_MAX_ACTIVE_TASKS` | 1.6-SWARM-CLAIM-B | unset (module default) | Per-agent cap of active claimed tasks reported by the supervisor overview and reported by the supervisor overview. A positive integer env value wins over everything else | Unset, empty or not a positive integer — falls back to `instance_settings.general.swarmClaim.MYRMIDON_SWARM_MAX_ACTIVE_TASKS` when present, else the module's own default |

## 1.6 — FORAGING (source registry, snapshot comparison, skill candidates)

Settings of `server/src/myrmidon/foraging/` (the 1.6 track). The feature is off by default:
without `MYRMIDON_FORAGING_ENABLED=1` no timer is armed, no source is read and the manual
pass answers `503 {enabled: false}`. The registry and the findings list stay readable while
it is off.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_FORAGING_ENABLED` | FORAGING | unset (off) | Master switch of the periodic comparison pass. Only the exact value `1` turns it on: the sweep then reads the enabled sources of every company that has a registry row, once per interval | Any other value (or unset) — the sweep never starts, `POST …/foraging/sweep` answers `503 enabled: false`, and the page shows that passes are off. A typo does not silently turn the feature on |
| `MYRMIDON_FORAGING_INTERVAL_SEC` | FORAGING | `3600` | Period of the pass, in seconds. A pass whose previous run is still going is skipped, not queued | From 60 to 86400; non-integer or out of bounds — `3600` |
| `MYRMIDON_FORAGING_BUDGET_CENTS` | FORAGING | `50` | Ceiling of the cost estimate of one pass, in cents. The sweep prices every fetched kilobyte and stops once the estimate reaches the ceiling; sources after the stop stay untouched and the next pass continues with them | A configured `0` or a negative number is the explicit "no limit"; empty or unset — `50` |
| `MYRMIDON_FORAGING_KEY_SECRET` | FORAGING | unset | **Name** of the company secret whose value is sent as a bearer token to the sources of that company. The value is read for the duration of the read, is never logged and never stored | Empty — sources are read without an authorization header |
| `MYRMIDON_FORAGING_MIN_HOST_INTERVAL_SEC` | FORAGING | `60` | Pause between two reads of one host, in seconds. Shared by every company of the process, so two roles pointing at one host cannot double the rate | From 5 to 86400; non-integer or out of bounds — `60`. A host that fails twice in a row is left alone for 6 h (breaker, not a setting) |
| `MYRMIDON_FORAGING_IDLE_GATE_ENABLED` | FORAGING | `1` (on) | **Forced override** of the foraging idle gate (`general.foragingIdleGate`, changed on the settings page via `GET/PATCH /api/myrmidon/foraging/idle-gate` without a restart). When the gate is on, a pass reads a role's sources only when the role's ready queue (the swarm-claim queue) is empty AND an agent of the role is free (not paused or in error, no live run or claim); a busy role is skipped with `queue_not_empty`/`no_idle_agent` and the pass continues with other roles | `0`/`false`/`off`/`no` — off (foraging runs regardless of queue/agent status). Unset or unreadable — the stored settings value, or the default (on) |
| `MYRMIDON_FORAGING_DAILY_BUDGET_CENTS` | FORAGING-LIMITS-UI | unset (no limit) | Forced per-key override of the stored `general.foraging` `dailyBudgetCents` (company ceiling per UTC day, cents); the interface value applies unless the variable is set | Unset — the settings row (or no limit) applies; parse failure — the variable is ignored |
| `MYRMIDON_FORAGING_MONTHLY_BUDGET_CENTS` | FORAGING-LIMITS-UI | unset (no limit) | Forced override of `monthlyBudgetCents` (company ceiling per UTC month, cents) | Unset — the settings row applies; parse failure — ignored |
| `MYRMIDON_FORAGING_ROLE_BUDGET_CENTS` | FORAGING-LIMITS-UI | unset (no limit) | Forced override of `roleBudgetCents` (daily ceiling for one role, cents) | Unset — the settings row applies; parse failure — ignored |
| `MYRMIDON_FORAGING_AGENT_BUDGET_CENTS` | FORAGING-LIMITS-UI | unset (no limit) | Forced override of `agentBudgetCents` (daily ceiling for one agent, cents) | Unset — the settings row applies; parse failure — ignored |
| `MYRMIDON_FORAGING_ENFORCEMENT` | FORAGING-LIMITS-UI | unset (settings row: `hard`) | Forced override of `enforcement`: only `hard`/`soft` are honoured, anything else falls through to the settings row | Unset — the settings row applies |
| `MYRMIDON_FORAGING_AUTO_OFF_COST_PER_TASK_CENTS` | FORAGING-LIMITS-UI | unset (check off) | Forced override of `autoOffCostPerTaskCents`: mean cost per task (BASELINE) above the threshold switches learning off and signals the attention feed | Unset or unparseable — the settings row applies; `null` in the row — the check is off |
| `MYRMIDON_FORAGING_IDLE_GATE_ENABLED` | FORAGING | `1` (on) | **Forced override** of the foraging idle gate (`general.foragingIdleGate`, changed on the settings page via `GET/PATCH /api/myrmidon/foraging/idle-gate` without a restart). When the gate is on, a pass reads a role's sources only when the role's ready queue (the swarm-claim queue) is empty AND an agent of the role is free (not paused or in error, no live run or claim); a busy role is skipped with `queue_not_empty`/`no_idle_agent` and the pass continues with other roles | `0`/`false`/`off`/`no` — off (foraging runs regardless of queue/agent status). Unset or unreadable — the stored settings value, or the default (on) |

The sweep is off by default because it is the only part of the feature that talks to the
outside: an operator turns it on together with `MYRMIDON_FORAGING_KEY_SECRET` when the
sources need a token. Findings are recorded `unverified` until the skill lifecycle accepts
them as candidates; `POST …/foraging/sweep` (board only) runs one pass by hand.

Порт кандидата подключён к SKILL-LIFECYCLE (`server/src/myrmidon/foraging/candidate-port.ts`, единственная точка сборки — `foragingCandidatePort(db)` в `index.ts`). Находка с непустым диффом при доступном порте: резолвится или создаётся компанейский навык с ключом по роли (`foraged-<slug>`), ему добавляется ревизия, в markdown которой видны summary, добавленные/удалённые строки диффа и источник (url, role, detectedAt), затем навык переводится в `candidate` через lifecycle (`setCandidate`, актор `system/foraging`); находка пишется со статусом `candidate` и `candidateRef` = id навыка. Продвижение кандидата — только существующим пайплайном lifecycle (promote-request → одобрение карточки `skill_promotion` → promote); порт не продвигает. Отказ создания навыка, ревизии или `setCandidate` не роняет проход: порт логирует предупреждение и возвращает null, находка пишется со статусом `rejected` и причиной «the skill lifecycle refused the finding»; когда порт недоступен (сборка не удалась), находка остаётся `unverified`. Флаг `MYRMIDON_FORAGING_ENABLED` по-прежнему выключен по умолчанию — включение прода не здесь.

## 1.6 — TG-NOTIFY-SETTINGS: what the board sends the owner in Telegram (part A, the settings core)

The company-level telegramNotify settings of `server/src/myrmidon/telegram-notify/` (the
TG-NOTIFY-SETTINGS epic, part A). This core only stores and serves the contract;
the parts that actually send (digest, errors, inbound, escalations, proactivity)
consume it. No environment variables: the settings are runtime-changeable per
company through the API.

- Storage: the `myrmidonTelegramNotifySettings` key of `instance_settings.general`, keyed by
  companyId (no migration, the vendor settings service keeps the key across its writes).
- API: `GET /api/myrmidon/telegram-notify` (company access) answers the full document —
  every field of every section always present; `PATCH /api/myrmidon/telegram-notify`
  (board only) applies a partial update, and every changed field is recorded in the
  changelog (actor, field path, from/to values, 200 entries kept).
- Defaults: every section OFF. With the defaults the owner receives only the replies to
  their own messages and the U2 decision cards; nothing else is sent to Telegram until
  a section is turned on.
- Sections: `digest` (time "HH:MM", chatId, topicId, sections list), `errors`
  (minSeverity warn|error|fatal, maxPerHour, chatId, topicId), `inbound`
  (requireMention), `escalations` (hours, channel dm|topic|none, chatId, topicId),
  `proactivity` (mode only_on_owner_request|rarely|normal, rarelyMaxPerDay). The
  proactivity per-agent override lives in `agents.metadata` under the same `"mode"`
  key (company level is the default for all agents).
- Contract: `packages/shared/src/myrmidon-telegram-notify.ts` (types and zod
  validators); the contract is fixed — later changes only add fields, names do not
  change.


## 1.6 — PARALLEL-HELPERS (delegated helper agents)

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_BOT_HELPER_MODEL` | PARALLEL-HELPERS | unset (helpers inherit the parent agent's model) | Model that delegated helper children run on when neither the agent card nor the stored `parallelHelpers` instance settings name one. Read from the agent card's environment when the bot profile is built. A deployment value: no model name is baked into the product | Empty/unset — the child uses the parent agent's model (Hermes' own behavior for an unset `delegation.model`) |

Instance settings (`instance_settings.general.parallelHelpers`, the "Parallel
helpers" card in Instance → General, instance-admin only): `maxPerAgent` is the
company ceiling agent cards are clamped to, `defaultMaxPerAgent` (default 2)
is what a card inherits when it says nothing, `buildSlots`/`hostMemoryMb`
feed the capacity hint. **There is no built-in upper limit on the ceiling
(HELPERS-NO-CAP, 1.6.1): the number the owner saves is the limit.** A saved
ceiling above 50 shows a host-load warning on the settings page ("values this
high put a real load on the host — make sure this is intended, not a typo");
it is never clamped or rejected. The module applies its own defaults
(`maxPerAgent` unset → 10, `defaultMaxPerAgent` unset → 2) only while the row
says nothing.

## CUSTOM-CASTES — the company caste (agent role) directory

Settings of `server/src/myrmidon/castes/` — the company caste directory and its
REST API (`GET/POST /api/myrmidon/companies/:companyId/castes`,
`PATCH/DELETE .../castes/:key`). No variables: the directory lives in the
`agent_castes` table, is read from the database on every request (no process
cache, no env), and seeds the 12 built-in castes idempotently on a company's
first read — so create/assign/delete are visible to the swarm without a
restart. Mutations are board-only; reads need company access.

## 1.6.1 — TG-NOTIFY-SETTINGS part F: the board UI for the Telegram notification settings

The board-facing half of the Telegram notification settings: the "Telegram
notifications" panel on the System screen of the 2.0 UI (Settings → System,
under the UI-2.0 shell). It edits the company-level `telegramNotify` document
the settings core (part A) stores and serves; no environment variables —
everything is runtime-changeable per company through the same API.

- The panel shows all five sections with their options: the daily digest
  (send time, chat id, topic id, sections), error notifications (chat id,
  topic id, minimum severity, rate limit per hour), owner messages
  (require mention), escalations (stuck hours, channel, chat id, topic id) and
  head-bot proactivity (mode, cap per day in "rarely" mode). With the contract
  defaults every section reads OFF.
- Saving sends one `PATCH /api/myrmidon/telegram-notify` with only the fields
  that differ from the stored values; the answer is applied back, so a change
  is reflected immediately. Editing is board-only on the server; a read
  without board access renders the denied state.
- The settings change log from the GET answer (actor, field path, previous and
  next value) is rendered under the sections — the same changelog the core
  records for every changed field.

## 1.6.1 — TG-NOTIFY head-bot proactivity (part E: gate, rarely limit, U2 bundling)

Settings of `server/src/myrmidon/telegram-notify/` (the proactivity half of the
TG-NOTIFY-SETTINGS epic, part E). The head bot's own-initiative publications are
gated per agent: `only_on_owner_request` (the default — the owner receives only
replies to their own messages and the U2 decision cards), `rarely` (at most
`rarelyMaxPerDay` proactive messages per agent per UTC day, everything beyond
the ceiling is bundled into a daily summary publication), or `normal` (no
limit). The mode and the ceiling live in the `proactivity` area of the
`telegramNotify` settings document (instance settings, runtime-changeable; the
contract and defaults are defined in `packages/shared/src/myrmidon-telegram-notify.ts`).
A per-agent override uses the same enum under the `mode` key of the agent's
metadata and wins over the company default.

Storage: no new tables. The rarely day counters and the bundle queues sit under
`instance_settings.general.myrmidonTelegramNotify` (the instance-settings JSON
pattern; preserved across vendor `general` writes). The U2 card bundling turns
several pending interaction cards older than 5 minutes in one conversation into
one summary publication; each bundled card keeps its own callback action rows,
so every card stays individually answerable.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `telegramNotify.proactivity.mode` (settings area) | 1.6-TG-PROACTIVITY-E | `only_on_owner_request` | Proactivity of the head bot per company: `only_on_owner_request` blocks every own-initiative publication; `rarely` allows at most `rarelyMaxPerDay` per agent per day and bundles the rest; `normal` removes the limit | Any other value is rejected by the validator; a malformed stored value falls back to the default |
| `telegramNotify.proactivity.rarelyMaxPerDay` (settings area) | 1.6-TG-PROACTIVITY-E | `3` | Daily ceiling of proactive messages per agent in `rarely` mode; the counter resets on the UTC day boundary | Integer from 1 to 50; anything else falls back to 3 |
| agent metadata key `mode` | 1.6-TG-PROACTIVITY-E | unset | Per-agent override of the mode (the same three values). Wins over the company default for that agent | A malformed value is ignored — the company default applies; an override can only pick one of the three modes |
| `telegramNotify.inbound.enabled` (settings area) | TG-NOTIFY-D | `false` | Enables inbound from Telegram group topics (forum topics): with the default `false`, a topic message never becomes task work and the vendor path is byte-for-byte unchanged | Read from instance settings on every inbound topic message (runtime-changeable, no restart). Part A owns the GET/PATCH routes for the document; until they merge it is read through the same instance-settings seam parts D and E use |
| `telegramNotify.inbound.requireMention` (settings area) | TG-NOTIFY-D | `true` | With inbound enabled, a topic message that the adapter did not mark as a mention/reply to the bot stays ignored — the vendor's group privacy contract, so commands in a topic work only when the bot is addressed, as in a DM | `false` admits any topic message, as in a DM. Any value that is not a boolean falls back to `true` |

No environment variables, no new secrets. The gate runs inside the chat
publication sweep; the bundling window is fixed at 5 minutes. Remove: the
`server/src/myrmidon/telegram-notify/` tree, the export line in
`packages/shared/src/index.ts`, the two marker lines in `app.ts` and
`instance-settings.ts`, and this section.

## 1.6.1 — TG-NOTIFY topic inbound (part D: Telegram group topics as a task inbox)

Settings of `server/src/myrmidon/telegram-notify/topic-inbound*.ts` (the
inbound half of the TG-NOTIFY-SETTINGS epic, part D). A message in a forum
topic of a connected Telegram group can become task work: the board continues
the conversation already bound to that topic or creates a task whose title is
the first words of the message and whose body carries the full text plus the
link to the Telegram thread. Both switches are off by default — with the
defaults the vendor path is byte-for-byte unchanged. Runtime-changeable, no
restart: the values live in the `inbound` area of the `telegramNotify`
settings document (the contract and defaults are defined in
`packages/shared/src/myrmidon-telegram-notify.ts`). The operator-facing guide
is [telegram-topic-inbound.md](../guides/telegram-topic-inbound.md).

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `telegramNotify.inbound.enabled` (settings area) | 1.6.1-TG-NOTIFY-D | `false` | Master switch of topic inbound: an admitted message in a Telegram forum topic continues the task already bound to that topic, or creates a new task with the message's first words as the title and the thread link in the body | Read from the settings document on every inbound topic message. Only `true` enables; anything else (absent, malformed, another value) reads as off and the vendor path is untouched |
| `telegramNotify.inbound.requireMention` (settings area) | 1.6.1-TG-NOTIFY-D | `true` | With inbound enabled, a topic message the adapter did not mark as a mention or a reply to the bot stays ignored — the group privacy contract, so commands in a topic work only when the bot is addressed, as in a DM | `false` admits any topic message, as in a DM. Any value that is not a boolean falls back to `true` |

## 1.6.1 — WIP-LIMIT: the WIP limit screen and badge (part B, UI)

The UI half of the WIP-LIMIT feature: the "WIP limit" screen in Company
Settings (`/company/settings/wip-limit`) edits the contract of part A —
`GET/PUT /api/myrmidon/companies/:companyId/wip-limit/settings`
(`{ defaultLimit, perAgent }`, empty default = no limit) — and the agents
list shows each agent's live `wip/limit` badge from
`GET .../wip-limit/status` (red when `overLimit`). No environment variables,
no new secrets: the values live in part A's store. While part A is unmerged
the routes answer nothing — the screen shows its error state and the roster
shows no badge, both harmless. Remove: the `ui/src/components/myrmidon/wip-limit/`
tree, `AgentWipBadge.tsx`, the nav item, the route, the `Agents.tsx` status
query/badge and the `wipLimit` i18n namespace.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| — | 1.6.1-WIP-LIMIT-B | — (always on) | The settings screen writes the row through part A's PUT; the badge on an agent row reads the status endpoint | Not configurable: no deployment-specific values in the UI half |
## 1.6.1 — model providers (MODEL-PROVIDERS A)

No `MYRMIDON_*` settings: the module reads the provider registry from the database
(`model_providers`) and the provider credential from the company secret store by the name
stored on the row. Default base URLs per provider type are constants in
`packages/shared/src/myrmidon-model-providers.ts`, not settings.

| `MYRMIDON_MAX_RUN_STARTS_PER_MINUTE` | C0, 1.6.2 RUN-ADMISSION | `5` | Start ramp: ceiling of run starts over a sliding minute, for every wake source (on_demand, assignment, idle-pickup, swarm idle wake, automation): a server restart, mass task approval or mass wake does not start everything in one salvo, and a bot's memory has time to grow before the next start reads host memory. Unused reserved slots do not count. Default at first start, afterwards changed on the fly via settings (see the row above). Since 1.6.2 the default is `5` (was: off); an instance that already saved its run limits keeps the saved value | `0`, `off`, `false`, `no`, `none` — the limit is off. Unset, empty, negative or non-numeric — the default `5`. An empty field in settings — off |
| `MYRMIDON_MIN_FREE_HOST_MEMORY_MB` | 1.6.2 RUN-ADMISSION | `15360` (15 GB) | Host free-memory floor of run admission: a new run (any wake source) starts only while the host's `MemAvailable`, minus the per-run budget (`MYRMIDON_RUN_MEMORY_ESTIMATE_MB`) of runs started in the last 30 s, is at least this many megabytes; otherwise it stays `queued` (not failed) and the queue pass retries it every 15 s. Bots run in their own containers outside the server cgroup, so `MYRMIDON_MIN_FREE_MEMORY_MB` cannot see them; this floor reads the host. Host memory is read from `/proc/meminfo`: inside a Docker container without lxcfs it is the host's file (the kernel does not namespace it), so no mount and no Docker API call are needed. The swarm idle-wake pass wakes nobody while the floor is closed (log line `swarm idle wake pass skipped…`, at most once per 5 min). When the floor holds runs back for more than 10 minutes, an attention card «Runs held: host memory» appears for the operator; it disappears on the first admitted run. Stored in `instance_settings.general.runLimits.minFreeHostMemoryMb` and changed on the fly like the other run limits (Instance → General «Run limits», Settings → «Runs & queue», `PATCH /api/myrmidon/runtime-limits`); a row saved before 1.6.2 lacks the key and takes the environment value or the default | `0`, `off`, `false`, `no`, `none` — the floor is off. Unset, empty, negative or non-numeric — the default. An empty field / `null` in settings — off. If the host memory cannot be read (no `/proc/meminfo`, or lxcfs makes it report the container limit as `MemTotal`) the floor is inactive and `run admission cannot read host memory…` is logged once; mount the host's `/proc/meminfo` and point `MYRMIDON_HOST_MEMINFO_PATH` at it. The floor covers the host the board runs on: bots placed on other hosts (fleetd) are not measured |
| `MYRMIDON_HOST_MEMINFO_PATH` | 1.6.2 RUN-ADMISSION | `/proc/meminfo` | Where the host free-memory floor (`MYRMIDON_MIN_FREE_HOST_MEMORY_MB`) reads `MemTotal`/`MemAvailable`. Needed only when the container's `/proc/meminfo` is virtualized (lxcfs): bind-mount the host's file read-only (e.g. `/proc/meminfo:/host/meminfo:ro`) and set this to the mount path. Read once when the admission is created (a restart applies a change) | Unset or empty — `/proc/meminfo` |
| `MYRMIDON_TEST_CAPTURE_PATH` | TEST | none | Path for capturing test environment variables during test runs | Development/testing only; specifies where to write captured environment data |

Behavior guide: [guides/stale-block.md](guides/stale-block.md) — what the
sweep inspects, what unblocking does, and the attention-feed card.
| `MAINTENANCE_EXIT_WAIT_SEC` | EXIT-ASYNC | `120` | Deploy-script setting (`deploy.env`): how long `deploy.sh` waits for the instance maintenance window to retire (state `off`) after the exit POST. The exit itself is asynchronous — it returns as soon as the window is marked `leaving`, and the maintenance tick (`MYRMIDON_MAINTENANCE_TICK_SEC`) completes the leave tail — so the wait is on the state, not on the HTTP call. Read by `scripts/myrmidon/deploy/{lib,deploy}.sh`, not by the server | A timeout is logged loudly and does not fail an already switched and healthy deploy (`leaving` already reopens admission); a failed exit request still aborts |
| `BOARD_COMPANY_ID` | POST-DEPLOY-CHECK | unset | Deploy-script setting (`deploy.env`): UUID of the company whose issues the post-deploy fleet check (step 9 of `deploy.sh`) reads — `GET $BOARD_API_URL/companies/$BOARD_COMPANY_ID/issues?status=blocked&updatedSince=<deploy start>`, then a re-read of the maintenance state. A blocked issue in the deploy window, an unreadable board or a window that did not retire prints `degraded: ...` and the run ends with `DEPLOY DEGRADED`; the verdict does not fail a switched and healthy deploy. The same company the post-deploy smoke's `MYRMIDON_DEPLOY_SMOKE_COMPANY` names | Unset (or `BOARD_API_URL` unset) — the check is skipped with a log line, a standalone install stays deployable. For a release deploy set both |
| `MYRMIDON_DEPLOY_AUTO_ROLLBACK` | R5-C | `1` (on) | Health-based automatic rollback of the board: when the post-deploy health check fails, the host executor immediately runs the same `rollback.sh` against the locally remembered previous image (the emergency path: the CI check of the rollback target only warns), the job ends `auto_rolled_back` with the window closed; a failed rollback itself ends `failed_rollback`, the window stays on for the operator | Operator guide: [guides/deploy-auto-rollback.md](guides/deploy-auto-rollback.md) | `0`/`false`/`no`/`off` — the old contract: `failed_health`, the window stays on, the rollback is manual. The host side of the same switch is `AUTO_ROLLBACK` in deploy.env; both sides must agree |
## BOT-DISK E — host disk usage signal

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_HOST_DISK_USAGE_THRESHOLD_PERCENT` | BOT-DISK E | `85` | The fill level of the host disk that raises the attention signal. The sweep measures the disk of the server data root (`MYRMIDON_HOST_DISK_DATA_ROOT`) on every scheduler tick, keeps a sample ring for the growth rate per hour, and when usage crosses this level the attention queue gets one row with the numbers and the biggest consumers. The value is the default at FIRST start only; the effective threshold lives in the instance settings (`instance_settings.general.hostDisk`) and changes live on the Instance → General page («Host disk») or through `GET`/`PATCH /api/myrmidon/host-disk` — the sweep re-reads it on every measurement, no restart | A non-integer or a value outside 1–99 — the default (85). A stored row that does not validate is ignored as a whole |
| `MYRMIDON_HOST_DISK_DATA_ROOT` | BOT-DISK E | `/data` | Directory whose filesystem usage is measured: `statfs` of this path reports the disk the board's database, workspaces and container volumes live on | Must exist and be readable by the server process; unreadable — the sweep logs one error per tick and no signal is raised |
| `MYRMIDON_HOST_DISK_CONSUMER_PATHS` | BOT-DISK E | the data root | Comma-separated directories ranked as «biggest consumers» in the signal: each is walked with a bounded depth/entry/time cap, biggest first | Unset — the data root itself is the one consumer listed |

### Task workspaces, the `myr-ws` CLI and the bot disk report (1.6.5 BOT-DISK-H, contract H0)

Inside the bot container the layout is fixed by the contract
(`docs/myrmidon/bot-disk-contract/README.md`):
`<HERMES_HOME>/.myrmidon/` holds `git-base/<owner>/<repo>.git` (bare bases),
`archive/<KEY>-<ts>.{bundle,patch,untracked.tar}` plus `manifest.json`
(archives of removed copies with unpushed work), `ws-registry.json` (the open
copies: `{version:1, entries:[{key, repo?, path, class:'E'|'G', branch?,
openedAt}]}`) and `disk-state.json` (disk pressure `{quotaPercent,
partitionPercent, pressure:'none'|'soft'|'hard'}`, written by botd on every
pass, read by `myr-ws open`; a file older than two botd ticks reads as
`pressure:"none"`). Task copies are `/workspace/<ISSUE-KEY>` worktrees on
branch `bot/<KEY>`; scratch copies live at `/scratch/<name>`.

`myr-ws` commands: `open <KEY> [owner/repo] [--base <ref>] [--scratch]`,
`list`, `close <KEY> [--force]`, `restore <KEY>`, `migrate`; global `--json`
(`{ok:true, …}` per command, any error `{ok:false, error, exitCode}` with the
human-readable message on stderr). Exit codes: `0` ok, `2` invalid arguments,
`3` quota/disk refusal (message starts with `BOT_DISK_QUOTA_EXCEEDED:`), `4`
repository over the base limit (8), `5` network/fetch, `6` no such
copy/archive, `7` unpushed work without `--force`. Environment:
`MYRMIDON_TASK_WORKSPACE` (the opened copy's absolute path, exported into the
run), `MYRMIDON_WS_BIN` and `MYRMIDON_WS_HOME` (test-only overrides).

The board side is two routes, called with the bot's own `PAPERCLIP_API_KEY`:
`GET /api/myrmidon/bots/me/workspaces` returns the desired state
(`{generatedAt, grace:{closingMinutes, scratchTtlHours, orphanHours},
pressure, workspaces:[{key, repo, state:'active'|'closing', since, prState,
branch}]}`; on 401/403/503 botd is fail-safe and deletes nothing), and
`POST /api/myrmidon/bots/me/disk-report` accepts the bot's disk snapshot
(bases, copies with `clean`/`pushed` and sizes, archives, at most 200 recent
actions, foreign copies with their sign, self-check results; body ≤ 1 MiB)
and answers `{ok:true, nextReportSec}` as the next tick's tempo.

dockergate gains two routes: `GET /myrmidon/disk` (partition statfs plus the
per-project `xfs_quota report -p` parse; without prjquota mounted —
`projects:[]`, `quotaEnabled:false`) and
`PUT /myrmidon/disk/<botKey>/quota` with body `{bytes}` (64 MiB…1 TiB) →
`{ok:true, projectId, hardBytes}`; deny codes `route_not_allowed`,
`quota_unavailable`, `bad_quota`. The board executes the existing per-bot
quota setting `general.botDiskQuota` through them.

Bot-facing instruction (to paste into the bot's system prompt or its task
message, 1.6.5 BOT-DISK-H design §2.2(4)):

> Your task's working copy is opened for you: `git clone <owner>/<repo>`
> becomes a worktree of a shared base (no own objects, no token in
> `.git/config`). Never pass `--filter`, `--depth`, `--mirror` or `--bare` —
> they are ignored. If you see `BOT_DISK_QUOTA_EXCEEDED:`, the bot partition is
> over quota: stop cloning, commit and push what you have, tell the board, and
> do not retry in a loop. Work inside the opened copy; the board archives and
> removes it when the task ends — do not delete `/workspace/<KEY>` yourself.

A `/v1/runs` request may carry `workspace: {key, repo, baseRef?}`: before the
model starts, the gateway runs `myr-ws open <key> <repo> [--base <baseRef>]
--json` and the run starts with `MYRMIDON_TASK_WORKSPACE=/workspace/<key>` as
cwd. Exit codes 3/4/5 do not fail the run silently: it starts in `/scratch`
with a warning event.

Attention cards (payload always carries `botKey` and `at`):
`bot_disk_lifecycle/agent-silent` (botd report older than 30 min in a running
container), `bot_disk_lifecycle/drift` (desired ≠ actual past grace + 15
min), `bot_disk_lifecycle/foreign` (a copy outside the base: promisor /
token in URL / no remote / `.trash-*` / full clone), `bot_disk_lifecycle/ws-cli`
and `bot_disk_lifecycle/reflink` (failed self-checks), `bot_image_stale` (bot
on a non-current image generation for over 24 h), `bot_disk_archive` (an
archive was created for the task; gone on restore or expiry).

Instance settings `general.botDisk.*` (changed on Instance → General,
`PATCH /api/myrmidon/bot-disk`; applied without a restart):

| Key | Default | What it does | Range / special |
|---|---|---|---|
| `general.botDisk.graceClosingMinutes` | `30` | Grace period (minutes) between a task turning `closing` in the desired state (terminal / reassigned / PR merged) and botd removing its worktree | 5–1440; out of range — the default. While the partition pressure is `hard` (quota ≥ 100 %) the effective grace is 0 |
| `general.botDisk.scratchTtlHours` | `24` | Idle TTL (hours, by mtime/ctime) of a scratch copy (class G): past it botd archives it if it holds unpushed commits, then removes it — the one place a timer is legitimate | 1–720; out of range — the default. Under hard partition pressure the effective TTL is 1 hour |
| `general.botDisk.partitionThresholdPercent` | `85` | Fill level of the bot partition (physical, from dockergate `GET /myrmidon/disk`) at which the instance card `host_disk_alert` is raised with the partition's figures | 50–100; out of range — the default |
| `general.botDisk.partitionRefuseOpenPercent` | `90` | Fill level of the bot partition at which `myr-ws open` refuses **every** bot with `BOT_DISK_QUOTA_EXCEEDED:` (exit 3) and every botd runs with grace 0 | 50–100; must be ≥ `partitionThresholdPercent`; out of range — the default |
| `general.botDisk.partitionCriticalPercent` | `95` | Fill level of the bot partition at which the critical instance card is raised and the owner gets a Telegram signal | 50–100; must be ≥ `partitionRefuseOpenPercent`; out of range — the default |
| `general.botDisk.pnpmStoreDir` | unset (per-bot store in the workspace mount) | Directory of the shared pnpm store; per contract it must sit **on the bot partition** (one store per partition), so a reflink import from it into the bot volumes works (reflink does not cross filesystems) | Unset — previous behaviour. When set, pair it with `pnpmImportMethod: clone` and a working reflink self-check (card `bot_disk_lifecycle/reflink` on failure) |
| `general.botDisk.pnpmImportMethod` | unset (image default `hardlink`) | pnpm `package-import-method`: `hardlink`, `clone`, `clone-or-copy` or `copy`. `clone` is reflink-only: a failure is loud, never a silent copy; a file edit inside `node_modules` cannot corrupt the store (unlike a hardlink) | Unset — previous behaviour. An unknown value is rejected by the settings schema |

### Task workspaces, the `myr-ws` CLI and the bot disk report (1.6.5 BOT-DISK-H, contract H0)

Inside the bot container the layout is fixed by the contract
(`docs/myrmidon/bot-disk-contract/README.md`):
`<HERMES_HOME>/.myrmidon/` holds `git-base/<owner>/<repo>.git` (bare bases),
`archive/<KEY>-<ts>.{bundle,patch,untracked.tar}` plus `manifest.json`
(archives of removed copies with unpushed work), `ws-registry.json` (the open
copies: `{version:1, entries:[{key, repo?, path, class:'E'|'G', branch?,
openedAt}]}`) and `disk-state.json` (disk pressure `{quotaPercent,
partitionPercent, pressure:'none'|'soft'|'hard'}`, written by botd on every
pass, read by `myr-ws open`; a file older than two botd ticks reads as
`pressure:"none"`). Task copies are `/workspace/<ISSUE-KEY>` worktrees on
branch `bot/<KEY>`; scratch copies live at `/scratch/<name>`.

`myr-ws` commands: `open <KEY> [owner/repo] [--base <ref>] [--scratch]`,
`list`, `close <KEY> [--force]`, `restore <KEY>`, `migrate`; global `--json`
(`{ok:true, …}` per command, any error `{ok:false, error, exitCode}` with the
human-readable message on stderr). Exit codes: `0` ok, `2` invalid arguments,
`3` quota/disk refusal (message starts with `BOT_DISK_QUOTA_EXCEEDED:`), `4`
repository over the base limit (8), `5` network/fetch, `6` no such
copy/archive, `7` unpushed work without `--force`. Environment:
`MYRMIDON_TASK_WORKSPACE` (the opened copy's absolute path, exported into the
run), `MYRMIDON_WS_BIN` and `MYRMIDON_WS_HOME` (test-only overrides).

The board side is two routes, called with the bot's own `PAPERCLIP_API_KEY`:
`GET /api/myrmidon/bots/me/workspaces` returns the desired state
(`{generatedAt, grace:{closingMinutes, scratchTtlHours, orphanHours},
pressure, workspaces:[{key, repo, state:'active'|'closing', since, prState,
branch}]}`; on 401/403/503 botd is fail-safe and deletes nothing), and
`POST /api/myrmidon/bots/me/disk-report` accepts the bot's disk snapshot
(bases, copies with `clean`/`pushed` and sizes, archives, at most 200 recent
actions, foreign copies with their sign, self-check results; body ≤ 1 MiB)
and answers `{ok:true, nextReportSec}` as the next tick's tempo.

dockergate gains two routes: `GET /myrmidon/disk` (partition statfs plus the
per-project `xfs_quota report -p` parse; without prjquota mounted —
`projects:[]`, `quotaEnabled:false`) and
`PUT /myrmidon/disk/<botKey>/quota` with body `{bytes}` (64 MiB…1 TiB) →
`{ok:true, projectId, hardBytes}`; deny codes `route_not_allowed`,
`quota_unavailable`, `bad_quota`. The board executes the existing per-bot
quota setting `general.botDiskQuota` through them.

A `/v1/runs` request may carry `workspace: {key, repo, baseRef?}`: before the
model starts, the gateway runs `myr-ws open <key> <repo> [--base <baseRef>]
--json` and the run starts with `MYRMIDON_TASK_WORKSPACE=/workspace/<key>` as
cwd. Exit codes 3/4/5 do not fail the run silently: it starts in `/scratch`
with a warning event.

Attention cards (payload always carries `botKey` and `at`):
`bot_disk_lifecycle/agent-silent` (botd report older than 30 min in a running
container), `bot_disk_lifecycle/drift` (desired ≠ actual past grace + 15
min), `bot_disk_lifecycle/foreign` (a copy outside the base: promisor /
token in URL / no remote / `.trash-*` / full clone), `bot_disk_lifecycle/ws-cli`
and `bot_disk_lifecycle/reflink` (failed self-checks), `bot_image_stale` (bot
on a non-current image generation for over 24 h), `bot_disk_archive` (an
archive was created for the task; gone on restore or expiry).

Since rc.8 (see the fragment `1-6-5-bot-disk-h-rc8-workspace-reach`): the board
writes `MYRMIDON_BOT_KEY=<bot id>` into the bot's `.env` (an id, not a secret) so
botd's report is accepted under the caller's key; the repository of a copy comes
from the task's project, then its latest pull request, then
`general.botDisk.defaultRepo` (a task with none of them still works in
`/scratch` with a warning); the `pressure` block of the desired state follows the
measured partition (`soft` from `partitionThresholdPercent`, `hard` from
`partitionRefuseOpenPercent`); botd also reaps pre-mechanism directories (class X)
under the scratch TTL; and `myr-ws`, `botd` and the git wrapper are part of the
base `runtime` image stage, so every image variant carries them. The desired
state also carries `protectKeys: string[]` — the keys of every open task (not
`done`/`cancelled`) assigned to the bot, repository or not; botd never removes the
directory of such a task.


## 1.6.1 — BOT-DISK B: shared package cache for bot containers

Not an environment variable: an instance setting, `instance_settings.general.botDisk.sharedPackageCachePath`,
changed on Instance → General («Shared package cache for bots») or through
`GET`/`PATCH /api/myrmidon/bot-disk` (GET is any board member, PATCH is
instance-admin only). It applies without a restart: the local driver and the
profile compiler re-read it on every reconcile pass, and every bot on the
default host is recreated with the new binds on the next pass. Full guide:
[bot-disk-cache.md](bot-disk-cache.md).

| Setting | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `general.botDisk.sharedPackageCachePath` | 1.6.1-BOT-DISK-B | unset (no shared cache) | Absolute host directory whose `pnpm`, `go-mod`, `go-build` and `gradle` subdirectories every bot on the default host mounts read-write at `/cache/…`; the profile compiler points `npm_config_store_dir`, `GOMODCACHE`, `GOCACHE` and `GRADLE_USER_HOME` at the mounts (pip is not covered: the image's `PIP_NO_CACHE_DIR` cannot be unset). Bots on a fleetd host are not affected (logged once) | `null` or empty — off. **Operator step:** dockergate must allow the same directory as `packageCacheRoot` ([dockergate.md](dockergate.md)), otherwise every cache bind is refused with `mount_source_not_allowed`; the four subdirectories must exist and belong to uid/gid 10001 |

| `MYRMIDON_MCP_TOKEN_*` | MCP-* | Secret value | MCP server authentication tokens generated per bot profile from `MYRMIDON_BOT_MCP_SERVERS` configuration | These are secret tokens that go to bot containers'.env files with 0600 permissions, where Hermes expands the references in config.yaml at load time |
| `permissions.boardAdmin` | ADMIN-AGENT (1.6.1) | flag absent — reads as `false` | The board administrator flag on the agent record. Enabling through `PATCH /api/agents/:id/permissions` with the `boardAdmin` field (or the "Board administrator" toggle on the agent card's Permissions tab) grants the fixed 17-key operator set (`BOARD_ADMIN_PERMISSION_KEYS`) and snapshots the pre-existing set keys into `permissions.boardAdminSavedGrantKeys`; disabling revokes only the keys the switch added. Flipping needs the company `users:manage_permissions` right (board actors) or the same grant (agent actors); an agent cannot grant board admin to itself (403). `GET /api/agents/:id` resolves `access.boardAdmin` for the CEO, the stored flag, or a pre-existing full set (read-time migration). Details: [guides/agent-board-admin.md](guides/agent-board-admin.md) | Clear the flag with the same PATCH and `boardAdmin: false` — keys outside the set and keys in the snapshot are untouched; both readers are fail-closed — an unreadable value reads as `false` |
## 1.6.1 — SWARM-SETTINGS-UI: queues of roles as instance settings

The pilot of the per-role queues is set in the interface, without a restart:
Instance → General → "Role queues (SWARM-CLAIM)" writes
`instance_settings.general.swarmClaim` (`GET`/`PATCH /api/myrmidon/swarm-claim`,
board reads, instance-admin writes). The server re-resolves the row on every
claim, checkout, sweep tick and supervisor read, so enabling a role takes
effect within a minute, and switching the pilot off releases the live leases
at once (the PATCH response reports how many). Every change appends a journal
entry — who changed what, and when — rendered by the settings screen and kept
under `general.swarmClaimJournal` (activity log stays the audit trail).

The environment variables below are now **forced overrides**, not the primary
source: a variable set in the process environment beats the stored value for
that key only, so an operator can pin a contour without touching the database.
Each key of the `GET` answer carries its source — `settings` (the UI value),
`env` (the override) or `default` — and both the settings screen and the
Swarm supervisor screen render that origin.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_SWARM_CLAIM_ENABLED` | 1.6-SWARM | `0` (off) | Override of the master switch of the per-role task queues: on — an agent claims the top task of its own role's queue behind a lease (TTL + heartbeat), an expired lease returns the task to the queue and the sweep wakes the next agent of the role; the checkout writes the run's claim, the finishing run releases it. Off — no claim is written; a disable also releases the live leases (reason `swarm_disabled`) | `1`/`true`/`on`/`yes` — force on. `0`/`false`/`off`/`no` — force off. Unset — the UI value applies; nothing stored — off, the swarm must be turned on deliberately |
| `MYRMIDON_SWARM_CLAIM_ENABLED_ROLES` | 1.6.1-SWARM-SETTINGS-UI | removed in 1.6.5 | No longer read: the pilot role set was dropped with the pilot (SWARM-T4), the master switch is the only gate | Remove the variable from the environment; it has no effect |
| `MYRMIDON_SWARM_CLAIM_ENABLED_COMPANY_IDS` | 1.6.1-SWARM-SETTINGS-UI | removed in 1.6.5 | No longer read: the pilot company set was dropped with the pilot (SWARM-T4), the master switch is the only gate | Remove the variable from the environment; it has no effect |
| `MYRMIDON_SWARM_LEASE_TTL_SEC` | 1.6-SWARM | `900` | Override of the lease TTL (sec): how long a claim's lease stays valid without a heartbeat; the run refreshes it on every checkout pass. The acceptance window (idle agent with a non-empty queue of its role) is one TTL plus one sweep interval | From 60 to 86400. Unset or unreadable — the UI value applies; nothing stored — 900 |
| `MYRMIDON_SWARM_MAX_ACTIVE_TASKS` | 1.6-SWARM | `3` | Override of the per-agent ceiling of live claims; a capped agent is not handed new work until a lease finishes, expires or is released | From 1 to 100; `none`/`0` — no ceiling. Unset or unreadable — the UI value applies; nothing stored — 3 |
| `MYRMIDON_SWARM_CLAIM_SWEEP_INTERVAL_SEC` | 1.6-SWARM | `30` | Override of the sweep interval (sec): how often the expired-claim sweep runs on the scheduler tick. Read live — a stored change spreads the passes without a restart; the constructed interval stays the floor | From 5. Unset or unreadable — the UI value applies; nothing stored — 30 |
| `MYRMIDON_SWARM_CLAIM_P0_PREEMPTION` | 1.6.1-SWARM-SETTINGS-UI | `1` (on) | Override of the P0 preemption: on — a `critical` task is the top of the queue; off — the queue is strictly oldest-first | `1`/`true`/`on`/`yes` — on. `0`/`false`/`off`/`no` — off. Unset — the UI value applies |
| `MYRMIDON_SWARM_IDLE_WAKE_BATCH` | 1.6.1 SWARM-IDLE-WAKE | `5` | Upper bound of agents one idle-wake pass of the swarm sweep may wake: for every role with a non-empty ready queue and free agents (no live claim, under the ceiling, not paused, no live run) the pass wakes the missing number, each wake bound to the top queue task (critical first) | From 1 to 25; out of range or non-numeric — clamped/falls back to the default |
The flow end to end — the registry, how a pass works, the screen and the API — is
the operator guide [guides/foraging.md](guides/foraging.md).


## 1.6.1 — BOT-RUNTIME-TUNING D: model fallback attention signal

Settings of `server/src/myrmidon/litellm-fallback-signal/`. The signal is off
by default: without `MYRMIDON_MODEL_FALLBACK_ENABLED=1` no timer is armed and
the attention feed never sees a fallback card. When on, the sweep reads the
gateway spend log (the same client and master-key secret as M2-A
litellm-costs), attributes rows to agents by the sha256 of each bot's virtual
key, and raises ONE medium-severity attention card per agent whose fallback
share — calls served by a model outside the agent's card model set — is at or
above the threshold over the window. The card disappears when the share drops
below half the threshold (hysteresis) or the window empties below min calls.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_MODEL_FALLBACK_ENABLED` | BOT-RUNTIME-TUNING D | unset (off) | Override of the master switch of the fallback signal sweep: computes each agent's share of gateway calls served outside its card model set and records both the attention signal the feed turns into a card and the per-agent rows the agent card shows | `1`/`true` — force on. `0`/`false` — force off. Unset — the stored instance setting applies (`instance_settings.general.modelFallbackSignal`, `GET`/`PATCH /api/myrmidon/model-fallback/settings`); nothing stored — off. The loop stays armed either way, but with the switch off a tick reads one settings row, makes no gateway request and records nothing. Needs `MYRMIDON_LITELLM_*` (M2-A) to read the spend log; without them the sweep logs one warn per tick and stays idle |
| `MYRMIDON_MODEL_FALLBACK_THRESHOLD_PCT` | BOT-RUNTIME-TUNING D | `20` | Override of the fallback share (percent of attributed calls in the window) at which an agent gets the card and the agent-card badge. Exit is half of this (hysteresis: a share hovering at the threshold must not blink) | Integer from 1 to 100; a readable value outside the range is clamped, a non-integer falls back to `20`. Unset — the stored setting applies, else `20`. Read on every sweep tick: a stored change applies to the next pass without a restart |
| `MYRMIDON_MODEL_FALLBACK_MIN_CALLS` | BOT-RUNTIME-TUNING D | `20` | Override of the minimum attributed calls in the window before the agent is evaluated at all — two calls must not raise a signal | Integer from 1; a readable value below is clamped, a non-integer falls back to `20`. Unset — the stored setting applies, else `20` |
| `MYRMIDON_MODEL_FALLBACK_WINDOW_SEC` | BOT-RUNTIME-TUNING D | `3600` (1 h) | Override of the rolling window the share is computed over | Integer from 300 to 86400; values outside are clamped, a non-integer falls back to `3600`. Unset — the stored setting applies, else `3600`. Read on every sweep tick |
| `MYRMIDON_MODEL_FALLBACK_INTERVAL_SEC` | BOT-RUNTIME-TUNING D | `300` | Override of the sweep period, in seconds. A tick whose previous sweep is still running is skipped, not queued. The next pass is scheduled with the interval of the current resolution, so a stored change re-schedules the loop | Integer from 60 to 86400; values outside are clamped, a non-integer falls back to `300` |

Since 1.6.5 (BOT-RUNTIME-TUNING-D2) these values are instance settings, resolved
on every sweep tick and on every request through
`GET`/`PATCH /api/myrmidon/model-fallback/settings` (board reads, instance-admin
writes): the stored row is the source of truth, a set environment variable
overrides its key, and nothing set means the default above. The sweep answers
`GET /api/myrmidon/companies/:companyId/model-fallback/status` with the last
pass's per-agent rows (attributed calls, fallbacks, share, the models that
served, above-threshold flag) and with the numbers it will obey, which is what
the `fallback N%` badge on the agents list renders.

## 1.6.1 — TG-NOTIFY jobs (daily digest and escalations, part B)

Settings of `server/src/myrmidon/telegram-notify/jobs.ts` — the periodic digest and
escalation jobs of the Telegram notify track (part B; the routes and the
`telegramNotify` settings area belong to part A). Both jobs read the owner
settings through part A's JSON contract every pass, so they are
runtime-changeable, and both are OFF by default: with the defaults the owner
receives in Telegram only replies to his own messages and U2 decision cards.
Delivery goes through the existing chat publication path (`chat_publications`,
the vendor outbox), never a second client. No new table: the escalation state
and the last digest day live under our own key of `instance_settings.general`.

The jobs are wired maintenance-style: `server/src/index.ts` has one marked call,
`startTelegramNotifyJobs(db)`; everything else lives in the module.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_TELEGRAM_NOTIFY_TICK_SEC` | 1.6.1-TG-NOTIFY-B | `300` | Period of the shared job interval: how often the jobs check whether the digest time has arrived or an escalation threshold has passed. The jobs still send only when the owner settings enable them | From 30 to 3600; non-integer or out of bounds — the default (300). A pass whose previous run is still going is skipped, not queued |

## 1.6.1 — GUARDRAILS (untrusted-input flagging layer)

Settings of `server/src/myrmidon/guardrails/` (the 1.6.1 flag-only layer). The whole layer is off
by default: without `MYRMIDON_GUARDRAILS_INJECTION_ENABLED` the wake queue stores exactly what it
stored before — no markers, no flag, no event — and the run starts as usual.

### INJECTION (part B: prompt-injection flag on the wake queue)

When enabled, an externally authored queued comment's text is wrapped in
`<untrusted-data>…</untrusted-data>` markers inside the wake payload the run reads (the board UI
view of the comment is unchanged), and a heuristic detector (RU+EN) scores the text for
instruction-override patterns. Flag-only mode: nothing is blocked, nothing is masked, the run
starts exactly as before; the flag travels in the payload next to the wrapped text. The event
journal (`recordGuardrailEvent`) is owned by part A; this part publishes the flag through the
payload only.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_GUARDRAILS_INJECTION_ENABLED` | GUARDRAILS-B | unset (off) | Master switch of the injection flag on the wake queue. Only the exact values `1`, `true`, `yes`, `on` turn it on | Any other value (or unset/empty) — the layer is off and the wake queue is byte-identical to the vendor path; a typo does not silently enable it |
| `MYRMIDON_GUARDRAILS_INJECTION_SCORE` | GUARDRAILS-B | `0.6` | Score threshold at which the heuristic scan sets `flagged: true`. `0` flags everything, `1` flags nothing | Unset, empty, non-numeric or outside 0..1 — the default `0.6` |





## 1.6.1 — CUSTOM-CASTES B: caste-directory consumers (role validator, swarm gate)

No environment variables and no new settings documents: this part wires the
consumers of the company caste directory (the directory itself is part A).
Both consumers read the directory through an injectable port, so until part A
lands the port is absent and every behavior below is a no-op that matches the
pre-directory release exactly.

Agent role validation (`packages/shared/src/validators/agent.ts`,
`server/src/services/agents.ts`): the `role` field of the agent create/update
payload is a caste key — latin letters, digits and hyphens, 1–60 characters —
and no longer one of the fixed twelve role names. When the directory port is
wired, create and update refuse a key that is not a caste of the company with
a 400 (`code` `role_not_company_caste`, the refused key in `role`); create the
caste first, then assign it. The board UI falls back to displaying the raw key
for any role the built-in label map does not know.

Swarm claim gate (`server/src/myrmidon/swarm-claim/service.ts`): when the
directory port is wired, the gate looks up the claiming agent's caste before
taking a task. A caste with `swarmEligible=false` never enters the claim pool
— the claim endpoint answers `caste_excluded` instead of taking a task (a
supervision caste such as a lead or an on-call reviewer stays out of the pool
the swarm draws from). A caste-set `maxActiveTasks` overrides the global
`MYRMIDON_SWARM_MAX_ACTIVE_TASKS` ceiling for agents of that caste only;
`null` keeps the global ceiling. A role with no directory entry behaves
exactly as before.

Unchanged: the autonomy matrix resolves the caste key as the role string with
no schema change (moving an agent between castes changes no verdict), the
`ceo` built-in checks stay byte-identical, custom roles keep working through
explicit grants, and the cloud-connector caste grants are untouched.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| — | 1.6.1-CUSTOM-CASTES-B | — | This part adds no tunables of its own; the directory rows (`swarmEligible`, `maxActiveTasks`) come from part A's store, the swarm globals stay under `MYRMIDON_SWARM_*` | A role with no directory entry is unaffected; nothing to disable |

Update: part A has landed. The directory is the `agent_castes` table described in [guides/custom-castes.md](guides/custom-castes.md); the "until part A lands" wording above no longer applies, and a role with no directory entry behaves exactly as before the directory.

## 1.6.1 — WIP-LIMIT: per-agent work-in-progress limit

Settings of `server/src/myrmidon/wip-limit/` (the 1.6.1 track, part A). The feature has no
environment variables: the limits are a policy choice stored in
`instance_settings.general.wipLimit` and changed from
`GET`/`PUT /api/myrmidon/companies/:companyId/wip-limit/settings` (any company member reads,
instance admins write). Absent settings mean "count only" — the status endpoint
(`GET …/wip-limit/status`) keeps answering, but no attention item and no comment is ever
raised.

The limit resolution is `perAgent[agentId]` over `defaultLimit`; an explicit `null` in either
place means count-only. The lead rule is not a setting: an agent someone reports to is a lead,
and a lead holding a task in `in_progress` or `in_review` is over the limit by definition (the
implementation limit of a lead is 0 — a lead supervises and accepts, it does not deliver).

The periodic check runs on the heartbeat scheduler (the same path the swarm-claim sweep uses)
with an in-module interval of 300 s; a pass whose previous run is still going is skipped. One
signal per agent per UTC day: a system-notice comment on the agent's most recent in_progress
task, deduplicated by the `wip-limit:<agentId>:<utc-day>` metadata key. The attention feed
(source kind `wip_limit`) needs no sweep — it recomputes on every list.

## REVIEW-ROUTING: automatic reviewer for tasks in review

Settings of `server/src/myrmidon/review-routing/`. The feature has no environment variables:
the values are a policy choice stored in `instance_settings.general.reviewRouting` and changed
on the Company Settings → Review routing screen or via
`GET`/`PUT /api/myrmidon/companies/:companyId/review-routing/settings` (any company member
reads, instance admins write; the values are instance-wide). The sweep reads them on every
pass, so a change applies within about a minute, with no restart. Absent or unreadable
settings mean the defaults below.

| Field | Default | What it does | How to disable / special |
|---|---|---|---|
| `enabled` | `true` | Master switch of the routing sweep: a task in `in_review` with no reviewer gets one, a review without a verdict is signalled and reassigned | `false` — the board does nothing and its attention cards disappear (vendor behavior: the task waits for a manual assignment) |
| `reviewerRoles` | `["reviewer"]` | Caste keys (`agents.role`) whose invokable agents may be picked as reviewers | An empty list — nobody is eligible, so every reviewer-less task is signalled as `no_reviewer` |
| `maxLoadPerReviewer` | `5` | A reviewer already holding this many tasks in flight (`in_progress` + `in_review`, as assignee) is not picked. From 1 to 100 | — |
| `reassignAfterHours` | `24` | Hours a review this routing started may stay without a verdict before it is signalled (`review_overdue` attention card, one system comment) and moved to another reviewer that has not had the task. From 0 to 2160 | `0` — never signal or reassign |

How it works. A pass every 60 s (an in-module interval; passes are skipped during maintenance
mode) looks at the 200 oldest-updated visible `in_review` tasks per company, 20 moves per pass.
A task needs a reviewer when it has no review stage participant and no execution workflow in
flight (a policy with no stages is kept and extended; a non-idle execution state or a monitor
leaves the task alone). The picked reviewer is the least-loaded eligible agent (ties by id),
never the task's author (`createdByAgentId`) or its assignee, and becomes the assignee while
the review is pending; the previous assignee is the return assignee. Approving closes the task
as done, requesting changes sends it back. The routing writes one system comment and one
activity entry (`issue.review_routing.assigned` / `issue.review_routing.reassigned`) per move
and wakes the reviewer. With no eligible reviewer the task is signalled on the attention desk
(source kind `review_routing`, `no_reviewer`) instead of staying silent. The overdue clock and
the reassignment apply only to reviews this routing started (they are found by their activity
entries); a review set up by a person is never reassigned automatically.

## 1.7 — METRICS: the board's own /metrics endpoint (Prometheus text)

Settings of `server/src/myrmidon/monitoring/metrics/`. The endpoint answers
`GET /metrics` at the origin root (outside `/api`, the same mounting shape the
swarm-claim ingress uses) with the Prometheus text exposition format 0.0.4, so
the existing scraper stack can collect it. Access is one bearer token: the
value comes from the company secret named by `MYRMIDON_METRICS_TOKEN_SECRET`
(resolved by name, the value is never returned and never logged) or, when no
secret name is set, from the `MYRMIDON_METRICS_TOKEN` variable. Without a
configured token the endpoint answers 401 for everyone — it never falls open.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_METRICS_TOKEN_SECRET` | 1.7-METRICS | unset | Name of the company secret that holds the scraper bearer token. The first resolvable secret of that name across companies wins (the same lookup order the litellm sweep uses); the value never appears in a log, an error or a response | Unset — the env token is used; both unset — the endpoint answers 401 |
| `MYRMIDON_METRICS_TOKEN` | 1.7-METRICS | unset | The scraper bearer token read from the environment, used when no secret name is configured | Unset together with the secret name — 401 for every request |
| `MYRMIDON_METRICS_ERROR_WINDOW_SEC` | 1.7-METRICS | `3600` | Window (seconds) of the error families (failed runs, gateway spend). A request may override it per scrape with `?window=<sec>` | From 60 to 86400; below 60 — 60, above 86400 — 86400, non-numeric — the default |
| `MYRMIDON_METRICS_LATENCY_WINDOW_SEC` | 1.7-METRICS | `21600` | Window (seconds) of the latency family: p50/p95 of finished run durations (finishedAt − startedAt). A request may override it with `?latency_window=<sec>` | From 300 to 86400; below 300 — 300, above 86400 — 86400, non-numeric — the default |
<!-- myrmidon(BOT-DISK-A): bot disk lifecycle — settings row -->
| `MYRMIDON_BOT_DISK_IDLE_TTL_MS` | BOT-DISK-A | `21600000` (6 h) | First-start default of the idle time after which an abandoned bot draft directory (bot `scratch` volume and clones in `workspace`; the `hermes` memory volume is never touched) is reaped by the maintenance-tick sweep. Once an instance admin saves `idleTtlMs` through `PATCH /api/myrmidon/bot-disk` (stored in `instance_settings.general.botDisk`, audited as `instance.bot_disk.updated`), the stored value wins; the sweep re-reads it every tick, no restart needed. `GET /api/myrmidon/bot-disk` (any board member) reports the effective values and their sources | From 5 min to 30 days; outside the window — the default (6 h) |
| `MYRMIDON_BOT_DISK_LIFECYCLE_ENABLED` | BOT-DISK-A | unset (on) | First-start default of whether the sweep reaps at all; `1`/`true`/`yes`/`on` or `0`/`false`/`no`/`off`. A stored `enabled` in `general.botDisk` (`PATCH /api/myrmidon/bot-disk`, instance admin) wins | Any other value is ignored (on) |

## 1.6.1 — VOICE-STT (server-side speech-to-text core, part A)

Settings of `server/src/myrmidon/stt/` (the 1.6.1 voice track). The path is off by default:
without `MYRMIDON_STT_ENABLED=1` every `transcribeAudio` call answers the stable
`stt_disabled` code and no outbound request is made. The default backend is a speech model
behind the shared LiteLLM gateway (`dashscope`); `deepgram` is the optional second backend.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_STT_ENABLED` | VOICE-STT | unset (off) | Master switch of the STT path. The exact values `1`/`true`/`yes`/`on` enable it; everything else keeps it off | Unset, empty or `0`/`false`/`no`/`off` — `stt_disabled`, zero outbound requests |
| `MYRMIDON_STT_BACKEND` | VOICE-STT | `dashscope` | Which backend transcribes: `dashscope` (multipart `/v1/audio/transcriptions` on the gateway) or `deepgram` (direct Deepgram call) | An unknown value falls back to `dashscope` (a typo does not switch the backend) |
| `MYRMIDON_STT_BASE_URL` | VOICE-STT | unset | Address of the gateway (DashScope path) or of Deepgram. A base ending in `/v1` is not doubled | Unset — `stt_unconfigured`, zero outbound requests |
| `MYRMIDON_STT_KEY_SECRET` | VOICE-STT | unset | **Name** of the company secret holding the gateway key for the `dashscope` path. The value is read per call, is never cached and never appears in logs, journals or error messages | Unset — `stt_unconfigured` |
| `MYRMIDON_STT_DEEPGRAM_KEY_SECRET` | VOICE-STT | unset | **Name** of the company secret holding the Deepgram key for the `deepgram` backend | Unset — `stt_unconfigured` |
| `MYRMIDON_STT_MODEL` | VOICE-STT | unset | Model name on the gateway for the `dashscope` path. Until an operator registers the model on the gateway, a call degrades to the stable `stt_unconfigured` (the gateway's "Invalid model name" answer is recognized) | Unset — `stt_unconfigured` |
| `MYRMIDON_STT_LANGUAGE` | VOICE-STT | `auto` | Recognition language hint: `auto` or `ru`. `auto` sends no language field to the DashScope path | An unknown value falls back to `auto` |
| `MYRMIDON_STT_DIARIZATION` | 1.6.5 VOICE-STT B | unset (off) | Turns on speaker diarization on both backends: the Deepgram path sends `diarize`, the LiteLLM/DashScope path sends `diarization_enabled`. The answer always reports what happened — requested, applied, the speaker count, or the stable marker `diarization_no_speakers` — the intake writes the marker line «Говорящие не размечены» into the task comment, and the meeting protocol says the participants are unmarked. Speakers are never invented | Exact `0`/`false`/`no`/`off` — off |
| `MYRMIDON_STT_MAX_DURATION_SEC` | VOICE-STT | `1800` | Duration limit: a longer recording answers the stable `audio_too_long` before any outbound request | Non-integer or non-positive — the default |
| `MYRMIDON_STT_MAX_BYTES` | VOICE-STT | `26214400` (25 MB) | Size limit: a larger recording answers `audio_too_large` before any outbound request | Non-integer or non-positive — the default |
| `MYRMIDON_STT_TIMEOUT_SEC` | VOICE-STT | `120` | Per-request timeout of one backend call. A timed-out call answers the stable `stt_timeout` | Clamped to 5–600 s; out of bounds — the default |
| `MYRMIDON_STT_CHUNK_SEC` | VOICE-STT | `60` | Target duration of one chunk in the pure-TS long-recording split (OGG page / MPEG frame boundaries; no ffmpeg). Chunks are merged back with timecode offsets | Clamped to 5–300 s; out of bounds — the default |

Runtime-mutable per-company overrides (enabled, backend, model, language, diarization,
duration limit) live under `instance_settings.general.myrmidonSttCompanies[companyId]`
(no new migration — the same JSON-column pattern the autonomy matrix uses) and are
managed through `GET`/`PATCH /api/myrmidon/companies/:companyId/voice-stt` (GET is
company access, PATCH is board only). The environment values are the defaults the
overrides start from; a stored `enabled: true` cannot resurrect a path whose contour
(address, key secret, model) is unnamed.

The PATCH accepts only `enabled`, `backend`, `model`, `language`, `diarization` and
`maxDurationSec` (a strict schema, an unknown field answers 400); `model: null`
clears the stored model back to the environment default. Every successful PATCH is
journaled as `myrmidon.stt.settings_saved`. The GET answers the effective settings
with the key secret's **name**, never its value, plus a `problem` object naming the
stable reason the path cannot serve yet; `problem` is `null` when the path is
ready.

The stable `transcribeAudio` error codes: `stt_disabled` (the path is off),
`stt_unconfigured` (the contour — address, key secret, model — is unnamed),
`audio_too_long` / `audio_too_large` (a limit answered before any outbound
request), `stt_timeout` (the backend call timed out), `stt_upstream_error`
(any other backend failure).

The container-bot side of the track — the media-mcp tools `audio_split` /
`stt_transcribe` and their `MEDIA_STT_*` service settings — is documented in
[media-tools.md](media-tools.md) («Speech-to-text»).

## 1.7 — BUDGET-CONFIG B: enforcement mode of spend limits

What a crossed spend budget limit does while its incident is open: only
signal (the default), pause the scope with an owner card, or refuse new runs.
The mode is a live instance setting — change it on Instance → General or via
`GET`/`PATCH /api/myrmidon/budget-enforcement` (GET is board, PATCH is
instance-admin) with no restart; the next budget evaluation applies it. The
environment variable is the forced override for an instance that never saved
the setting (precedence: stored settings → env → default; the effective
source is shown on the screen).

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_BUDGET_ENFORCEMENT_MODE` | 1.7-BUDGET-CONFIG-B | unset (`signal_only`) | The enforcement mode while nothing is stored in `instance_settings.general.budgetEnforcement`: `signal_only` — the incident is created and the owner is signalled, but the scope is not paused and runs start; `soft` — pause plus the owner card (raising the budget resumes); `hard` — new runs of the over-limit scope are refused with the budget reason | Any other value (or unset) — the default `signal_only`; once a value is saved from the settings page, the environment stops mattering. The signals themselves additionally honor `MYRMIDON_BUDGET_SIGNAL_MODE=off`. Full guide: [guides/budget-enforcement.md](guides/budget-enforcement.md) |

## 1.7 — Spend limits per hierarchy level (BUDGET-CONFIG A)

Settings of `server/src/myrmidon/budget-limits/` (the 1.7 BUDGET-CONFIG epic,
part A). Limits live in `budget_limits` (migration 0312, additive: one row per
`(company, level, ref)` with `amount_cents`, `period` `calendar_month_utc` or
`lifetime`, mode `hard`/`soft`, `is_active`) with the change journal
`budget_limit_changes`; they are managed through
`/api/myrmidon/companies/:companyId/budget-limits` (CRUD is board-only, every
mutation writes a journal row). The global "signal only" mode is stored in
`instance_settings.general.budgetLimits` (`{ signalOnly }`, ON by default via
`preserveBudgetLimitsGeneralKey`) and changed at runtime through
`GET/PATCH …/budget-limits/signal-only` without a restart; `usage` answers the
spent-in-period of every limit from `litellm_cost_events` with an `overLimit`
flag. See the guide [guides/budget-limits.md](guides/budget-limits.md).

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_BUDGET_LIMITS_SIGNAL_ONLY` | BUDGET-CONFIG A | unset | **Forced override** of the global "signal only" mode. `1`/`true`/`yes`/`on` — limits never stop work; `0`/`false`/`no`/`off` — the stored mode applies as enforcement | Unset — the stored value of `instance_settings.general.budgetLimits.signalOnly` applies (ON by default); any other value is ignored, so a typo never flips the owner's choice. GET `…/budget-limits/signal-only` reports the effective value with its source (`stored`, `default`, `env`) |

## 1.6.2 — BOT-LSP-DEFAULTS: bot language servers by role

Settings of `server/src/myrmidon/bot-lsp/` and the profile compiler's `lsp` block
(`packages/shared/src/myrmidon-bot-lsp.ts`). No environment variables: the policy is stored
in `instance_settings.general.botLsp` and changed from Instance settings → General → "Bot
language servers" or `GET`/`PATCH /api/myrmidon/bot-lsp` (board members read, instance admins
write; a `null` field in the PATCH body resets it to the default). An agent card can pin its
own mode in `adapterConfig.lsp.mode`; an absent pin follows the role.

The profile compiler re-reads the policy on every reconcile tick. A changed `lsp` block is a
`config.yaml` change, so the reconciler applies it with the bot's admission paused (the path a
model change takes); the server is not restarted.

| Field | Default | What it does | Bounds / special |
|---|---|---|---|
| `codingRoles` | `engineer, qa, devops, reviewer, release` | Caste keys (`agents.role`) whose bots write code. Custom castes count; matching is case-insensitive | Latin letters, digits, hyphens; up to 200 keys. A bot with no role is non-coding |
| `codingMode` | `limited` | Mode of a coding bot | `off` / `limited` / `full` |
| `nonCodingMode` | `off` | Mode of every other bot | `off` / `limited` / `full` |
| `idleTimeoutSeconds` | `120` | `lsp.idle_timeout` of the limited mode: an idle language server is stopped after this long | 30–86400 (Hermes raises anything below 30 to 30) |
| `tsserverMemoryMb` | `1024` | `maxTsServerMemory` of the limited mode (tsserver `--max-old-space-size`) | 256–16384 |
| `excludeRoots` | empty | `lsp.exclude_roots` for bots whose servers run (limited or full): workspaces where no language server starts | Globs, up to 50 |

Modes, as written into the bot's `config.yaml`:

- `off` — `lsp.enabled: false`: no language server and no LSP event loop.
- `limited` — `lsp.enabled: true`, `lsp.idle_timeout`, and
  `lsp.servers.typescript.initialization_options` = `{ disableAutomaticTypingAcquisition: true,
  maxTsServerMemory, tsserver: { useSyntaxServer: "never" } }` — one tsserver per worktree
  instead of two, no typings download.
- `full` — nothing written (Hermes' own defaults), except `exclude_roots` when set.

## 1.6.2 — PLUGIN-ENTITLEMENT C: plugin entitlement keys (instance settings UI)

Instance-level plugin entitlement keys. A plugin whose manifest sets
`requiresEntitlement: true` is not activated (no worker, no UI slots, hidden
from menus and settings) until the instance admin accepts a valid key for its
exact plugin id. Managed from the "Plugin keys" block of the instance
settings page; the API is `GET/POST/DELETE /api/myrmidon/plugin-entitlement/keys`
(instance admin). Keys live in `instance_settings.general.pluginEntitlementKeys`
(`[{ pluginId, key, expiresAt, acceptedAt }]`); accepting or removing a key
applies without a restart — the loader gate re-reads the row on every
activation pass. No env override: which plugins are unlocked is a licensing
choice, not a deployment knob. Key verification (cryptographic) arrives with
the ML1/ML2 API; until then a syntactically valid key for a known plugin id
is accepted. An invalid input answers 400 with a clear message.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `pluginEntitlementKeys` | 1.6.2-PLUGIN-ENTITLEMENT C | absent | The accepted plugin entitlement keys in the instance general settings; absent means "no keys registered" — every entitlement-gated plugin stays inactive | Remove the keys in the UI or via DELETE …/keys/:pluginId; a malformed stored row fails closed to "no keys" |

## 1.6.3 — PROMPT-BUDGET C: prompt-budget advice and deep analysis

What the last run's prompt was made of — which part dominates it and what to do about it — is shown
on the agent card (Overview). The advice is computed on request from the recorded breakdown; a
"Deep analysis" button files a task for a cheap-model optimizer agent, which drafts instruction
edits as a comment on that task. Nothing is scheduled and nothing is changed automatically.

The static thresholds are code constants of
`server/src/myrmidon/prompt-budget-advice/advice.ts`, not settings: a part is worth a recommendation
from 30% of the prompt (`PROMPT_BUDGET_ADVICE_SHARE_PCT`), is critical from 50%
(`PROMPT_BUDGET_ADVICE_CRIT_SHARE_PCT`), and no advice is produced below 2000 prompt tokens
(`PROMPT_BUDGET_ADVICE_MIN_TOTAL_TOKENS`).

API: `GET /api/myrmidon/companies/:companyId/prompt-budget/agents/:agentId/advice` (company
member) returns the breakdown and the recommendations; `POST .../advice/deep` (board) answers 201
with the id and identifier of the filed task, or 422 with a clear message when no optimizer agent
is configured or usable.

| Field | Default | What it does | Bounds / special |
|---|---|---|---|
| `promptBudget.optimizerAgentId` | absent | Agent that receives the deep-analysis task filed by the "Deep analysis" button | A uuid of another agent of the same company; absent, blank or not a uuid answers the deep POST with 422. An additive field of the `promptBudget` area owned by the thresholds part (`instance_settings.general.promptBudget`); no environment variable |
| `promptBudget` | 1.6.3-PROMPT-BUDGET D (read-only here; written by part B) | absent | Threshold settings of the prompt budget. The report judges a run against `warnPct` percent of the context window of the model that served the run (`litellm_models.maxInputTokens`); the average prompt size uses `heartbeat_runs.usageJson.promptBreakdown.total`, and the input tokens of the run's own cost events when the run recorded no breakdown | Absent, `enabled: false` or an unusable value — the share column stays empty (`null`), never zero, and the report keeps working. A run whose model window is unknown counts towards the average prompt size but is left out of the share. Removing the key removes the column content; nothing else changes |

The live thresholds of part B (the same `promptBudget` settings area):

| Field | Default | What it does | Bounds / special |
|---|---|---|---|
| `promptBudget.warnPct` | `70` | Warn level, percent of the model window; a last run at or above it raises a medium card | Whole number 1–99, strictly below `critPct`; an unreadable stored row falls back to the full default set |
| `promptBudget.critPct` | `90` | Crit level, percent of the model window; a last run at or above it raises a high card | Whole number 2–100, strictly above `warnPct` |
| `promptBudget.enabled` | `true` | `false` = the status is still reported, but no card and no signal comment are produced | The sweep skips the pass before any query |
| `promptBudget.fallbackWindowTokens` | `200000` | The window the thresholds count against when the agent's model has no known `maxInputTokens` | Whole number ≥ 1000; the status row marks it with `windowIsFallback: true` |

## 1.7 — LiteLLM budget projection (BUDGET-CONFIG C)

Settings of `server/src/myrmidon/litellm-budget-sync/` (the 1.7 BUDGET-CONFIG
epic, part C). The feature is off by default: the sweep is a no-op and the
status/re-sync endpoints answer 503 `enabled: false` until the instance names
the gateway contour (the M2-A/M2-B variables below) AND the company's stored
document turns the master switch on. Limits live per company in
`instance_settings.general.myrmidonBudgetProjectionCompanies[companyId]`
(no new migration — the JSON-column pattern the STT overrides use) and are
managed through `GET`/`PUT /api/myrmidon/companies/:companyId/litellm-budget-sync/settings`;
the signal-only global mode is on by default, so no projected limit stops
work until the owner turns it off. See the guide
[guides/litellm-budget-projection.md](guides/litellm-budget-projection.md).

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_LITELLM_BUDGET_SYNC_INTERVAL_SEC` | 1.7-BUDGET-CONFIG-C | `30` | The sweep interval of the budget projection pass, in seconds — a changed limit reaches LiteLLM within this window (the acceptance criterion is ≤ 60 s). The stored per-company `sweepIntervalSec` is the source the UI writes; this variable is a **forced override** for its key only, and the settings GET answers which side won | Unset — the stored value or the default applies. Clamped to 10–3600; non-integer values are ignored |

## 1.6.3 — GITHUB-SHARED-IDENTITY: self-hosted GitHub Apps ("authorize once")

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_GITHUB_VENDOR_CONNECTOR` | GITHUB-SHARED-IDENTITY (T3) | unset (**off**) | Instance-wide switch of the vendor's cloud GitHub connector (OAuth through the vendor's GitHub App, `github.code` connector profile). Off (default): new managed GitHub connections and their OAuth start are refused (`github_vendor_connector_disabled`), and existing vendor-connector connections are ignored by the credential resolver (shell git/gh, the run broker, workspace git) — the instance uses the self-hosted GitHub Apps registered in Company settings → Shared GitHub authorization | `1`/`true`/`yes`/`on` — emergency enable of the vendor path. Any other value or unset — off. Read on every call; a change takes effect on process restart |

Everything else is runtime-changeable per company. Company settings →
"Shared GitHub authorization" (`GET`/`PUT /api/myrmidon/companies/:companyId/github-shared-identity`;
GET: board with company access, PUT: board with `tools:manage_connections`)
edits `instance_settings.general.myrmidonGithubSharedIdentity[companyId]`:

| Field | Default | What it does |
|---|---|---|
| `enabled` | `false` | Master switch. Off: no App serves anybody (the pre-change behavior). |
| `apps[].appId` | — | The id of our own GitHub App (registered with Contents and Pull requests read/write, Metadata read). |
| `apps[].privateKeySecretId` | — | Company secret (company scope, active) holding the App's private key PEM. Validated on save. |
| `apps[].installationId` | `null` | Installation id; `null` — discovered per repository (`GET /repos/{owner}/{repo}/installation`). |
| `apps[].roles` / `apps[].agentIds` | `[]` | Agents that may use the App (by role or id). Both empty: nobody. |
| `apps[].allowedRepos` | `[]` | `owner/repo` or `owner/<pattern with *>` the App serves; the owner is literal. The broker picks the App by the target repository of each operation; a repository matched by two Apps is an error. |
| `commitEmailDomain` | `null` (`agents.myrmidon.invalid`) | Domain of the agent's commit email `<agent-slug>@<domain>`. Author and committer stay the agent. |

The board mints installation tokens itself (RS256 JWT, `POST
/app/installations/{id}/access_tokens`), narrowed to the one target
repository and `contents: write, pull_requests: write, metadata: read`;
cached in memory until five minutes before expiry. Precedence: dedicated
(per-agent) grant > the run's personal grant > App. Audit:
`myrmidon.github_app.issued`/`denied`, secret access event with config path
`github_app:<owner/repo>`. In bot containers patch 09 keeps stripping raw
tokens; `git-credential-paperclip` (now with `useHttpPath = true`) and the
`gh` wrapper send the target repository to the broker. Full guide:
[guides/github-shared-identity.md](guides/github-shared-identity.md).

## 1.6.5 — GITHUB-APP-SCOPES: per-entry GitHub App permissions

| Field | Default | What it does |
|---|---|---|
| `apps[].permissions` | contents + pull requests `write`, all other keys `none` | The permission list the broker requests verbatim on every installation token of this App entry: each of `actions`, `checks`, `contents`, `deployments`, `environments`, `issues`, `pull_requests`, `workflows` is `none` (never requested), `read` or `write`; `metadata: read` is always added (GitHub grants it to every installation token), `workflows` is `write`-only. Keys outside this allow-list (secrets, administration, organization permissions) are rejected on save. Part of the token cache key — widening an entry re-mints. To let agents edit `.github/workflows/*`, enable Workflows on the App registration first, accept the updated permissions on the installation, then set `workflows: write` here. |

## 1.6.4 — AUTONOMY-DELETE: matrix enforcement tests and route mapping

Unit tests for the `delete` action-class enforcement on agent-accessible DELETE routes
(`server/src/routes/issues.autonomy.myrmidon.test.ts` — gate level, no DB: forbidden role gets
403 `autonomy_forbidden` and the handler never runs; allowed and board calls pass), plus the
route-to-guard mapping in `docs/myrmidon/guides/delete-route-mapping.md`. See the guide
`docs/myrmidon/guides/autonomy-delete-enforcement.md` (+ `.ru.md`) for operator docs.

## Team liveness settings (instance and agent card)

The three automatic behaviours read their knobs from one settings area. The
stored row lives in `instance_settings.general.teamLiveness`, holds only the
keys an operator saved, and is changed on the Instance → General page ("Team
liveness") or via `GET`/`PATCH /api/myrmidon/team-liveness`. Precedence is per
key: stored value, else the environment variable of the same knob (the table in
"Track 2 — wake and run core"), else the built-in default. The GET answers with
`sources` per key — `settings`, `env` or `default` — so a field the environment
does not actually control is never shown as "environment". The three sweeps
re-read the row on every pass: a saved change takes effect on the next pass
without a restart.

| Stored key | Behaviour | Default | What it does | Accepted values |
|---|---|---|---|---|
| `autoResumeEnabled` | AUTO-RESUME | `true` (on) | Master switch: the board resumes an agent left in `error` with backoff | boolean; absent follows `MYRMIDON_AUTO_RESUME_ENABLED` |
| `runStallEnabled` | RUN-STALL | `true` (on) | Master switch: a run that records no progress for the threshold is interrupted as stalled | boolean; absent follows `MYRMIDON_RUN_STALL_ENABLED` |
| `runStallThresholdSec` | RUN-STALL | `1200` (20 min) | Silence window after which a run counts as stalled (seconds) | 60..86400; a stored value outside the range is ignored and the environment/default applies |
| `idlePickupEnabled` | IDLE-PICKUP | `true` (on) | Master switch: the board wakes an idle agent whose ready task is assigned to it | boolean; absent follows `MYRMIDON_IDLE_PICKUP_ENABLED` |
| `idlePickupIntervalSec` | IDLE-PICKUP | `30` | How often (sec) the wake pass may look | at least 5; a smaller stored value is raised to 5 |
| `idlePickupWakeBudgetPerMin` | IDLE-PICKUP | `5` | Company-wide ceiling of automatic wakes per minute | 1..60; the budget object is re-configured from this value on every pass |
| `idlePickupWakeBatch` | IDLE-PICKUP | `5` | How many of that minute one pass may spend at once | 1..60, never above the minute ceiling |

Per agent, `adapterConfig.teamLiveness = { autoResume?, runStall?, idlePickup? }`
("Team liveness" on the agent card) overrides one behaviour's switch for that
one agent: absent means "follow the instance settings". The card carries no
numbers — the company-wide ceiling and throttle stay on the instance settings
page.

Every change is written to the activity log for every company as
`instance.team_liveness.updated`, with the previous stored values and the
changed keys.

## 1.6.5 — DOCKERGATE-A2A3-STORM: board pacing toward dockergate

| `MYRMIDON_DOCKERGATE_MAX_RPS` | DOCKERGATE-A2A3-STORM | `20` | Ceiling of board→dockergate requests per second summed over every loop (reconcile sweep, health wait, clone-report collector, "apply now"): a client-side token bucket in the docker driver, so the board stays under the gate's own global bucket (50/s) with margin and a fleet rollout does not ride the limit | `0` — the bucket is off (the loops hammer the gate's bucket directly, as on 1.6.5-rc.1). Non-numeric or above 50 — the default. Configs built in code without this field (tests) also run unpaced |
| `MYRMIDON_CLONE_REPORT_INTERVAL_SEC` | DOCKERGATE-A2A3-STORM | `300` | How often the clone-hygiene report collector asks each bot's container for its report (inspect + report read under the per-bot lock). Until here it ran on the maintenance tick (5 s): 74 bots turned into ~30 gate requests per second — the 05.10 A2/A3 storm. A report is valid for 24 h, so minutes are enough | From 60 to 86400; empty, non-integer or out of range — `300`. Read at server startup (the collector starts with the bot container runtime), a change needs a restart. Applies only while `MYRMIDON_BOT_CONTAINERS` is enabled |

## Name mapping PAPERCLIP_* → MYRMIDON_*

Since 1.7 the product reads its environment variables as `MYRMIDON_<NAME>`;
the vendor `PAPERCLIP_<NAME>` spelling works for one release as an alias with a
one-time deprecation warning in the log (see
[guides/env-names-alias.md](guides/env-names-alias.md)). When both names are
set, `MYRMIDON_*` wins. The mapping of every variable the product reads:

| Old name | New name |
|---|---|
| `PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST` | `MYRMIDON_ACPX_PROVIDER_PACKAGE_MANIFEST` |
| `PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT` | `MYRMIDON_ACPX_PROVIDER_PACKAGE_ROOT` |
| `PAPERCLIP_ADAPTER_MODELS` | `MYRMIDON_ADAPTER_MODELS` |
| `PAPERCLIP_AGENT_JWT_AUDIENCE` | `MYRMIDON_AGENT_JWT_AUDIENCE` |
| `PAPERCLIP_AGENT_JWT_DISABLE_LEGACY_FALLBACK` | `MYRMIDON_AGENT_JWT_DISABLE_LEGACY_FALLBACK` |
| `PAPERCLIP_AGENT_JWT_ISSUER` | `MYRMIDON_AGENT_JWT_ISSUER` |
| `PAPERCLIP_AGENT_JWT_SECRET` | `MYRMIDON_AGENT_JWT_SECRET` |
| `PAPERCLIP_AGENT_JWT_TTL_SECONDS` | `MYRMIDON_AGENT_JWT_TTL_SECONDS` |
| `PAPERCLIP_ALLOWED_ATTACHMENT_TYPES` | `MYRMIDON_ALLOWED_ATTACHMENT_TYPES` |
| `PAPERCLIP_ALLOWED_HOSTNAMES` | `MYRMIDON_ALLOWED_HOSTNAMES` |
| `PAPERCLIP_ANNOUNCEMENTS_ENABLED` | `MYRMIDON_ANNOUNCEMENTS_ENABLED` |
| `PAPERCLIP_ANNOUNCEMENTS_FEED_URL` | `MYRMIDON_ANNOUNCEMENTS_FEED_URL` |
| `PAPERCLIP_API_BRIDGE_MODE` | `MYRMIDON_API_BRIDGE_MODE` |
| `PAPERCLIP_API_KEY` | `MYRMIDON_API_KEY` |
| `PAPERCLIP_API_URL` | `MYRMIDON_API_URL` |
| `PAPERCLIP_ATTACHMENT_MAX_BYTES` | `MYRMIDON_ATTACHMENT_MAX_BYTES` |
| `PAPERCLIP_AUTH_BASE_URL_MODE` | `MYRMIDON_AUTH_BASE_URL_MODE` |
| `PAPERCLIP_AUTH_DISABLE_SIGN_UP` | `MYRMIDON_AUTH_DISABLE_SIGN_UP` |
| `PAPERCLIP_AUTH_PUBLIC_BASE_URL` | `MYRMIDON_AUTH_PUBLIC_BASE_URL` |
| `PAPERCLIP_AUTH_RATE_LIMIT_ENABLED` | `MYRMIDON_AUTH_RATE_LIMIT_ENABLED` |
| `PAPERCLIP_AUTH_STORE` | `MYRMIDON_AUTH_STORE` |
| `PAPERCLIP_BIND` | `MYRMIDON_BIND` |
| `PAPERCLIP_BIND_HOST` | `MYRMIDON_BIND_HOST` |
| `PAPERCLIP_BRIDGE_HOST` | `MYRMIDON_BRIDGE_HOST` |
| `PAPERCLIP_BRIDGE_MAX_BODY_BYTES` | `MYRMIDON_BRIDGE_MAX_BODY_BYTES` |
| `PAPERCLIP_BRIDGE_MAX_QUEUE_DEPTH` | `MYRMIDON_BRIDGE_MAX_QUEUE_DEPTH` |
| `PAPERCLIP_BRIDGE_NONCE` | `MYRMIDON_BRIDGE_NONCE` |
| `PAPERCLIP_BRIDGE_POLL_INTERVAL_MS` | `MYRMIDON_BRIDGE_POLL_INTERVAL_MS` |
| `PAPERCLIP_BRIDGE_PORT` | `MYRMIDON_BRIDGE_PORT` |
| `PAPERCLIP_BRIDGE_QUEUE_DIR` | `MYRMIDON_BRIDGE_QUEUE_DIR` |
| `PAPERCLIP_BRIDGE_RESPONSE_TIMEOUT_MS` | `MYRMIDON_BRIDGE_RESPONSE_TIMEOUT_MS` |
| `PAPERCLIP_BRIDGE_TOKEN` | `MYRMIDON_BRIDGE_TOKEN` |
| `PAPERCLIP_BUILD_COMMIT` | `MYRMIDON_BUILD_COMMIT` |
| `PAPERCLIP_BUILD_VERSION` | `MYRMIDON_BUILD_VERSION` |
| `PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL` | `MYRMIDON_CHAT_WEBHOOK_PUBLIC_URL` |
| `PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN` | `MYRMIDON_CLOUD_TENANT_SERVER_TOKEN` |
| `PAPERCLIP_CODEX_PROVIDERS` | `MYRMIDON_CODEX_PROVIDERS` |
| `PAPERCLIP_COMPANY_ID` | `MYRMIDON_COMPANY_ID` |
| `PAPERCLIP_CONFIG` | `MYRMIDON_CONFIG` |
| `PAPERCLIP_CONTEXT` | `MYRMIDON_CONTEXT` |
| `PAPERCLIP_DB_BACKUP_ALERT_FILE` | `MYRMIDON_DB_BACKUP_ALERT_FILE` |
| `PAPERCLIP_DB_BACKUP_DIR` | `MYRMIDON_DB_BACKUP_DIR` |
| `PAPERCLIP_DB_BACKUP_ENABLED` | `MYRMIDON_DB_BACKUP_ENABLED` |
| `PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES` | `MYRMIDON_DB_BACKUP_INTERVAL_MINUTES` |
| `PAPERCLIP_DB_BACKUP_MAX_AGE_HOURS` | `MYRMIDON_DB_BACKUP_MAX_AGE_HOURS` |
| `PAPERCLIP_DB_BACKUP_RETENTION_DAYS` | `MYRMIDON_DB_BACKUP_RETENTION_DAYS` |
| `PAPERCLIP_DEBUG_VERSION_RESOLUTION` | `MYRMIDON_DEBUG_VERSION_RESOLUTION` |
| `PAPERCLIP_DECISIONS_OPEN_CAP` | `MYRMIDON_DECISIONS_OPEN_CAP` |
| `PAPERCLIP_DECISIONS_RECOVERY_GRACE_MS` | `MYRMIDON_DECISIONS_RECOVERY_GRACE_MS` |
| `PAPERCLIP_DECISIONS_SWEEP_BATCH_SIZE` | `MYRMIDON_DECISIONS_SWEEP_BATCH_SIZE` |
| `PAPERCLIP_DECISION_SIGNING_SECRET` | `MYRMIDON_DECISION_SIGNING_SECRET` |
| `PAPERCLIP_DEPLOYMENT_EXPOSURE` | `MYRMIDON_DEPLOYMENT_EXPOSURE` |
| `PAPERCLIP_DEPLOYMENT_ID` | `MYRMIDON_DEPLOYMENT_ID` |
| `PAPERCLIP_DEPLOYMENT_MODE` | `MYRMIDON_DEPLOYMENT_MODE` |
| `PAPERCLIP_DEV_SERVER_STATUS_TOKEN` | `MYRMIDON_DEV_SERVER_STATUS_TOKEN` |
| `PAPERCLIP_EMBEDDED_POSTGRES_PORT` | `MYRMIDON_EMBEDDED_POSTGRES_PORT` |
| `PAPERCLIP_EMBEDDED_POSTGRES_VERBOSE` | `MYRMIDON_EMBEDDED_POSTGRES_VERBOSE` |
| `PAPERCLIP_ENABLE_COMPANY_DELETION` | `MYRMIDON_ENABLE_COMPANY_DELETION` |
| `PAPERCLIP_ENABLE_DARWIN_SSH_ENV_LAB` | `MYRMIDON_ENABLE_DARWIN_SSH_ENV_LAB` |
| `PAPERCLIP_FEEDBACK_EXPORT_BACKEND_TOKEN` | `MYRMIDON_FEEDBACK_EXPORT_BACKEND_TOKEN` |
| `PAPERCLIP_FEEDBACK_EXPORT_BACKEND_URL` | `MYRMIDON_FEEDBACK_EXPORT_BACKEND_URL` |
| `PAPERCLIP_HOME` | `MYRMIDON_HOME` |
| `PAPERCLIP_IMPORT_ZIP_MAX_BYTES` | `MYRMIDON_IMPORT_ZIP_MAX_BYTES` |
| `PAPERCLIP_INSTANCE_ID` | `MYRMIDON_INSTANCE_ID` |
| `PAPERCLIP_IN_WORKTREE` | `MYRMIDON_IN_WORKTREE` |
| `PAPERCLIP_LISTEN_HOST` | `MYRMIDON_LISTEN_HOST` |
| `PAPERCLIP_LISTEN_PORT` | `MYRMIDON_LISTEN_PORT` |
| `PAPERCLIP_LOG_LEVEL` | `MYRMIDON_LOG_LEVEL` |
| `PAPERCLIP_MANAGED_RUNTIME_EXPOSURE` | `MYRMIDON_MANAGED_RUNTIME_EXPOSURE` |
| `PAPERCLIP_MANAGED_RUNTIME_HTTPS` | `MYRMIDON_MANAGED_RUNTIME_HTTPS` |
| `PAPERCLIP_MANAGED_RUNTIME_PUBLIC_URL` | `MYRMIDON_MANAGED_RUNTIME_PUBLIC_URL` |
| `PAPERCLIP_MCP_GATEWAY_AUTH_FAILURE_LIMIT` | `MYRMIDON_MCP_GATEWAY_AUTH_FAILURE_LIMIT` |
| `PAPERCLIP_MCP_GATEWAY_AUTH_FAILURE_WINDOW_MS` | `MYRMIDON_MCP_GATEWAY_AUTH_FAILURE_WINDOW_MS` |
| `PAPERCLIP_MCP_GATEWAY_REQUEST_LIMIT` | `MYRMIDON_MCP_GATEWAY_REQUEST_LIMIT` |
| `PAPERCLIP_MCP_GATEWAY_REQUEST_WINDOW_MS` | `MYRMIDON_MCP_GATEWAY_REQUEST_WINDOW_MS` |
| `PAPERCLIP_MCP_GATEWAY_SESSION_SETUP_LIMIT` | `MYRMIDON_MCP_GATEWAY_SESSION_SETUP_LIMIT` |
| `PAPERCLIP_MCP_GATEWAY_SESSION_SETUP_WINDOW_MS` | `MYRMIDON_MCP_GATEWAY_SESSION_SETUP_WINDOW_MS` |
| `PAPERCLIP_MCP_GATEWAY_TOKEN_REQUEST_LIMIT` | `MYRMIDON_MCP_GATEWAY_TOKEN_REQUEST_LIMIT` |
| `PAPERCLIP_MCP_GATEWAY_TOKEN_REQUEST_WINDOW_MS` | `MYRMIDON_MCP_GATEWAY_TOKEN_REQUEST_WINDOW_MS` |
| `PAPERCLIP_MIGRATION_AUTO_APPLY` | `MYRMIDON_MIGRATION_AUTO_APPLY` |
| `PAPERCLIP_MIGRATION_PROMPT` | `MYRMIDON_MIGRATION_PROMPT` |
| `PAPERCLIP_NATIVE_RUNTIME_CONTEXT_PATH` | `MYRMIDON_NATIVE_RUNTIME_CONTEXT_PATH` |
| `PAPERCLIP_NORMALIZED_SESSION_ID` | `MYRMIDON_NORMALIZED_SESSION_ID` |
| `PAPERCLIP_NO_BROWSER` | `MYRMIDON_NO_BROWSER` |
| `PAPERCLIP_ONBOARDING_SEED_ADAPTER_TYPE` | `MYRMIDON_ONBOARDING_SEED_ADAPTER_TYPE` |
| `PAPERCLIP_OPENCODE_COMMAND` | `MYRMIDON_OPENCODE_COMMAND` |
| `PAPERCLIP_OPENCODE_PERMISSION_MODE` | `MYRMIDON_OPENCODE_PERMISSION_MODE` |
| `PAPERCLIP_OPENCODE_PRINT_LOGS` | `MYRMIDON_OPENCODE_PRINT_LOGS` |
| `PAPERCLIP_OPENCODE_PROVIDERS` | `MYRMIDON_OPENCODE_PROVIDERS` |
| `PAPERCLIP_OPENCODE_RUNTIME_DIR` | `MYRMIDON_OPENCODE_RUNTIME_DIR` |
| `PAPERCLIP_OPENCODE_SMALL_MODEL` | `MYRMIDON_OPENCODE_SMALL_MODEL` |
| `PAPERCLIP_OPENCODE_STORAGE_DIR` | `MYRMIDON_OPENCODE_STORAGE_DIR` |
| `PAPERCLIP_OPEN_ON_LISTEN` | `MYRMIDON_OPEN_ON_LISTEN` |
| `PAPERCLIP_PAGES_API_URL` | `MYRMIDON_PAGES_API_URL` |
| `PAPERCLIP_PG_DUMP_PATH` | `MYRMIDON_PG_DUMP_PATH` |
| `PAPERCLIP_PI_COMMAND` | `MYRMIDON_PI_COMMAND` |
| `PAPERCLIP_PI_PROVIDERS` | `MYRMIDON_PI_PROVIDERS` |
| `PAPERCLIP_PROCESS_SESSION_COMMAND_B64` | `MYRMIDON_PROCESS_SESSION_COMMAND_B64` |
| `PAPERCLIP_PROCESS_SESSION_DIR` | `MYRMIDON_PROCESS_SESSION_DIR` |
| `PAPERCLIP_PROCESS_SESSION_STDIN_MAX_RETRIES` | `MYRMIDON_PROCESS_SESSION_STDIN_MAX_RETRIES` |
| `PAPERCLIP_PROCESS_SESSION_TERMINATE_GRACE_MS` | `MYRMIDON_PROCESS_SESSION_TERMINATE_GRACE_MS` |
| `PAPERCLIP_PROJECT_WORKSPACE_ID` | `MYRMIDON_PROJECT_WORKSPACE_ID` |
| `PAPERCLIP_PSQL_PATH` | `MYRMIDON_PSQL_PATH` |
| `PAPERCLIP_PUBLIC_URL` | `MYRMIDON_PUBLIC_URL` |
| `PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE` | `MYRMIDON_RESPONSIBLE_USER_AUTHZ_MODE` |
| `PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW` | `MYRMIDON_RESPONSIBLE_USER_AUTHZ_SHADOW` |
| `PAPERCLIP_RUNNER_BINARY` | `MYRMIDON_RUNNER_BINARY` |
| `PAPERCLIP_RUNNER_INSTANCE_ID` | `MYRMIDON_RUNNER_INSTANCE_ID` |
| `PAPERCLIP_RUNNER_NETWORK_ACCESS` | `MYRMIDON_RUNNER_NETWORK_ACCESS` |
| `PAPERCLIP_RUNNER_STATE_DIR` | `MYRMIDON_RUNNER_STATE_DIR` |
| `PAPERCLIP_RUNTIME_API_URL` | `MYRMIDON_RUNTIME_API_URL` |
| `PAPERCLIP_RUNTIME_TOOLS_TOKEN` | `MYRMIDON_RUNTIME_TOOLS_TOKEN` |
| `PAPERCLIP_RUN_ID` | `MYRMIDON_RUN_ID` |
| `PAPERCLIP_RUN_SCRATCH_DIR` | `MYRMIDON_RUN_SCRATCH_DIR` |
| `PAPERCLIP_SECRETS_AWS_DELETE_RECOVERY_DAYS` | `MYRMIDON_SECRETS_AWS_DELETE_RECOVERY_DAYS` |
| `PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID` | `MYRMIDON_SECRETS_AWS_DEPLOYMENT_ID` |
| `PAPERCLIP_SECRETS_AWS_ENDPOINT` | `MYRMIDON_SECRETS_AWS_ENDPOINT` |
| `PAPERCLIP_SECRETS_AWS_ENVIRONMENT` | `MYRMIDON_SECRETS_AWS_ENVIRONMENT` |
| `PAPERCLIP_SECRETS_AWS_KMS_KEY_ID` | `MYRMIDON_SECRETS_AWS_KMS_KEY_ID` |
| `PAPERCLIP_SECRETS_AWS_PREFIX` | `MYRMIDON_SECRETS_AWS_PREFIX` |
| `PAPERCLIP_SECRETS_AWS_PROVIDER_OWNER` | `MYRMIDON_SECRETS_AWS_PROVIDER_OWNER` |
| `PAPERCLIP_SECRETS_AWS_REGION` | `MYRMIDON_SECRETS_AWS_REGION` |
| `PAPERCLIP_SECRETS_MASTER_KEY` | `MYRMIDON_SECRETS_MASTER_KEY` |
| `PAPERCLIP_SECRETS_MASTER_KEY_FILE` | `MYRMIDON_SECRETS_MASTER_KEY_FILE` |
| `PAPERCLIP_SECRETS_PROVIDER` | `MYRMIDON_SECRETS_PROVIDER` |
| `PAPERCLIP_SECRETS_STRICT_MODE` | `MYRMIDON_SECRETS_STRICT_MODE` |
| `PAPERCLIP_SEED_EXPECTED_COMPANY_ID` | `MYRMIDON_SEED_EXPECTED_COMPANY_ID` |
| `PAPERCLIP_SERVER_HOST` | `MYRMIDON_SERVER_HOST` |
| `PAPERCLIP_SERVER_PORT` | `MYRMIDON_SERVER_PORT` |
| `PAPERCLIP_SERVICE_MANAGED` | `MYRMIDON_SERVICE_MANAGED` |
| `PAPERCLIP_SHIM_PATH` | `MYRMIDON_SHIM_PATH` |
| `PAPERCLIP_STORAGE_LOCAL_DIR` | `MYRMIDON_STORAGE_LOCAL_DIR` |
| `PAPERCLIP_STORAGE_PROVIDER` | `MYRMIDON_STORAGE_PROVIDER` |
| `PAPERCLIP_STORAGE_S3_BUCKET` | `MYRMIDON_STORAGE_S3_BUCKET` |
| `PAPERCLIP_STORAGE_S3_ENDPOINT` | `MYRMIDON_STORAGE_S3_ENDPOINT` |
| `PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE` | `MYRMIDON_STORAGE_S3_FORCE_PATH_STYLE` |
| `PAPERCLIP_STORAGE_S3_PREFIX` | `MYRMIDON_STORAGE_S3_PREFIX` |
| `PAPERCLIP_STORAGE_S3_REGION` | `MYRMIDON_STORAGE_S3_REGION` |
| `PAPERCLIP_TAILNET_BIND_HOST` | `MYRMIDON_TAILNET_BIND_HOST` |
| `PAPERCLIP_TAILSCALE_BROKER_SOCKET` | `MYRMIDON_TAILSCALE_BROKER_SOCKET` |
| `PAPERCLIP_TAILSCALE_DNS_NAME` | `MYRMIDON_TAILSCALE_DNS_NAME` |
| `PAPERCLIP_TASK_ID` | `MYRMIDON_TASK_ID` |
| `PAPERCLIP_TEAMS_CATALOG_DEFAULT_ADAPTER_TYPE` | `MYRMIDON_TEAMS_CATALOG_DEFAULT_ADAPTER_TYPE` |
| `PAPERCLIP_TEAMS_CATALOG_DIR` | `MYRMIDON_TEAMS_CATALOG_DIR` |
| `PAPERCLIP_TELEMETRY_BACKEND_TOKEN` | `MYRMIDON_TELEMETRY_BACKEND_TOKEN` |
| `PAPERCLIP_TELEMETRY_BACKEND_URL` | `MYRMIDON_TELEMETRY_BACKEND_URL` |
| `PAPERCLIP_TELEMETRY_DISABLED` | `MYRMIDON_TELEMETRY_DISABLED` |
| `PAPERCLIP_TELEMETRY_ENDPOINT` | `MYRMIDON_TELEMETRY_ENDPOINT` |
| `PAPERCLIP_TEST_CONNECTION_DELIVERY_HOLD` | `MYRMIDON_TEST_CONNECTION_DELIVERY_HOLD` |
| `PAPERCLIP_TEST_POSTGRES_RESERVED_PORTS` | `MYRMIDON_TEST_POSTGRES_RESERVED_PORTS` |
| `PAPERCLIP_TOKEN_BROKER_ALLOWED_HOSTS` | `MYRMIDON_TOKEN_BROKER_ALLOWED_HOSTS` |
| `PAPERCLIP_TOOL_ACTION_SIGNING_SECRET` | `MYRMIDON_TOOL_ACTION_SIGNING_SECRET` |
| `PAPERCLIP_TOOL_OAUTH_CLIENT_ID` | `MYRMIDON_TOOL_OAUTH_CLIENT_ID` |
| `PAPERCLIP_TOOL_OAUTH_CLIENT_SECRET` | `MYRMIDON_TOOL_OAUTH_CLIENT_SECRET` |
| `PAPERCLIP_TOOL_RUNTIME_TRUSTED_HOST` | `MYRMIDON_TOOL_RUNTIME_TRUSTED_HOST` |
| `PAPERCLIP_TRUSTED_MCP_RUNTIME_HOST` | `MYRMIDON_TRUSTED_MCP_RUNTIME_HOST` |
| `PAPERCLIP_UI_DEV_MIDDLEWARE` | `MYRMIDON_UI_DEV_MIDDLEWARE` |
| `PAPERCLIP_UPDATE_CHECK` | `MYRMIDON_UPDATE_CHECK` |
| `PAPERCLIP_UPDATE_CHECK_URL` | `MYRMIDON_UPDATE_CHECK_URL` |
| `PAPERCLIP_VITE_CACHE_DIR` | `MYRMIDON_VITE_CACHE_DIR` |
| `PAPERCLIP_VITE_HMR_PROTOCOL` | `MYRMIDON_VITE_HMR_PROTOCOL` |
| `PAPERCLIP_WORKSPACE_BASE_CWD` | `MYRMIDON_WORKSPACE_BASE_CWD` |
| `PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS` | `MYRMIDON_WORKSPACE_REAPER_COOLDOWN_DAYS` |
| `PAPERCLIP_WORKTREES_DIR` | `MYRMIDON_WORKTREES_DIR` |
| `PAPERCLIP_WORKTREE_START_POINT` | `MYRMIDON_WORKTREE_START_POINT` |
(address, key secret, model) is unnamed.

The PATCH accepts only `enabled`, `backend`, `model`, `language`, `diarization` and
`maxDurationSec` (a strict schema, an unknown field answers 400); `model: null`
clears the stored model back to the environment default. Every successful PATCH is
journaled as `myrmidon.stt.settings_saved`. The GET answers the effective settings
with the key secret's **name**, never its value, plus a `problem` object naming the
stable reason the path cannot serve yet; `problem` is `null` when the path is
ready.

The stable `transcribeAudio` error codes: `stt_disabled` (the path is off),
`stt_unconfigured` (the contour — address, key secret, model — is unnamed),
`audio_too_long` / `audio_too_large` (a limit answered before any outbound
request), `stt_timeout` (the backend call timed out), `stt_upstream_error`
(any other backend failure).

The container-bot side of the track — the media-mcp tools `audio_split` /
`stt_transcribe` and their `MEDIA_STT_*` service settings — is documented in
[media-tools.md](media-tools.md) («Speech-to-text»).
