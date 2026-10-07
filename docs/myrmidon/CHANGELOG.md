# Myrmidon changelog

> Russian version: [CHANGELOG.ru.md](CHANGELOG.ru.md)

Release notes for Myrmidon, newest first. The version comes from the git tag
`myr-v<major>.<minor>.<patch>` (CI stamps it into the image and `/api/health`); there is no
version file to edit. Base Paperclip version is in the image label
`io.github.itkadr-git.myrmidon.base.paperclip-version`. Details of the release procedure:
[ci.md](ci.md) and [deploy.md](deploy.md).

## Unreleased

## 1.6.5

### Central session history for gateway bots (MEMORY-CENTRAL-B)

- With `MYRMIDON_BOT_CENTRAL_HISTORY=1` (off by default) the Hermes gateway
  adapter saves the final output of every completed run as a session-turn record
  in the bot's own hindsight bank (documents keyed by the session key, tag
  `myrmidon-session-history`) and on the next wake of the same session restores
  the last turns (default 20, card field `centralHistoryMaxTurns`) into the wake
  input under a visible "restored conversation history" header. Recreating the
  container volume no longer loses the history.
- Store address, bank and key resolve in order (first hit wins): card fields
  `adapterConfig.centralHistoryUrl` / `centralHistoryBankId` /
  `centralHistoryApiKey` / `centralHistoryMaxTurns`; then
  `MYRMIDON_BOT_HINDSIGHT_API_URL` / `MYRMIDON_BOT_HINDSIGHT_BANK` /
  `MYRMIDON_HINDSIGHT_API_URL` / `HINDSIGHT_API_KEY`; then the same names in the
  server environment. The bank defaults to the card's `hindsight.bankId`.
- Off or unconfigured, vendor behaviour is untouched. While on, a store failure
  never blocks a run (a failed read continues without the restored block, a
  failed save is logged). Only the redacted final output is stored, and the
  restored block is bounded by turn count and size.
- New: `packages/adapters/hermes/src/gateway/server/central-history.ts` and its
  suite; `execute.ts` gains three marked call sites.

### Build offload C: dev-variant bot containers get DEVBUILD env and the build-server ssh key (BUILD-OFFLOAD C)

- New board settings `MYRMIDON_DEVBUILD_HOST` / `MYRMIDON_DEVBUILD_USER`
  (default `devbuild`) / `MYRMIDON_DEVBUILD_BASE` (default `/srv/devbuild`).
  When HOST is set, every NEW dev-variant bot container (`myrmidon-hermes-dev`
  images, detected by the image reference's last segment) receives
  `DEVBUILD_HOST`/`DEVBUILD_USER`/`DEVBUILD_BASE` in its container env — an
  internal hostname and paths, not secrets — plus a read-only mount of the
  build server's ssh key at `/opt/devbuild-ssh`; the key's host directory is
  taken from `MYRMIDON_BOT_MOUNT_SOURCES` (an entry ending in `devbuild-ssh`).
  The create body always carries `Env` (`[]` when the feature is off).
- The mount point `/opt/devbuild-ssh` is added to `RESERVED_CONTAINER_PATHS`:
  a card's own `extraMounts` cannot take it over. Secrets never travel in the
  container `Env` — docker inspect would disclose them; keys travel as files.
- dockergate learned the `Env` list of the bot create body: empty or exactly
  the three `DEVBUILD_*` entries in builder order, anything else is denied
  (`deny.JSONUnknownKey`/`deny.JSONValue`); contract fixtures regenerated.

### Flag-only guardrail detectors for run output (1.6-GRD, part A)

- New `guardrail_events` journal (migration 0311) plus a board-only read route:
  the secret/pii detectors fire on run output and record a flag-only event.
  The stored snippet has every detected secret/PII fragment replaced by a
  `[REDACTED:<subtype>]` placeholder (also in the activity log), is at most
  200 characters, and a run journals at most 20 events. Deleting a company
  removes its events; deleting a run keeps them with an empty run. Off by default; enabled per instance
  with `MYRMIDON_GUARDRAILS_OUTPUT_ENABLED=1`, detector subset with
  `MYRMIDON_GUARDRAILS_OUTPUT_CATEGORIES` (csv of `secret,pii`).

### Model-provider registry syncs with the LiteLLM gateway (MODEL-PROVIDERS B)

- Part B of the model-providers epic: the enabled models of the company
  provider registry (part A) now propagate to the LLM gateway. At startup each
  company whose store holds the gateway admin key registers its enabled models
  in LiteLLM, reclaims stale registrations of its own provider credentials and
  re-applies the model allowlist of every agent gateway key; the
  enable/disable, key-rotation and provider-removal routes then propagate the
  same changes live. The gateway is configured with the single documented pair
  `MYRMIDON_LITELLM_BASE_URL` + `MYRMIDON_LITELLM_ADMIN_KEY_SECRET` — the
  latter is the NAME of a company secret, the board authenticates with the
  resolved VALUE, and either unset keeps sync fully off (one skip line at
  startup, the provider routes behave exactly as part A). Requirement: the
  gateway runs with `STORE_MODEL_IN_DB=true` — model registrations reference
  provider credentials as `secrets/<name>`, which that mode resolves in the
  gateway's own store.
- A gateway failure during a live propagation answers 422
  `litellm_sync_failed`: the database state stays the source of truth and the
  gateway converges on the next mutation pass or the startup reconciliation.

### Agent pause by grant (ADMIN-AGENT D)

- `POST /agents/:id/pause` now authorizes agent actors through the same
  direct-grant ladder as resume: an agent holding `agents:configure` may
  pause an agent of its company, while `agents:suggest-changes` and
  ungranted peers stay denied. Board actors keep the previous semantics
  unchanged, and the pause activity entry now records the real acting
  principal (agent, run, API key) instead of a board placeholder.
  Drain-vs-cancel semantics are untouched.

### Wake resurrection for rejected wakeups (WAKE-STALL-ROOT A)

- A wakeup rejected by the board with `execution_reconciliation_required`
  is executed once after the execution reconciliation finishes (one bounded
  retry) instead of being lost. Adds `resurrectionCount` to
  `agent_wakeup_requests` (migration 0303); the rerun carries a fresh
  idempotency key and an incremented resurrection counter, at most one retry
  per wakeup, and no retry when `evidence.automaticRecovery.replay="blocked"`.

### 1.6.3 PROMPT-BUDGET B: prompt-size thresholds and over-threshold signals (OPE-4806)

- Live company settings `instance_settings.general.promptBudget`
  (`warnPct` / `critPct` / `enabled` / `fallbackWindowTokens`), edited on the
  Instance → General "Prompt budget" panel without a restart.
- Attention feed: one card per agent whose last run's prompt crosses the
  threshold (`sourceKind prompt_budget_alert`, warn → medium, crit → high);
  the detail names the top-3 prompt parts, the window and the crossed level.
- Agent card (Overview): "Prompt budget" section with the window share, totals
  and the per-part breakdown of the last run.
- API: `GET/PUT /api/myrmidon/companies/:companyId/prompt-budget/settings`,
  `GET .../prompt-budget/status`.

### The company agent list ships without adapter_config (PERF-DIET G2)

- `GET /api/companies/:companyId/agents` no longer returns `adapterConfig`:
  the heavy, secret-bearing column is not read at all for this response —
  the list selects a narrow projection and extracts the model in SQL into a
  new `adapterModel` field. The full configuration stays available through
  `GET /agents/:id`, `GET /agents/:id/configuration` and
  `GET /companies/:companyId/agent-configurations`; access rules and spend
  hydration are unchanged; an actor without `agent_config:read` gets the
  restricted list view with `runtimeConfig` and `adapterModel` blanked.
- The board UI follows: the agents list renders its model column from
  `adapterModel`; the new-issue dialog and the properties pane read the
  assignee's configuration on demand; Settings → Secrets reads the
  configuration endpoint.
- `paperclipai secrets migrate-inline-env` and the bot-image rollout follow
  on the same footing (the rollout reads bot cards from the
  agent-configurations endpoint; its fake-board test pins this).

### Autonomy matrix enforced in the tool gateway (1.6 AUTONOMY-MATRIX, gateway half)

- Before an agent's tool call is executed, the tool gateway maps the tool
  onto an action class by name and resolves the matrix verdict for the
  agent's role — at the point of action, before the access policy and before
  any provider dispatch. A `forbidden` verdict refuses the call with 403
  `autonomy_forbidden` (the upstream is never called); `approval_required`
  parks the call in the existing `tool_action_requests` holding conveyor
  (409 `approval_required`, an approval card, execution after approval via
  `approvedActionRequestId`); `allowed` and every non-agent caller pass to
  the ordinary policy path unchanged. A tool with no action class is not
  governed by the matrix.
- The tool → action-class mapping is configurable per instance without a
  restart: stored settings (`instance_settings.general.myrmidonAutonomyToolMapping`)
  win, then the `MYRMIDON_TOOL_AUTONOMY_MAPPING_JSON` env override, then the
  built-in defaults (the three classes of the design — merge / deploy /
  external_message — with their common tool-name patterns). Operator guide:
  [guides/autonomy-matrix-tool-gateway.md](guides/autonomy-matrix-tool-gateway.md).

### The hermes_gateway adapter sends the task workspace in the run request (1.6.5 BOT-DISK-H, part H5a)

- A run of a task that has a repository now carries a `workspace` field in the
  `POST /v1/runs` body: `{key, repo, baseRef}` — the issue identifier, the
  project's repository as `owner/name` and the workspace ref (omitted when the
  workspace has none). The gateway uses it to open the task copy before the
  model starts.
- A task without a repository, or without a board identifier, sends no field.
  A `workspace` written into the card's `payloadTemplate` is overwritten, like
  `github_broker`: a card cannot forge it.

### A broken nested `.git` is not a repository: archived as files, the closed task directory goes (1.6.5 BOT-DISK-H)

- `archive-remove` of a closed task directory failed with `archive-incomplete: nested repository repo: bundle create failed: fatal: Need a repository to create a bundle` when a `.git` directory inside it was hollowed out by an old cleanup. botd now treats a `.git` that fails `git rev-parse --git-dir` as no repository: no bundle or patch is made, its files (without `.git`) go into the parent's `dir.tar`, and the directory is removed once the tar is verified. A real repository whose bundle fails is still kept.

### Board answers a bot's desired-state poll from a 5-minute cache (1.6.5 BOT-DISK-H LOAD)

- `GET /api/myrmidon/bots/me/workspaces` is polled ~30 times a minute across the
  fleet and every answer used to run the full store pass for the bot (assigned +
  reassigned issues, PR work products, project repo urls, settings). The service
  now caches the built desired state per bot (`companyId + agentId`) in process
  memory for 300 s — the same window as `nextReportSec` the bot is told to
  honor — so a bot costs the board at most one store pass per window. The route
  still serializes every reply (cached value included) through
  `wsDesiredStateSchema`.
- Event invalidation (review fix): TTL alone is not enough. When an issue's
  `status` or `assigneeAgentId` changes, the issue route drops the cached
  desired-state entries of the previous and the next assignee through a
  process-local registry (`bot-workspaces-invalidation.ts`), so the next poll
  rebuilds from the store: a reopened task is back in `protectKeys` at once
  (botd would otherwise archive-delete its directory mid-work), and a
  reassigned task moves between the bots' caches immediately.
- The `enabled` switch is read on every request, uncached: turning the
  mechanism off acts immediately, the reaper stops at the next poll.
- A failed build is not cached; the next request retries. Concurrent pollers
  of one bot collapse into a single store pass.
- `POST /api/myrmidon/bots/me/disk-report` verified to hold no DB await and no
  heavy work beyond validation plus the in-memory map write; no change needed.

### botd no longer deletes a repository with unsaved work while the bot has a live run (1.6.5 BOT-DISK-H)

- botd archived and removed `/scratch/repo` of a developer bot with 135 uncommitted edits during a run: any pressure level cut the scratch term to 1 hour and the run's state was never checked. Now a git directory with unsaved work (dirty or not pushed) in `/scratch` or `/workspace` is kept while a run is live, and when the run state is unknown (fail-closed); it is listed in the report as held (`unsafe-git-live-run`, `unsafe-git-run-unknown`). Pressure no longer shortens its term: it is archived and removed only without a run and after the full `scratchTtlHours` (24 h) of idle time. A run is live when the board lists an active task, a process of the container works under `/workspace` or `/scratch`, or a run woke the bot (SIGUSR1) in the last 30 minutes; for 30 minutes after botd starts the state is unknown. Clean and pushed copies and non-git data behave as before.

### botd paces its tick by the board's nextReportSec; errors back off exponentially (1.6.5 BOT-DISK-H LOAD)

- The fleet hammered the board with ~189 disk reports per five minutes instead
  of ~72: the loop paused on `min(intervalMs, nextReportSec)`, so the default
  60 s interval clamped the board's 300 s cadence and every tick re-polled
  desired-state. The pause after a successful pass is now the board's
  `nextReportSec` (floored 10 s, capped 1 h) stretched by one-sided 0..+10 %
  jitter — never shorter, so "not more often than once per nextReportSec"
  holds for both the disk report and the desired-state poll. `intervalMs` is
  only the initial value until the first accepted report.
- A failed pass (report rejected or desired-state poll failed) no longer keeps
  the flat cadence: the wait grows exponentially, `intervalMs * 2^k` over the
  consecutive failed passes, floor 10 s, cap 1 h, ±10 % jitter so the fleet
  does not resynchronise; the first success resets the streak and returns to
  the board's cadence.
- SIGUSR1 (a run woke the bot) stays an immediate trigger: it cancels the
  pending pause and is not bound by the pacing; the desired poll inside a pass
  remains single-flight.
- The desired-state client's own `start()` timer default moved from 60 s to
  300 s. botd never runs it — the entry wires `poll()` through the main loop
  only — but an autonomous `start()` can no longer add a parallel 60 s poll.

### The workspace mechanism reaches every bot and every task (1.6.5 BOT-DISK-H, rc.8: parts H4b/H5d)

- New instance setting `general.botDisk.defaultRepo` (`owner/repo`, empty by default;
  `PATCH /api/myrmidon/bot-disk` accepts `""`/`null` to clear it). It is the last-resort
  repository of a task: the run's `workspace` field and the desired state of the bot
  workspaces (`GET /api/myrmidon/bots/me/workspaces`) take the repository from the task's
  project, then from its latest pull request, then from `defaultRepo`. A task with no
  repository at all works as before, in `/scratch`, with the warning. Most dev tasks have
  neither a project nor a pull request, so without it the board never asked a bot for a
  working copy and every clone landed in `/scratch` (class G, 24 h TTL).
- botd learns its own key: the board writes `MYRMIDON_BOT_KEY=<bot id>` into the bot's
  `.env` (an id, not a secret), so a report that does not carry `botKey` is accepted under
  the caller's key (a body naming another bot is still 403). Until the bot's profile is
  re-applied after the update, its reports are refused as before.
- Disk pressure reaches the bots: the desired state's `pressure` is built from the measured
  partition (`soft` from `partitionThresholdPercent`, `hard` from
  `partitionRefuseOpenPercent`), not the constant `none`; `disk-state.json` and
  `myr-ws open` follow it.
- botd also takes the directories that already lie on the disk: copies that predate the
  mechanism (class X, kept in `/workspace/<KEY>` outside the registry) are archived when
  they hold unpushed work and removed under the same TTL/grace and the same live-task
  protection as scratch copies; their age ignores `.git` activity (a background fetch no
  longer resets the TTL).
- The workspace mechanism — the git wrapper, `myr-ws`, `botd` and Node 24 for them — is
  built into the base `runtime` stage of `docker/bot-runtime/Dockerfile`, so the default
  image and the Node.js variant carry it too, not only the development variant. A bot of
  any variant can now report to the board and have its old copies reaped.

### botd plans with a Date clock; the bot partition is measured over the dockergate socket (1.6.5 BOT-DISK-H, rc.9)

- botd deleted nothing on the production host: the loop handed the rules a
  `Date` as the clock, the rules only accepted a number or a string, read it as
  "no time" and returned an empty plan without a word. The rules now accept a
  `Date` (finite check included) and the loop passes epoch milliseconds.
- The host-disk sweep never measured the bot partition on a host where
  dockergate listens on a unix socket only: the client was built only from
  `MYRMIDON_DOCKERGATE_URL` (TCP), so the pressure stayed `0 / none` and the
  log said "host disk usage could not be read" every five minutes. The sweep
  now takes its client from the same socket the docker driver uses
  (`MYRMIDON_BOT_DOCKER_SOCKET`); the TCP client is built only when
  `MYRMIDON_DOCKERGATE_URL` is set and no socket is configured. A failing gate is
  still "not measured", never an error in the sweep.
- Deletion policy under `/workspace` is decided by the board's word about a task key, not by a
  timer. The directory name is normalized to a key (`ope3282v2`, `scratch-ope3213`,
  `.trash-OPE-4331`, `OPE-4915-stale-rootowned` -> `OPE-3282`, ...) and, in this order: the copy of
  an active task is never touched; a key in `protectKeys` (open, assigned to the bot) is kept and
  reported as `legacy-open`; a key in the new `closedKeys` (done/cancelled, no lookback limit) is
  archived and removed after the closing grace; a key the board lists elsewhere (reassigned, in
  review) is kept and reported `legacy-open-elsewhere`; a key-like name the board does not know is
  reported `unknown-key`; a name that is no task (`shared`, `tmp`, `work`, `srv-dev`) is reported
  `non-task`, and removed only when empty or regenerable. Under hard pressure the last three are
  archived after `legacyPressureIdleDays` (default 7; setting `general.botDisk.legacyPressureIdleDays`,
  also in `grace`), except `shared`. A timer applies to `/scratch` only. Without `closedKeys` (an older
  board) nothing under `/workspace` is removed.
- Nested repositories (a `.git` up to three levels below the directory) are seen by the classifier
  and archived one by one (`<KEY>--<relpath>`: bundle, patch, untracked files) before the
  directory is removed, next to a tar of the rest of the tree. A failed, missing or truncated archive
  of any part keeps the whole directory (`archive-incomplete`).
- The botd tick is the board's `nextReportSec` (300 s), clamped to 10 s..1 h. Directories that are
  only held are listed in the report as skipped actions (`legacy-open`, `legacy-open-elsewhere`,
  `unknown-key`, `non-task`).
- `botd --once --plan` is a dry run: it prints the inventory plan as JSON, executes nothing,
  writes no `disk-state.json` and sends no report.
- `general.botDisk.enabled=false` makes `GET /api/myrmidon/bots/me/workspaces` answer 503, which botd
  reads as "no desired state": nothing is removed.
- Operator note: `/cache/pnpm-store` is mounted read-write; the host source
  directory must belong to uid/gid 10001 (documented in the shared package cache
  steps).

### The bot partition threshold is read from the partition's physics (1.6.5 BOT-DISK-H, part H10)

- New instance settings `general.botDisk.partitionThresholdPercent` (85),
  `general.botDisk.partitionRefuseOpenPercent` (90) and
  `general.botDisk.partitionCriticalPercent` (95), validated as an ordered
  triple (85<90<95). Readable and writable without a restart via
  `GET`/`PATCH /api/myrmidon/host-disk/partition` (PATCH is instance-admin
  only); env vars `MYRMIDON_BOT_PARTITION_THRESHOLD_PERCENT`,
  `MYRMIDON_BOT_PARTITION_REFUSE_OPEN_PERCENT`,
  `MYRMIDON_BOT_PARTITION_CRITICAL_PERCENT` are the first-start defaults.
- The host-disk sweep measures the bot partition through dockergate
  `GET /myrmidon/disk` (contract C5) instead of inferring it from the server's
  own `/data`: on 07.10.2026 the partition filled to 100 % while `/data`
  stayed fine. The `host_disk_alert` card counts against the partition from
  the warn threshold and goes critical at the critical threshold. Without
  dockergate data the previous statfs behaviour is unchanged and the
  partition is reported as not measured. Set `MYRMIDON_DOCKERGATE_URL` to the
  dockergate base URL to enable the measurement.
- From the refuse-open threshold the desired state of the bot workspaces
  reports `pressure.level = "hard"` (grace 0): `myr-ws open` refuses new
  copies. The board side of the C3 route is part H1c; H10 exports the
  evaluation (`botPartitionThresholdRuntime`) the route reads.
- At the critical threshold the owner receives a Telegram message through the
  existing owner-cards channel (the telegram-notify outbox), once per
  crossing — the latch re-arms only after the partition drops below the warn
  threshold.

### The bot runtime is mounted read-only from one copy on the host (1.6.5 BOT-DISK-H, part H11)

- New instance setting `general.botDisk.sharedBotRuntimePath`: an absolute host
  directory whose `bin`, `lazy-packages` and `lsp` subdirectories every bot on
  the default host mounts read-only over its own runtime paths — one host copy
  instead of one per bot (5–7 GiB per copy on the production fleet). Unset (the
  default) keeps today's behaviour: every bot has its own copies. Changed on the
  Instance → General page or via `PATCH /api/myrmidon/bot-disk`; the next
  reconcile pass applies it, without a restart.
- The three read-only binds land at the real path inside the bot's own mount:
  `/bot/hermes/{bin,lazy-packages,lsp}` for a single-layout bot,
  `/bot-scope/<botKey>/hermes/…` for a member of a shared isolation scope, and
  `/data/hermes/…` for a contract-`1` (legacy three-bind) image.
- A bot card may mount an allowlisted host directory read-only at a path inside
  the bot's own tree, but only under `/data/hermes/.hermes/shared`,
  `/data/hermes/media` or `/data/hermes/work` (epic design, class J); the board
  binds it at that subtree's real path inside the bot's tree. Every other
  reserved path — the three runtime paths included — is still refused, so a card
  can neither shadow the shared runtime nor write into it.
- dockergate: `botRuntimeRoot` in its configuration (the same path; unset
  accepts no runtime bind) and the class J mount points.

### Parser of `git clone` arguments for the bot git wrapper (1.6.5 BOT-DISK-H, part H1a)

- New pure module `docker/bot-runtime/git-reference/clone-args.js` (no dependencies):
  from the arguments of `git clone` it tells a GitHub repository (https, ssh, scp-like,
  with or without `.git`, with or without a token in the URL) from any other host
  (`kind: "foreign"`, the real git runs) and returns `{kind, owner, repo, dir,
  ignoredFlags, hadUserinfo}`. The URL, the token and option values never enter the
  result. Nothing is wired in yet: the wrapper switches over in part H1c.

### The bot git wrapper turns `git clone` into `myr-ws open` and strips credentials from remote URLs (1.6.5 BOT-DISK-H, part H1b)

- `git clone <GitHub repository> [dir]` (https, ssh, scp-like, with or without a token
  in the URL) no longer clones: the wrapper runs `myr-ws open` (key from
  `MYRMIDON_TASK_WORKSPACE`, otherwise `--scratch <dir name>`), so the copy is a worktree of
  the bot's shared base. `--filter`, `--depth`, `--mirror`, `--bare` and the other
  history options are dropped with a line on stderr. The exit code and stderr of `myr-ws`
  (3 = quota) are passed through. A clone of another host, a missing `myr-ws` or
  `clone-args.js`, or `MYRMIDON_GIT_INTERCEPT=0` keeps the previous behaviour.
  `MYRMIDON_WS_BIN` replaces the `myr-ws` binary.
- `git remote add|set-url` and `git config remote.<name>.url|pushurl` with a credential
  in the URL are rewritten without it. `clone-args.js` is now copied into the image next
  to the wrapper.

### `myr-ws open`: a task copy is a worktree of the bot's base, refused under disk pressure (1.6.5 BOT-DISK-H, part H2b)

- `myr-ws open <KEY> [owner/repo] [--base <ref>] [--scratch <name>] [--json]`
  creates `/workspace/<KEY>` as a git worktree of the bot's class-D base on the
  branch `bot/<KEY>`: the copy has no object store of its own, so it weighs the
  working tree and an index, not a clone. `--scratch <name>` makes
  `/scratch/<name>` (a detached worktree with a repository, an empty directory
  without).
- `open` is idempotent: a registered copy is returned as it is (`reused: true`);
  a branch `bot/<KEY>` left by an earlier copy is reattached, not reset. Every
  new copy is written to `ws-registry.json`.
- Before creating anything `open` reads `disk-state.json`; with `pressure: hard`
  it exits with code 3 and `BOT_DISK_QUOTA_EXCEEDED:` and names the five
  largest registered copies to close. A missing, broken or stale (older than two
  botd ticks) file counts as no pressure. Reusing an existing copy is never
  refused.
- A key must look like `PREFIX-123`, a scratch name may hold only letters,
  digits, `.`, `_`, `-`; anything with `/` or `..` is refused with code 2.

### `devbuild` understands a git worktree copy (1.6.5 BOT-DISK-H, part H2g)

- A task copy opened as a worktree of the bot's bare base has a one-line `.git`
  file (`gitdir: <base>/worktrees/<name>`) instead of a `.git` directory.
  `devbuild` now resolves it (`resolve_git_dir`: plain clone, worktree with an
  absolute or relative gitdir, or neither), ships the bare base (without other
  worktrees' admin directories) and this worktree's admin directory to a
  per-bot place in `/srv/devcache/git-wt/` on the build VPS, and repoints the
  `.git` file and the admin directory's back-reference at the VPS paths, so
  every git command in the synced copy works. Only bases under
  `/data/hermes/.myrmidon/git-base` are shipped; anything else is refused.
- A plain clone, including the `--reference` clone with alternates, is synced
  exactly as before.
- Fixed: a missing `$HERMES_HOME/.env` made `devbuild` exit silently under
  `pipefail`.

### botd deletion rules as a pure function (1.6.5 BOT-DISK-H, part H3b)

- New `docker/bot-runtime/botd/lib/rules.js`: `decide(inventory, desired, now,
  settings)` returns the list of actions (`remove`, `archive-remove`, `prune`,
  `delete-base`, `delete-archive`) for the table of the bot-disk design, section
  2.3. It only returns data; nothing is executed and nothing is read from disk.
- A closing copy goes after the grace period (30 minutes by default): only when
  it is clean and pushed (a merged PR does not relax this) — removed; anything
  else, including unknown (null) facts — archived first. A copy missing from the board's list is treated as closing with
  a 24-hour grace. A copy of an active task is never removed; a vanished
  directory is only pruned.
- Pressure from the board (`soft`) drops the grace to zero, the scratch TTL to
  one hour and archive age to seven days; `hard` does the same and `plan()`
  also returns `blockOpen: true`. A base repository with no worktree for 30 days
  is deleted (never when it holds local branches not on origin or this is unknown), over eight bases the oldest idle one goes, archives expire after
  30 days or past the 2 GiB cap (oldest first).
- The inventory shape (`worktrees`, `scratch`, `bases`, `archives`) is the main
  one; the classifier of #745 maps to it with an adapter. Any other shape yields
  no actions.
- No desired state from the board (error, 401/403/503) deletes nothing.

### botd classifier of foreign copies and scratch (1.6.5 BOT-DISK-H, part H3d)

- New `docker/bot-runtime/botd/lib/classify.js`: walks `/workspace`, `/scratch`
  and `/data/hermes/cache/scratch` and puts every directory into class E (task
  copy), G (scratch) or X (foreign) with a sign: `promisor`, `token`,
  `no-remote`, `trash`, `full-clone`. Output is a list of
  `{path, class, sign, ageSec, sizeBytes}` plus an action per item for the
  lifecycle rules (scratch removed after a 24 h TTL by mtime/ctime; foreign
  copies get a card at once and are held while a task with the same key is
  active; nothing is removed when the board is unreachable).
- Repositories are read as text (`.git/config`), never through git, because a
  repository's own config can name programs git would run. A credential in a
  remote URL is only ever reported as the flag `token`; the first pass can
  rewrite `remote.origin.url` without userinfo with `git remote set-url` and
  returns the count.
- `toInventory(items)` adapts the result to the inventory of the deletion rules
  (`worktrees`, `scratch`, `bases`, `archives`, ISO `mtime`). `clean` and
  `pushed` stay `null` (git is never run on a bot's repository), which the rules
  read as "archive before removing". The `action` hints of `classifyAll` are
  advisory; deletion is decided by the rules only.

### The board tells each bot which task copies it should keep (1.6.5 BOT-DISK-H, part H4a)

- New route `GET /api/myrmidon/bots/me/workspaces`, for the bot's own agent key
  only (any other actor gets 403, an anonymous call 401). It answers with the
  desired state of the bot's task copies: `active` for the bot's tasks that are
  not terminal, `closing` for tasks that are done, cancelled, hidden, reassigned
  to someone else, or whose pull request is merged (read from the work products
  that the task PR sync keeps current). A task with one merged and one still
  open pull request stays `active`.
- The repository of a copy is the Repo URL of the task's project workspace, or
  the repository of the task's latest pull request. The `grace` block follows
  `general.botDisk.graceClosingMinutes` / `scratchTtlHours` (defaults 30 min /
  24 h); `pressure` is `none` until a dockergate snapshot is wired in.
- The lifecycle rule is a pure function (`workspaceStateOf`), the answer is
  checked against the C3 schema from `@paperclipai/shared` before it is sent.

### The board receives the disk report of every bot (1.6.5 BOT-DISK-H, part H4b)

- New route `POST /api/myrmidon/bots/me/disk-report`, for the bot's own agent key
  only (any other actor gets 403, an anonymous call 401). The body is checked
  against the C4 schema from `@paperclipai/shared`: a broken body is 400 and the
  previous report stays, a body over 1 MiB is 413, a report that names another
  bot is 403. The answer is `{ok, nextReportSec}` (300 s).
- The last report of each bot is kept in memory with its receive time, the same
  way the in-container clone report is; `readBotDiskReports()` hands them to the
  Attention cards and the panel. The clone report path is unchanged.

### Attention cards for the bot-disk lifecycle (1.6.5 BOT-DISK-H4c)

- New cards on the attention queue, computed from the bots' disk reports:
  `agent-silent` (a running bot container that has reported before and whose
  last report is older than 30 minutes; a bot that never reported raises none), `drift` (the copy of a closed task is alive longer than the
  grace plus 15 minutes, with the reason from the report), `foreign` (a copy
  outside the managed layout, raised at once with path and sign).
- `bot_disk_archive` sits on the task while its archive of unpushed work can be
  restored and disappears on restore or after 30 days; `bot_image_stale` is raised
  for a bot whose image generation has not been current for over 24 hours.
- Card wording never carries remote URLs, tokens or e-mail addresses from a report,
  including bot-supplied paths and task keys.

### A run's `workspace` field opens the task copy before the model starts (1.6.5 BOT-DISK-H5b)

- The bot runtime's gateway patch `10-run-workspace-open.patch` makes `/v1/runs`
  accept an optional `workspace` field (`{"key", "repo", "baseRef"?}`). Before the
  model starts the gateway runs `myr-ws open <key> <repo> [--base <ref>] --json`
  (120 s limit) and starts the run in the opened copy: it becomes the run's
  working directory and `MYRMIDON_TASK_WORKSPACE` for its terminal commands.
- Exit codes 3, 4 and 5 (quota refusal, base limit, network) never fail the run
  silently: it starts in `/scratch` and the run's event stream carries a
  `run.workspace_fallback` warning. Any other failure fails the run loudly.
- A run without the field behaves as before, and its commands never inherit
  another run's workspace path.

### One pnpm store per partition, imported by reflink (1.6.5 BOT-DISK-H, part H8a)

- The pnpm store of the bots with the shared package cache is now ONE directory
  per partition: `<sharedPackageCachePath>/pnpm-store` on the host, bound
  read-write at `/cache/pnpm-store` into every bot of `sharedCacheRoles`.
  `npm_config_store_dir` points at it. It replaces the per-bot
  `/workspace/.pnpm-store` (eight stores of about 2.4 GiB each on the production
  fleet).
- `npm_config_package_import_method` is `clone` by default: a reflink, the copy
  shares the store's blocks and a write to a file in `node_modules` never reaches
  the store. Strictly `clone`: `clone-or-copy` and `hardlink` are refused by
  `PATCH /api/myrmidon/bot-disk` with a message, because pnpm copies silently
  where a reflink is refused.
- Values stored by an earlier release read as today's: `pnpmStoreDir`
  `/workspace/.pnpm-store` as `/cache/pnpm-store`, `pnpmImportMethod`
  `hardlink` or `clone-or-copy` as `clone`. Each migration is logged as a
  warning, as is a store inside a bot's own tree (a store per bot, not shared).
- dockergate: the `pnpm-store` pair joins the writable package cache mounts.
  Update dockergate BEFORE the board, otherwise the create of a bot with the
  shared cache is refused with `mount_source_not_allowed`.

### Bot containers prove at start that pnpm can reflink (1.6.5 BOT-DISK-H, part H8b)

- The container entrypoint replaces the hard-link self-check with a reflink
  self-check: a probe file in the pnpm store is copied with
  `cp --reflink=always` into `/workspace`, `/scratch` and `/data/hermes`. The
  result goes to `${HERMES_HOME}/.myrmidon/reflink-check.json` (the old
  hardlink-check.json format plus `method: "reflink"`). A refusal (EXDEV,
  EOPNOTSUPP) logs an ERROR and raises the `bot_disk_lifecycle/reflink`
  Attention key; the gateway still starts.
- The image CI check is `pnpm-reflink-check.sh`: it installs a fixture package
  offline from every clone root and reports whether the file shares physical
  extents with the store (`filefrag`). A store on another superblock is a
  silent copy; the negative test proves the check sees it, and is skipped with
  its reason where the runner cannot make a second filesystem.

### The board enforces bot disk quotas through dockergate (1.6.5 BOT-DISK-H, part H9c)

- The bot disk quota sweep now puts the quota it resolves (card, per-agent,
  per-caste, default) as the hard xfs project limit of the bot
  (`PUT /myrmidon/disk/<botKey>/quota` of dockergate), once per change: a quota
  already in force or already applied is not sent again, and a refused PUT is
  retried only after the remeasure interval.
- Usage for the 80 % / 100 % `bot_disk_quota` signals and for the clone admission
  check is the physical figure of `GET /myrmidon/disk`. When quotas are not
  enabled on the bot partition, or dockergate does not answer, the previous du
  walk is the estimate and the signal says so (`usageSource: "estimate"`).
- An unreachable or off-contract dockergate never fails a sweep tick.

### One uv cache per partition, imported by reflink (1.6.5 BOT-DISK-UV, part A)

- The uv cache of the bots with the shared package cache is now ONE directory
  per partition: `<sharedPackageCachePath>/uv` on the host, bound read-write at
  `/cache/uv` into every bot of `sharedCacheRoles`. `UV_CACHE_DIR` points at it,
  `UV_LINK_MODE` is written next to it; both land in the profile's `hermes/.env`
  and win over the card's value (the dropped card value is logged as a warning,
  like the other cache variables).
- `UV_LINK_MODE` is `clone` by default: a reflink on a copy-on-write filesystem.
  `clone`, `hardlink` and `copy` are accepted. `symlink` is refused by
  `PATCH /api/myrmidon/bot-disk` with a message: environments reached through
  symlinks in the shared cache break bot isolation. Unlike pnpm, `hardlink` is
  allowed — it is a documented uv value, and uv itself fails loudly with an
  EXDEV error when a hard link cannot cross the bind; uv's own
  clone→hardlink→copy fallback (logged in the bot) is accepted, so there is no
  `clone-or-copy` analog and no separate ban.
- A cache inside a bot's own tree (`/workspace`, `/data`, `/scratch`, `/bot`) is
  accepted with a warning — it is a cache per bot, counted against the quota,
  not a shared one. Any other path is refused. This is a new feature: nothing to
  migrate, a stored profile without the keys reads as today's defaults.
- dockergate: the `uv` pair joins the writable package cache mounts. Update
  dockergate BEFORE the board, otherwise the create of a bot with the shared
  cache is refused with `mount_source_not_allowed`.

### Bot containers prove at start that the shared uv cache can clone (1.6.5 BOT-DISK-UV, part B)

- The container entrypoint runs a uv cache self-check at every start: a probe
  file in `UV_CACHE_DIR` is copied with `cp --reflink=always` into
  `/data/hermes`, `/workspace` and `/scratch`; where `filefrag` is available
  the result is confirmed by shared physical extents. For `UV_LINK_MODE=hardlink`
  the probe checks the inode instead (`stat -c %i`), because a hard link is the
  success case there and a reflink proof would report the opposite.
- The result goes to `${HERMES_HOME}/.myrmidon/uv-cache-check.json`
  (`method` = the uv link mode, same shape as reflink-check.json: `version`,
  `checkedAt`, `cache`, `ok`, `roots[]`). A refusal or a silent full copy logs
  an ERROR and does not stop the gateway: a bot with a broken shared cache
  works, it just wastes space and traffic (same logic as the pnpm check).
- The check is gated by `MYRMIDON_UV_CHECK` (the entrypoint reads it from the
  bot's `hermes/.env` first, then the process environment; default `1`) and
  its roots by `MYRMIDON_UV_CHECK_ROOTS`. The cache keys
  (`general.botDisk.uvCacheDir`, `general.botDisk.uvLinkMode`) are documented
  by part A.

### The bot image rollout script follows the async "Apply now" (BOT-IMAGE-ROLLOUT)

- Since 1.6.5 `POST /api/myrmidon/agents/:id/bot-container/apply` answers 202
  with `{applyId, status}`. `bot-image-rollout.sh` read `.outcome.kind` from that
  answer, found none and reported every bot as FAILED while the containers were
  switching in the background (the rc.12 rollout, 08.10).
- Now the script polls `GET .../bot-container/apply/:applyId` until
  `succeeded|failed` (at most `MYRMIDON_BOT_IMAGE_ROLLOUT_APPLY_WAIT_SEC`,
  default 300, every `MYRMIDON_BOT_IMAGE_ROLLOUT_APPLY_POLL_SEC`, default 4).
  `failed` fails the bot with the job's error in the journal; a timeout is
  "deferred" (the sweep finishes it). The bots of a batch are therefore switched
  one after another again.
- `succeeded` is not taken as proof (a busy bot's deferred pass is recorded as
  succeeded): the bot counts as switched only when
  `GET .../bot-container/status` shows the container running on the release
  image, otherwise it is deferred and retried. The old synchronous answer
  (`outcome.kind`) is still understood.
- A POST `apply` refused with 409 (`bot_container_not_applicable`: the agent
  went running between the status read and the apply) is deferred, not failed.
- A failed or deferred bot never interrupts the run: the loop reaches every
  remaining bot, the end-of-run line is `WARNING` when bots stayed deferred
  and `DEGRADED` only when at least one actually failed.

### Deferred bot image rollout applies itself when the bot frees up (BOT-ROLLOUT, part C)

- A bot busy when its image rollout arrived (running turn, owner in chat, or
  someone else's maintenance window) no longer waits for the next deploy: the
  reconcile pass records the deferral in the `myrmidonBotRolloutDeferred` key of
  `instance_settings.general` (row-locked like the maintenance and canary keys)
  and a watcher in the same 60-second sweep retries the recorded bots.
- A retry goes out once the bot reports no running work, through the regular
  `applyBotContainerNow` (same per-bot lock, fresh card read); on success the
  record is removed.
- A bot busy longer than `MYRMIDON_BOT_ROLLOUT_DEFERRED_MAX_WAIT_SEC` (default
  3600) is retried without the busy gate: the reconciler opens the maintenance
  window, drains the in-flight run (runs are never interrupted, OPE-3638) and
  switches the container after the current turn.
- A record not converged within 4x the max wait is retired: dropped and logged
  to the reconcile log and the audit feed (`myrmidon.bot_rollout.deferred_retired`).

### Idle-skip measurement and prompt cache by answer cost (1.2-COST-CACHING)

- `MYRMIDON_IDLE_SKIP_METRICS` (off by default) counts every skipped empty timer wake and the model calls it saved, and logs the running totals.
- `MYRMIDON_PROMPT_CACHE_MIN_COST` (unset = off) lets a timer wake with an identical context snapshot reuse the previous finished run's recorded answer when that answer cost at least the threshold. Cheap answers are always recomputed. The skipped wake names the source run.

### docs: custom castes (CUSTOM-CASTES A) — the company agent-role directory

- A new guide (EN+RU) describing the agent_castes directory: the fields of a caste, the twelve seeded built-ins, the REST contract under /api/myrmidon/companies/:id/castes including the DELETE reassignTo flow, and live reads with no restart.
- The stale 'until part A lands' wording in the CUSTOM-CASTES B section of SETTINGS.md/SETTINGS.ru.md is corrected (part A is in; the directory section itself comes from the 1-6-1-custom-castes-a fragment). The guides table points at the new guide, and the wiki settings page mentions the Agent castes screen.

### Snapshots and audit reports of the board's own database (1.6.5 DBC-4)

- Storage optimisation becomes a board function: the module
  `server/src/myrmidon/datastore-care/` collects one snapshot an hour of the
  datastore it runs on — total size (`pg_database_size`), per-table and TOAST
  bytes, index bytes, the heaviest `pg_stat_statements` queries, the settings
  the audit criteria watch, the age of the last backup — and keeps both
  snapshots and audit reports for 90 days of its own.
- Two myrmidon-owned tables, `datastore_snapshots` and
  `datastore_audit_reports` (migration
  `packages/db/src/migrations/0310_datastore_care.sql`, additive only), plus
  the granularity the module reports on: per-table bytes, transitions and the
  growth between neighbouring snapshots.
- `GET /api/myrmidon/datastores` answers the targets with their live size and
  the newest snapshot; `POST /api/myrmidon/datastores/:key/snapshots` takes an
  out-of-band snapshot; `POST /api/myrmidon/datastores/:key/audit-reports`
  writes the report of the section-6 criteria as it stands at that moment and
  `GET .../audit-reports/:id/export` returns it as the `db-audit.md` markdown
  (the top-25 queries and every criterion with its measured value).
- The routes are instance-admin only (`assertInstanceAdmin`): the numbers are
  the instance's own — database size, catalog contents, server parameters — so
  a board member of a company has nothing to read there. A snapshot keeps the
  indexes as aggregates (total, unused and their bytes, the largest unused, the
  invalid count) and not as the full list of ~1040 rows: kept hourly over the
  90-day retention that list alone would add ~200 MB per target.
- The collector is parameterised by connection and by `dbId`
  (`pg_database.oid`) from its first day, so DBC-5 only adds targets to the
  same code; the board target is implicit. pgvector and full-text-search
  metrics appear only when the extension is installed. `engine` stays
  `"postgres" | "clickhouse-ro"`.
- The hourly job runs behind the kill switch `MYRMIDON_DATASTORE_CARE_ENABLED`
  (any of `0/false/off/no/disabled` turns it off); no rules and no automatic
  actions are attached to the numbers collected — the module only measures and
  reports.
- The release gate `scripts/myrmidon/release/db-audit-gate.sh` turns one audit
  report into a release decision. For 1.6.5 it runs in **warning** mode:
  findings are printed and the release is not blocked; the next release runs
  the same script with `--mode block`, and `--strict` also fails on warnings.
- The 1.6.5 audit itself ships with the release:
  `docs/myrmidon/releases/1.6.5-db-audit.md` (the path the release checklist
  names for every final tag) carries the sizes slice, the criteria with their
  measured values, every adopted change with its effect, and the "after"
  slice to be taken on the live database; `releases/1.6.5/db-audit.md` is the
  short entry point that points at it.

### Migration 0380 removes the historical executionContinuation duplicates from run snapshots

- `heartbeat_runs.context_snapshot` keeps one copy of the `executionContinuation`
  envelope: the top-level key. Rows written before the single-copy writer also
  carry a nested duplicate in `paperclipWake.executionContinuation`. Migration
  `0380` removes the nested duplicate in primary-key batches of 200 rows. A row
  that has the envelope only in the nested place (written by an external adapter
  under the old contract) gets it lifted to the top level first, so the read
  path keeps seeing it. A second run changes nothing. The migration is heavy on
  the production database: apply it in a maintenance window.

### The host-disk sweep measures the real mounted path and stops spamming when it cannot (1.6.5 F-03)

- `MYRMIDON_HOST_DISK_DATA_ROOT` points the sweep at the directory that is
  actually mounted into the server container (default `/data`). When the
  path is missing the sweep result switches to `state: "unmeasured"` with a
  `measuredPath: null` and an `error` text that names the missing path and
  the setting to fix — instead of one `host disk usage could not be read`
  log line per tick.
- The transition into `unmeasured` is logged once at error level; further
  failed ticks are debug, with the error repeated at most once an hour. When
  the path appears, the measurement resumes without a restart and one info
  line records the recovery.
- Every path in `MYRMIDON_HOST_DISK_CONSUMER_PATHS` is measured on its own
  filesystem (`usedPercent`/`usedBytes`/`totalBytes`/`freeBytes` per path) —
  a consumer can live on a different filesystem than the data root. The main
  result stays the data root; the per-path list is returned as
  `measurements` from `GET /api/myrmidon/host-disk` together with the new
  `state` and `error` fields.
- `post-boot-check.sh` fails red when the host-disk sweep reports
  `measuredPath: null`, so a board that boots blind does not pass the gate.
  `POST_BOOT_CHECK_HOST_DISK=off` disables the check.

### Telegram `/model` and `/think` work for gateway agents (1.6.5-F06-A)

- The gateway adapter (`hermes_gateway`) is allowed for both `/model` and
  `/think`. It compiles the same hermes profile and hands `model`/`effort` to
  the run, so a chat override reaches it the same way it reaches `hermes_local`
  — the note that kept it out ("until the gateway passes a model") was stale.
- For a gateway agent `/model` lists the model catalog of the LLM gateway:
  this agent key's own allowlist when the gateway answers it, the whole catalog
  otherwise, and the reply says which of the two it is. The list is grouped by
  provider family (`dashscope-*`, `zai-*`, `nous-*`), the card's own model and
  its fallbacks stay on top, and the 30-model cap is unchanged.
- Writing a gateway agent's `/model` or `/think` now applies its profile
  without a restart: the reply says the change takes effect from the next
  reply. If the apply fails, the card is restored to its previous value and the
  reply names the reason; with the bot-containers feature off nothing is
  treated as broken — the value stays and the reply says the new profile is not
  applied yet.
- `/think` checks the chosen level against the model's own effort list
  (effort-policy): a level the model does not accept (e.g. `medium` for a GLM
  model) is not written, and the answer names the allowed levels.
- A refusal for an unsupported adapter now names the adapter type and the
  reason, in the language of the chat's user.

### The run journal names the model of a gateway run

- Runs of the Hermes gateway are no longer recorded with `unknown` as their
  model. The adapter now reads the model from the gateway's terminal answer in
  order of trust — the `model` field first, then the LiteLLM route name
  `model_group` (both at the top level and inside `usage`) — and falls back to
  the model the run was configured with when the answer names neither. An empty
  value or the `unknown` sentinel is not treated as a model.

### Attention feed: one query for per-agent prompt-budget runs (1.6.5 F-15 D)

- The Attention feed reads each agent's last run with a measured prompt size
  for the prompt-budget cards. The old code sent one `heartbeat_runs` query
  per agent. On the audited board that was about 84 round trips in a cold
  feed build.
- The feed now fetches all agents in one statement: one lateral top-20 scan
  per agent, joined through a single round trip. The selection rules — scan
  window, ordering, the fallback from `finished_at` to `started_at`, and the
  "first row with a usable prompt size" pick — did not change. Feed
  composition stays identical.
- Tests: an embedded-Postgres equivalence test seeds 5 agents × 10 runs and
  compares the batched read against the old per-agent loop, row for row; the
  perf test seeds 1 000 runs across 80 agents and fails if the read stops
  being a single statement (100 ms budget) or, when
  `MYRMIDON_PROMPT_BUDGET_PERF=1` is set, exceeds 300 ms on embedded
  Postgres.

### Partial lifecycle index for the attention screen's exhausted-runs query (1.6.5 F-15)

- The attention screen (`server/src/services/attention-exhausted-runs.ts`)
  looks for runs whose bounded retry budget ran out: it filters
  `heartbeat_run_events` by `company_id` + `event_type = 'lifecycle'` +
  `message like 'Bounded retry exhausted%'` before joining the run rows. The
  two non-unique indexes on the table (`company_run`, `company_created`) do not
  carry `event_type`, so the leg read every event row of the whole table — a
  sequential scan, one of the measured legs behind the feed's p50 2.3 s / p95
  4.7 s (OPE-6346 trace).
- Migration `packages/db/src/migrations/0381_attention_exhausted_lifecycle_idx.sql`
  adds one partial b-tree index
  `heartbeat_run_events_company_lifecycle_run_idx (company_id, event_type, run_id)`
  `WHERE event_type = 'lifecycle'`: the scan shrinks to the lifecycle slice of
  one company. Additive index-only migration: no query text, no schema and no
  behaviour change.
- Measured on embedded PostgreSQL with 83 200 seeded events across 20 companies
  (synthetic data, no production rows): the exhausted-runs leg went from
  `Seq Scan ... Rows Removed by Filter: 83 095` at 20.2 ms to
  `Bitmap Heap Scan ... Bitmap Index Scan on heartbeat_run_events_company_lifecycle_run_idx`
  at 0.87 ms — 23x faster, 1443 → 62 shared buffers.
- `CREATE INDEX IF NOT EXISTS` (not CONCURRENTLY — drizzle migrations run
  transactionally). `heartbeat_run_events` is bucketed "large" by the
  migration-safety checker (10 833 local rows × 250), so the statement carries
  the explicit `paperclip:migration-safety-ignore` note as 0307/0308 do for
  their large tables; production deploys run through the operator's maintenance
  mode and the partial predicate keeps the build cost at the lifecycle slice.
- Guard: `packages/db/src/attention-exhausted-lifecycle-index.myrmidon.test.ts`
  checks the migration file, the journal entry and the snapshot statically,
  confirms on embedded Postgres that the leg is served by the index and falls
  back to the sequential scan after `DROP INDEX` (the assertions have teeth),
  and applies the migration statement twice on one database to prove
  idempotency.

### The board raises an attention card when the gateway model catalog is empty (1.6.5 F-18)

- The spend collection sweep refreshes the model catalog from
  `/v1/model/info` on every pass. A successful refresh that returns 0 models
  now records an operator attention card: "Gateway model catalog is empty —
  check the accounting key". The usual cause is an accounting key created
  with a restricted model list (no default models): the gateway answers an
  empty list on a successful request, and every feature that reads the
  catalog (prices, model lists, entry limits) silently stops working.
- The card is per company and deduped: repeated empty sweeps keep the same
  card, and the first sweep that sees a non-empty catalog clears it — no
  dismissal bookkeeping. The first sweep right after the server start records
  the same way, so a misconfigured key surfaces immediately, not after one
  interval.
- The fix is operational, not a code change: re-create the accounting key
  (`MYRMIDON_LITELLM_KEY_SECRET`) with access to `/spend/logs/v2` and
  `/v1/model/info` and an empty model list (all models visible). The
  SETTINGS.md row now spells this out.

### The owner's own words close the pending owner card (1.6.5-F21-A)

- An answer written by the owner in a chat (a Telegram DM with the authoring agent, or a comment the owner leaves on the task) now closes the freshest pending owner card of that task. The decision talks to the existing resolution services; the owner is attributed as the resolver, so nothing about the card state machine changes.
- The same wording is used in both places: the inbound chat writer reads the owner's message with this parse (it can name an option by number or letter and pick the card's recommended option) and keeps its own free-text reading as the fallback for cards that accept a typed-in answer.
- The sentence is read against a RU/EN phrase table: "да / ок / делай / согласен / go ahead" accepts a confirmation, "нет / стоп / не надо / cancel" rejects it. Option cards match an option by number ("2) да"), by letter ("вариант б"), by the option's own wording, and "по твоим рекомендациям / the recommended one" picks the option the card marks as recommended. A free-text answer lands in the question's own free-text option when it has one.
- A sentence that decides nothing is never treated as a decision: the text is kept as the owner's comment, the card stays pending with a note saying the answer did not decide, and the question is re-sent with buttons — once per answer.
- Cards raised before the owner ever received a DM carry no message binding. They are closed by the same task-level rule, which is why no data migration is needed.
- When several cards of the task are pending, one line with buttons asks which question the answer belongs to instead of guessing.
- Setting: none. The behaviour rides the existing owner delivery mode (`via_bot`); in every other mode the path is inert.

### Register a GitHub App in one click from the company settings (GITHUB-APP-MANIFEST)

- Company settings → "Shared GitHub authorization" can now register a GitHub
  App through GitHub's manifest flow instead of hand-filling GitHub's form
  and pasting a .pem: `POST
  /api/myrmidon/companies/:companyId/github-shared-identity/app-manifest/begin`
  returns the GitHub form URL, the manifest JSON (private app, webhooks
  off, exactly contents + pull requests write and metadata read) and an
  unguessable anti-CSRF `state` the form posts alongside the manifest; the
  browser callback converts GitHub's one-time code only when the `state`
  GitHub echoes back matches the one begin issued for this company and actor
  (one-time use, ten-minute TTL) — a code without a live state is refused
  before GitHub is called — and stores the App's private key
  straight into a company secret — the key never appears in a response, a log
  line or an error — and `GET
  /api/myrmidon/companies/:companyId/github-shared-identity/apps/:entryId/install`
  returns the App's "Install on GitHub" URL. The callback redirects back to
  the settings with `github_app_created=1` or `github_app_error=<message>`.
- The App entry gains a nullable `slug` (additive; no migration — the
  document lives in `instance_settings.general`); the manual path (App id +
  key secret) keeps working unchanged, with or without a slug.

### The managed GitHub launcher reaches agents that start through the gateway (GITHUB-SHARED-IDENTITY)

- The launcher — the `git` and `gh` wrappers plus `git-credential-paperclip` —
  is staged by the board in its own filesystem for a run with a local or SSH
  execution target. A run that starts through the `hermes_gateway` adapter has
  no execution target on the board side, so those paths never existed where the
  run happens: the agent pushed and opened pull requests with the static
  `MYRMIDON_GITHUB_TOKEN` from its environment, and its `run_identity_contexts`
  row stayed without a GitHub identity.
- The gateway adapter now ships the launcher bodies with the run request, and a
  gateway stages them per run: under its own temporary root, in a directory
  named by the run id, first on that run's `PATH`, with the login-shell profiles
  and `GH_CONFIG_DIR` that keep the staged directory in place. Only that run's
  terminals and `execute_code` children see it — one gateway process serves many
  concurrent runs from threads that share one environment, so the binding is
  per-context, never process-wide.
- The bodies are program text and carry no credential: the token still comes
  from the run's broker capability, and the staged helper asks for it per
  invocation for the repository the operation names. A run without a capability,
  or a request whose launcher payload is malformed (wrong version, a file name
  outside the fixed set, an oversize body), stages nothing and behaves exactly
  as before — no partial directory, no directory another run could be pointed
  at. Nothing is written to a file, and no static token is needed anywhere.

### A retried run replaces its failed attempt's prompt in the hermes session (1.6.5)

- The bot runtime's gateway patch `12-stranded-run-turn-replace.patch` makes a
  `/v1/runs` run supersede the unanswered prompt(s) that earlier failed attempts
  left at the end of the session, instead of adding one more user row per retry.
  Before, a session that kept failing grew one row per attempt and the replay
  merged them into a single user message of megabytes, so every retry hit the
  provider's input limit again.
- Only stranded plain-text prompts that share the new prompt's first 256
  characters are replaced; answered turns, unrelated text, images and compaction
  summaries are never touched. `HERMES_KEEP_STRANDED_RUN_TURNS=1` turns it off.

### Memory is written once per run; run-start recall is conditional (1.6.5 PERF-DIET HS/D1)

- The hindsight memory fork (`0.3.0-myrmidon.2`) no longer writes one memory
  per ticket comment: a run's comments wait in run-scoped plugin state and
  are retained as one `Run <runId> digest` per bank at run end (metadata
  carries `kind: "run-digest"`, run/agent/issue ids, comment count; duplicate
  ids collapse, short bodies and board-machinery comments drop). A comment
  outside a run is retained immediately, as before. A failed retention is a
  warning; the run never fails because of memory.
- Run-start recall takes the plugin config field `recallOnRunStart`:
  `new-issue` (default — search only when the agent has not already searched
  this ticket), `always` (old behaviour) or `never`. `hindsight_recall` still
  searches on demand. Bank routing is unchanged.

### Company-wide wake budget for idle pickup (IDLE-WAKE-BUDGET)

- The board wakes at most five ready agents a minute per company (was: every
  idle agent with a ready task in one pass). The wakes go out in batches: one
  sweep pass emits at most `MYRMIDON_IDLE_PICKUP_WAKE_BATCH` wakes for a
  company, the rest follow on the next pass inside the same minute.
- The ceiling is shared by both idle-pickup paths — the periodic sweep and the
  pickup that runs right after a run releases its task — so a fleet of
  finishing runs cannot burst past it either.
- Two new environment knobs: `MYRMIDON_IDLE_PICKUP_WAKE_BUDGET_PER_MIN`
  (default 5, the ticket's number) and `MYRMIDON_IDLE_PICKUP_WAKE_BATCH`
  (default 5, never above the minute budget).
- A wake denied by the budget is not lost: the same candidate is re-evaluated
  in the next window, and both paths report how many candidates waited.

### Wake carries its task id; run liveness follows gateway events (N4)

- A wake whose task id reaches `heartbeatService.wakeup` only via
  `contextSnapshot.issueId` (for example the run-stall sweep's
  `issue_stalled_run`) is now stored and delivered with that id in the wake
  payload: the wake carries its task context to the agent, and every
  downstream consumer (wake payload renderer, coalescing key,
  execution-blocker check) sees the same `issueId`.
- Run liveness can follow gateway progress instead of the wall clock. With
  `MYRMIDON_RUN_LIVENESS_EVENTS=1` (default off) the hermes_gateway adapter
  replaces its fixed `timeoutSec` watchdog with a silence watch: a run that
  keeps emitting gateway events past its timeout is alive and is left alone,
  and only a run whose event stream has been silent for the whole budget is
  reported timed out. Per-agent opt-in via the card's «Liveness by gateway
  events» toggle. Off — the old fixed timeout, unchanged.

### Owner decisions find their owner when the task has none (1.6.5-OWNER-FALLBACK)

- Fixes the `via_bot` mode (1.6.5-OWNER-VIA-BOT) for tasks created by agents or by the operator service account: the owner was computed as `responsibleUserId ?? createdByUserId`, so on such tasks the author was never woken (`skipped_no_owner_dm`) and the owner of the company received nothing.
- One shared rule now picks the human who receives an owner decision: the interaction's human addressee, then the task's responsible user, then its creator, then the active owner(s) of the company (`company_memberships.membership_role = 'owner'`). The first candidate with a live Telegram DM with the author agent wins; a candidate without one is skipped.
- The same choice drives the wake of the author, the message to the owner, the "open decisions" list in the run prompt, the card-delivery lookup of the other delivery modes and the check that closes an interaction from the owner's text answer, so the person who got the message is the person whose answer is accepted.
- When nobody qualifies, the behaviour is unchanged: the question stays on the board only.
- The "explain it to the owner" wake no longer merges into the author's still-running run (which raised the question in the same turn, so the explanation block never reached its prompt). It waits behind that run and starts a separate run with the block. The response that creates a human-only interaction now carries `ownerExplain: { required: true, tool: "myrmidonMessageOwner", interactionIds }`, so the author can explain at once; a message sent in the same run cancels the deferred wake.

### The owner's own message closes the decision it answers (1.6.5-F21-AUTOCLOSE)

- Closes the gap left by the `via_bot` mode (1.6.5-OWNER-VIA-BOT) and by its guard: closing an owner decision required a live owner DM, an agent message bound to the interaction, the answer inside that DM and the author agent's live run (`authorizeOwnerReplyResolution`). A card raised before the mode existed — and any answer that arrives as a plain sentence in the task's own chat — satisfied none of that, so it stayed pending until a human resolved it by hand.
- The ingest of an inbound comment now closes the decision it answers by itself: when exactly one open owner decision of that task waits for the writer, the card is closed through the ordinary resolution path (`issue-thread-interactions`) with the owner as the acting user — the same thing the board would do — so the author agent's continuation is woken through the same continuation outbox as after a board click. No agent run is needed, which is what makes this path instant.
- A sentence closes a card only where the card itself asks for one: a single question with `allowOther`, or with an option marked `freeText` (the platform's inline-text choice, whose typed value is returned as the question's `otherText`). A closed select ("2) да" must pick option 2), a card with several questions and a worded confirmation stay pending for the owner-reply parser (1.6.5 F-21 part A).
- Refusals are deliberate and reported, never guessed: several open decisions of the same writer, a writer who is not the card's owner, a comment written before the card, a quarantined comment origin, a governed payload (`toolAction`/`secretProposal`) or a review verdict. Nothing in the path throws into the ingest.
- Expired cards (pending longer than TTL) remain the TTL sweep's business (1.6.5 F-21 part B).

### PREDEPLOY-DB-CHECK: the predeploy token file is checked with the other inputs of the step, before the first docker call

- `scripts/myrmidon/deploy/predeploy-board-check.sh` — when
  `MYRMIDON_PREDEPLOY_TOKEN_FILE` (optional) is set, the file is validated next
  to the other step inputs (`MYRMIDON_PREDEPLOY_POSTGRES_IMAGE`,
  `*_BOARD_ENV_FILE`), BEFORE the first docker call: "set but not a file",
  "set but not readable" and "set but empty" each stop the deploy with a
  message naming the input. Before this, only the setting being filled was
  checked, and a set-but-unreachable file surfaced later, in
  `auth_header_args` on the health-wait step — after Postgres was up and the
  dump restored. The token stays optional: without it the route walk gets
  401/403 and that is still a warning.
- `scripts/myrmidon/deploy/deploy.env.example` — a comment on the setting.
- Tests: `scripts/myrmidon/deploy/predeploy-board-check.test.mjs` — the 401/403
  case now uses a real token file (its previous `/nonexistent/token`
  configuration is exactly the case that moved earlier), plus a new case: a
  missing file, a directory, an empty file and (only when not run as root) an
  unreadable file stop the deploy and docker is never called.

### Plugin cron job launches are captured with a database CAS (PROCS-Q2 part B)

A plugin job fired by the scheduler is now claimed atomically before it runs:
`UPDATE plugin_jobs SET status='running' WHERE id=? AND status<>'running'
RETURNING`. Only the caller whose statement returns the row dispatches the
worker; every other concurrent tick — a second scheduler process, or a
double pass of the same tick — receives no row and skips the launch as a
normal, silent outcome (not an error). This closes the double-execution race
for plugin cron jobs under the multi-process board (OPE-5394 §4, §5.5).

The capture is released in the same dispatch path after the run reaches a
terminal state and the schedule pointer has advanced, so no process can
re-dispatch with a stale `nextRunAt`. The release is conditional on the job
still being `running`: an operator pause recorded mid-run is never clobbered
back to `active` by a finishing run. `running` joins the job status enum as a
transient, host-managed state: `GET /plugins/:id/jobs?status=running` can
filter on it, but it remains non-settable through the API (pause/resume still
accept only `active`/`paused`/`failed`). Default single-process behaviour is
unchanged apart from the guard itself. A capture left behind by a process
that died mid-run is reclaimed back to `active` by the scheduler tick once it
is older than two job timeouts, so a crashed owner can never wedge a job.
Covered by an embedded-Postgres test:
two scheduler instances ticking the same due job produce exactly one worker
execution and one run row.

### Release publish fits GitHub's size limit

- A release body over GitHub's 125 000-character limit was refused (HTTP 422, 1.6.5-rc.11). The notes section is now cut at a line boundary to keep the body under 120 000 characters and ends with a link to the full section of `docs/myrmidon/CHANGELOG.md` on the same tag; the component digest table is never cut.

### Run lists and the attention feed read thin run-context columns (OPE-5007 П2)

- `heartbeat_runs` gained nine nullable text columns (`context_issue_id`,
  `context_task_id`, `context_task_key`, `context_comment_id`,
  `context_wake_comment_id`, `context_wake_reason`, `context_wake_source`,
  `context_wake_trigger_detail`, `context_run_summary`) that mirror the small
  hot fields previously buried in the `context_snapshot` jsonb. The run list,
  the attention feed and the exhausted-runs query read the columns with a
  `coalesce(column, context_snapshot ->> key)` fallback, so historical rows
  keep resolving while the board's hottest queries stop detoasting dozens of
  kilobytes of snapshot per row. Migration `0313` only adds the columns (no
  table rewrite); a background job fills historical rows in small primary-key
  batches, committing each batch and pausing between them, so the hot table is
  never held by one long transaction. `context_snapshot` is stored unchanged.

### One stored copy of the execution continuation per run (1.6.5 RUN-SNAPSHOT-DEDUP)

- A run snapshot now holds the execution continuation envelope once, at
  `context_snapshot.executionContinuation`. The structured wake payload no
  longer carries its own copy: dispatch re-attaches the canonical envelope to
  the payload the adapter and the native runner receive, so the delivered
  prompt is unchanged. The duplicated envelope was ~90-100 KB, written twice
  into every run snapshot.
- The run detail response (`GET /api/heartbeat-runs/:id`) drops a nested
  copy that is byte-identical to the canonical one, so runs written before this
  change stop sending the envelope twice. A payload that differs from the
  canonical copy is left untouched, and no response loses information.
- The run-ownership probe (`getConversationOwnershipBlocker`) selects the six
  columns it reads instead of the whole `heartbeat_runs` row. It runs several
  times per dispatched run, and every candidate row used to arrive with its
  snapshot and result JSON attached.

### Task clones share one git object store per bot and per scope (1.6.5 BOT-DISK-G)

- Bot task clones copied the whole git history each (~0.4 GB; the volume grew
  ~4 GB/h): a bot terminal rebuilds PATH without the 1.6.2 git wrapper. The
  image now shadows git with `/usr/local/bin/git` and runs the wrapper with an
  absolute interpreter.
- The wrapper keeps one bare mirror per repository in the bot store (or the
  shared `/bot-scope/.git-objects` of an isolation scope); later clones borrow
  it with `--reference-if-able`. Measured here: first clone 414 MB / 144 MB
  `.git`, later clones 272 MB / 2 MB `.git`. Mirrors never prune objects a
  clone borrows; every failure falls back to a plain clone.
- The store used to stay empty next to live task clones: those clones run with
  `--reference <neighbour clone>`, the wrapper read that as the clone's own
  storage decision and stepped aside silently. Now only options that pick the
  storage of the clone's own objects opt out (`--dissociate`, `--shared`,
  `--local`, `--mirror`, `--filter`); clones naming `--reference`,
  `--reference-if-able` or `--no-local`, bounded clones (`--depth`,
  `--shallow-since`, `--shallow-exclude`) and non-GitHub clones keep the
  store's mirror as an extra alternate. `devbuild` follows the alternates.
- A clone the store does not serve is no longer silent: one `[myrmidon-git]`
  line on stderr plus `<HERMES_HOME>/.myrmidon/git-objects-last-error.json`.
  The start-time self-check (reported as `gitRefCheck`) runs a real offline
  reference round trip, plus `store-fills` and `store-in-use`; a failure raises
  an attention card (`gitref`, `bot_disk_lifecycle`).
- Switches: `MYRMIDON_GIT_LOCAL_MIRROR=""`, `MYRMIDON_GIT_LOCAL_MIRROR_REFRESH_SEC=0`,
  `MYRMIDON_GIT_OBJECTS_CHECK=0`. See [bot-disk-cache.md](bot-disk-cache.md).

### STARTUP-WATCHDOG-PAUSED: a paused watchdog agent no longer stops the board; the predeploy copy uses the production secrets key

- `server/src/services/task-watchdogs.ts` — when waking the watchdog agent
  fails with 409 ("Agent is not invokable in its current state": paused or
  disabled), that watchdog is skipped with a warning (counted as `skipped`),
  and the remaining watchdogs are processed as before. Other errors still throw.
- `server/src/index.ts` — the startup `reconcileTaskWatchdogs` call is
  best-effort: an error is logged as a warning and startup continues. Before,
  a restart with a paused watchdog agent ended in `startup heartbeat recovery
  failed` / `Paperclip server failed to start`.
- `scripts/myrmidon/deploy/predeploy-board-check.sh`,
  `scripts/myrmidon/deploy/deploy.env.example` — new optional
  `MYRMIDON_PREDEPLOY_MASTER_KEY_FILE`: that single file (production
  `instances/default/secrets/master.key`) is mounted read-only into the
  throwaway board, with `PAPERCLIP_SECRETS_MASTER_KEY_FILE` set. Without it the
  copy creates its own key (stored secrets fail with "Secret decryption
  failed") and the check prints a WARNING. The key is never printed.
- Tests: `server/src/__tests__/task-watchdogs-scheduler.test.ts`,
  `scripts/myrmidon/deploy/predeploy-board-check.test.mjs`.

### Release tags get their own un-cancellable CI; the publish gate reads it (1.6.5 TAG-CI)

- The 1.6.4 incident: the tag was pushed, bots merged four PRs into `main` a
  minute later, and the shared concurrency group of `myrmidon-ci.yml`
  (`cancel-in-progress: true`) cancelled the CI run of the tag's commit — the
  automatic publish refused, the tag CI and the release were re-run by hand.
- New workflow **Myrmidon CI (tag)** (`.github/workflows/myrmidon-ci-tag.yml`):
  the full CI tier on every `myr-vX.Y.Z` tag push (including `-rc.N`) and via
  `workflow_dispatch` with a mandatory `tag` input. Own concurrency group
  `myrmidon-ci-tag-<tag>` with `cancel-in-progress: false` — a push to `main`
  can no longer cancel it.
- The publish gate (`publish-github-release.sh`) now waits for the tag's own
  CI run only (`head_branch == tag`): a green main run of the same commit no
  longer satisfies the gate, and a cancelled tag run refuses the publish
  loudly with the recovery path (instead of timing out).
- The release tag pattern accepts `-rc.N` tags end to end (gate, tag CI,
  publish workflow trigger).

### Team liveness: a 24-hour health card (TEAM-LIVENESS-METRICS)

The company settings (health) page gains a "Team liveness" card with the four
counters of the last day for the selected company: **auto-resumes** (agents the
board brought back out of `error` by itself), **resumes given up** (attempts
ran out, so a human has to look), **wakes** (wake requests the board created)
and **stalled runs** (runs progress-based run liveness interrupted).

Nothing new is stored: the numbers are read from the rows the three behaviours
already write — the activity log for auto-resume, `agent_wakeup_requests` for
the wakes, and the run error code for the stalls. `GET
/api/myrmidon/team-liveness/metrics?companyId=…` serves them to the board; the
route is company-scoped, the same access rule the fleet console uses.

To be read: a nonzero "stalled runs" is the sweep doing its job, not a broken
server; a nonzero "resumes given up" is the one number that asks for a human.

### Team liveness settings on the instance and per agent (TEAM-LIVENESS-SETTINGS)

- The three automatic behaviours — AUTO-RESUME, RUN-STALL and IDLE-PICKUP —
  no longer read their `MYRMIDON_*` variables only at construction. Their knobs
  are now one settings area: stored in
  `instance_settings.general.teamLiveness`, resolved over the environment on
  every sweep pass, and changed on the Instance → General page ("Team liveness")
  or via `GET`/`PATCH /api/myrmidon/team-liveness`. A saved change takes effect
  on the next pass, with no restart and no run dropped in flight.
- Precedence is per key: a stored value wins, otherwise the environment
  variable, otherwise the built-in default. A key the operator never saved stays
  unsaved, so removing a variable later really takes effect; the settings page
  reports, per key, which of the three layers is in force.
- An agent card can switch a behaviour off for that one agent
  (`adapterConfig.teamLiveness = { autoResume?, runStall?, idlePickup? }`,
  "Team liveness" on the card). The card carries no numbers: the company-wide
  wake ceiling and the wake throttle stay on the instance settings page, so no
  single agent can raise them.
- Every change is written to the activity log for every company
  (`instance.team_liveness.updated`), with the previous values and the changed
  keys.

### Team liveness: the stand scenario that lets the watchdog be switched off (TEAM-LIVENESS-STAND)

`scripts/myrmidon/team-liveness/stand-recovery.ts` rehearses the situation the
epic exists for: the gateway dies mid-run and the team comes back by itself. It
has no liveness logic of its own; the product passes (RUN-STALL by progress,
AUTO-RESUME, IDLE-PICKUP) decide, built as the server builds them. The runner
seeds the situation, SIGKILLs the process, steps the clock and reads the
database back.

The verdict names three legs: the run is settled, the task is not left waiting
(it left `in_progress` and has a wake or a live run), the agent is not stuck in
`error`, all inside a budget (10 minutes by default); the exit code carries the
result. `rehearse` is self-contained (throwaway embedded database, a real
gateway process) and writes the knobs through the instance settings API;
`watch` is read-only against the live board database. Runbook:
[guides/team-liveness-stand-scenario.md](../guides/team-liveness-stand-scenario.md).
The default stall threshold (20 min) exceeds the budget, so the rehearsal sets
it lower through the settings area.

### PREDEPLOY-PG-COMPAT: the version comparison and the extension read really run on Debian/PGDG servers (1.6.6)

- `scripts/myrmidon/deploy/predeploy-board-check.sh` — the dump-header parser
  kept only the leading major digits. A Debian/PGDG server records its version
  with the package tail (`; Dumped from database version: 18 (Debian
  18.6-1.pgdg12+2)`); the previous sed did not anchor the end, so the whole
  tail landed in `dump_major` and the arithmetic comparison died with
  `((: 18 (Debian 18.6-1.pgdg12+2): syntax error in expression` — bash does
  not abort on a failed arithmetic expression inside `if`, so the version
  check of the rc.11/rc.12 deploys (08.10) was silently skipped. The copy's
  `SHOW server_version` answer is parsed the same way.
- The two psql probes against the copy (`SHOW server_version`,
  `SELECT extname FROM pg_available_extensions`) no longer swallow stderr
  into `/dev/null`. They run through one helper that retries three times
  (`POLL_INTERVAL_SEC` apart) and captures the psql error; if the list still
  cannot be read, the WARNING names the captured error instead of failing
  silently. This is the second silent skip of the same deploys
  (`WARNING: the copy's extension list could not be read`).
- Tests: `scripts/myrmidon/deploy/predeploy-board-check.test.mjs` — the fake
  docker answers the real Debian-tailed headers
  (`18 (Debian 18.6-1.pgdg12+2)`, `17.2 (Ubuntu 17.2-1.pgdg22.04+1)`) and can
  make each probe fail with a psql error. New cases: younger copy with a
  tailed header is refused with no `syntax error in expression` in the output,
  equal majors pass, the extension list is read and a missing extension is
  refused, a failing extension probe is retried and its error appears in the
  WARNING, the version WARNING carries the probe error. Every new case fails
  on the previous script.

### LiteLLM budget projection (BUDGET-CONFIG C)

- Limits saved on the board are projected into the LLM gateway's own budgets
  without a restart and within a minute: per-key budgets via `/key/update`
  (addressed by the M2-B key alias) and tag budgets via `/budget/update` on
  the stable `myrm-<level>-<scope>` tag. One point of change: the limit is
  edited on the board. A per-company sweep (interval from the stored
  document, default 30 s; env is a forced override only) pushes changed
  limits and compares both sides: a manual gateway edit is a divergence —
  signalled as a system-notice comment, never silently overwritten; the way
  out is re-saving the limit or `POST …/litellm-budget-sync/re-sync`. The
  global signal-only mode is on by default, so no projected limit stops work
  until the owner turns it off.

### Spend limits per hierarchy level, API and change journal (1.7-BUDGET-CONFIG-A)

- The board stores spend limits per hierarchy level — nest (company/project), caste (role),
  foraging, issue — one row per `(company, level, ref)` with `amountCents`, `period`
  (`calendar_month_utc`/`lifetime`), `mode` (`hard` refuses, `soft` pauses with a card to the
  owner) and `is_active`. Full change journal (`budget_limit_changes`): every create/update/delete
  with before/after snapshots and the actor.
- API under `/api/myrmidon/companies/:companyId/budget-limits`: CRUD on limits (mutations are
  board-only, each mutation writes a journal row and an activity-log entry), the journal (newest
  first, filterable by level), `usage` — the "spent in period" of every limit computed from
  `litellm_cost_events` per level (foraging reads the FORAGING sweep budget state, absorbing
  OPE-3964) with an `overLimit` flag.
- The global "signal only" mode (`instance_settings.general.budgetLimits.signalOnly`) is ON by
  default: limits never stop work until the owner explicitly turns it off. Runtime-mutable via
  `GET/PATCH …/budget-limits/signal-only`; the env variable `MYRMIDON_BUDGET_LIMITS_SIGNAL_ONLY`
  is a forced override only, and the GET reports the effective value's source
  (`stored`/`default`/`env`).
- DB: tables `budget_limits` and `budget_limit_changes` (migration 0312, additive only). See
  [guides/budget-limits.md](guides/budget-limits.md).

### Tab and home-screen icon — Myrmidon ant mark (1.7 FAVICON)

- The browser tab and the phone home screen ship the Myrmidon ant mark from
  the design-system export (`ui/public/brand/myrmidon/`): `favicon.svg` (the
  bare mark, adaptive navy/white), `favicon.ico` (16/32/48), 16/32 px PNGs for
  the tab, `apple-touch-icon.png` (180) and `android-chrome-192/512.png`
  (maskable 512 included) for the home screen, referenced from `index.html`
  and `site.webmanifest`; no vendor paperclip artwork ships. Icon and manifest
  URLs are served with `?v=<build version>` so a deploy refreshes the browser
  icon store.
- New guard test `ui/src/lib/myrmidon-favicon-build.myrmidon.test.ts`: the
  page links the full tab icon set, the manifest carries the 192/512 icons
  (incl. maskable), a built `ui/dist` ships the same ant files, and no
  paperclip artwork remains in `ui/public`.
- Guide: [favicon.md](../guides/favicon.md) (EN) and
  [favicon.ru.md](../guides/favicon.ru.md) (RU).

### Telegram bridge texts follow the user's language (TG-LOCALE)

- Service prose of the bridged Telegram DM (command replies, statuses,
  refusals, the migration notice, the unlinked refusal) moved from hardcoded
  Russian literals to server-side locale catalogs
  (`server/src/myrmidon/agent-chat-bridge/locales/{en,ru}.ts`): EN is the
  base, RU keeps the pilot wording key for key. The linked board user's
  Settings → Language choice decides per message (read again on every
  command, no restart); English is the default.
- `MYRMIDON_TELEGRAM_DM_LANGUAGE` forces one language instance-wide — the
  only env knob, operator override; the Telegram private-chat command menu
  (one menu per bot) follows this instance decision, per-message replies
  follow the user.
- The Settings → Language screen shows the source of the bridge value
  (user preference vs environment force, with the forced language named),
  recomputed on every read; `GET /api/myrmidon/ui2/language/me` carries
  `telegramBridge`. The current-interface language switch in the account
  menu now persists to the same server preference row.
- Ratchet test forbids Cyrillic string literals in bridge sources outside
  the catalogs; acceptance tests prove an EN user gets English and an RU
  user Russian end to end (embedded Postgres), including the live switch of
  a preference taking effect on the next reply.

### The real git leaves PATH in the bot image (1.6.5 BOT-DISK-H, part H1c)

- In the development image the Debian `git` moves to
  `/opt/paperclip/libexec/git` (a `dpkg-divert`, so a package upgrade does not
  bring it back) and `/usr/bin/git` becomes a symlink to the git wrapper, like
  `/usr/local/bin/git`: a bare `git` in any terminal PATH answers through the
  wrapper. The wrapper's default real git is the libexec path
  (`MYRMIDON_GIT_REAL` still overrides it).
- `myr-ws` (`/opt/paperclip/bin` and `/usr/local/bin/myr-ws`) and `botd` are
  installed from the build-context directories `docker/bot-runtime/myr-ws/` and `botd/` (whole, into `/opt/paperclip/myr-ws` and `/opt/paperclip/botd`, symlinked)
  when present; the image still builds without them.
- The entrypoint starts `botd` instead of `bot-clone-hygiene`; an image without
  `botd` keeps the old reporter.

### `myr-ws`: per-bot base repository and CLI frame (1.6.5 BOT-DISK-H2a)

- New `docker/bot-runtime/myr-ws`: the CLI frame (command parsing, `--json`,
  the exit codes of the bot-disk contract) and the class-D base library. A base
  is one bare repository per `owner/repo` under
  `/data/hermes/.myrmidon/git-base/<owner>/<repo>.git`, with the standard
  refspec `+refs/heads/*:refs/remotes/origin/*` (a fetch never overwrites a
  bot's local branches), `fetch.prune=true`, `gc.auto=0` and
  `gc.pruneExpire=never`. The origin URL carries no credentials: git asks
  `git-credential-paperclip`.
- A base is fetched at most every `MYRMIDON_WS_REFRESH_SEC` (default 900 s); a
  ninth repository is refused with exit code 4; names that are not a GitHub
  `owner/repo` (`..`, extra `/`, URLs, userinfo) are refused with exit code 2
  before anything touches the disk. Real git comes from `MYRMIDON_GIT_REAL`.
- `open`, `list`, `close` and `restore` are stubs here (exit 2, "not
  implemented"); their own tasks fill them in. Nothing calls `myr-ws` yet and
  the image does not ship it yet, so bot behaviour is unchanged.

### `myr-ws close`: the regular removal of a task copy (1.6.5 BOT-DISK-H2d)

- New `docker/bot-runtime/myr-ws/lib/close.js`: `close <KEY> [--force]`. A clean
  copy whose commits are all on `origin/*` is removed with `git worktree
  remove`, its branch `bot/<KEY>` is deleted from the base, the base is pruned
  (`git worktree prune`) and the entry leaves `ws-registry.json`.
- A copy with uncommitted/untracked files or commits that no `origin` ref holds
  is refused with exit code 7 and nothing is touched. With `--force` the
  archive module of botd (`archive(copyPath, key)`) runs first; the copy is
  removed only after it reported ok, otherwise it stays. An unknown key exits 6;
  a registry path outside `/workspace` and `/scratch` is refused (exit 2).
- The `close` verb is registered in `lib/cli.js` (integration BOT-DISK-H).

### `myr-ws migrate`: the old object mirror becomes the class-D base (1.6.5 BOT-DISK-H2f)

- New `docker/bot-runtime/myr-ws/lib/migrate.js`: a one-shot, idempotent
  migration of `.myrmidon/git-objects/<owner>/<repo>.git` (refspec
  `+refs/heads/*:refs/heads/*`) into `.myrmidon/git-base/<owner>/<repo>.git` with
  the standard refspec. Objects are hardlinked (copied across devices), the
  mirror's heads become `refs/remotes/origin/*`, the origin URL is rebuilt
  without the mirror's credentials, and the base is built beside its final path
  and renamed only after `git fsck --connectivity-only` passes.
- The mirror is only read, never changed or deleted, so existing clones that
  borrow its objects through `objects/info/alternates` keep working. After a
  successful check it gets a `.migrated` marker; on a failed check it stays
  unmarked, no base is left behind and the command exits non-zero. A second run
  is a no-op. The ninth base is refused with exit code 4.
- The result is the contract shape `{ ok, repo, basePath, refs }`. The verb is
  not wired into `cli.js` or the entrypoint yet (`command` in `migrate.js` is
  the handler), so bot behaviour is unchanged.

### botd reads the desired workspace state from the board (1.6.5 BOT-DISK-H, part H3a)

- New module `docker/bot-runtime/botd/lib/desired.js`: the client of
  `GET /api/myrmidon/bots/me/workspaces` (contract C3). It authenticates with the
  bot's `PAPERCLIP_API_KEY`, times out after 10 s, validates the answer against
  the C3 schema, keeps the last good answer with its `fetchedAt`, and polls every
  60 s and on SIGUSR1 (run wake-up).
- Fail-safe: 401/403, 5xx, network errors, timeouts, broken JSON and an answer
  that does not match the schema (an unknown `state` included) return
  `{ ok: false, reason }`; the caller deletes nothing and only reports. The API
  key is never written to a log or a reason.

### botd archives unpushed work before a copy is deleted (1.6.5 BOT-DISK-H, part H3c)

- New module `docker/bot-runtime/botd/lib/archive.js`: `archive(copyPath, key)` writes
  `<KEY>-<ts>.bundle` (the copy's branch and stash minus `origin`), `<KEY>-<ts>.patch`
  (`git diff HEAD --binary`) and `<KEY>-<ts>.untracked.tar` (untracked files, ignored
  excluded; over 200 MB only bundle+patch and `truncatedUntracked: true`), and appends
  `{key, repo, bundle, patch, untrackedTar, createdAt, sizeBytes, truncatedUntracked}`
  to `manifest.json`.
- It returns `ok: true` only after the bundle verified (header and the pack itself) and the
  tar was listed back; otherwise `ok: false`, nothing stays on disk, and botd must not delete
  the copy.
- `retain()`: 30 days or 2 GiB per bot, oldest first; the entry just created is never evicted.

### botd main loop, action executor and disk report (1.6.5 BOT-DISK-H, part H3e)

- New `docker/bot-runtime/botd/botd` (CommonJS entry), `lib/loop.js` and
  `lib/report.js`. Every 60 s (and on SIGUSR1) botd takes the desired state from
  the board, gathers the inventory, asks the rules for actions, executes them,
  writes `disk-state.json` from the board's pressure and posts the C4 report
  to `POST /api/myrmidon/bots/me/disk-report` (three attempts with backoff).
- Fail-safe: without the board's desired state, or with a failed inventory, nothing
  is removed — only the report goes out with the reason. One failing action is
  reported as `error` and does not stop the others.
- The desired/rules/classify/archive modules are loaded by their contract
  interfaces; while one is absent from the image the loop works with an inert
  stand-in and removes nothing.

### Bot disk panel and working-copy line (1.6.5 BOT-DISK-H, part H4d)

- Instance → General, "Bot disk": a physical section (partition, quota, other consumers) and a per-bot table: quota and usage, number of E/G/X copies, archives, report age (stale after 30 minutes is flagged), image generation; expanding a bot lists its copies with key, task status, branch, clean/pushed state and age.
- New `BotDiskWorkspaceRow`: on a task, "working copy: bot, path, state" and "archive: path, size, retention". Old reports without some fields render without errors.

### dockergate reports the physical state of the bot partition (1.6.5 BOT-DISK-H, part H9a)

- New dockergate route A14, `GET /myrmidon/disk` (outside the Docker API prefix; the daemon is not
  called): the partition of the volume root from `statfs` (total, used, free, percent) and the project
  quotas from `xfs_quota -x -c 'report -p -b -N' <volumeRoot>` as `{botKey, projectId, usedBytes,
  softBytes, hardBytes}` per bot, plus `other.usedBytes` (project 0, unnamed projects and names that
  `/etc/projid` does not list). The answer is the C5 shape of the bot-disk contract.
- A partition mounted without `prjquota` (the quota command fails) is a normal answer: HTTP 200,
  `quotaEnabled=false`, no projects. A volume root that cannot be read, or a report that cannot be
  understood, is `upstream_error` (502); a quota command that hangs is `upstream_timeout`.
- The route is one exact target and GET only; every other method or path under `/myrmidon/` is
  `route_not_allowed`. Operator note: dockergate must be able to run `/usr/sbin/xfs_quota -x` and read
  `/etc/projid` (open question 9 of the epic design).

### dockergate sets a bot's disk quota (1.6.5 BOT-DISK-H, part H9b)

- New dockergate route A15, `PUT /myrmidon/disk/<botKey>/quota` with `{"bytes": N}`
  (contract C5). `N` must be in [64 MiB; 1 TiB], otherwise `bad_quota` (400).
  dockergate gives the bot a stable XFS project id (kept in `/etc/projid` and
  `/etc/projects`, both replaced atomically), points the project at the bot's
  volume `<volumeRoot>/<botKey>` and sets a hard limit of `N` and a soft limit of
  0.8 of it with `xfs_quota`. Answer: `{"ok": true, "projectId": ..., "hardBytes": ...}`.
- The same request again keeps the project id and the files. If the bot
  partition is mounted without `prjquota`, the answer is `quota_unavailable`
  (503) and nothing is written. A key that is not a lowercase UUID, another
  method or a query string is `route_not_allowed`; a bot that is not enrolled is
  `bot_not_enrolled`. The route never reaches the Docker daemon.

### the execution continuation leaves `context_snapshot` (DB-CARE DBC-3)

- New table `heartbeat_run_continuations` (migration `0330_heartbeat_run_continuations`,
  one row per run, unique on `run_id`). The continuation envelope of a run is written
  there by `heartbeat.ts` instead of `heartbeat_runs.context_snapshot`; the row also
  carries `envelope_chars` for the DB audit and `wake_links` (run id, origin comment
  ids, source run id, interaction id) that reference the wake payload instead of
  copying it a second time. `heartbeat_runs.context_snapshot` stops carrying the task
  history, so the average snapshot size drops from the 31 KB the 08.10 audit measured.
- Readers (`execution-continuation.ts`, `run-continuation-snapshot.ts`,
  `native-completion-feedback.ts`, the interaction origin lookups) read the envelope
  from the new table and fall back to the legacy `context_snapshot` copy, so runs
  written before this change resume unchanged and a failed continuation write degrades
  to the old behaviour instead of stopping the run.
- `limitExecutionContinuationHistory` now also caps the message list by characters
  (`MYRMIDON_CONTINUATION_MESSAGE_CHARS`, default 32 000, 0 disables it). Bodies of the
  oldest messages that carry no direction become references (`bodyOmitted`): the id and
  freshness stay, the text lives in the task thread. Direction always survives — the
  original request, the latest request and the triggering comments keep their bodies,
  and a pinned body that alone exceeds the per-body budget
  (`MYRMIDON_CONTINUATION_MESSAGE_BODY_CHARS`, default 8 000) is shortened with an
  explicit marker instead of being dropped. The resume delta treats a reference as
  already delivered, and the cut is deterministic, so a capped message never comes back
  as new.
- `completedActions` of the envelope no longer collects tool receipts from every run the
  task ever had: only the previous context run (or the handoff source run) contributes,
  which is what made the envelope grow with the age of the task.

### The board no longer burns CPU on abort listeners of long bot runs (GATEWAY-DELAY-LEAK)

- The hermes gateway adapter waits between status polls with a helper that
  hung an `abort` listener on the run's signal and removed it only on abort.
  Every poll tick of a long run left one more listener behind; with thousands
  of them, every add/remove on that signal (undici adds one per fetch) walked
  the whole list. A live CPU profile of the board on 06.10 showed ~40 % of the
  single board process in `addEventListener`/`removeEventListener`, and API
  answers took 20–30 s. The helper now removes its listener when the timer
  fires.

### Hot board queries without full-row reads + company/issue index as a migration (OPE-4131 part B, closes OPE-4106)

- `getConversationOwnershipBlocker`
  (`server/src/services/conversation-continuation.ts`) selects only the columns
  it checks and returns (`id`, `agent_id`, `process_pid`, `process_group_id`,
  `process_started_at`) instead of the full `heartbeat_runs` row, which dragged
  the multi-KB `result_json` / `runner_profile_json` / `context_snapshot`
  through the executor about 10 times per run (planning alone took 74 ms in
  production).
- Migration `0302_heartbeat_runs_company_issue_coalesce_created_index.sql`
  persists `heartbeat_runs_company_issue_coalesce_created_idx` on
  `(company_id, coalesce(native_issue_id::text, context_snapshot->>'issueId'), created_at desc, id desc)`,
  created manually in production (OPE-4106); `IF NOT EXISTS` keeps the manual
  index and makes a re-run a no-op.
- Migration test
  `packages/db/src/heartbeat-runs-company-issue-coalesce-index.myrmidon.test.ts`:
  the full chain applies, EXPLAIN uses the index for the blocker predicate,
  replaying the statements is a no-op. DIVERGENCE row: `OPE-4131-B`.

### Forgotten-pause guard: the board lifts operator pauses left behind (1.6.5 PAUSE-GUARD)

- The board resumes, on its own, an agent that an operator paused and left
  paused longer than the threshold (20 minutes by default). The pause is the
  operator's own (`pause_reason = manual`); pauses the board sets for its own
  reasons — budget, archived company, import, a plugin note — are never
  touched. A resumed agent goes through the same wake chain the resume route
  uses, so its queued runs and its stranded `todo`/`in_progress` tasks come
  back to life instead of waiting for someone to notice.
- A pass resumes at most `maxResumesPerPass` agents (20 by default). The
  ceiling is what keeps a fleet-wide resume after a long night from starting
  every stranded backlog at the same instant: the remainder waits for the next
  pass and raises ONE notice per company on the attention desk, which
  disappears in the pass that finds nothing left over. Every resume is written
  to the activity log as `agent.pause_guard_resumed`.
- Settings live on the instance settings page next to "Run limits" (switch,
  threshold in minutes, interval in seconds, an allowlist of agent names, the
  per-pass ceiling) and change while the server runs — no restart, no run in
  flight is dropped. Saving re-arms the guard, so the next tick applies the new
  values. Names on the allowlist are never resumed: a maintenance window on a
  named agent is an operator decision, not a forgotten pause.
- This replaces the maintenance script that used to run from the host every 10
  minutes with a journal file and a fleet allowlist. The allowlist starts
  empty; the values an operator kept in the host file are moved in by hand.
- `MYRMIDON_PAUSE_GUARD_*` stays the default for an instance that has never
  saved the block; once saved, `instance_settings.general.pauseGuard` is the
  source of truth. The feature ships enabled: it is a defect fix (an operator
  pause that is forgotten is a stopped agent nobody decided to stop). See
  [SETTINGS.md](../SETTINGS.md).

### Run admission decides on CPU utilisation, not load average (1.6.5 RUN-ADMISSION, rc.3)

- Admission moved from the host load average to measured CPU utilisation: the
  non-idle share of all cores from `/proc/stat` over a window of at least 250 ms,
  and optionally PSI cpu pressure (`some avg10` of `/proc/pressure/cpu`). Load
  average stays in the gate report as an auxiliary number. On 06.10 load1 65.7 on
  16 cores held 11 runs while the CPU was only 60-75 % busy: load average also
  counts tasks blocked on disk or a lock.
- New limits: `maxHostCpuBusyPercent` (`MYRMIDON_MAX_HOST_CPU_BUSY_PERCENT`,
  default 90, absolute percent of the whole CPU) and `maxHostCpuPsiSomeAvg10`
  (`MYRMIDON_MAX_HOST_CPU_PSI_SOME_AVG10`, off unless set). The ceiling closes
  when either threshold is reached.
- A settings row saved before rc.3 has neither key (absent = off) and keeps
  deciding on load average as in 1.6.5 until a CPU ceiling is set. An unreadable
  `/proc/stat` (or pressure file with its ceiling set) leaves the gate `unknown`
  and the ceiling inactive, logged once; paths `MYRMIDON_HOST_PROCSTAT_PATH`,
  `MYRMIDON_HOST_PRESSURE_CPU_PATH`.
- `GET /api/myrmidon/runtime-limits` and the attention card gained
  `cpuBusyPercent`, `busyThresholdPercent`, `psiSomeAvg10`, `psiThresholdPercent`
  and `source` (`cpu-busy` / `load-average`).

### Run admission by host CPU load (1.6.5 RUN-ADMISSION)

- A new run starts only while the host's 1-minute load per core stays under
  `maxHostLoadPercentPerCore` (`MYRMIDON_MAX_HOST_LOAD_PERCENT_PER_CORE`,
  default 90 % of one core); otherwise it stays `queued` and the 15 s queue
  pass retries it. The night of 05.10: 43+ simultaneous run starts pushed the
  host to load 95 on 16 cores and the board's API fell over on timeouts.
- Load is read from `/proc/loadavg`, cores from `os.cpus()`; an unreadable
  reading logs once and leaves the ceiling inactive. The setting lives in
  Run limits (Instance → General, Settings → Runs & queue) and applies
  without a restart; the swarm idle-wake pass holds while the ceiling is
  closed, and a hold over 10 minutes raises an attention card.
- rc.2: the ceiling counts ABOVE the host's background floor (the lower of
  the 1-/15-minute averages per core, ratchet-stored, rising ≤1 % of a core
  per minute), so a host with always-on services is no longer held shut by
  its own baseline, and a burst of runs cannot raise the floor.
- Settings → «Runs & queue» shows the current load, floor and ceiling state.

### Per-agent start share setting and the queue snapshot in run limits (1.6.5 RUN-FAIRNESS)

- A new run limit, `maxPerAgentStartSharePercent`
  (`MYRMIDON_MAX_PER_AGENT_START_SHARE_PERCENT`, default 15): the share of the
  global concurrency ceiling's start slots one agent may take while the
  ceiling is busy. It lives in the same Run limits settings (Instance →
  General, Settings → Runs & queue, `PATCH /api/myrmidon/runtime-limits`),
  changes on the fly without a restart, accepts 1–100, and `null`/`off`
  switches it off. A row saved before 1.6.5 keeps working and takes the
  environment value or the default.
- `GET /api/myrmidon/runtime-limits` now carries a `queue` snapshot: runs in
  flight against the ceiling, runs still waiting, the timestamp of the oldest
  waiting run and the agent waiting longest — so the operator sees the real
  state of the queue next to the limits instead of guessing from the counters
  page. `queue` is `null` when the admission or the database is unavailable.
- Part 2 of RUN-FAIRNESS; the fair admission pass that enforces the share
  lands separately (part 1) and reads this key.

### Fair-queue controls in the run settings (1.6.5 RUN-FAIRNESS, UI)

- Both run settings panels (Instance → General «Run limits», Settings →
  «Runs & queue») now edit the single-agent start share,
  `maxPerAgentStartSharePercent` (1..100 or off, default 15): the most starts
  one agent may take in a 10-minute window before its new runs wait for the
  other agents' turns, so a hot agent can no longer occupy the queue while
  the global ceiling is full.
- Both panels show the queue snapshot from `GET /api/myrmidon/runtime-limits`:
  runs in flight against the concurrency ceiling, how many runs wait, and
  since when the oldest one waits (with its agent).
- The «Runs & queue» screen names why the head of the queue still waits —
  the run's `contextSnapshot.waitReason` (ceiling full, start ramp, memory
  floors, host CPU, the fair share, the agent's own concurrency limit), in
  both locales. See [SETTINGS.md](../SETTINGS.md).

### A fair queue for the global run cap, and the wait reason on the run itself (1.6.5 RUN-FAIRNESS)

- While the global ceiling is busy, a freed slot goes to the longest-waiting
  queued run: the sweep visits agents in the order of each agent's oldest
  queued run, and a per-agent share gate (`maxPerAgentStartSharePercent`,
  default 15, over the sliding 10-minute window) holds back an agent that took
  its share while other agents wait. A lone queue is never throttled by the
  share.
- A queued run now says why: `waitReason` (`global_cap`, `start_ramp`, `memory`,
  `host_memory`, `host_cpu`, `agent_fair_share` or `agent_concurrency`) is written
  into its `contextSnapshot` by the queue pass and removed on the claim that
  starts the run.

### Memory snapshot in the run load view (1.6.5 C0-ui)

- `GET /api/myrmidon/runtime-limits` now ships a `memory` block next to
  `hostLoad` and `queue`: the host's available and total memory (the numbers
  the memory floors `MYRMIDON_MIN_FREE_MEMORY_MB` /
  `MYRMIDON_MIN_FREE_HOST_MEMORY_MB` decide on) and the server container's
  cgroup v2 usage against its limit (`memory.max` − `memory.current`, with
  the reclaimable `inactive_file` page cache counted as free — the same rule
  the admission's memory guard applies). Either side is `null` when the
  server cannot read it (no cgroup limit, host memory unreadable), so a
  consumer shows nothing rather than a number the server made up.
- Both run settings panels (Instance → General «Run limits», Settings →
  «Runs & queue») show the snapshot next to the queue line: the load screen
  now covers the queue, the ceiling, and the memory of the host and the
  server container in one place. See [SETTINGS.md](../SETTINGS.md).

### The queue starts reviews, releases and current-release work first (1.6.5 RUN-PRIORITY, part A)

- While run admission is closed, a freed slot no longer goes to whoever queued
  first: every queued run now carries an effective weight banded by its agent's
  role — the role opens the band, and the issue priority, the current-release
  lift and the aging step only order the runs *inside* it. The role therefore
  decides who starts whatever the issue priority is: a review or release run
  goes before an engineer's critical-issue run, and a run carrying the current
  release goes before every other role, one whole band above the heaviest one.
  Default role weights put `review` and `release` on top, `lead` next, then
  `engineer` and `docs`, everything else at the floor; default issue weights
  follow the familiar critical > high > medium > low order inside the band.
- Both queue paths apply it: the global sweep visits agents by their
  best-weighted queued run (weight, then the age of that run, then id) before
  starting anything, and the per-agent comparator sorts each agent's own queue
  by the same weight inside each readiness rank, with a `createdAt`
  tie-break. The admission gates themselves (load, memory, starts per
  minute, per-agent slots, the fair share) are unchanged — priority only
  reorders the choice inside the slots admission admits.
- The waiting run also says where it stands: with priority on, every pass writes
  `queuePosition` of `queueLength` into each queued run's `contextSnapshot` (the
  rank that pass's order gave it), and a run left behind by a pass that did start
  runs of its agent gets `waitReason: "priority"` — its slot went to a heavier
  run. The claim that starts a run clears both fields, so they describe the
  current wait only; the run card renders the position beside the reason (UI,
  part B).
- Against starvation: the effective weight grows by a configurable step per
  configurable waiting minutes (capped by a maximum bonus) *inside* the band,
  and a run that waits past the starvation limit takes the escape lane outright
  — one that outranks every role and the current-release lift, so no queued run
  can stay behind the queue forever.
- The weights are live settings, the run-limits pattern: the sweeps read them
  fresh every pass, so a change through `PATCH /api/myrmidon/run-priority`
  (or the environment at boot) reorders the very next sweep without a server
  restart. Turning the feature off falls back to the pre-feature ordering
  (fair-share oldest-first globally, priority-rank + `createdAt` per agent).

### Run stall detection settings without a restart (RUN-STALL-SETTINGS)

- The progress-based run liveness sweep (RUN-STALL) is configured from the UI:
  `GET /api/myrmidon/run-stall` reports the effective values — the master
  switch, the silence threshold, the sweep interval and the scan page size —
  together with where each value came from (`settings` for the stored
  document, `env` for the deployment environment, `default` for the built-in
  fallback); `PATCH /api/myrmidon/run-stall` (instance admin only) writes
  `instance_settings.general.runStall`, records the change in the activity log
  for every company (`instance.run_stall.updated`, old and new values) and
  applies the values to the live sweep, so the very next pass works with the
  new threshold and interval. No restart — a restart drops every run in
  flight.
- The environment keeps its role on an instance that never saved the settings:
  unset `MYRMIDON_RUN_STALL_*` are the built-in defaults, and the values the
  deployment sets are read with the sweep's own semantics (an unrecognized
  switch value keeps the fix on). A stored value wins over the environment;
  out-of-range writes are refused with 400 (threshold 60 s – 24 h, interval
  15 s – 24 h, page size 1 – 200).
- One source of truth: whether the sweep runs and its silence threshold belong
  to the team-liveness settings (`runStallEnabled`, `runStallThresholdSec` at
  `/api/myrmidon/team-liveness`), which the sweep already obeyed. `GET` reports
  those two values from there (with their source); `PATCH` accepts only
  `checkIntervalSec` and `pageSize` and answers 409
  (`run_stall_managed_by_team_liveness`, with the team-liveness path) when the
  body names `enabled` or `thresholdSec`.
- Instance → General carries a «Run stall detection» section: the interval and
  the page size are editable, the switch and the threshold are shown read-only
  with a link to the Team liveness section.
- The sweep itself does not change: only where it reads its settings from.

### Session generations: a task's bot session no longer grows forever (PERF-DIET K)

- The session key of a task's container bot now carries a generation:
  `paperclip:company:<cid>:agent:<aid>:issue:<iid>:g<N>`. A new generation
  starts when the current one passes its threshold — more than
  `general.sessions.maxMessages` messages (default 400) or older than
  `general.sessions.maxDays` days (default 14) — and Hermes then opens an empty
  session for the new key instead of resuming a transcript that has been growing
  since the task started (80–110 MB of `state.db` on a long task).
- The first generation has no suffix, so nothing changes — for a task below its
  thresholds, and for every session that is already running — until a threshold
  is actually crossed. The wake that starts a new generation carries the board's
  existing continuation summary plus a session-handoff note naming the previous
  session, the reason and the last run's summary; the generation change is
  recorded in the run log and, with its reason, in the board's log.
- Other adapters and the `agent`, `run` and `none` session-key strategies are
  untouched.

### Agent pause by grant (ADMIN-AGENT D)

- `POST /agents/:id/pause` now authorizes agent actors through the same
  direct-grant ladder as resume: an agent holding `agents:configure` may
  pause an agent of its company, while `agents:suggest-changes` and
  ungranted peers stay denied. Board actors keep the previous semantics
  unchanged, and the pause activity entry now records the real acting
  principal (agent, run, API key) instead of a board placeholder.
  Drain-vs-cancel semantics are untouched.

### Bot-card "Apply now" now shows the async apply: progress, applied time, failure text (ASYNC-BOT-APPLY-UI)

- After `POST .../bot-container/apply` answers 202 + `applyId` (ASYNC-BOT-APPLY,
  server side), the agent card polls `GET .../bot-container/apply/:applyId`
  every 2 s instead of holding a 36 s request open. While the pass is live the
  button reads "Applying…", is disabled, carries a spinner, and a progress
  line explains that the result will appear on the card.
- The outcome is rendered on the card: a succeeded job shows the finish time
  ("Applied at 14:03:12."), a failed one shows the server's error text — on
  screen, not only in the console. The live `applyId` is kept in
  `sessionStorage`, so reloading the page in the first minutes resumes the
  same job and the outcome (error included) is not lost with the component;
  the first poll after resume catches a job that finished while the page was
  closed.
- A poll round lasts at most ~2 minutes; then the card says the apply is still
  running and to check again in a few minutes, and the button becomes
  pressable again. Pressing it again returns the still-live job's id from the
  server (one pass, not two). An unknown job id (404 — e.g. the instance was
  rebuilt while the page was open) stops the poll and shows that reason.
- Backward compatible: a server older than ASYNC-BOT-APPLY still answers the
  POST synchronously with an `outcome`, and the card words it exactly as
  before, so this UI can merge before the server part.

### "Apply now" on the bot card is asynchronous: 202 + apply id, background pass, DB status (ASYNC-BOT-APPLY)

- The apply button used to run the whole reconcile inside the HTTP request and
  held it for ~36 s on a cold restart (facts §6.3). `POST
  /api/myrmidon/agents/:id/bot-container/apply` now validates what the old
  route validated inline (feature flag, runtime presence, saved-card
  applicability — same 409/503 answers as before), journals one row in the new
  `bot_apply_jobs` table and answers **202 `{ applyId, status }` in under a
  second**. The reconcile pass runs in the background of the same process
  (fire-and-forget; every outcome is written to the job row, no unhandled
  rejection, no new dependencies, no restart).
- `GET /api/myrmidon/agents/:id/bot-container/apply/:applyId` reads **only the
  database** and answers `{ status, error, startedAt, finishedAt }` with
  `status` walking `pending → running → succeeded | failed`. A failed pass
  stores the (clipped) failure text in `error`, so the outcome a presser needs
  is never lost in a catch. Unknown/foreign ids answer 404; the route is
  board-actor-gated like the POST.
- Idempotency: while a bot has a live (`pending`/`running`) job, a repeated
  POST returns that job's id instead of queueing a second pass; the
  `bot_apply_jobs` partial unique index enforces one live row per bot across
  racing POSTs and api processes, and the store re-reads the winner's row on a
  unique violation. A live job older than ten minutes is an orphan of a
  stopped board process: the next POST closes it as `failed` (the reason stays
  readable through the status route) and starts a fresh pass, so a crash never
  pins the bot to a dead job id.
- Contract for the board UI (part B of the parent task): after the 202, poll the GET
  status until it leaves `pending`/`running`; render `error` on `failed`.

### Attention feed: stale-while-revalidate cache, one background rebuild (ATTENTION-FEED-SWR)

- The per-company attention feed snapshot is now served while it is stale. A
  snapshot older than the TTL is returned at once, and one background rebuild
  refreshes it; the reader does not wait for that rebuild. Parallel callers
  share the single rebuild of a cache key, so a poll from every open tab costs
  one feed build instead of one per tab.
- Past `2 × TTL` the read waits for a rebuild again. A reader therefore never
  receives a snapshot older than `2 × TTL`.
- The TTL default is now 60 seconds, the UI poll interval (was 45 seconds).
  `instance_settings.general.attentionFeedCacheTtlSeconds` still takes 0 to
  300, and `0` disables the cache.
- Invalidation stays TTL-based. The existing explicit invalidation (dismiss
  and snooze writes) additionally discards a rebuild that started before that
  write, so such a write is still visible on the next read.
- `generatedAt` now carries the build time of the served snapshot instead of the
  request time. A feed served from the cache therefore reports the age of its
  data rather than the age of the poll, and two reads of one snapshot return the
  same value.
- Unit tests with fake timers cover the three windows: fresh, stale (served at
  once, one rebuild for N parallel callers), and older than `2 × TTL` (waits).

### Attention feed: bounded failed-run window and a per-company cache (ATTENTION-WINDOW-CACHE)

- `GET /api/companies/:id/attention` recomputed the whole feed on every
  request and read every unresolved failed run of the company. The query
  window grew with the age of the oldest unresolved failure, so on
  production-like volume the route answered in tens of seconds.
- The failed-run window is now bounded by a horizon: exhausted runs created
  older than `now − horizon` never enter the feed, and the follow-up run
  lookup is additionally constrained by `created_at > greatest(oldest failed
  run, now − horizon)`. The horizon is an instance setting
  (`instance_settings.general.attentionFailedRunHorizonDays`, default 7
  days). Card semantics for fresh failures are unchanged.
- The built feed snapshot is cached per company in an in-process TTL cache
  (`instance_settings.general.attentionFeedCacheTtlSeconds`, default 45
  seconds). The cache key is the company, the request options
  (`all`/`queue`/`userId`/`includeDismissed`) and the horizon. Writes
  (dismiss, decisions) are visible with up to the TTL delay; there is no
  invalidation event and no new table, and no redis.
- Unit tests cover the horizon (an old failure stays out, a fresh failure is
  in, the second query window is bounded) and the cache (a second `list()`
  inside the TTL serves the stored snapshot and runs no new feed queries;
  after expiry the feed is rebuilt). Existing attention suites pass; the
  read-after-write suites opt the cache out per service instance.

### Backup retention: a "keep only the latest backup" option in instance settings (BACKUP-KEEP-LAST, UI part)

- The general instance settings page shows a "Keep only the latest backup"
  option next to the daily/weekly/monthly retention presets. It is active when
  `backupRetention.keepLastOnly` is `true` and is saved through the existing
  `PATCH /api/instance/settings/general` with
  `{"backupRetention": {..., "keepLastOnly": true}}`.
- Picking any daily/weekly/monthly preset turns the mode back off
  (`keepLastOnly: false`) so the two ways of configuring retention never fight
  each other; while the mode is on, a hint under the presets explains that the
  presets are ignored.
- The contract is additive (`keepLastOnly?: boolean` on
  `BackupRetentionPolicy`); the server part ships separately.
- A safety note under the option states the server behaviour: older backups are
  deleted only after the new dump passes verification, so a broken new dump
  leaves the older copies in place (nothing is lost, but disk space is not freed
  until the next successful run).

### Keep only the last verified database backup (1.6.5 BACKUP-KEEP-LAST)

- `instance_settings.general.backupRetention.keepLastOnly` (default off): when
  on, a backup run ignores the tier presets — after the new dump is written it
  is stream-verified (full gunzip pass plus a dump-completion marker in the
  decompressed tail, holding only a 64 KiB buffer) and only then every
  previous `<prefix>-*` backup is deleted.
- A new dump failing verification is deleted on the spot, all previous backups
  kept: the mode can never trade a good old backup for a bad new one. Both
  engines (pg_dump and the JavaScript logical dump) verify and prune
  identically; a verification failure is never retried on the other engine.
- Independent of the mode, pruning first removes orphaned unfinished `.sql`
  files older than one hour (leftovers of interrupted runs); the live run's
  own writer is never touched.
- Additive: payloads written before 1.6.5 parse unchanged. The UI toggle ships
  separately; server contract `keepLastOnly` on
  `PATCH /api/instance/settings/general`.

### Container bot cards are complete, and the image rollout names every bot (1.6.4-BOT-CONTAINER-CARD)

- Migration `0299_bot_container_card_complete`: cards with a `container` block
  get `enabled: true` and the product defaults for missing limits (`memoryMb`
  2048, `cpus` 1, `pidsLimit` 512); values already on the card win. Such cards
  were refused at apply and skipped by the bot-image rollout before.
- Saving an incomplete `container` block is refused 422 naming the fields; the
  card UI shows and fills what is missing.
- The bot-container status API carries `imageTracking`
  (`tracks_release` / `pinned` / `not_applicable`); the rollout reports every
  bot in one of these categories and its card PATCH sends the whole
  `container` block (an image-only patch dropped the limits).
- Clone-hygiene reports are collected per bot by name (the old container
  listing was on dockergate's closed list and answered 403); dockergate gained
  the narrow read-only archive route A13 for the report file (one fixed file of the main container).
- Contract test: every Docker API path in the board driver must be in the
  gate's allowed-routes table.

### A bot can no longer fill the host disk (1.6.1-BOT-DISK-C)

- Per-bot disk quota: instance setting `general.botDiskQuota` — a default in MB
  for every bot, per-caste (`agents.role`) and per-bot overrides, plus a
  `container.diskQuotaMb` override on the bot card (it wins). Set in the panel on
  the instance general settings page or through `GET`/`PATCH /api/myrmidon/bot-disk-quota`
  (instance admins only); applies without a restart.
- Usage is the bot's own volume `<MYRMIDON_BOT_VOLUME_ROOT>/<botKey>` (hermes,
  workspace, scratch), measured by the maintenance-tick sweep one page of bots
  per tick; a hard-linked pnpm store counts once per bot, deep or huge volumes
  stop at caps and report a lower bound.
- Approaching (>=80%) or exceeding the quota raises an attention card
  (`bot_disk_quota`) on the board's attention queue; while a bot is over quota a
  NEW execution workspace clone is refused before its directory is created, and
  the bot sees `BOT_DISK_QUOTA_EXCEEDED:` with its usage, the limit and the setting
  to fix. Existing workspaces keep working; deleting old drafts frees room.
- With no `MYRMIDON_BOT_VOLUME_ROOT` on the board's host, or no quota saved, the
  feature is inert: no measurement, no card, no refusal. Details:
  [bot-disk-quota.md](bot-disk-quota.md) / [bot-disk-quota.ru.md](bot-disk-quota.ru.md).

### Bot task workspaces are owned by the board: `myr-ws`, worktrees off a per-bot base, removal on task lifecycle events (1.6.5 BOT-DISK-H, parts H1–H5, contract H0)

- A task's working copy is now a **git worktree** of a per-bot bare base
  (`<HERMES_HOME>/.myrmidon/git-base/<owner>/<repo>.git`, standard refspec
  `+refs/heads/*:refs/remotes/origin/*`, `fetch.prune=true`, `gc.auto=0`), not a
  clone the bot made itself: no per-copy objects, no `--filter` promisor packs,
  no token in `.git/config`. The base limit is 8 repositories per bot
  (`WS_GIT_BASE_LIMIT`), a base fetch is throttled to one per 900 s
  (`WS_GIT_BASE_FETCH_MIN_INTERVAL_SEC`).
- New in-image CLI `myr-ws`: `open <KEY> [owner/repo] [--base <ref>] [--scratch]`,
  `list`, `close <KEY> [--force]`, `restore <KEY>`, `migrate`; global `--json`.
  `open` is idempotent (`reused: true` for an existing copy). Task copies live at
  `/workspace/<ISSUE-KEY>` on branch `bot/<KEY>`; scratch copies (class G) at
  `/scratch/<name>`.
- The git wrapper no longer adds `--reference`: a `git clone` of a GitHub
  repository is intercepted into `myr-ws open` (the task key comes from
  `MYRMIDON_TASK_WORKSPACE`, otherwise the clone becomes a scratch copy);
  `--filter`/`--depth`/`--mirror`/`--bare` are ignored with a message — the
  objects are already in the base. The real git moves to
  `/opt/paperclip/libexec/git` outside PATH; the credential helper stays the
  only source of auth, so a token never lands in a repository config.
- The board, not a timer, drives removal: the in-container agent `botd` fetches
  the desired state `GET /api/myrmidon/bots/me/workspaces` (`state:
  active|closing` per copy, grace `closingMinutes` 30, `scratchTtlHours` 24) and
  removes the worktree when the task turns terminal / is reassigned / its PR
  merges. A copy with unpushed work is **archived first** (branch bundle +
  patch + untracked files under `archive/<KEY>-<ts>.*` with a manifest, cap 2
  GiB and 30 days per bot) and can be brought back with `myr-ws restore <KEY>`.
  When the board is unreachable botd is fail-safe: it deletes nothing.
- Refusals are explicit, with stable exit codes parsed by the gateway:
  `3` quota/disk — the message starts with `BOT_DISK_QUOTA_EXCEEDED:` —
  `4` repository over the base limit, `5` network/fetch, `6` no such
  copy/archive, `7` unpushed work without `--force`. A run whose `workspace`
  field cannot be opened (codes 3/4/5) still starts, in `/scratch`
  (`RUN_WORKSPACE_FALLBACK_DIR`), with a warning event — never a silent
  failure.
- Observability: botd posts `POST /api/myrmidon/bots/me/disk-report`
  (bases, copies with clean/pushed flags and sizes, archives, actions, foreign
  copies with their sign; body ≤ 1 MiB, at most 200 actions) and the answer
  sets its next tick (`nextReportSec`). Attention cards:
  `bot_disk_lifecycle/agent-silent` (report older than 30 min),
  `bot_disk_lifecycle/drift`, `bot_disk_lifecycle/foreign`,
  `bot_disk_lifecycle/ws-cli`, `bot_disk_lifecycle/reflink`,
  `bot_image_stale`, `bot_disk_archive`.
- New instance settings under `general.botDisk.*`: `graceClosingMinutes` (30),
  `scratchTtlHours` (24), `partitionThresholdPercent` (85),
  `partitionRefuseOpenPercent` (90), `partitionCriticalPercent` (95),
  `pnpmStoreDir`, `pnpmImportMethod`; the per-bot quota setting is the existing
  `general.botDiskQuota`. See SETTINGS for the full table.
- Interface contract H0 (directory layout, CLI, desired state, disk report,
  dockergate routes, `/v1/runs` field, settings) is fixed in
  `docs/myrmidon/bot-disk-contract/README.md` with JSON fixtures that validate
  against the Zod schemas in `packages/shared/src/myrmidon-bot-workspace.ts`
  (PR #702). This change documents and implements against that contract;
  neighboring parts land as their own PRs.

### Selectable disk isolation scope for bots (BOT-DISK-F)

- Each bot keeps its own disk by default. The owner can now set a scope
  instance (named group, caste, reporting subtree, project, catalog team, or
  the whole company) to shared root: members share one host directory and one
  pnpm store, so hard links work across the bots of the instance. The most
  specific level wins.
- Groups are a first-class entity, managed in Instance settings or through
  `/api/myrmidon/companies/:id/bot-scopes`, with no restart.
- A change marks bots `restart required`; apply runs a checked sequence per
  bot (pause, dry-run of the move, build the replacement, stop, rename, swap,
  start-time self-check, resume). Nothing restarts by itself.
- dockergate accepts the shared bind only for enrolled bots; deploy the gate
  and the board together and enrol before applying.
- Trade-off: members share one uid and directory — share only between bots
  that trust each other. DB: four `myrmidon_scope_*` tables (migration 0300).

### The driver normalizes the bot root's traversal at apply; a blocked /bot fails with its own error (BOT-ROOT-TRAVERSE)

- A bot mounts `<volumeRoot>/<botKey>` at `/bot`, but the prepare helper only
  fixed the three subdirectories behind it: a root left `0710` by an external
  operation (51 of 74 production bots) hid `/bot` from the bot's uid 10001 and
  surfaced as a misleading "API_SERVER_KEY is required".
- The prepare helper (driver, template, dockergate mirror, contract fixtures)
  now also binds the bot root and ends with one non-recursive `chmod 0711` —
  the bot can enter `/bot` without browsing it; idempotent, no recursion or
  globs. The shared-scope layout needs no extra line.
- dockergate's isolated helper accepts exactly the four binds; the gate
  deliberately lets mode `0710` pass so the helper can reach and fix it.
- entrypoint.sh: an unexecutable bot root fails in one line naming the
  problem (recreate the bot) instead of falling through to the API-key error.
  Tests: prepare-root-traverse, entrypoint, driver/scope/gate units.

### Auxiliary calls of a bot have a cheap ceiling, never a paid fallback (1.6.5 BOT-RUNTIME-TUNING-AUX-CEILING)

- The instance setting `MYRMIDON_BOT_AUX_FALLBACK_MODELS` (a list of gateway
  model aliases) is written by the profile compiler as
  `auxiliary.title_generation.fallback_chain` and
  `auxiliary.compression.fallback_chain` in the bot's `hermes/config.yaml`.
- Hermes walks that chain before the main chain and the gateway ladder, so a
  refused auxiliary request is served by another cheap model instead of
  climbing into a paid one (02.10: a rejected `json_schema` in title
  generation was served from a paid model). Dropping unsupported
  `response_format` needs no change — Hermes keeps a per-route memo.
- Each entry resolves its own base URL and key env; an entry repeating the
  task's model is dropped; an unresolvable route drops the chain with a
  compile warning. The ceiling never covers `auxiliary.vision`.

### Compression threshold in tokens comes from the agent card; the fleet compacts at 100 000 (BOT-RUNTIME-TUNING A)

- A bot profile now carries `compression.threshold_tokens: 100000` by default, so a
  long session compacts at that count instead of at half the model's window (for
  `dashscope-glm-5.3` that was ~255k tokens and multi-minute compactions).
- The agent card gained a **Compression threshold (tokens)** field
  (`adapterConfig.models.compressionThresholdTokens`): one agent can be tuned
  without touching the instance. Empty keeps the company default.
- `MYRMIDON_BOT_COMPRESSION_THRESHOLD_TOKENS` is now an override of that company
  default instead of an on/off switch, and an explicit `0` turns the cap off
  (Hermes's own 256 000 applies). `model.context_length` and its own card field
  are unchanged.

### BOT-RUNTIME-TUNING, part C: per-model effort validation and safe default instead of medium (1.6.5-BOT-RUNTIME-TUNING)

- The agent card's "Thinking effort" field now offers only the values the
  selected model accepts (GLM models via DashScope: low/high/max), and saving
  the card rejects (422) a value the model refuses.
- An empty effort on the card no longer reaches Hermes as its global default
  "medium": the profile compiler (bot containers) and the single-run config
  overlay (hermes adapter) write the model's own safe default instead
  (GLM → high), so DashScope no longer rejects the effort and the LLM gateway
  no longer falls back to another model on every call.
- The effort registry (`effortsForModel` / `effortForModel`) is the single
  source; a future model-provider registry entry overrides the static table.

### Model fallback signal: the threshold is a board setting, and the signal shows on the bot's card (1.6.5 BOT-RUNTIME-TUNING-D2)

- The model fallback signal thresholds are instance settings, not startup
  values: `GET`/`PATCH /api/myrmidon/model-fallback/settings` read and write
  `instance_settings.general.modelFallbackSignal` (board reads, instance-admin
  writes); every key reports its origin (`settings`, `env` or `default`). The
  sweep re-resolves the row each tick and schedules the next pass by the
  returned interval, so a change of N%, the window, the minimum call count or the
  sweep period applies without a restart. `MYRMIDON_MODEL_FALLBACK_*` variables
  keep working as per-key overrides.
- The signal shows on the agent's card, not only in the attention feed.
  `GET /api/myrmidon/companies/:companyId/model-fallback/status` returns the last
  sweep's rows per agent (attributed calls, fallbacks, share, serving models,
  above-threshold flag) with the effective numbers; the agents list renders a
  `fallback N%` badge for an agent above the threshold.
- With the switch off the sweep makes no gateway request: it reads one settings
  row per interval and clears both registries, so no stale card or badge
  lingers, and turning it on takes effect within one interval.
- Built on the 1.6.1 module `server/src/myrmidon/litellm-fallback-signal/`
  (attention kind `model_fallback_alert`); the existing policy tests stay green.

### One mount per bot container, hard-linked node_modules (BOT-DISK-D)

- A bot container has one bind for its writable data: `<volume root>/<bot key>`
  at `/bot`, with `hermes/`, `workspace/` and `scratch/` inside; `/data/hermes`,
  `/workspace` and `/scratch` are links made by the image. link(2) cannot cross a
  mount point, so with three binds (and the pnpm store on a fourth) every `pnpm
  install` silently copied each package into each clone and a bot's disk grew
  ~5 GB per hour. The host layout is unchanged; helper containers keep their
  three narrow binds; dockergate accepts the single-bind body (deploy dockergate
  and the board together, as in ONE-DEPLOY).
- The pnpm store lives inside the mount (`/workspace/.pnpm-store`) and pnpm runs
  with `package-import-method=hardlink`. pnpm 9 still copies silently when the
  kernel refuses a link, so the guard is the start-time self-check, not pnpm.
  `/cache/pnpm` stays a download cache only. Settings `general.botDisk.pnpmStoreDir`
  and `pnpmImportMethod` replace `pnpmStore` (`workspace`/`shared`), applied on
  the next reconcile pass (Instance -> General).
- Every container start checks that a hard link from the store into
  `/data/hermes`, `/workspace` and `/scratch` works; a failure is logged and
  shown as an attention card (`bot_disk_lifecycle`) via the clone-hygiene report.
  The image build checks all three roots and the repository test runs the script.
- Migrating running bots: [bot-disk-cache.md](../bot-disk-cache.md#migrating-running-bots-to-the-single-mount).
  Removed: the `pnpmStore` key (a stored value is ignored) and its `shared` mode.

### `devbuild`: bot builds and tests on the build VPS (BUILD-OFFLOAD B)

- The dev bot image carries `/opt/paperclip/bin/devbuild` (root-owned, from
  `docker/bot-runtime/devbuild/devbuild`): it rsyncs the `/workspace` repo
  copy (`.git` included, `node_modules` and build outputs excluded) to
  `$DEVBUILD_BASE/<bot>/<repo>/` on the shared build VPS over ssh, runs the
  given command there with the shared caches exported
  (`npm_config_store_dir=/srv/devcache/pnpm`, `GOMODCACHE`, `GOCACHE`,
  `GRADLE_USER_HOME` — created on first run, shared by all bots) and passes
  the exit code through. Heavy jobs (`pnpm -r typecheck`, full test suites,
  `go test`) run there instead of inside the 1 CPU / 3 GB bot container;
  editing, git and pushing stay local.
- Connection settings come only from the bot profile env (`DEVBUILD_HOST`,
  `DEVBUILD_USER`, `DEVBUILD_BASE`) — nothing is baked into the image or
  tests; without them the script prints a pointer to the `devbuild` skill and
  exits 1. The ssh key is read from `/opt/devbuild-ssh/id_ed25519`, mounted by
  the runtime template; key authorization and remote resource limits are the
  fleet operator's part. The image adds `rsync` for the transport.
- New skill `skills/devbuild/SKILL.md` documents when to use it, the env
  table, where the caches live, how to collect results and the typical
  errors, with pnpm/tsc/go examples.

### Change fragments: new sections, prose, row replacement and a converter (CHANGE-FRAGMENTS)

- A fragment can now carry what used to force a hand edit of the shared
  registry documents: whole new `##` sections for DIVERGENCE.md / SETTINGS.md /
  SETTINGS.ru.md (`…-new`), prose or tables inside an existing section
  (`…-append`) and rewritten table rows (`…-replace`), each with an anchor by
  section heading, occurrence number or exact line. Fragments are applied in
  plain code-unit order of their file names, so the assembled documents do not
  depend on how the file system lists them.
- `scripts/myrmidon/release/fragments-from-diff.mjs` converts a branch that
  already edited the shared documents: it writes the equivalent fragment,
  reverts the documents, and checks that assembling the fragment reproduces
  the branch's own edit (a mismatch stops the run). Format and usage:
  `docs/myrmidon/changes/README.md`.

### Chat reconciliation asks a cheap "is there work" gate before each lane (DB-PERF-C-P5)

- The chat reconciliation coordinator ticks once a second and ran every durable
  lane on every tick, whether or not the lane had anything to do. Measured over
  04–06.10 on the production database: the run-milestone projection 37k calls ×
  58.7 ms (≈2197 s CPU), the `chat_actions`/`agent_wakeup_requests` sweeps 34k ×
  74.6 ms (≈2556 s CPU) and ~921k sequential scans over `chat_publications`
  (~1.65e9 tuples) — ≈5.5k s of CPU in a 13.6 h window while the queues were
  almost always empty.
- Every gated lane now answers one cheap question first, with ONE statement of
  the shape `select 1 where <probe> limit 1` over the lane's own outbox (module
  `server/src/myrmidon/chat-reconciliation/work-gates.ts`): the publication
  flush probes the due `chat_publications` rows (`chat_publications_work_idx`),
  the delivery lane probes `chat_deliveries` plus every `chat_actions` kind it
  drains (`chat_deliveries_work_idx`,
  `chat_actions_inbound_wakeup_sweep_idx`), the Slack lanes probe their own
  `chat_actions` kind, and the run-milestone lane probes runs of live chat
  conversations updated after the last completed pass
  (`heartbeat_runs_company_ctx_issue_created_idx`). A gate that answers "no
  work" skips its lane for that tick.
- The probes are deliberately conservative: a probe may report work for a queue
  that turns out to be empty (the lane then behaves exactly as before), never
  the other way round. Nothing was rewritten inside the lanes themselves.
- `notifyPublications()` — the live "a publication was committed" signal —
  bypasses both gates for exactly one forced pass of the publication and
  milestone lanes, so a fresh commit cannot wait for the next tick that happens
  to have other work. Periodic recovery polls do not force anything.
- The run-milestone lane keeps a watermark of its last completed pass in
  process memory. The first tick after a start/restart is always a full pass
  (nothing accumulated while the process was down is lost), a pass that
  inserted anything does not move the watermark (the projection may have
  stopped at its own row budget with older candidates still unprocessed), and
  one full pass per 10 minutes bounds the delay of a candidate that becomes
  eligible without a run being updated.
- The Telegram-notify proactivity sweep used to sit in front of the publication
  flush inside the same lane. It is a producer for that queue, so it moved to
  its own lane and keeps its cadence while the flush is gated.
- The publication lane also runs two notice producers
  (`enqueueInboundWakeupPublications`, `enqueueFailedChatRetryPublications`)
  whose condition is "a settled wakeup whose notice publication is still
  missing". That one question cannot be asked inside a cheap index probe — it
  costs a scan of the whole settled-wakeup population plus one publication
  probe per row, and measured slower than the sweep it would replace — so the
  lane reaches those producers through a safety window instead: one forced pass
  every 5 seconds. An idle instance therefore pays for the sweep a fifth as
  often (a fifth of its previous share of the tick), and a notice waits at most
  that window; any other publication work, or a live commit signal, opens the lane
  immediately.
- Left ungated on purpose: provider-runtime reconciliation, GitHub webhook
  delivery recovery, and the periodic Telegram endpoint state-repair staging
  inside `processPendingTelegramMaintenance` (its condition is a
  runtime-derived scope that SQL cannot reproduce, and the same staging is
  reached from the endpoint lifecycle paths).
- No migration: the gates use the index set of the release they land in.

### Fix: chat reconciliation work gates failed on every call (DB-PERF-C-P5)

- The cheap work gates bound a JavaScript `Date` as a parameter inside raw
  `sql` templates (`next_attempt_at <= $1`, `updated_at > $1`), which the
  postgres-js driver cannot serialise. Every gate probe threw, so the log
  filled with `Failed to reconcile chat run milestones` and `Failed to
  reconcile chat publications` roughly every 30 seconds. Timestamps are now
  bound as ISO strings with an explicit `::timestamptz` cast. A regression test
  runs the gates against a real PostgreSQL.

### Knowledge corpus pilot: pgvector search matches RAGFlow (CORPUS-2.0 step 3)

- The step 3 pilot of the corpus epic measured retrieval on PostgreSQL +
  pgvector against the RAGFlow baseline: recall@5 0.8429 vs 0.829, nDCG@10
  0.7056 vs 0.663, p95 search latency ~0.1 s vs ~15 s (gate p95 < 2 s passed
  with a wide margin). Recommendation for the future corpus module: DashScope
  `text-embedding-v4` (1024 dimensions) via the LiteLLM gateway, HNSW index
  (`m = 16`, `ef_construction = 64`, `ef_search = 64`), hybrid retrieval with
  RRF (`k0 = 60`, `k_candidates = 100`) and a `pg_trgm` GIN full-text index;
  embedding cost ~$1.64 per 100,000 chunks. The pilot ran outside the product
  and changes nothing in this build; the record and the decision are in
  [design/corpus-pgvector-pilot.md](design/corpus-pgvector-pilot.md).

### Data retention: the run and log windows in instance settings (1.6.5-DB-RETENTION, UI part)

- The general instance settings page shows a "Data retention" panel that edits
  the three whole-day windows of the grown tables: "Run history"
  (`heartbeatRunsDays`), "Activity log" (`activityLogDays`) and "Access audit
  logs" (`accessAuditDays`). `0` keeps the rows forever. The values are saved
  through `PATCH /api/myrmidon/data-retention` and the cleanup sweep re-reads
  them on every run, so a saved value applies without a restart.
- An input accepts only a whole number of days (`0` or more); anything else —
  a negative or fractional draft — shows an inline error and no request is
  sent, the same draft pattern the host disk panel uses.
- The panel reads `GET /api/myrmidon/data-retention` and shows the state of the
  last cleanup: the time of the last sweep and of the last backup check, how
  many rows were deleted and how many bytes were freed per table group, and the
  total freed.
- While the sweep is waiting for a fresh backup (`waitingForBackup: true`) the
  panel shows a visible note that cleanup starts once a backup younger than
  24 hours exists — nothing is deleted until then.
- Each window also shows whether its value comes from the stored settings or
  from the default. On an instance that does not serve the route the section is
  not rendered at all, so the settings page never shows an empty block of dead
  inputs. The server side of the feature ships separately; until it lands, the
  panel reads the contract above.

### Retention of runs and logs: settings, sweep and backup gate (1.6.5 DB-RETENTION, server core)

- Finished heartbeat runs and access-audit rows now age out on a schedule
  (the activity log is the audit trail and is kept forever by default —
  `activityLogDays: 0` — until the instance admin opts into a limit). Three
  new instance settings —
  `instance_settings.general.datastoreCare.retention.heartbeatRunsDays`,
  `...activityLogDays` and `...accessAuditDays` — set the retention per table
  group in whole days (defaults: runs 90, activity log 0 = kept forever — it
  is the audit trail, access audit 180; `0` keeps the group forever). The
  settings live in the datastore-care object of the §3.6 "Хранение" panel
  (`general.datastoreCare.retention`); the stored value is the single truth,
  an absent row applies the defaults.
- A retention sweep runs at most one pass per 10 minutes (the 30 s scheduler
  tick no-ops in between), deleting in batches of 5000 rows (at most 100
  batches per table per pass, under a 60 s statement timeout) — every batch
  is its own transaction, so a failed batch rolls back only itself, and a
  batch that hits the timeout writes one `data.retention_sweep_throttled`
  activity line instead of being swallowed silently. The sweep state
  (`lastRun`) is written only when a pass actually deleted something or the
  backup-gate flag changes — not on every idle tick. A run is deleted only
  when it is finished, past the retention and not referenced by open work:
  runs of open issues (execution/checkout), retry parents of live runs and
  the sources of unresolved failed-run attention items survive, as do the
  activity rows of every surviving run (the audit trail stays complete). A
  run referenced by any decision-making or native completion record
  (decisions, decision bundles, status decisions, work assessments, native
  run results) is never deleted — those records outlive the run. Run events
  go with their run; financial rows keep their record with the run reference
  cleared.
- The sweep never deletes without a fresh verified database backup: when the
  newest `<prefix>-*.sql.gz` in the configured backup directory is older than
  24 hours (or missing), the pass deletes nothing, writes one
  `data.retention_waiting_for_backup` activity line (at most once per hour)
  and reports `waitingForBackup` in its status; the gate lifts on the next
  pass once a fresh backup appears. The filename prefix is configurable via
  `MYRMIDON_DB_BACKUP_FILE_PREFIX` (default `paperclip`) — see
  [SETTINGS.md](../SETTINGS.md).
- `GET /api/myrmidon/data-retention` (board-readable) reports the three
  values with their source (`settings` | `default`) and the last pass
  (timestamp, per-table deleted counters, a freed-bytes lower bound, the
  backup-gate state, all persisted across restarts).
  `PATCH /api/myrmidon/data-retention` (instance-admin) changes the values;
  the sweep re-reads them at the top of every pass, so no restart is needed.
  The settings UI ships separately (part P2).

### Four audit indexes for the heartbeat_runs and issues hot paths (1.6.5 DB-AUDIT-INDEXES)

- The PostgreSQL audit measured four hot query groups that the planner could
  not serve with any existing index: the attention feed over `heartbeat_runs`
  (company + agent id + created_at window — 1 926 s per 13.6 h statistics
  window), the chat-reconcile milestone projection (company +
  `context_snapshot->>'issueId'` + status — 2 197 s), and the issue claim
  lockup (`FOR UPDATE` on company + execution_run_id / checkout_run_id —
  2.6k s, a Seq Scan that also locked neighbouring rows).
- Migration `packages/db/src/migrations/0306_audit_indexes_heartbeat_issues.sql`
  adds four plain b-tree indexes:
  `heartbeat_runs (company_id, agent_id, created_at)`,
  `heartbeat_runs (company_id, (context_snapshot->>'issueId'), status)`,
  `issues (company_id, execution_run_id)`,
  `issues (company_id, checkout_run_id)`.
- `CREATE INDEX IF NOT EXISTS`, no `CONCURRENTLY`: drizzle migrations run
  transactionally. Both tables are bucketed "medium" by the migration-safety
  checker, so a plain build is the accepted form here; production deploys run
  through the operator's maintenance mode.
- The audit's blocker expression index (company, coalesced issue reference,
  created_at) is not in this migration — the hot-queries PR persists it as
  migration 0302, and this branch deliberately does not duplicate it.
- Guard: `packages/db/src/audit-indexes-migration.myrmidon.test.ts` checks the
  migration file, the journal entry and the snapshot statically, confirms the
  four audited query shapes plan onto the new indexes on embedded Postgres, and
  applies the migration twice on one database to prove idempotency.

### Five audit indexes and lz4 column compression, persisted from the production database (1.6.5 DB-CARE)

- The datastore audit of 07-08.10.2026 created five indexes by hand on the
  production board database. Migration
  `packages/db/src/migrations/0308_db_care_audit_indexes.sql` persists the five
  statements verbatim, each as `CREATE INDEX IF NOT EXISTS`, so the deploy on
  production is a no-op and a fresh installation builds the same indexes.
- The five indexes: `activity_log_issue_last_activity_idx` (partial
  `(company_id, entity_id, created_at DESC)` without the read/inbox marker
  actions), `issue_comments_body_lower_trgm_idx` (partial GIN on
  `lower(body) gin_trgm_ops` without deleted rows),
  `heartbeat_runs_attention_feed_idx` (`(company_id, agent_id, created_at,
  context_snapshot->>'issueId', context_snapshot->>'taskId')`),
  `heartbeat_runs_ctx_paperclip_issue_id_idx` (partial
  `(company_id, context_snapshot->'paperclipIssue'->>'id')`) and
  `heartbeat_runs_updated_at_idx` (`updated_at`).
- No `CONCURRENTLY`: drizzle migrations run transactionally. `activity_log` and
  `issue_comments` are bucketed "large" by the migration-safety checker, so
  those two statements carry the explicit
  `paperclip:migration-safety-ignore large-create-index-not-concurrently` note.
- Migration `packages/db/src/migrations/0309_db_care_lz4_compression.sql` sets
  the compression method `lz4` on the three largest varlena columns of
  `heartbeat_runs` (`context_snapshot`, `result_json`, `stdout_excerpt`). The
  statement is catalog-only: a short `ACCESS EXCLUSIVE` lock, no row rewrite, and
  the rows already stored keep their method until they are rewritten. On
  production the three columns already carry `l`, so the statement is a no-op
  there.
- That migration is one procedural block on purpose. PostgreSQL has no catalog
  view of the available compression methods, and a build configured without
  `--with-lz4` rejects the statement (the project's own embedded-Postgres test
  harness is such a build). A plain statement would stop the whole migration
  chain on those installations for a storage tuning that is not a correctness
  requirement. The block applies `lz4` where the build offers it and otherwise
  keeps the current method and writes a notice to the deploy log.
- The Drizzle schema declares the five indexes
  (`packages/db/src/schema/activity_log.ts`, `heartbeat_runs.ts`,
  `issue_comments.ts`, label `myrmidon(DB-CARE)`), and the `0308`/`0309`
  snapshots record them, so `db:generate` stays clean and the schema tells the
  same story as production's `pg_indexes`. Compression is a storage parameter,
  so it adds no schema object and `0309_snapshot.json` repeats the `0308`
  snapshot.
- The identifier indexes of `issues` need no change: production carries
  `issues_identifier_idx` (unique btree) and `issues_identifier_search_idx`
  (GIN `gin_trgm_ops`), which are two different indexes and both are already
  declared in the schema.

### Previous-assignee index on the activity log, persisted from the production database (1.6.5 DB-CARE)

- The datastore audit of 07-08.10.2026 created `activity_log_issue_prev_assignee_idx`
  by hand on the production board database: the attention feed resolves, for one
  agent, the issues whose assignee *left* that agent, reading the audit rows'
  payload `details->'_previous'->>'assigneeAgentId'` for `issue.updated` rows of
  a company and ordering by `created_at`.
- Migration `packages/db/src/migrations/0307_db_care_issue_prev_assignee_index.sql`
  persists the statement verbatim (`CREATE INDEX IF NOT EXISTS ... USING btree
  (company_id, ((details -> '_previous' ->> 'assigneeAgentId')), created_at)
  WHERE entity_type = 'issue' and action = 'issue.updated'`). On production it
  is a no-op; a fresh installation builds the same index.
- `CREATE INDEX IF NOT EXISTS`, no `CONCURRENTLY`: drizzle migrations run
  transactionally. `activity_log` is bucketed "large" by the migration-safety
  checker, so the statement carries the explicit
  `paperclip:migration-safety-ignore large-create-index-not-concurrently` note,
  as the earlier activity_log indexes do.
- The Drizzle schema declares the index (`packages/db/src/schema/activity_log.ts`,
  label `myrmidon(DB-CARE)`) and `0307_snapshot.json` records it, so
  `db:generate` stays clean and the schema tells the same story as production's
  `pg_indexes`.
- The remaining production objects of the same audit (five more indexes and the
  `lz4` column compression) land with the same pull request as migrations `0308`
  and `0309` — see `docs/myrmidon/changes/db-care-audit-indexes-lz4.md`.

### DB-TUNING: the PostgreSQL settings of the database audit are applied declaratively by the deploy (deploy.sh / rollback.sh)

- `scripts/myrmidon/deploy/db-tuning.sql` and
  `scripts/myrmidon/deploy/db-tuning-rollback.sql` — the declarative source of
  the settings from the OPE-4270 audit lives in the repository: `jit=off`,
  `work_mem=16MB`, `wal_compression=lz4`, `autovacuum_vacuum_scale_factor=0.05`
  (with `0.02` for `heartbeat_runs`, `agent_wakeup_requests`,
  `company_secrets`), `autovacuum_analyze_scale_factor=0.02` for `issues`, plus
  `pg_reload_conf()`. The rollback file resets exactly those. No manual
  `ALTER SYSTEM` on the live server anymore.
- `scripts/myrmidon/deploy/lib.sh` — four new optional deploy settings
  (`load_config`): `DB_TUNE_COMMAND` applies the tuning file (empty — the step
  is skipped), `DB_TUNE_SHOW_COMMAND` prints a `SHOW` value for the parameter
  name in `DB_TUNE_PARAM`, `DB_TUNE_EXPECTED` lists the `name=value` pairs to
  verify, `DB_TUNE_ROLLBACK_COMMAND` returns the previous settings (empty — the
  settings rollback is skipped with a warning). Before the first apply the
  live values are recorded to `$STATE_DIR/db-tuning-previous`.
- `scripts/myrmidon/deploy/deploy.sh` — a new step after the health check:
  apply, then verify every expected pair through SHOW; a mismatch is
  DEPLOY FAILED — maintenance stays on, the rollback command is printed, and
  the half-applied settings are returned via `DB_TUNE_ROLLBACK_COMMAND`
  (same failure shape as the health step). The dry-run plan describes the step
  like the others.
- `scripts/myrmidon/deploy/rollback.sh` — after the image and health steps:
  apply `DB_TUNE_ROLLBACK_COMMAND` and verify the same parameters SHOW against
  the recorded previous values; a mismatch fails the rollback loudly with
  maintenance staying on.
- `scripts/myrmidon/deploy/deploy.env.example` — the four settings documented
  with production examples.
- `docs/myrmidon/deploy.md` / `docs/myrmidon/deploy.ru.md` — a "DB-TUNING"
  section: the audit values, where the declarative source lives, how the
  deploy applies and verifies (SHOW), how the rollback returns, and the exact
  `pg_stat_statements` query for the before/after top-query timing.
- Tests: `scripts/myrmidon/deploy/deploy.test.mjs` — the step is skipped when
  `DB_TUNE_COMMAND` is empty; a matching SHOW passes; a SHOW mismatch fails the
  deploy, keeps maintenance on and rolls the settings back; `rollback.sh`
  applies `DB_TUNE_ROLLBACK_COMMAND` and restores the previous values.

### Run-context retention: heartbeat_runs context compaction as a board function (1.6.5-DBC1)

- The bulky continuation payloads of finished runs (`executionContinuation`,
  `paperclipWake`, `paperclipTaskMarkdown`/`…Compact`,
  `paperclipWakeComment`, `paperclipSessionHandoffMarkdown`,
  `paperclipContinuationSummary`, `externalChatContinuation` — the O1a key
  list) are now compacted out of `heartbeat_runs.context_snapshot` by the
  board itself: every terminal run older than
  `instance_settings.general.datastoreCare.retention.heartbeatRunContextDays`
  (env `PAPERCLIP_HEARTBEAT_RUN_CONTEXT_RETENTION_DAYS`, default 7 days, 0 =
  disabled) has those keys stripped and `_compactedAt` stamped in its
  snapshot. Small keys (taskKey, issueId, wakeReason) survive; attention-feed
  derivations and audit queries keep working. Compaction is a rewrite, not a
  row delete.
- The compaction runs on the maintenance sweep tick under the maintenance
  gate (it does nothing while an instance window is open), in batches of 500
  rows per statement with a 250 ms pause between batches and a 30 s
  statement timeout per batch, and only when the backup precondition holds:
  the newest matching backup (`<prefix>-*.sql.gz` or `<prefix>-*.dump`; with
  an empty `MYRMIDON_DB_BACKUP_FILE_PREFIX` any `*.sql.gz`/`*.dump` in the
  dir) in the configured backup dir must be under 24 hours old. Without a
  fresh backup the pass rewrites nothing and logs one throttled
  `datastore.retention_waiting_for_backup` line (at most once per hour),
  carrying the checked dir, prefix and the names it saw; the pass state
  keeps the full gate verdict under `contextLastRun.backupGate`.
- Each pass writes one `datastore.retention_applied` activity line per
  company that had work, carrying `compactedRows` and `freedBytes` (the exact
  `pg_column_size` delta of the rewritten snapshots), and persists its state
  in `general.datastoreCare.retention.contextLastRun`, so the counters survive
  restarts.
- `GET /api/myrmidon/datastore-care` (board-readable) reports the resolved
  window with its source (`settings` | `env` | `default`) and the last pass;
  `PATCH /api/myrmidon/datastore-care` (instance-admin) changes the window —
  the sweep re-reads it every pass, no restart needed. The retention
  sub-block is the same `datastoreCare` block the row-deletion limits
  (OPE-5011) live in, so the UI shows one "Storage" panel. The settings UI
  ships separately.
- With the board compaction live, the host-side O1b cron job becomes
  redundant and must be removed at rollout (recorded in the deploy repo, not
  here).

### Deploy hardening: a deploy that fails early and says why (DEPLOY-HARDENING)

- One source of truth per component image: the generated override file is
  what the deploy writes, the rollback restores and the boot unit reads; the
  previous image comes from `docker inspect`, not a file, and a stale
  override is corrected before the deploy starts.
- `--dry-run` runs the real preflight: compose project, boot unit, service
  and health settings and the dockergate config check on the edited copy —
  the dry run fails exactly when the real run would.
- dockergate health is proven by its log (`self-check ok` /
  `config_reloaded` reporting the new version and config hash), not by a
  `_ping` the host cannot make through the socket; rollback uses the same
  proof.
- Config writes keep the file's owner and mode (a strict umask no longer
  makes dockergate's config unreadable), and after SIGHUP the deploy verifies
  the loaded config hash and fails loudly otherwise.

### The board image is proven on a copy of the production database before the window; rollback without a live board (PREDEPLOY-DB-CHECK)

- `scripts/myrmidon/deploy/predeploy-board-check.sh` (new): before the
  maintenance window the production dump is restored into a throwaway Postgres
  and the new board image runs next to the new dockergate on an isolated
  network; it waits for `/api/health` `ok` with the image's version, walks the
  attention list and main routes, and any failure stops the deploy with
  nothing changed on production (the 1.6.3 crash on production data inside
  the window is why it exists).
- deploy.sh step 3b runs it pre-window; changed components roll out BEFORE
  the board switch; rollback of the board happens only if its image line was
  written.
- rollback.sh no longer needs the board API to enter/leave maintenance — a
  rollback usually runs BECAUSE the board is down; the image switch and health
  check still decide. `maintenance_enter` reports a failed enter honestly.
- New `MYRMIDON_PREDEPLOY_*` settings (check on by default); tests walk the
  whole throwaway stack against fake `docker`/`curl`.

### The board no longer storms dockergate; a fleet rollout fits the gate's limit (1.6.5-DOCKERGATE-A2A3-STORM)

- On 05.10 (rc.1) the board sent 5 395 allowed A2/A3 requests to dockergate
  in three minutes (~30/s against the gate's global 50/s bucket, 394 429
  refusals); a five-bot rollout batch took 6–10 minutes with most applies
  failing on 429. Four stacked causes fixed: the clone-hygiene report
  collector asked every bot every 5 s maintenance tick; the reconcile pass
  inspected each bot twice; the post-apply health wait polled every second;
  a 429 failed the pass only to hammer the gate on the next tick.
- The collector moved to its own timer (`MYRMIDON_CLONE_REPORT_INTERVAL_SEC`,
  default 300 s — reports are valid 24 h), reconcile
  probes status and drift from one inspect (2 gate requests per bot per pass
  instead of 3), the health wait polls every 5 s (was 1 s), and the gate client
  has a token bucket (`MYRMIDON_DOCKERGATE_MAX_RPS`, default 20/s across all
  loops) and a 429 retry with exponential backoff and jitter, honouring
  `Retry-After`, up to 5 retries.

### The board generates the media ACL registry and the facade reloads it without a restart (MEDIA-PROVISION, part B)

- New exporter in the bot-container sweep (`server/src/myrmidon/bot-containers/media-acl-export.ts`):
  every reconcile pass collects the fleet's cards and rewrites the media MCP
  `bots.json` itself — for every container bot whose card env resolves a
  non-empty `MEDIA_TOOLS_TOKEN`, one entry `{token_sha256, peer_host, tools}`
  keyed by bot key, `peer_host` the container's docker-DNS name, `tools` the
  default allowlist of `tools/media-mcp/config.example.json`. A card without a
  token contributes no entry. The exporter never creates tokens (provisioning
  is the separate card-side half of the track) and never writes or logs the raw
  token — the file carries only its sha256.
- The rewrite is atomic (temp file + rename, mode 0600) and deterministic
  (bot keys sorted): the file is touched only when its text or mode actually
  changed, so the facade sees exactly the card changes. A failed export leaves
  the previous registry in place and is recorded in the reconcile activity log;
  a single card whose env cannot be resolved is skipped (counted), not fatal
  for the fleet.
- Because the exporter owns the file, hand-narrowed per-bot entries are
  rewritten back to the default allowlist on the next pass. Per-bot tool
  narrowing needs a card knob of its own (out of this part's scope).
- The media MCP facade hot-reloads the registry (`tools/media-mcp`): the
  authenticator now revalidates `bots.json` by an `(mtime_ns, size)` stamp
  before each authentication (stat at most once per `MEDIA_BOTS_RELOAD_INTERVAL_S`,
  default 1s) and re-reads it only when the stamp changed. A broken or vanished
  rewrite keeps the last valid registry and logs a warning — the facade stays
  up for the bots that already authenticate against it. Card changes reach the
  facade without a process restart.
- New settings: `MYRMIDON_MEDIA_BOTS_FILE` on the board server (where the
  exporter writes; default `/config/bots.json`, the facade's own
  `MEDIA_BOTS_FILE` default, so one shared bind of the same path needs no
  second setting) and `MEDIA_BOTS_RELOAD_INTERVAL_S` on the facade service.
  The exporter runs only while `MYRMIDON_BOT_CONTAINERS` is enabled.
- One-time rollout is NOT part of this change: regenerating the registry for
  the whole fleet and issuing tokens to the bots still without one stays an
  operator/release step after merge (it happens on the first enabled pass by
  itself — the exporter writes whatever the cards carry).

### Fragments with a settings-ru section fold into the RU settings document again

- `collect-fragments.mjs` resolves the `settings-section` heading inside
  SETTINGS.ru.md by a language-independent key (release version + the all-caps
  feature-id tokens of the heading) when the exact EN heading is absent, so a
  fragment that names the EN section — as every fragment does — folds its
  `settings-ru` rows into the Russian variant of that section instead of
  failing the release cut (the RU file never carried the EN headings, contrary
  to what the fragment README claimed; `bot-disk-quota.md` hit exactly this).
  An exact heading still wins; an ambiguous key match is not guessed and fails
  loudly as before.
- `change-fragments-gate-selftest.test.mjs` now also runs
  `collect-fragments --version 0.0.0 --dry-run` over the checked-out tree: a
  fragment the collector cannot fold turns the PR red before merge instead of
  breaking the next release cut. No workflow file was touched — the check
  rides the existing `node --test` step of the `checks` job.

### The shared git object store shows its facts, and one command accepts it on a live bot (1.6.5 BOT-DISK-G, part B)

- The start-time self-check records the store's state (`storeState` in
  `git-objects-check.json`: path, enabled, mirrorCount, totalBytes, bounded
  `repos[]`), the same facts ride the clone-hygiene report, and the board
  parses both; an older image reads as `null`, never as an error.
- `GET /api/myrmidon/agents/:id/bot-container/git-store` answers the facts to
  an agent key — the one bot-container route that is not board-only. It reads
  the report file only: no exec into the bot.
- Acceptance is one command on the board host:
  `scripts/myrmidon/deploy/git-objects-live-acceptance.sh --bot <container>` —
  it clones twice inside one live bot and checks that the store holds a mirror
  (≥100 MiB default) and the second clone borrows from it (alternates entry,
  ≤20 MiB `.git`); prints PASS/FAIL per criterion.

### GitHub wiki: installation is one command, requirements with real numbers

- `docs/wiki/Installation`, `docs/wiki/Quick-start` (EN+RU) — rewritten around
  the one-line installer: `curl -fsSL https://github.com/itkadr-git/myrmidon/releases/latest/download/install.sh | sudo bash`.
  The page walks what the installer does step by step, what the user sees at
  the end, what to do when a step fails, and the options (`--version`,
  `--dir`, `--port`, `--interactive`, `--lang`, `--uninstall`).
- `docs/wiki/System-requirements` (EN+RU) — real numbers instead of "the docs
  do not name them": the installer's minimums (Ubuntu 24.04 / Debian 13,
  x86_64/aarch64, 2 CPU, 4 GB RAM, 10 GB disk, port 3100) and recommendations
  from the project's own production server (16 cores / 64 GB RAM for 74
  agents; 1–4 GB per agent, 8 GB for the board and database).
- `docs/wiki/Manual-deployment` (EN+RU, new) — the hands-on `deploy.sh`
  maintenance-window flow moved off the front pages, for experienced
  administrators.
- `docs/wiki/Upgrading-and-rollback` (EN+RU) — the installer re-run is now
  the primary update path (database dump and automatic rollback included);
  the `deploy.sh` flow remains as the operator reference.
- `docs/wiki/Home` (EN+RU) — the page list reflects the new structure.

### Run-ownership probe no longer reads the whole runs table (1.6.5 HEARTBEAT-POLL)

- The wake path's ownership question (`getConversationOwnershipBlocker`)
  filters one company, terminal legacy runs and the issue reference, plus
  correlated `exists` predicates — with no index carrying the issue
  reference, the planner read the whole runs table per call.
- Migration `0301_heartbeat_run_ownership_index.sql` adds one partial index
  on `(company_id, coalesce(native_issue_id::text,
  context_snapshot->>'issueId'), created_at DESC, id DESC)` where the run is
  legacy and terminal, making the equality selective and the `ORDER BY` free.
  No query, schema or behaviour change.

### Apply wipes the vendor's config backups out of hermes volumes (HERMES-CONFIG-BACKUP-SECRETS)

- The vendored Hermes CLI snapshots `config.yaml` into `hermes/backups/config/` on
  every successful config load and offers no switch to disable it, so those copies
  (which can carry the gateway credential once the CLI resolves it) reached host
  backups. The generated profile apply script now removes `data/hermes/backups` as
  a best-effort step after the staged files land and before the applied-state
  marker, so a leak is cleaned up on the next profile rebuild of every bot and an
  `rm` failure can never abort the apply.
- The dockergate gate's embedded apply-script template and contract fixtures carry
  the same step; tests pin the cleanup's presence and its order relative to the
  marker, and that the compiler never writes a secret value into `config.yaml`
  (only a `${VAR}` reference; the key lives in `hermes/.env`, mode 0600).

### Bot runtime builds hermes from the author's repository (HERMES-UPSTREAM)

- The bot image now clones hermes-agent from `NousResearch/hermes-agent` at the pinned tag and commit (`HERMES_GIT_REF`, `HERMES_GIT_SHA`) instead of a separate mirror fork. The fork was a byte-identical mirror; our hermes changes already live in `docker/bot-runtime/patches/`. The pinned commit keeps the build reproducible.

### A review that waits on a person is a lawful wait state (HUMAN-REVIEW-WAIT)

- An issue delivered to review (`in_review`) that stays assigned to its agent
  executor can now declare `reviewPolicy: "human_only"` as its review path.
  The board then treats the review as covered by a human reviewer: the executor
  is not woken, no "review path lost" recovery fires, no disposition is
  demanded, and automatic review routing never hands the verdict to an agent
  reviewer. A human comment or attachment still wakes the assignee as usual.
- Before the fix, a review the owner (a person) must approve looked stalled to
  the board's liveness mechanism: after every finished run the executor got an
  `issue_review_path_lost` wake every few minutes and each turn ended with
  another "waiting for the owner" comment. A deliberate `blocked` wait with an
  `unblockDescriptor` was also rolled back to `in_progress` minutes later by
  the stale-block watchdog when the reason was an event gate without a readable
  key, and the liveness sweep then demanded a disposition. Key-less event
  reasons are now unknown facts: the watchdog leaves the block alone.
- Agents moving an issue to `in_review` may set `reviewPolicy: "human_only"`
  in the same update as the review path; the invalid-disposition guard accepts
  it next to an interaction, approval, human assignee, review participant or
  monitor.
- The decisions feed shows only reviews that genuinely lack a maintained path
  (PAP-16080): a covered human wait is by definition not a stalled-review
  card, so no "choose review path" demand appears while the person reads.

### The model input limit is checked before a run is sent (1.6.5-INPUT-LIMIT, OPE-6168)

- The board resolves the agent model's input limit from the model catalog (`litellm_models.maxInputTokens`; override with adapter config `inputLimitTokens` / `inputLimitChars`) and passes it to the adapter.
- When the task's session already holds so many prompts that the next one would not fit, the run starts a fresh session (new `hermes_gateway` session-key generation) and records a `fresh_session` lifecycle event instead of sending into the full session.
- The `hermes_gateway` adapter trims a request that alone exceeds the budget (head and tail of the input kept, the cut named in the middle) instead of sending it to a provider that rejects it.
- Tunables: `MYRMIDON_INPUT_LIMIT_PRECHECK=0` (off), `MYRMIDON_INPUT_LIMIT_CHARS_PER_TOKEN` (3), `MYRMIDON_INPUT_LIMIT_SAFETY` (0.9). See `docs/myrmidon/input-limit-precheck.md`.

### Input-overflow guard and fresh session on automatic retries (1.6.5-INPUT-OVERFLOW, OPE-6168)

- Automatic `transient_failure_retry` runs start a fresh task session instead of resuming the failed attempt's session (upstream #15487); the codex same-session first step is kept.
- New error family `input_overflow` for provider input-length rejections (DashScope, OpenAI, Anthropic, Gemini, generic wording table); `hermes_gateway` sets it and the server also detects it by text.
- After an overflow failure the next attempt uses a fresh session (task session dropped, `hermes_gateway` session key gets a generation suffix); after N consecutive identical failures on one issue (`MYRMIDON_INPUT_OVERFLOW_MAX_FAILURES`, default 3) automatic retries stop and the issue is escalated with the facts. See `docs/myrmidon/input-overflow-guard.md`.

### Task list orders by a stored last-activity column (DB-PERF-P7)

- `GET /issues` and the blocked-inbox list no longer recompute the "last activity" of every
  candidate task with two correlated `MAX` subqueries (`issue_comments`, `activity_log`) before
  the `LIMIT` — that per-row aggregate was the endpoint's dominant cost. The value is now
  stored in `issues.last_activity_at` and indexed by `(company_id, last_activity_at)`.
- The stored value is `greatest(updated_at, newest comment, newest activity row)` per company,
  exactly as before; local inbox bookkeeping (`issue.read_marked`, `issue.read_unmarked`,
  `issue.inbox_archived`, `issue.inbox_unarchived`) still does not count as activity.
- The column is maintained by triggers, not by call sites: a new comment or activity row raises
  it, an issue update that moves `updated_at` raises it, and it never moves backwards.
- Migration `0355_issues_last_activity_at` is additive (new column with a default, new index,
  triggers); the previous image keeps working on the new schema. Existing rows are backfilled
  with the expression the endpoint used before.

### Bots' Hermes local memory behind an instance switch (MEMORY-CENTRAL-A)

- `MYRMIDON_BOT_LOCAL_MEMORY_OFF` (off by default): when set truthy (`1`/`true`/`yes`/`on`), every bot container's compiled `hermes/config.yaml` gets `memory.memory_enabled: false` and `memory.user_profile_enabled: false` — the vendor flags behind the built-in MEMORY.md/USER.md file stores — so a bot's durable memory lives only in the shared hindsight service. `memory.provider: "hindsight"` and the hindsight rule (mode `local_external`, never cloud) are unchanged either way.
- Off (or an unrecognized value — a typo must not silently disable a bot's memory) the memory block compiles byte-for-byte as before, so turning the switch off restores the previous restartHash and needs no bot restart beyond the normal config change.
- Carrying over the existing bots' local memory files into hindsight is a separate operator step and not part of this change.

### Learning switch and spend limits (FORAGING-LIMITS-UI)

- The learning switch, the pass interval, the same-host read pause, the
  per-pass budget, the **daily** and **monthly** company ceilings, the per-agent
  and per-role limits, the hard/soft (ask the owner) enforcement mode and the
  cost-per-task auto-off threshold are instance settings now: the "Learning
  (foraging)" section of Instance → General
  (`GET`/`PATCH /api/myrmidon/foraging-settings`), key `general.foraging`.
- No restart: the sweep re-resolves the settings row before every pass, a
  changed value applies with the next pass. The 1.6 env variables
  (`MYRMIDON_FORAGING_*`) stay forced per-key overrides of the matching field,
  the built-in default is the floor; the panel shows the origin of each value.
  `MYRMIDON_FORAGING_KEY_SECRET` stays env-only: it names a company secret, not
  a limit.
- When a limit stops a pass (sources after the stop stay untouched), a
  `foraging_limit` card lands in the attention feed (it clears when a pass
  runs without a stop; the auto-off card stays until learning is re-enabled).
  Soft mode marks the signal as a question to the owner: raise the limit or
  switch learning off.
- The learning spend is tracked on its own: a `foraging_spend_events` table
  (cents, role, agent, source URL) and one `training_charge` finance event per
  pass — Costs shows learning as its own "Training" line, by agent and source
  (`GET /api/myrmidon/companies/:companyId/foraging/spend`).
- Cost auto-off: when the mean cost per task (BASELINE) rises above the
  threshold from the settings, learning switches itself off and signals the
  attention feed.

### Telegram notify: one rarelyMaxPerDay range (TG-NOTIFY)

- The `rarelyMaxPerDay` range is now single: 1-50, the merged proactivity contract. The
  settings schema, the stored-document parser and the panel input all enforce it; an
  out-of-range stored value falls back to the default of 3.

### Baseline snapshots API: freeze a window, label it, pin it (1.6.2 BASELINE-SNAPSHOTS)

- Three endpoints join the BASELINE metrics route: `POST
  /api/myrmidon/companies/:companyId/baseline/snapshots` computes the metrics
  for the window in the body, stores the whole answer in
  `baseline_metric_snapshots.payload` and returns the stored row;
  `GET .../baseline/snapshots` lists the company snapshots and
  `GET .../baseline/snapshots/:snapshotId` returns one row (404 when the
  company has none).
- `from` and `to` are required; `label` and `pinned` are optional. Pinning a
  snapshot clears `pinned` on the company's previously pinned snapshot, so a
  company keeps a single reference point.
- Creating a snapshot is board-only (`assertBoard` plus the company access
  check); reading is the usual company access check.
- Two additive columns (`label`, `pinned`) with a partial index on the pinned
  snapshots of a company. The vendor tables are only read.
- Guide: `docs/myrmidon/guides/baseline-snapshots-api.md`.

### Authorize GitHub once for the whole server with our own GitHub Apps (GITHUB-SHARED-IDENTITY)

- Development agents could push only with an OAuth GitHub identity connected
  per person or per agent through the vendor's cloud connector and the
  vendor's GitHub App (a third party with write access to the code); bot
  containers strip raw tokens from the terminal, so agents without such an
  authorization could not push at all.
- Company settings → "Shared GitHub authorization"
  (`GET`/`PUT /api/myrmidon/companies/:companyId/github-shared-identity`)
  lists **our own GitHub Apps**: App id, private key (a company secret),
  installation, the agents (roles and/or agents) and the allowed
  repositories (`owner/repo` patterns). Applied without a restart.
- The board mints the installation tokens itself — no external broker — for
  the one target repository with contents/pull requests read-write and
  metadata read only. The App is picked by the target repository of each
  operation: products under different accounts never mix; a repository
  matched by no App stays absent, by two is an error. A dedicated per-agent
  grant (and the run's personal grant) still wins.
- The commit author and committer stay the agent; each issuance is audited
  (`myrmidon.github_app.issued`); the key and the token are never logged.
- The vendor cloud GitHub connector is **off by default**
  (`MYRMIDON_GITHUB_VENDOR_CONNECTOR=1` turns it on).
- Bot image: patch 09 keeps stripping raw tokens; `git-credential-paperclip`
  (`useHttpPath = true`) and the `gh` wrapper send the target repository to
  the broker. [guides/github-shared-identity.md](guides/github-shared-identity.md).

### Review-return loop: a RETURN verdict opens the rework task itself (REVIEW-REWORK)

- A review verdict that returned a pull request used to hang: no rework task, the
  review stayed in `todo`, and the reviewer was woken every 10-30 minutes on an
  unchanged lane (OPE-4417 waited 7 hours on PR #484; OPE-4360 kept a todo card
  on an already-merged PR). A sweeper (every 60 s, per company) now reads the
  verdict (a `VERDICT ...#<N>: RETURN` marker on the review task, or the PR's
  GitHub `CHANGES_REQUESTED` decision; the newest word wins) and:
  1. opens a rework task (child of the review, linked to the verdict comment and
     head sha) for the executor chosen down the ladder: the review's return
     assignee (PR author) -> assignee of the task the PR delivers -> instance
     fallback setting -> nobody (role queue for SWARM-CLAIM); the executor is
     woken;
  2. moves the review to `blocked` pointing at the rework, so the reviewer stops
     being woken;
  3. when the PR head moves past the baseline, lifts the block to `todo`, records
     a `HEAD-ACK <pr>: <sha>` line (retiring the verdict signal) and wakes the
     reviewer with the new head;
  4. closes the review (`done`) when every linked PR is merged or closed, and
     reopens the same rework task (never a duplicate) when a newer RETURN lands.
- Instance -> General gains "Review-return loop (REVIEW-REWORK)": master switch
  and fallback executor, `GET`/`PATCH /api/myrmidon/review-rework`, stored in
  `instance_settings.general.reviewRework` with a change journal; applied without
  a restart. Off restores the old behaviour exactly.
- An unresolvable PR (no token, GitHub outage) moves nothing: the loop never
  invents a merge, head move or verdict.

### Quality screen: comparison with the pinned baseline snapshot (1.6.5-BASELINE-COMPARE-UI)

The Quality screen (`/quality`) gains a "Comparison with the pinned snapshot" block below the two metrics tables. For the same window the page shows, it reads the compare endpoint (merged in 1.6.2, PR #484) and lists, per project and per role: the current window value, the pinned snapshot value and the delta (absolute + percent; the return rate delta in percentage points; green = better, red = worse). A row without a counterpart on either side shows "—" instead of a delta.

- No pinned snapshot is a normal "no baseline yet" state, not an error, and the metrics tables stay intact.
- A failed comparison request is shown as its own error state and does not break the tables above.
- The block follows the page's range preset / custom dates; a guide describes the flow (docs/myrmidon/guides/baseline-comparison.md).

### The bot's volume layout follows its image's runtime contract (BOT-LAYOUT-V)

- A bot container is now created and recreated with the volume layout its IMAGE
  declares: contract "1" (the 1.6.4 and older images) keeps the three separate
  binds the image boots from; contract "2" gets the single /bot mount; the
  transition images (contract "1" plus the scope label) also get /bot. Template
  drift is compared against a create body built for the image's own contract,
  so a card on an old image neither reports a phantom Binds drift nor gets
  recreated under a layout its image cannot start with.
- The board reads the applied marker and the clone-hygiene report of a
  legacy-layout container through /data/hermes; dockergate allows exactly that
  path and nothing else under it.
- An image without a recognized contract is still refused before anything is
  created. Old 1.6.4 images stay supported under the new board for a smooth
  rollout; the bot-runtime Dockerfile is unchanged in this PR (the transition
  rule classifies it) — the image itself moves to contract "2" together with
  the myrmidon-bot-image.yml check in a release-engineering step.

### GitHub App permissions are set per App entry, Workflows can be allowed (GITHUB-APP-SCOPES)

- Every App entry in Company settings → Shared GitHub authorization now
  carries a permission list — `actions`, `checks`, `contents`, `deployments`,
  `environments`, `issues`, `pull_requests`, `workflows` — each `none` /
  `read` / `write`. The broker requests exactly that list on every
  installation token (`metadata: read` is always added, which GitHub grants
  to every token anyway); secrets, administration and organization keys are
  not on the allow-list and are rejected on save, so a stored document can
  never widen the broker beyond it. `workflows` is write-only — GitHub's
  token API has no `workflows: read`.
- The default is the historical fixed set (Contents + Pull requests write,
  everything else none), so an upgraded installation keeps minting exactly
  the tokens it minted before until the operator widens an entry.
- The permission list is part of the token cache key: widening an entry
  re-mints instead of reusing the narrower token. The issuance audit
  (`myrmidon.github_app.issued`) now records the permission list.
- To let agents edit `.github/workflows/*`: first enable **Workflows: Read
  and write** on the GitHub App registration and accept the updated
  permissions on the installation, then set **Workflows** to `write` on the
  App entry and save — no restart. The guide has the steps
  ([guides/github-shared-identity.md](guides/github-shared-identity.md)).

### The GitHub App of the board serves non-container runs too (GITHUB-SHARED-IDENTITY)

- A run whose execution target is local or SSH (the development agents on the
  build machine, and bots whose container `fleetd` starts on a second machine)
  had no GitHub credential path: the launcher staged for it asked the broker
  without naming a repository, so a run whose only identity is a self-hosted
  GitHub App never got a token and the agents kept pushing with a static token.
- The launcher now stages `git-credential-paperclip` next to its `git` and `gh`
  and gives Git the configuration the bot image installs in `/etc/gitconfig`: the
  leading empty `credential.helper`, ours scoped to github.com over https, and
  `useHttpPath = true`. git hands the helper the repository path and the helper
  asks the broker for exactly that `owner/repo`; the `gh` wrapper names the
  repository from `-R`/`--repo`, `GH_REPO` or the `origin` remote, and a `git`
  command from the remote in its arguments or the `origin` of its directory.
- An operation that names no usable repository, or one no App serves, stays
  without managed credentials and works as before. Only the token, the
  terminal-prompt switch and the commit identity are taken from the broker's
  answer, so a broker-supplied helper never replaces the staged one. No token is
  written to a file.
- Once the second list's agents are moved over, their static GitHub tokens
  (`env.GITHUB_TOKEN`, `~/.git-credentials`) are removed.

### 403 "key not allowed" is a permanent configuration error, not a retry (PERF-DIET-I)

A run whose Hermes gateway turn ended with the LiteLLM 403 message "key not
allowed to access model <model>" used to fall into the generic retry path:
every retry re-issued the same 403 (257 empty retries a day, perf-plan-v2
§1.4).

- The `hermes_gateway` adapter now tags such a failed run with the new
  `permanent_config_error` error family (case-insensitive signature match;
  the "Connection error." transient marking is unchanged).
- The recovery classifier routes both the new family and the raw 403 text
  (historical runs, other adapters) to the existing `configuration_incomplete`
  escalation: the issue goes to `blocked` with the cause recorded in the
  comment, no retry is scheduled, and the operator gets the deduplicated
  recovery-action attention card.

### Review-return loop: a work product without a repo no longer fails the pass (REVIEW-REWORK)

- A `pull_request` work product whose metadata has no `repo` (an older record
  that carries only a number or a URL) used to crash the sweep with
  `TypeError: Cannot read properties of undefined (reading 'toLowerCase')`
  while the PR coordinates were being collected, so the whole task failed
  every pass. Now the loop reads the repo from the work product's
  pull-request URL when the metadata has none, and silently skips the entry
  when neither the metadata nor the URL yields coordinates — one bad record
  never fails the task's pass again.

### Review-return loop finds the delivering task by PR url again (REVIEW-REWORK F-02)

- The url branch of the delivering-task lookup built `like $n%` — the wildcard
  sat outside the bound parameter, so Postgres answered every call with a
  syntax error and the review-return loop was dead for tasks whose PR is
  reachable only through a pull_request work-product url. The branch now
  matches the PR exactly: query/fragment parts are stripped and the url is
  anchored on `/github.com/<repo>/pull/<number>(/|$)`, so `/pull/12` and
  `/pull/12/files` match PR 12 while `/pull/123` no longer matches a search
  for 12. The metadata repo/number branch is unchanged.
- New guard: `scripts/myrmidon/ci/sql-template-lint.mjs` (CI step in the
  `checks` job) flags a `%` wildcard glued to a `sql` template interpolation
  edge — the exact bug class — across `server/src`; its node:test suite runs
  with the other script tests. Embedded-Postgres regression test:
  `server/src/myrmidon/review-rework/store.db.myrmidon.test.ts`.

### Channel settings: the Telegram bridge and the chat limits without a restart (SETTINGS-TO-UI)

- `GET /api/myrmidon/channel-settings` reports the effective value of every
  channel setting — the Telegram DM bridge list and status, the split and
  attachment limits, the cross-channel numbers and the chat reconcile interval —
  together with where each value came from (`ui` for the stored document, `env`
  for the deployment environment, `default` for the built-in fallback) and
  whether the environment pins it.
- `PATCH /api/myrmidon/channel-settings` (instance admin only) writes
  `instance_settings.general.channelSettings`, records the change in the activity
  log for every company and answers with the settings now in force. The
  deployment environment keeps winning over a stored value: a set `MYRMIDON_*`
  variable stays the forced override and the answer marks the key `overridden`.
- The document is registered in the instance settings contract
  (`instance_settings.general.channelSettings`), so the stored value survives a
  read-write of the general block instead of being dropped as an unknown key.

### REBRAND-C env alias: codemod repair after main merge (OPE-4561)

- The REBRAND-C codemod had rewritten `delete process.env.X` into
  `delete readProductEnv(From)(...)` in the hermes adapter, the CLI onboard
  command and the native-session executor — a no-op at runtime that left the
  variable in the child environment and stopped type-checking after the main
  merge. Removal now goes through `deleteProductEnv`, dropping both the
  `MYRMIDON_*` and the legacy `PAPERCLIP_*` spelling.
- Call sites that used the `readProductEnv(From)` result as a guaranteed
  string (opencode-local / pi-local command override, server config path,
  agent-assigned-tools API base URL, startup-banner JWT file check) now bind
  the value once and narrow `undefined` explicitly.
- A stray commit `7b22807f` (Telegram `/accept` `/reject` commands, not part
  of this PR) and the OPE-4131 heartbeat list-perf edits it had pasted into
  `server/src/services/heartbeat.ts` were removed by a revert commit.

### Metrics self-check probe (1.6.6 METRICS annex)

- `GET /api/myrmidon/monitoring/selfcheck` — the link self-check of the
  metrics module: one scrape of every family, answered as the aggregate
  `{ok, families_ok, families_failed, scrape_ms, checked_at}` with no
  secret and no metric value. The probe rides the same origin-root router
  and the same single scraper bearer token as `GET /metrics` — no board
  rights, no second credential. 200 on a green scrape, 503 when a family
  read failed (the names it lists are exactly what `myrmidon_scrape_errors`
  exposes for the alerting half to open a task for the owning role), 500
  with the shape when the probe itself crashes.
- A failing family now reports by name: the collector returns the failed
  family list alongside the snapshot; `myrmidon_scrape_errors` keeps the
  counter role.

### Prompt-budget advice and deep analysis (PROMPT-BUDGET C)

- The agent card (Overview) shows what the last run's prompt was made of —
  which part dominates it and what to do about it. The advice is computed on
  request from the recorded breakdown; a "Deep analysis" button files a task
  for a cheap-model optimizer agent, which drafts instruction edits as a
  comment on that task. Nothing is scheduled and nothing is changed
  automatically.
- The static thresholds are code constants, not settings: a part is worth a
  recommendation from 30% of the prompt, is critical from 50%, and no advice
  is produced below 2000 prompt tokens.
- API: `GET /api/myrmidon/companies/:companyId/prompt-budget/agents/:agentId/advice`
  (company member) returns the breakdown and the recommendations;
  `POST .../advice/deep` (board) answers 201 with the filed task, or 422 with
  a clear message when no optimizer agent is configured
  (`promptBudget.optimizerAgentId` in the instance general settings). See
  [SETTINGS.md](../SETTINGS.md).

### Bot replies are no longer cut at 2000 characters (TG-REPLY-FULL)

- The Hermes adapters (local and gateway) used to copy only the first 2,000
  characters of the answer into the run summary, which the chat bridge delivers to
  the owner when the run has no separate final message. Long answers therefore
  arrived in Telegram cut off. The summary now carries the whole answer; the
  existing Telegram publication path then splits anything above the 4,096 limit into
  ordered messages at paragraph, line, then word boundaries (and sends long
  structured Markdown as one attached document). Nothing is silently dropped.

### ONE-COMMAND-INSTALL: one command brings a fresh server to a working board

- `scripts/myrmidon/install/install.sh` (new) installs a fresh server. It checks
  the machine and names what is missing (root, Ubuntu 24.04 / Debian 13, arch, 2
  CPU, 4 GB memory, 10 GB free disk, a free port), installs Docker and the
  compose plugin if absent, resolves the latest release (`releases/latest` or
  `--version myr-vX.Y.Z`) and its manifest `release-components.json`, and pins
  the board, dockergate and bot images BY DIGEST (no flag skips it). It
  generates every secret, writes `deploy.env` (0600), `compose.yml` and the
  dockergate configuration, starts the database, board and dockergate, waits for
  `/api/health` `status: ok` and prints the address, the first-administrator
  link and the written paths.
- Re-running it is the update path: dump the database before the image line
  changes, switch digests, check health, roll back to the previous digests if the
  new board is not healthy. `--uninstall` removes the stack (data kept);
  `--uninstall --purge` also deletes the database volume and install directory.
  It asks nothing by default (`--interactive` enables three questions) and
  speaks Russian or English by locale (`--lang`).
- `scripts/myrmidon/release/publish-github-release.sh` attaches the installer to
  every release as `install.sh`, so
  `https://github.com/itkadr-git/myrmidon/releases/latest/download/install.sh`
  serves the latest one; the committed file is the single source.
- Tests: `scripts/myrmidon/install/install.test.mjs` runs the real script against
  fake `docker`, `curl`, `ss`, `systemctl`, `apt-get`: digest pinning and secrets,
  update with a dump, rollback on an unhealthy release, no-op on the same
  release, foreign directory refused, uninstall/purge, Russian locale, malformed
  `--version` refused.

### Dockergate poll storm removed (OPE-4789, second half of OPE-4752)

The board talked to dockergate far more than the planned once-a-minute sweep:
~30 requests/s on a 74-bot fleet, hour-and-a-half rollouts, 28 refusals.

- The clone-report collector runs at most once a minute and asks only about
  running bots.
- One reconcile pass costs one inspect and one marker read; the create-body
  template context is cached 60 s per bot instead of re-read three times.
- The health wait after a start polls every 3 s, matching the image's 30 s
  HEALTHCHECK cadence.
- A duplicated apply within 30 s answers from freshness; real changes (Apply
  now, secret rotation, canary wave) pass `force: true` and always run.
- A 429 is retried by the call that got it — after `Retry-After` or a capped
  backoff (1/2/4/8 s, max 4 attempts) — not by every caller at once.

Measured on the fake daemon: a plain sweep costs 2 gate requests (was 3+), a
canary-overlapped pass 2 (was 6).

### Predeploy database check restores the dump with --no-owner --no-acl by default (1.6.5 PREDEPLOY-NO-ACL)

- The default restore command of the predeploy database check
  (`predeploy-board-check.sh`, `MYRMIDON_PREDEPLOY_RESTORE_COMMAND`) now
  carries `--no-acl` next to the existing `--no-owner`. The production dump
  contains GRANTs to roles that exist only on the production server (e.g.
  `backup_ro`); the throwaway Postgres of the check does not have them and
  `pg_restore` aborted with `role "backup_ro" does not exist`, so the check
  died on the restore step of every such dump before the board was ever
  started (OPE-4875, vm-core 06.10).
- The check proves the board reads the production DATA on the copy, not the
  production grants model, so skipping ownership and ACL statements is the
  correct default. An operator who wants the grants modelled on the copy
  pre-creates the roles and overrides `MYRMIDON_PREDEPLOY_RESTORE_COMMAND`;
  the override is still used exactly as given.
- `scripts/myrmidon/deploy/deploy.env.example` documents the new default and
  the reason; the script test suite now models a dump with a GRANT to a
  missing role and proves the old command aborts on it while the new default
  restores.

### Company base skills reach every agent automatically (1.6.5 BASE-SKILLS)

- The company now keeps a **base skills** list on the Skills screen: the skills
  every agent of the company is supposed to have. A base skill is given to an
  agent automatically — a new one at creation, an existing one the moment the
  skill joins the list, and again whenever the board presses "Apply to all
  agents". The fact of 06.10: `parallel-helpers` was attached to 52 of 82
  agents by hand, the other 30 silently missed it, and the SMM bot could not
  start the viewer flow it needed.
- The panel lists each base skill with the count of agents that carry it and
  names the agents that do not, so a gap is visible instead of silent. An agent
  whose adapter cannot receive skills at all is reported as such, and a base
  key that no longer exists in the skill library is flagged as "not in the
  library" — it can reach nobody.
- A base skill cannot be taken away from a single agent: the agent's own skill
  screen keeps it in the selection (it is the company list that decides).
  Removing a skill from the base list stops the automatic assignment; the
  agents that already carry it keep it.
- The registry is additive: a new `company_base_skills` table, board-only
  mutations (`GET/POST/DELETE /api/companies/{companyId}/base-skills`, plus
  `POST …/base-skills/apply`), and one activity-log entry per change
  (`company.base_skills_added` / `_removed` / `_applied`). A company without
  base skills behaves exactly as before.

### Text search: trigram indexes now cover the coalesce-wrapped predicates too (1.6.5 PERF-DIET-P)

- Both search paths match task text with `ILIKE '%…%'`, and both already ran on
  pg_trgm GIN indexes: the plain-column ones shipped by the vendor in migrations
  `0051`/`0079` — `issues(title)`, `issues(description)`, `issues(identifier)`,
  `issue_comments(body)`, `documents(title)`, `documents(latest_body)` — and the
  task-search statement matches those columns bare, so it uses them.
- Company search has a second family of predicates that wraps the column in
  `coalesce`: `coalesce(title, '') ILIKE '%…%'` over `documents` and
  `coalesce(identifier, '') ILIKE '%…%'` over `issues`
  (`server/src/services/company-search.ts`, `company-artifacts.ts`). A wrapped
  expression cannot use the plain-column index, so the planner sequentially
  scanned `documents` — the table whose `latest_body` column is the heavy one —
  and `issues`.
- Migration `packages/db/src/migrations/0314_search_coalesce_trgm_indexes.sql`
  adds one expression index per emitted shape,
  `gin ((coalesce(col, '')) gin_trgm_ops)`. It also repeats
  `CREATE EXTENSION IF NOT EXISTS pg_trgm` (idempotent; vendor migration
  `0051` already creates it) so the file is self-contained. It is an additive
  index-only migration: no query text, no schema and no behaviour change, and the search
  semantics stay identical (a NULL column and the empty string are both
  non-matching, and the predicates sit in positive OR/AND chains).
- Measured on embedded PostgreSQL, selective term, 20 000 documents / 50 000
  issues: `coalesce(documents.title, '')` sequential scan 13.3 ms → bitmap index
  scan 0.6 ms; `coalesce(issues.identifier, '')` 37.3 ms → 2.6 ms.
- Guard: `server/src/__tests__/task-search-trgm-index.myrmidon.test.ts` asserts
  every search index exists as a GIN index, that each emitted predicate is served
  by its index instead of a sequential scan, that dropping the expression index
  puts the statement back on a sequential scan (the assertions have teeth), and
  that company search returns the same hits with and without the expression
  indexes.
- `CREATE INDEX IF NOT EXISTS` (not CONCURRENTLY — the migration runner wraps
  every file in a transaction) on the medium-bucket tables `documents` and
  `issues`; an operator who wants to build it on a live board without the
  migration's brief lock uses `CREATE INDEX CONCURRENTLY IF NOT EXISTS` with the
  same definition, and the idempotent statements then skip the finished work.

### Deploy hygiene: the deploy no longer fills the disk it deploys from (OPE-5107)

On 06.10 the deploy host's root filesystem went from 86 % to 92 % in the hour of
one rc.3 deploy: the predeploy database copy kept its Postgres data in an
anonymous volume `docker rm -f` never removes (3.4 GB + 3.6 GB orphaned), images
of past releases were never deleted (~33 GB), and the deploy pulled new images
without checking the free space.

- PREDEPLOY-DB-CHECK: the copy's data lives in a named volume
  (`myr-predeploy-dbvol-<digest8>-<pid>`) removed by the run's EXIT trap on
  success, failure and interrupt. `MYRMIDON_PREDEPLOY_KEEP=1` keeps it and
  prints its name.
- Disk precheck before the first pull and the dump (deploy.sh, standalone
  bot-image-rollout.sh / rollout-component.sh): free space of the filesystem
  holding /var/lib/docker must reach `MYRMIDON_DEPLOY_MIN_FREE_GB` (default 15
  GiB, 0 = off), otherwise the deploy stops before anything changed and names
  the cleanup candidates (`docker system df`). A dry run prints the check.
- Image retention after a successful deploy: local images of
  `MYRMIDON_DEPLOY_IMAGE_REPOS` (board, dockergate, fleetd, three bot images)
  older than `MYRMIDON_DEPLOY_IMAGE_KEEP` previous releases (default 1; 0 = off)
  are removed. An image used by any container is never removed; a cleanup
  failure is a warning, not a failed deploy.

### Active issue claims are unique at the database (1.6.5 SWARM-CLAIM-UNIQUE-INDEX)

- The swarm-claim capture path checked the live lease with a SELECT and then
  INSERTed, so two board processes racing for the same issue could both pass
  the check and both take the task — the same issue ran twice at once, and the
  lost racer on the older single-writer path surfaced a raw unique-violation
  error instead of a busy answer.
- Migration `packages/db/src/migrations/0360_issue_claims_active_unique.sql`
  first folds the historical duplicates: for every issue with more than one
  live claim (`released_at IS NULL`) the earliest row by `claimed_at` (ties
  broken by `id`) stays live and the rest get `released_at` with
  `release_reason = 'migration_dedup_0360'`. Then it builds the partial unique
  index `issue_claims_issue_active_uq` on `(issue_id) WHERE released_at IS
  NULL` — one live claim per issue, enforced by PostgreSQL, not by application
  order. `IF NOT EXISTS` and the dedup predicate exclude already-released
  rows, so re-applying the migration on a database that already moved is a
  no-op.
- The capture store (`server/src/myrmidon/swarm-claim/store.ts`) now maps a
  23505 from the claim INSERT to the same `null` the pre-check returns —
  «занято», not a 500. Non-uniqueness errors still propagate unchanged.
- Default behavior does not change: the claim API contract, the lease fields,
  the sweep and the supervisor rebalance are untouched; the index only closes
  the window where two winners were possible.
- Guards: `packages/db/src/issue-claims-active-unique-migration.myrmidon.test.ts`
  (static: migration file, journal entry, 0360 snapshot index; embedded
  Postgres: dedup keeps the earliest live claim and releases the rest, the
  index is partial and unique, a second live INSERT for the same issue raises
  23505, released rows do not collide, re-application is idempotent) and
  `server/src/myrmidon/swarm-claim/claim-race.myrmidon.test.ts` (two parallel
  claims of one issue on embedded Postgres — exactly one succeeds, the other
  gets the busy answer, never an exception; the mapped 23505 seam and its
  narrowness are pinned with fakes).

### Concurrent instance-settings PATCHes no longer lose edits (PROCS-Q5)

- `updateGeneral` and `updateExperimental` read, merge and rewrite the whole
  settings document of the singleton `instance_settings` row. Two PATCHes that
  overlap in time could both read the same state, and the later commit wrote a
  merge of that stale read — the earlier edit disappeared without any error.
  Both paths now run as one database transaction that first takes the row with
  `SELECT … FOR UPDATE`, so concurrent PATCHes serialize on the row: order of
  application = order of commits, and every edit survives.
- The general and the experimental documents share the same row, so both write
  paths take the same lock: a general PATCH and an experimental PATCH can no
  longer clobber each other either. The first-writer insert also happens under
  the lock, so two brand-new instances cannot deadlock on the singleton insert.
- API behavior is unchanged: same routes, same validation, same response
  bodies, same preserved keys (maintenance, deploy jobs, access hub and the
  rest of the `preserve*` keys keep working — they now re-read the locked row).
  A single-process deployment with no overlapping PATCHes sees identical
  results, one write at a time.

### Run queue wait reason and priority settings in the UI (RUN-PRIORITY B)

- `ui/src/components/myrmidon/runQueueApi.ts` — client for the server core:
  `GET/PATCH /api/myrmidon/run-priority` (switch, role weights, default role
  weight, current-release line and bonus, aging step/weight/cap, starvation
  limit) and the queued run's own waiting state — `waitReason` plus its
  `queuePosition` of `queueLength` — read from
  `GET /api/heartbeat-runs/:runId`. A 404/405 answers `null`: an older server
  shows no data instead of an invented number.
- `ui/src/components/myrmidon/RunQueueWaitLine.tsx` — the line under a queued
  run's chat card: "waiting: the host CPU ceiling is closed". The core publishes
  the run's rank in the waiting queue (`contextSnapshot.queuePosition` of
  `queueLength`, written by the priority sweep), so the line shows "queue
  position 3 of 12" beside the reason; a server that publishes no rank degrades
  to the reason alone instead of an invented number. Renders nothing for a run
  that has left the queue.
- `ui/src/components/IssueChatThread.tsx` — mounts the wait line under the
  queued run card (the same card that already shows the "Queued" badge).
- `ui/src/components/myrmidon/RunQueuePrioritySettingsPanel.tsx` and
  `ui/src/pages/InstanceGeneralSettings.tsx` — the queue-priority section of
  Instance → General, on the runtime-limits pattern: five role weights
  (review, release, lead, engineer, docs; an empty one falls back to the
  default role weight; roles set through the API are kept on save), the
  priority switch, the current-release line and bonus, the aging step, step
  weight and cap, and the starvation limit. Values are checked against the
  server bounds before the save; the section says whether the stored row or
  the environment decides. Saving applies on the next admission pass without a
  restart.
- `ui/src/i18n/myrmidon-locales/{en,ru}.json` — the `runQueue` catalog (en+ru,
  parity-checked).

### Drizzle snapshot chain repaired and checked (1.6.5 OPE-5575)

- `meta/0305_snapshot.json` carried the same `id` as 0304 and a `prevId` pointing at itself, so `drizzle-kit generate` stopped with a parent-snapshot collision. 0305 gets a new unique `id`; 0306 `prevId` follows it. Migrations and the journal are untouched, so the runner is not affected.
- `check:migrations` now also runs `src/check-migration-snapshots.ts`: unique ids, no self-reference, no cycles, and from 0296 on every snapshot names the preceding snapshot as its parent. Older snapshots with dangling parents (0027, 0039, 0077, 0091, 0292, 0295) are tolerated.

### Deploy scripts and the predeploy check no longer assume the built-in database container: shared PostgreSQL 18 (1.6.5 PREDEPLOY-PG-COMPAT)

- The board's database may live on a SHARED PostgreSQL 18 server (its own
  database and role; the same server hosts other products). The dump and
  restore commands were always pure configuration (`DUMP_COMMAND`,
  `RESTORE_COMMAND`), and `deploy.env.example` now carries both profiles: the
  built-in `db` container (unchanged default) and the shared server —
  `pg_dump "$DATABASE_URL"` / `pg_restore -d "$DATABASE_URL" --no-owner
  --no-acl`, run with a pg_dump 18 client from the deploy directory. On a
  shared server `--no-owner --no-acl` is required and the connection string
  must be only the board database and the board role. No container name is
  compiled into the scripts.
- The predeploy board check gained `PREDEPLOY-PG-COMPAT`: after the throwaway
  copy starts, the dump's own TOC (`pg_restore --list`) and the copy are
  compared — the server major the dump came from must equal the copy's major,
  and every extension the dump restores must be available in the copy image;
  after the restore, `SELECT extname FROM pg_extension` must show them
  installed. A mismatch (for example a copy image without `vector`, which the
  board has needed since migration 0051) stops the deploy before the
  maintenance window with a clear message. `MYRMIDON_PREDEPLOY_PG_COMPAT=off`
  skips the comparison; the ANALYZE step (PREDEPLOY-ANALYZE) is unchanged.
- `deploy.env.example` sets the copy image default to
  `pgvector/pgvector:pg18` for a new shared-server profile: PostgreSQL 18 with
  pgvector compiled in (the stock `postgres:18` image has no `vector`).

### Board database on a shared PostgreSQL 18 server

- Installation and Upgrading-and-rollback wiki pages document running the
  board's database on a shared PostgreSQL 18 server (pgvector, a dedicated
  database and role per program): connecting the installer to an external
  server through its database-address parameter, the `DATABASE_URL`-based
  `DUMP_COMMAND` /
  `RESTORE_COMMAND` shape for backups and rollback, the PostgreSQL 18 client
  requirement for `pg_dump`, and `MYRMIDON_PREDEPLOY_POSTGRES_IMAGE` for the
  predeploy check. Moving an existing production database to the shared
  server is the operator's one-time zero-downtime task (logical
  replication), outside the scripts.

### 1.6.5 F-07 /agents: grouped agent list with a role, a live status and default aliases (OPE-6323)

- `/agents` in a bridged Telegram DM prints one group per direction instead
  of a flat list: the title comes from the card itself
  (`agents.metadata.telegramGroup`) or, when it is absent, from the agent-name
  prefix (`adm-*` → Infrastructure / Myrmidon, `bbq-*` → bbq, `work-*` → work,
  the rest → Other). Group titles are catalogue strings (en + ru).
- Every line names the agent, its role (`agents.title`, one line), its live
  status (`agents.status`: idle / running / paused, localised) and its aliases;
  the current addressee is marked.
- Written-off cards no longer take a slot: terminated, pending-approval and
  retired-by-name (`-retired` suffix) agents, plus service cards without a live
  board presence, are hidden. Paused cards stay out of the default list and
  come back on request (`listCompanyAddressableAgents(..., { includePaused: true })`),
  and a group holding paused cards says how many wait. The fixed
  60-agent cut-off is gone — the Telegram transport splits a long reply itself.
- Default aliases: an agent without `telegramAliases` answers to the last
  dash-separated segment of its name, lower-cased (`adm-dev-eng-15` → `15`);
  collisions get `-2`, `-3` (`work-runner-2` → `2-2` when `2` is taken). It is
  computed on read only — nothing is written to the card — and `/to`,
  `/who` and `@mention` all resolve it through the same loader.

### Database backup and restore sessions ignore the database-level statement_timeout (1.6.5 BACKUP-STATEMENT-TIMEOUT)

- Automatic database backups failed on stand Postgres instances that set a
  database-wide `statement_timeout` (the live board ran 120 s): the long
  `COPY ... TO STDOUT` of a big table was cancelled mid-dump with
  PostgresError 57014 and the run lost its dump.
- Every connection the backup and the restore open now sets session
  `statement_timeout = 0` (postgres.js startup parameter, and
  `PGOPTIONS=-c statement_timeout=0` for the spawned pg_dump/psql children),
  so a dump or a restore can never be cut short by the database default. A
  startup-packet/session value overrides `ALTER DATABASE ... SET`, while all
  other board connections keep the database limit unchanged.
- The override is scoped to `packages/db/src/backup-lib.ts` only: backup and
  restore are the sole users of `backupClientOptions` / the PGOPTIONS env. No
  app or migration connection is affected.

### Database backups work against a shared PostgreSQL 18 server (1.6.5 SHARED-PG-BACKUP)

- The board's dump path never shells into a container: `runDatabaseBackup`
  dumps exactly the database and role of the configured connection string
  (`DATABASE_URL` / `config.database.connectionString`), with the host's
  `pg_dump` as a plain client binary. No code or packaging reference to
  `paperclip-db-1` / the compose database service remains in `packages/db` or
  `cli`.
- Before the first dump row is read, the pg_dump engine now compares the
  client major (`pg_dump --version`) with the server major (`SELECT
  version()`). A client older than the server — the pg_dump 17 vs PostgreSQL
  18 case, where libpq refuses with a raw "server version X is newer than
  client version Y" mid-spawn — is diagnosed up front: `backupEngine:
  "pg_dump"` fails immediately with `BackupClientVersionError` naming the
  fix, and `backupEngine: "auto"` (the scheduled default) warns and falls
  back to the JavaScript dump, which streams the same tables over the already
  compatible wire protocol and always produces a backup.
- The warning travels to operators: `RunDatabaseBackupResult.warnings`, the
  one-line `formatDatabaseBackupResult` summary, the CLI `db:backup` output
  and its `--json` payload, and the scheduled-backup logger.
- The dump client is configured, not assumed: `PAPERCLIP_PG_DUMP_PATH` points
  the engine at a client of the server's major or newer (e.g. the PGDG 18
  `pg_dump` on a board host whose distro still ships client 17); the same
  idea for the restore path via `PAPERCLIP_PSQL_PATH`. Both were already read
  by the engine; the compatibility check is what makes setting them
  observable instead of trial-and-error.

### Owner-DM delivery filter, part B: the mode switch (OWNER-DM-FILTER)
- Company Settings has a new **Owner Telegram delivery** section. It picks which cards an agent raises are sent to the task owner's Telegram DM: **Owner decisions only** (the default — only the cards that wait for the owner) or **All cards** (everything, the behaviour before this change).
- The current mode is read with `GET /api/myrmidon/owner-delivery` and saved with `PATCH /api/myrmidon/owner-delivery` (`{ mode }`, instance administrator). A missing or unreadable setting shows `owner_decisions_only`.

### Owner-DM delivery filter: only cards addressed to a human reach the task owner's Telegram (1.6.5-OWNER-DM-FILTER)

- Owner-DM delivery filter (U2): in the default mode `owner_decisions_only` the task owner's Telegram DM receives only cards addressed to a human — interactions whose effective resolver policy is `human_only`, or whose `addresseeUserId` is the task owner.
- Agent-addressed and purely operational confirmations (resolverPolicy `anyone`/`not_creator` without a human addressee) stay board-only instead of flooding the owner's DM.
- The mode lives in `instance_settings.general[ownerDelivery]` and is read/written via `GET/PATCH /api/myrmidon/owner-delivery` (read: any board member, write: instance admin); `mode: "all"` restores the pre-filter behaviour.
- Cards delivered to the owner DM carry a human-readable header line ("Нужно ваше решение: <prompt>") built from the interaction's own fields — vendor bindings keep the vendor card text byte-for-byte.

### Owner decisions arrive as a message from the bot, not as a card (1.6.5-OWNER-VIA-BOT)

- New owner-delivery mode `via_bot`, now the default (`instance_settings.general[ownerDelivery]`, `GET/PATCH /api/myrmidon/owner-delivery`). In this mode the owner's Telegram DM receives NO card with buttons. `owner_decisions_only` and `all` keep their previous behaviour for instances that store them.
- When an agent creates a human-only question or confirmation for the task owner, the author is woken on that task with the open decision in its prompt and must explain it to the owner in one plain message: what to decide, why, each option with its consequence, a recommendation.
- New agent tool `myrmidonMessageOwner` (`POST /api/myrmidon/owner-message`) writes that message into the owner's standing Telegram DM conversation from a run on any task. Only the author of an open owner decision may use it; one message per question; several open questions must be covered by one summary message (`409 summary_required`).
- The owner's text answer reaches the agent as a normal DM turn marked as a reply to the open interaction. The new tool `myrmidonResolveInteractionByOwnerReply` (`POST /api/myrmidon/owner-message/resolve`) closes the interaction as the OWNER (the ordinary accept / reject / respond route runs with the owner as the acting user) and only when the owner's own comment in that chat, written after the bound message and received from Telegram, is named. Tool-action, secret and connection confirmations are not closable this way.
- The Paperclip skill documents both tools (`references/owner-dialogue.md`); the owner-delivery settings screen offers the new mode.

### The predeploy copy gets planner statistics before the board is checked (1.6.5 PREDEPLOY-ANALYZE)

- The predeploy board check now runs `ANALYZE` on the throwaway database right
  after the dump is restored, as a separate step logged as `analyze`. A restored
  dump carries rows but no planner statistics, so on the copy the issues list
  ran on default estimates and missed the 30 s route budget (the rc.8 rollout
  stopped there on 07.10 while the same route answered on production).
- The step runs after any restore command, including an overridden
  `MYRMIDON_PREDEPLOY_RESTORE_COMMAND`. Its command can be overridden with
  `MYRMIDON_PREDEPLOY_ANALYZE_COMMAND`. A failed ANALYZE is a warning, not a stop.

### Release candidates publish with notes from change fragments (RC-NOTES)

- A release candidate is cut before the changelog is folded, so `release-body.mjs` now builds its notes from the pending change fragments (`docs/myrmidon/changes/*`, "changelog-en" blocks) when CHANGELOG has no section for the version. Final releases still require their CHANGELOG section. 1.6.5-rc.1 and rc.2 failed to publish for this reason.

### Release candidates and the `latest` marker only after the production proof (RC-VERSIONS)

- Releases now go through a trial run: the tag `myr-vX.Y.Z-rc.N` builds every
  component image as `X.Y.Z-rc.N` (the version `/api/health` reports), and the
  release publish goes out as a GitHub **pre-release** `Myrmidon X.Y.Z-rc.N
  (RC N)` with the base version's changelog notes and its own digest manifest.
  `deploy.sh --release myr-vX.Y.Z-rc.N` works like any release; the CI-image
  gate (deploy scripts and the board's deploy/canary checks) accepts the rc
  tag as release proof.
- A publish — rc or final — NEVER moves the GitHub `latest` marker:
  `publish-github-release.sh` no longer passes `--latest`. An rc supersedes
  nothing, and a final tag never supersedes its own release candidates.
- The marker moves only by the explicit step
  `scripts/myrmidon/release/promote-latest.sh --tag myr-vX.Y.Z`: it refuses an
  rc tag, a pre-release, a release commit not on `main`, and — the point of
  the requirement — any case where our production board's `/api/health`
  reports a version other than `X.Y.Z`. The board address comes from
  `--health-url` / `MYRMIDON_PROD_HEALTH_URL` (fallback `HEALTH_URL`) and, in
  `authenticated` mode, `--health-token-file` / `MYRMIDON_PROD_HEALTH_TOKEN_FILE`
  (fallback `HEALTH_TOKEN_FILE`). The full flow: rc → deploy to our
  production → verify (health, attention list, fleet taking tasks, bot
  images) → final tag `myr-vX.Y.Z` on the SAME commit → promote to Latest.
  See [deploy.md](deploy.md), "Release candidates and the `latest` marker".

### One read per reconcile sweep, not one per bot (PERF-DIET-G)

The bot container reconciler compiles a profile for every bot on every sweep
(once a minute), and most of what it read is company- or instance-scoped: the
company's skill lifecycle delivery, the runtime skill catalogue and files, and
the instance settings (compression defaults, helper ceiling, language-server
policy, shared package cache, pnpm store, clone TTL). A fleet of N bots paid N
reads a minute.

- A sweep now shares one pass: the first bot of a tick reads those values, the
  others get the same. The pass is dropped at the end of the sweep, so a settings
  or skill change still reaches the bots within one reconcile interval and
  nothing is cached between ticks. A skill carried by several bots is read from
  disk once per pass.
- `pnpmSettings` was read twice per bot per compile; now once per pass.
- The agent card behind a profile is read as one row by id instead of `getById`,
  which also hydrates the company and the agent's month spend.
- "Apply now" and the canary wave reconcile one bot with no shared pass and
  behave as before. Reconciler log, interfaces and UI are unchanged.

Measured over a sweep of three bots with counting fakes: 21 instance-scoped port
calls before, 6 after; skill catalogue 3 -> 1, lifecycle company-wide reads
3 -> 1, a skill directory carried by two bots 2 -> 1, the card read 3 rows
instead of 3 x 3 queries.

### Release freeze: merges into main wait until the release tag's CI is green (RELEASE-FREEZE)

- A new PR check, `freeze` ("Release freeze gate"), fails while the newest
  release tag (`myr-vX.Y.Z` or `myr-vX.Y.Z-rc.N`) has no green Myrmidon CI.
  The tag workflow opens one issue `release-freeze: <tag>` at the cut and
  closes it when the tag CI succeeds. The gate fails closed on lookup errors.
- This prevents the 1.6.4 incident: merges right after the cut cancelled the
  tag's CI run and the publish gate refused the release.
- Operator step: add the `freeze` check to main's required status checks to
  make the freeze binding.

### SHARED-PG: a fresh install stands up one PostgreSQL 18 + pgvector shared database

- `scripts/myrmidon/install/install.sh` — the database layer of a clean
  install is now a PROFILE, not a hard-coded `postgres:17-alpine` container.
  The default (internal) profile runs ONE PostgreSQL 18 image with the
  pgvector extension (`docker.io/pgvector/pgvector:pg18`, overridable with
  `MYRMIDON_DB_IMAGE`, digest pinning included) and creates, on first start,
  a separate database and login role per service: the board (`paperclip`)
  plus the shared services `litellm`, `langfuse` and `hindsight`
  (`MYRMIDON_SHARED_SERVICES`); every service database gets the `vector`
  extension. The generator lives in `db-init/01-shared-roles.sh`, mounted
  into `/docker-entrypoint-initdb.d` — it is idempotent (a role/database that
  already exists is reused) and re-applies the memory parameters with
  `ALTER SYSTEM` so the sizing survives in the cluster.
- The server's memory parameters (`shared_buffers`,
  `effective_cache_size`, `maintenance_work_mem`, `work_mem`, `shm_size`)
  are sized for the SUM of all services sharing the cluster: by default from
  the host's `MemTotal` (capped at 16 GB) — shared_buffers = 1/4 RAM,
  effective_cache_size = 3/4 RAM, maintenance_work_mem = RAM/64 (>= 64 MB),
  work_mem = 16 MB, shm = RAM/8 clamped to 128 MB..1 GB. Every value is
  overridable in the install environment (`MYRMIDON_DB_TOTAL_MEMORY_MB`,
  `MYRMIDON_DB_SHARED_BUFFERS`, `MYRMIDON_DB_EFFECTIVE_CACHE_SIZE`,
  `MYRMIDON_DB_MAINTENANCE_WORK_MEM`, `MYRMIDON_DB_WORK_MEM`,
  `MYRMIDON_DB_SHM_SIZE`) and is written into `deploy.env`, so the numbers a
  cluster actually runs with are visible in one place.
- External shared server: `--database-url postgres://...` (or
  `MYRMIDON_INSTALL_DATABASE_URL` / the `DATABASE_URL` the operator exports)
  switches the installer to the external profile — no db service is written
  into `compose.yml`, no pgdata volume, the board's container points straight
  at the operator's server through `MYRMIDON_DATABASE_URL` in `deploy.env`.
  A non-`postgres://` URL is refused. The databases and roles on the external
  server are provisioned by the operator; the installer only validates the
  connection string shape.
- Existing installs are never migrated implicitly: a stack whose compose file
  carries a literal `image: postgres:` line and whose `deploy.env` names no
  profile gets the `keep` profile — re-running the installer (including
  `--version`) leaves its database container and data volume untouched.
  Moving a PG 17 database onto the shared PG 18 server is an operator task
  with its own procedure, not a side effect of an update.
- `docker/docker-compose.yml` and `docker/quadlet/paperclip-db.container`
  (the manual-deployment variants) move to the same
  `pgvector/pgvector:pg18` image; the compose variant gains the `db-init`
  bind mount and the sizing command line, mirroring what the installer
  generates.
- Tests: `scripts/myrmidon/install/install.test.mjs` gains the profile
  cases — a fresh install renders compose with the PG 18 + pgvector image,
  the sizing command line and the `db-init/01-shared-roles.sh` generator
  that creates the four databases and roles; `--database-url` produces no db
  service and no init directory; a malformed external URL is refused; an
  existing pre-profile stack is marked `keep` and its compose file is not
  rewritten.

### Guide: address any agent from one Telegram chat (TG-MULTI-AGENT)

- New operator guide
  [telegram-multi-agent](guides/telegram-multi-agent.md):
  `@`-mention addressing and the `/agents`, `/to`, `/who` commands of the
  bridged Telegram DM — aliases (`telegramAliases` in the agent card), the
  sticky default addressee (`telegramStickyAgentId`), and the protection
  rules (own bridged conversation only, same-company agents only, polite
  list of valid aliases for an unknown alias). X9a/X9b are already in main;
  X9c ships with the code PR.

### Telegram notifications (TG-NOTIFY-SETTINGS, part A: the settings core)

- The company-level settings that say what the board sends to the owner in
  Telegram: the daily digest, error notifications, inbound rules, escalations
  and head-bot proactivity, as ONE runtime-changeable contract
  (`packages/shared/src/myrmidon-telegram-notify.ts` — types and zod
  validators shared by the server and the UI). Storage without migration:
  the `myrmidonTelegramNotifySettings` key of `instance_settings.general`,
  company-keyed. API: `GET /api/myrmidon/telegram-notify` answers the full
  document (every field of every section always present), `PATCH
  /api/myrmidon/telegram-notify` applies a partial update; each changed
  field is recorded in a bounded changelog (200 entries) with the actor, the
  field path and the from/to values. Reads need company access; PATCH is
  board only. Every section defaults to OFF — with the defaults the owner
  keeps receiving only the replies to their own messages and the U2 decision
  cards; the parts that actually send (digest, errors, inbound, escalations,
  proactivity) consume this contract. No environment variables are added.

### Telegram group topics as a task inbox (TG-NOTIFY part D)

- A message in a forum topic of a connected Telegram group can now become
  work on the board: the message continues the task already bound to that
  topic, or a new task is created with the first words of the message as the
  title and the thread link in the body. Both switches
  (`telegramNotify.inbound.enabled`, `telegramNotify.inbound.requireMention`)
  are off by default; the require-mention default keeps the group privacy
  contract, so commands in a topic work only when the bot is addressed. See
  [telegram-topic-inbound](../guides/telegram-topic-inbound.md).

### Tool gateway policy reads are served from a per-company cache with a live TTL (1.6.5 DB-PERF-C-P4)

- Every `tools/list` and every tool call decides access by reading
  `tool_profile_bindings`, `tool_profiles`, `tool_profile_entries` and the
  enabled `tool_policies` of the company. The tables are nearly empty, so the
  cost is the round trips: by the measurement of 06.10 that was ~5.4M statements
  over three days of statistics, with `POST /mcp/gateways` taking 18–26 s on
  average. The four row sets are now served from an in-process cache keyed by
  company (`server/src/myrmidon/tool-policy-cache/`, one cache per server
  process), and the cache stores exactly the rows the gateway read before, so a
  cached read returns the same row sets as a fresh one.
- Setting: `instance_settings.general.toolPolicyCache = { ttlMs }`, changed
  from `GET/PATCH /api/myrmidon/tool-policy-cache` (GET is open to board
  members, PATCH is instance-admin only). Default 30 s, minimum `0` (cache off),
  maximum 300 s. The field is also on the instance settings page ("Tool gateway
  policy cache", in seconds). The cache reads the row on every access, so a change
  applies to the next gateway call without a restart.
- Every write drops the company snapshot, and not only inside the two access
  services: create, update, delete, duplicate and reorder of policies, the
  trust-rule create/revoke and the trust-rule hit (it rewrites
  `tool_policies.config`) in `server/src/services/tool-access-policy.ts`, every
  profile, binding and profile-entry mutation in
  `server/src/services/tool-access.ts`, plus the writers outside both of them —
  the email-channel setup (creates a profile with its entries and bindings), the
  named MCP gateway (binds a profile) and the smoke lab (rewrites and removes its
  own profile rows). A changed policy is therefore visible to the very next
  decision instead of living until the TTL, which closes the risk the database
  audit raised. A load that was already running when the write landed cannot
  put its stale rows into the cache: every invalidation bumps a per-company
  generation counter and a load whose generation moved is dropped and redone
  once. Writes made on a caller's transaction handle (a remembered approval, a
  connection-intent completion, a catalog refresh) invalidate after the commit as
  well, and a service built on a transaction reads straight from the database. A write made
  straight through the database handle (a fixture, a manual fix) is likewise out
  of the cache's reach until the window ends, so the vendor tests that seed these
  four tables directly drop the snapshot themselves — the same way
  `tool-access-service.test.ts` already does for the cloud-connector cache.
- Deliberately not cached: rate-limit counters, audit events and principal
  permission grants. They are per-principal state and the gateway writes to
  them; they stay direct reads and writes.
- `ttlMs: 0` restores the previous behaviour exactly: the cache answers "no
  snapshot", the gateway runs its own statements unchanged, and the statement
  set is the one it had before the cache existed. The only read the cache adds
  in that mode is the settings row that carries the switch itself.
- Guard: `server/src/myrmidon/tool-policy-cache/tool-policy-cache.myrmidon.test.ts`
  drives the cache directly (TTL window, invalidation, eviction cap, the
  switched-off mode) and through the real `toolAccessPolicyService` on a fake
  database handle that counts the SELECTs per table: two decisions inside the
  window cost one snapshot load, a policy change through the API is visible to
  the next read and to the next decision with the clock untouched, and with
  `ttlMs: 0` every decision reads the policy tables again.

### VOICE-STT part C: the speech recognition settings screen (VOICE-STT-C)

- Company Settings gets a "Speech" screen (`/company/settings/voice-stt`): enable
  recognition, pick the provider (DashScope or Deepgram), the model, the
  language (auto or Russian), speaker separation and the recording length limit.
  Only changed fields are saved. Secret values never reach the screen.

### VOICE-STT part B: speaker diarization and the meeting protocol (VOICE-STT-B)

- The recognition path now answers the speaker-label outcome as a value: which
  call asked for diarization, whether the answer carried labels, how many
  speakers it found and, when labels are missing, the stable marker
  `diarization_no_speakers`. The LiteLLM/DashScope path asks the model for
  labels the way the Deepgram path already did — with the setting on, a
  recording with two voices comes back as «Говорящий 1/2» lines.
- A model that cannot separate voices is no longer a silent single-voice
  transcript: the task comment carries the marker line «Говорящие не размечены:
  diarization_no_speakers», and the meeting protocol reports the participants
  as unmarked instead of naming one.
- The work bot builds the meeting protocol from the labeled transcript — a
  deterministic pass (participants, decisions, action items) exposed as the
  function `buildMeetingProtocol` and as
  `POST /api/myrmidon/companies/:companyId/voice-meeting-protocol`, which
  answers the ready markdown document plus the facts it was built from. Naming
  the people behind «Говорящий N» stays with the bot's own meeting skill.

### VOICE-STT part A: Telegram voice and audio are recognized at intake (VOICE-STT-A)

- The shared speech-to-text core (`server/src/myrmidon/stt/`) is now wired into
  the inbound Telegram lane: with the feature enabled, a voice note or audio
  file arrives as a task comment whose body carries the transcript next to the
  kept attachment, so the bot reads it as user input on the same wakeup.
- The feature can be enabled per company from the STT settings screen — no
  server restart: the stored setting is read on every voice message. The
  environment variable `MYRMIDON_TELEGRAM_VOICE_STT` stays the instance-wide
  master switch and, when it names a value, wins over the company setting in
  both directions.
- A recognition failure (gateway unavailable, recognition model not registered,
  timeout, oversized or too long recording) is a skip, never a delivery
  failure: the comment keeps the vendor body and its metadata carries the
  redacted `stt_skipped: <code>` code.

### LLM Wiki plugin install/upgrade guide and release wiring test (WIKI-PLUGIN-RELEASE)

- `docs/wiki-plugin-install-guide.md` — installation, folder configuration,
  upgrade and troubleshooting steps for `@paperclipai/plugin-llm-wiki`.
- `scripts/myrmidon/wiki-plugin/wiki-plugin-release.test.mjs` — static
  `node:test` contract that pins the plugin's release wiring (esbuild build
  script, SDK from the repository workspace, `paperclipPlugin` entry points,
  packaged file list, esbuild config, guide presence) inside the cheap
  `checks` tier, without running a build.

## 1.6.4

### Fix: the board failed to start when a synthetic attention card was present

- The attention list looks up agent names with `agents.id IN (...)`. The
  bot-disk lifecycle card uses a key (`bot-disk-lifecycle`) as its subject id,
  not an agent id, and that key went into the lookup; Postgres rejected the
  uuid cast and the board exited at start. Agent-name lookups now take only
  uuid-shaped ids (`isAgentIdLike`), and the clone-hygiene lookup skips the
  query when no bot key is a uuid.

### Registry entries as per-PR change fragments (CHANGE-FRAGMENTS)

- The shared registry documents — `docs/myrmidon/CHANGELOG(.ru).md`,
  `DIVERGENCE.md`, `SETTINGS(.ru).md` — are no longer appended to by hand.
  Every PR adds its entry as one file in `docs/myrmidon/changes/` (format and
  template: `docs/myrmidon/changes/README.md`), so two PRs with changelog
  entries merge back to back without conflicts instead of re-resolving the
  same append conflict in a circle.
- At release cut `node scripts/myrmidon/release/collect-fragments.mjs
  --version X.Y.Z` folds every fragment into the shared documents (changelog
  sections under a new `## X.Y.Z`, an empty `## Unreleased` /
  `## Без выпуска` left on top; divergence/settings table rows into the
  section the fragment names) and deletes the fragment files.
- A CI gate (`scripts/myrmidon/ci/change-fragments-gate.mjs`, running inside
  the existing node:test step of the checks job — no workflow change) refuses
  a PR that edits a shared registry document by hand and prints the hint:
  restore the file, add a fragment. The release-cut PR is recognized by the
  fragment deletions it carries and passes.

### Vendor share metric: measuring files inherited from the vendor (VENDOR-SHARE-METRIC)

- `node scripts/myrmidon/vendor-share.mjs` measures how many tracked files the
  fork still inherits from the pinned vendor base commit
  (`scripts/myrmidon/vendor-base.txt`, refreshed per vendor import). A file is
  inherited when its path existed at the base (renames followed via
  `git diff -M`) and its line similarity against the base revision is at or
  above the threshold (`--threshold` flag → `MYRMIDON_VENDOR_SHARE_THRESHOLD`
  → built-in 0.5; the report names the source it used). Output is JSON or a
  short Markdown table; the release ritual records the number, replacing the
  hand audit.

### Board MCP tool names renamed to `myrmidon*` with one-release aliases (1.7 REBRAND D)

- The board MCP server (`packages/mcp-server`) publishes every tool under a
  `myrmidon*` name (`myrmidonMe`, `myrmidonListIssues`, `myrmidonUpdateIssue`,
  …). Each old `paperclip*` name stays registered as a deprecated alias bound
  to the same handler for exactly one release, so existing agent skills and
  installed systems keep working; the alias is marked in the tool description.
  The `connections_search`/`connection_request` tools have no vendor prefix
  and are unchanged. Details and the 1.8 removal plan:
  [guides/mcp-tool-names.md](guides/mcp-tool-names.md).
- Guard test: `packages/mcp-server/src/tool-aliases.test.ts` (both names call
  one handler; every old name mapped and marked deprecated; catalog-drift
  guard).

## 1.6.3

### One deploy for every component (ONE-DEPLOY)

- A release deploy now updates every component in one maintenance window:
  `deploy.sh --release myr-vX.Y.Z` reads the release's component digests (board,
  dockergate, fleetd, bot images) from the new machine-readable release asset
  `release-components.json` (the release publish step uploads it; the digest table of the
  release body is the fallback for older releases). On 04.10 the board moved to 1.6.2 while
  dockergate stayed on 1.3.0 and the shared package cache did not work until dockergate was
  updated by hand.
- Components that already run their release image are not restarted; a release with
  missing digests, or a component that cannot roll out, is refused before the window.
- The window is all-or-nothing: a failing component rolls the changed components, the
  dockergate config and the board back together (`MYRMIDON_COMPONENT_AUTO_ROLLBACK=0` keeps
  the manual contract).
- dockergate: `dockergate check-config` runs with the new image before the service is
  recreated; after the recreate the startup self-check version is verified; the release bot
  images (including the dev variant) are added to `images[]`.
- Bot cards that track the release image (a previous release image of the same repository)
  switch in batches of at most 5, only while the agent is paused or idle; pinned cards are
  left alone; progress and failures are reported. Includes BOT-IMAGE-ROLLOUT (PR #454).
- `component_host_service_exists` no longer reports a service as missing when `grep -q`
  closes the pipe early (SIGPIPE under `pipefail`).

### Prompt-budget advice and deep analysis (PROMPT-BUDGET part C)

- The agent card's Overview tab carries a "Prompt budget advice" panel: the last run's
  prompt breakdown by parts, a concrete recommendation for every part whose share crosses
  30% (Critical from 50%; below 2000 prompt tokens no advice is produced — the thresholds
  are code constants, not settings), and a "Deep analysis" button that files a task for a
  cheap-model optimizer agent. The optimizer drafts instruction edits as a comment on that
  task; nothing is scheduled and nothing is changed automatically.
- The optimizer agent is the instance general setting `promptBudget.optimizerAgentId`
  (no environment variable); the deep POST answers 422 with a clear message when it is
  absent, not a uuid, the analysed agent itself, or not an agent of the company. Dedup:
  one deep task per target agent per run.
- API: `GET /api/myrmidon/companies/:companyId/prompt-budget/agents/:agentId/advice`
  (company member), `POST .../advice/deep` (board). Operator guide:
  [guides/prompt-budget-advice.md](guides/prompt-budget-advice.md).

### Agent memory works without a key and is set in the UI (MEMORY-UI)

- The Memory tab on the agent card no longer says "Agent memory is not enabled on this
  instance" for a memory service without authentication. The API key is optional: the
  section is on whenever an address is known, and the key is sent only when a key secret
  is named.
- The address defaults to `MYRMIDON_BOT_HINDSIGHT_API_URL` (the same service as the bots
  use) when `MYRMIDON_HINDSIGHT_API_URL` is unset. Precedence: instance setting, then
  environment, then the bot address.
- New instance setting `general.agentMemory` (`enabled`, `apiUrl`, `keySecretName`) with an
  "Agent memory" panel in Instance settings → General and `GET`/`PATCH
  /api/myrmidon/agent-memory`. It is re-read on every request: no restart. See
  [SETTINGS.md](SETTINGS.md).

### Automatic reviewer for tasks in review (REVIEW-ROUTING)

- A task that moves to `in_review` with no reviewer no longer waits for a manual
  assignment. A board sweep (every 60 s) gives it a one-stage review with the
  least-loaded agent of the reviewer roles that is below the load ceiling — never
  the task's author or assignee — leaves a system comment and an activity entry,
  and wakes the reviewer. The review is the ordinary execution review stage:
  approving closes the task as done, requesting changes returns it to the previous
  assignee.
- When no reviewer is available the task raises an attention card
  (`review_routing`) instead of staying silent. A review this routing started that
  has no verdict after the configured hours raises a card and moves to another
  reviewer (never one that already had it).
- Settings — enabled, reviewer roles, max load per reviewer, reassign-after hours —
  are on the new Company Settings → Review routing screen (stored in the instance
  settings) and apply on the next pass, without a restart. See
  [SETTINGS.md](SETTINGS.md), section "REVIEW-ROUTING".

### Live progress steps in the Telegram DM status message (DM-PROGRESS)

- The owner reported that a bot in a bridged Telegram DM only says "queued",
  "working" and then the result, with nothing in between. While a run is
  active the one status message now shows what the bot is doing — "читаю
  презентацию deck.pptx", "правлю слайды 4, 9", "проверяю результат" — plus the
  last few finished steps and the elapsed time, and is edited in place until
  the answer replaces it.
- Steps come from the run's native step events and, for adapters that write
  none (the Hermes gateway and local adapters), from a small in-memory step
  history fed by the runtime status and the run-log tool lines. A tool call
  reaches the chat only as a short phrase with at most a file basename or
  slide numbers; commands, paths and arguments never do.
- Edits are throttled: a milestone change posts at once, a change of the step
  kind (reading, editing, checking) after about 5 seconds, anything else only
  once the configured interval has passed (default 45 s).
- On/off and the interval live in Instance settings → General ("Telegram DM:
  live progress", `GET`/`PATCH /api/myrmidon/telegram-dm-progress`) and apply at
  the next status update without a restart. Environment overrides:
  `MYRMIDON_TELEGRAM_DM_PROGRESS`, `MYRMIDON_TELEGRAM_DM_PROGRESS_INTERVAL_SEC`;
  the default of "on" follows `MYRMIDON_TELEGRAM_DM_STATUS`. Turning it on also
  turns the status message on for bridged DMs.
- The queued and working texts of the status message are now in Russian, like
  the step labels. Guide: [telegram-dm-status.md](guides/telegram-dm-status.md).

### Idle engineers take unassigned ready work (1.6.2 SWARM-UNASSIGNED-ROUTE)

- The swarm idle pass paired free agent number i with queue slot i. The engineer
  queue is ordered by priority and also held the tasks already assigned to busy
  peers, so those filled every slot and the unassigned tasks behind them were
  never offered: idle engineers and ready unassigned `todo` tasks coexisted for
  hours. Now each free agent takes its own assigned task first, else the top
  unassigned task of its role; a peer's task is never offered to it, and tasks
  already covered by a live claim or a wake in flight no longer take a slot. The
  claim path (`claimNextTaskForAgent`) reads the same membership: the agent's own
  tasks plus the unassigned tasks of its role.
- An unassigned task is queued for one role: the one its `role:<key>` label
  names, the engineer when it has no such label (before, every role was offered
  every unassigned task).
- A config gap is a signal, not idleness: ready tasks routed to a role with no
  agents are reported on every pass (`idleUnstaffedRoles` in the pass result and
  a warning naming the role and the tasks).

### Heavy builds blocked inside the dev bot image (1.6.1 BUILD-OFFLOAD, part A)

- The development variant of the bot image (`runtime-dev`,
  `ghcr.io/itkadr-git/myrmidon-hermes-dev`) no longer relies on convention to keep
  heavy repository operations off the bot container: `pnpm`, `tsc`, `vitest`,
  `gradle` and `go` shims in `/opt/paperclip/bin` (first on `PATH`, ahead of the
  real binaries) refuse every non-trivial invocation with exit 1 and a stderr
  message naming the exact `devbuild …` replacement, unless an executable
  `/usr/local/bin/devbuild` exists in the container. That gateway file is never
  baked into the image — the part-B driver mounts it into the per-invocation
  build container — so the barrier is always closed in the ordinary bot
  container. See
  [docker/bot-runtime/README.md](../../docker/bot-runtime/README.md), section
  "Heavy builds are blocked at the image level".
- Light probes keep working locally: `pnpm --version`, `pnpm config …`,
  `pnpm store status`/`path`, and bare `--version`/`--help` of the other wrapped
  tools. `git`, `node`, `cargo`, `gh` and `docker` are deliberately not wrapped —
  the light, editing half of the cycle still runs in the container. To run a
  build: `devbuild pnpm install`, `devbuild pnpm exec tsc --noEmit`,
  `devbuild pnpm vitest run`, `devbuild go build ./...` — the workspace is
  mounted into a build container on the build VPS and the same command runs
  there.

### Release publish waits for the tag's own image runs (RELEASE-PUBLISH-WAIT)

- Pushing the `myr-v1.6.1` tag failed to publish the Release on the first
  try: the publish gate matched workflow runs by the tag commit's
  `head_sha` only, so it saw the already-green `main`-branch run of the
  same commit (which builds the `main`/`sha-` image tags) instead of
  waiting for the tag's own board image run, and then the digest probe
  failed with "component image digests missing … board". The gate now
  also filters runs by `head_branch == the tag`, so the publish waits for
  every required image workflow of the same tag (up to ~40 minutes) and
  a failed tag run still refuses the publish with the workflow's name.
  Follow-up (same day): the CI gate accepts a green main-branch run of the
  same commit — `myrmidon-ci.yml` has no tag trigger, so a tag never has a
  CI run of its own and the strictly tag-scoped gate would have refused
  every publish after ~20 minutes of polling.
- A manual re-run from the `main` branch no longer overrides the typed
  tag: `myrmidon-release.yml` resolves the tag as
  `inputs.tag || github.ref_name` (checkout `ref`, `TAG` env and the
  concurrency group), so `gh workflow run myrmidon-release.yml -f tag=…`
  from `main` publishes the given tag without `--ref`.

### Chats are never held; an owner message always wakes (CHAT-HOLD)

- Incident: a host OOM cancelled the run of a perpetual Telegram DM chat;
  execution recovery closed it as "do not replay" and set the chat issue
  `blocked`, and every later owner message was parked as
  `deferred_issue_execution` behind that hold. The owner saw only "Your
  follow-up is queued" for hours.
- A chat is a conversation, not a work ticket. An issue that backs a chat (a
  bridged chat thread, or a board Agent Chat conversation) is never put into
  `blocked` by automatic recovery and gets no replay hold: its stopped turn
  is settled as `chat_continuation`, the issue returns to the idle
  `in_review` state, and the next message is a fresh turn. Ordinary work
  issues keep the existing recovery unchanged.
- A new message a person writes in a chat is an explicit human action: the
  wake admission passes any settled hold of the chat, lifts it with the
  successor run (the same clear path as the board unblock), moves a chat the
  recovery had blocked back to `todo`, and records it in the activity log
  (`issue.execution_recovery_settled`, `continuation: chat_owner_message`).
  A "retry the failed run" wake is not a message and stays withheld.
- No silent queue: when a message in a bridged Telegram DM cannot start (the
  previous turn is winding down, recovery, a pending decision, a paused
  agent, an exhausted budget, the host memory gate), the chat is told why in
  plain Russian, with a time estimate where one is known (the memory gate
  re-checks every 15 seconds). Guide: [telegram-dm-status.md](guides/telegram-dm-status.md).

### Shared package cache for development bots (1.6.2, BOT-DISK B)

- An instance setting, `general.botDisk.sharedPackageCachePath` (Instance → General or
  `PATCH /api/myrmidon/bot-disk`, instance admins only), gives every bot on the board's host
  read-write mounts `/cache/{pnpm,go-mod,go-build,gradle}` from one host directory, and the
  profile points `npm_config_store_dir`, `GOMODCACHE`, `GOCACHE` and `GRADLE_USER_HOME` at
  them, so downloads are kept once instead of once per bot. Applies on the next reconcile pass
  without a restart; off by default. Bots on a fleetd host are not affected.
- dockergate: new `packageCacheRoot` key (default empty: no cache bind). **Operator step:** set
  it to the same directory and send `SIGHUP`, and create the four subdirectories owned by
  uid/gid 10001 — see [bot-disk-cache.md](bot-disk-cache.md).

### Bot workspace duplication: shared git objects, hard-linked node_modules, clone hygiene (1.6.2, BOT-DISK C)

- Shared git objects. `general.botDisk.gitMirrorRepos` lists GitHub `owner/repo` names; the board
  keeps one bare mirror of each under `<sharedPackageCachePath>/git/<owner>/<repo>.git`
  (refreshed by `git fetch --prune` every `gitMirrorRefreshMs`, default 15 minutes, under a lock;
  gc never prunes), and bots mount it **read-only** at `/cache/git`. The dev image's `git`
  wrapper adds `--reference-if-able` to `git clone https://github.com/<owner>/<repo>` when the
  mirror exists, so a clone stores only objects the mirror lacks; every other git invocation is
  unchanged and `git-credential-paperclip` keeps working. Off by default (empty list). dockergate
  accepts `<packageCacheRoot>/git` only as a read-only bind to `/cache/git`.
- Hard-linked node_modules. A hard link cannot cross a mount, and `/workspace`, `/cache/pnpm`
  and the image's previous store `/data/hermes/.pnpm-store` are three different mounts, so pnpm
  silently **copied** every package into every clone. The store now defaults to
  `/workspace/.pnpm-store` (image and profile), on the clones' mount; `general.botDisk.pnpmStore:
  "shared"` keeps it on `/cache/pnpm` and sets `package-import-method=clone-or-copy` for
  reflink-capable filesystems. The dev image's build runs `pnpm-hardlink-check.sh` and fails on a
  copy; CI runs the same proof, including the cross-mount copy.
- Clone hygiene in the BOT-DISK A lifecycle. A git clone is no longer reaped by its directory's
  mtime. The board server has no mount of the bot volumes, so the BOT-DISK A sweep found no root
  and reclaimed nothing in production; it now logs one warning, does nothing, and raises a
  "Lifecycle not effective" Attention card when no bot reports either. The deletion runs inside
  each bot container (`bot-clone-hygiene`, policy `MYRMIDON_CLONE_IDLE_TTL_SEC` written into the
  profile): a clean, fully pushed, idle clone is removed, a clone with unpushed work (dirty tree,
  operation in progress, stash, commits on no remote) never is, and the board reads the report to
  raise an Attention card (source `bot_disk_lifecycle`) for it. The workspace pnpm store is
  never swept.
- Scope: the shared package cache and the git mirror now apply only to bots whose role is in
  `general.botDisk.sharedCacheRoles` (default `engineer`, `reviewer`, `devops`, `release`, `qa`;
  editable without a restart). Other bots (e.g. marketing) get no cache mounts or variables, so
  enabling the cache no longer recreates them.
- **Operator steps:** see [bot-disk-cache.md](bot-disk-cache.md#enabling-git-mirrors-operator-steps)
  — create `<cache>/git` owned by the board's user (mode 0755), then
  `PATCH /api/myrmidon/bot-disk` with `{"gitMirrorRepos": ["owner/repo"]}`. The bot image must be
  rebuilt (the wrapper, the reporter and the store default are in the image); older images keep
  working without them.

### A board unblock lifts a settled replay hold; a parked wake is not "covering" (HOLD-READY)

- A task with a closed recovery action whose `evidence.automaticRecovery.replay`
  reads `"blocked"` stayed stuck for good: the wake admission parked every
  automatic wake of it (`deferred_issue_execution`, `executionWait`
  `process_identity_missing`), idle pickup and the swarm sweep then counted that
  parked wake as "already covering" the task and skipped it, and a manual
  `POST /api/agents/:id/wakeup` without `issueId` answered 409 "no ready task".
  Moving the task from `blocked` back to `todo` on the board did not help: the
  status-change and comment wakes of that PATCH are not explicit wakes and were
  parked as well. Agents sat idle with a full `todo` queue.
- Now a board person (not an agent's run) who moves a task out of `blocked`
  (to `todo`/`in_progress`) or reassigns a workable task clears its settled
  replay holds in the same transaction, the same operator resolve as
  `recovery-actions/resolve` (activity `issue.execution_recovery_replay_cleared`).
  After commit one wake of the assignee (`execution_hold_cleared`) re-plans the
  wakes parked on the hold through the ordinary admission. Active/escalated
  recovery actions are not touched.
- A deferred wake parked on an execution hold no longer counts as covering the
  task in idle pickup, the manual-wake task binding or the swarm sweep, and the
  ready-task prefilters of idle pickup and the swarm queues skip a task that is
  really held (the same predicate the admission reads), so a held task is not
  reported as ready. No settings change.

### Gateway spend attributed through per-bot secret references (1.6.2 hotfix, M2-A)

- The gateway cost sweep wrote no rows: every collected spend row was counted as
  unattributed. Bot cards carry their gateway key as a `secret_ref` binding
  (`adapterConfig.env.<MYRMIDON_BOT_LLM_API_KEY_ENV>` = `{ type: "secret_ref", secretId, version }`,
  one company secret per bot), and the key lookup only understood an inline value or the one
  shared secret. The lookup now resolves the card's secret reference by id and version, the
  same reference the bot's container is compiled from, so the key hash matches the gateway
  ledger and rows are attributed to the agent and its run. Inline values still work; the
  shared secret (`MYRMIDON_BOT_LLM_API_KEY_SECRET`) is read once per pass and only for cards
  without their own binding; a reference to a secret that cannot be read skips that card
  instead of falling back to the shared key. The model fallback signal, which reuses the
  lookup, is fixed by the same change. No settings change.
### Plugin bridge: invocation-scope attribution from any in-flight invocation (PLS1 -> PLS2)

- The plugin bridge attributes an un-echoed worker call (a worker whose bundle
  carries a plugin SDK that predates invocation-id echo) to the company of ANY
  in-flight host-issued invocation — a plugin API route, `onEvent`,
  `performAction`, `getData`, `executeTool` or an environment call — instead
  of only an in-flight API route call. Bridge entry points register their
  invocation scope without the apiRoute marker, so nested calls issued from
  those handlers (the LLM Wiki plugin's `localFolders.*` calls) were answered
  with "missing, expired, or unknown invocation scope"; this change closes the
  same gap on `bridge/data`, `bridge/action` and plugin tool calls, fixing the
  empty page list, pages that would not open and the failing
  `wiki_write_page`-style tools of plugins built with the old SDK.
- The safety guard is unchanged: attribution applies only while every
  in-flight invocation of any kind belongs to one company; an in-flight call
  of another company keeps the call denied (`INVOCATION_SCOPE_DENIED`), and a
  call carrying an unknown or forged invocation id is still rejected.
- The scope is always the host-issued one (the company the entering call
  resolved and authorized); a value from the worker is never taken. No rights
  are widened: the worker received the invocation ids of those calls and
  could echo any of them.
- The resolver moved from `server/src/myrmidon/plugin-api-route-scope.ts`
  (deleted) to `server/src/myrmidon/plugin-invocation-scope.ts`; the vendored
  worker manager marks the new branch `myrmidon(PLS2)` and the divergence
  registry entry in [DIVERGENCE.md](DIVERGENCE.md) was rewritten for the
  all-entry-points semantics. The removal condition stands: once the plugin
  is rebuilt from `packages/plugins/plugin-llm-wiki` with the current SDK
  (the worker echoes the invocation id itself), the PLS1/PLS2 branch, the
  `apiRoute` field and the resolver files go away.
- Guard test: `server/src/myrmidon/plugin-invocation-scope-bridge.myrmidon.test.ts`
  with the fixture
  `server/src/__tests__/fixtures/plugin-worker-invocation-scope-bridge.cjs`
  covers the three bridge entry points (red without the fix, green with it)
  and the cross-company denial.

### Automatic rollback by health: operator guide (AUTO-UPDATE-SETTINGS A)

- Docs only: the existing R5-C behavior (a failed post-deploy health check rolls
  the board back to the remembered previous image, `auto_rolled_back` /
  `failed_rollback`) gets its operator guide,
  [guides/deploy-auto-rollback.md](guides/deploy-auto-rollback.md)
  ([RU](guides/deploy-auto-rollback.ru.md)): when the rollback fires, the job
  and report phases, where the failure reason is recorded (job steps, activity
  log, the executor log), what the owner sees when a rollback fails (the
  maintenance banner, the Board update panel, the Telegram digest), and the
  settings of both halves of the switch. The `MYRMIDON_DEPLOY_AUTO_ROLLBACK`
  row of [SETTINGS.md](SETTINGS.md) links the guide. No code change; the
  acceptance test of the behavior is the R5-C block of
  `server/src/myrmidon/deploy-jobs/service.myrmidon.test.ts` and
  `scripts/myrmidon/deploy/deploy-from-job.test.mjs` (a deliberately broken
  image against the fake driver).

### Budget enforcement modes (1.7 BUDGET-CONFIG B)

- What a crossed spend budget limit does is now a mode, not a fixed stop:
  `signal_only` (the default — the incident and the owner signal appear, but
  the scope is not paused and runs start), `soft` (pause plus the "raise the
  budget or keep paused" card; raising resumes the scope), `hard` (new runs
  of the over-limit scope are refused with the budget reason). One mode for
  the whole instance, changed live from Instance → General or
  `PATCH /api/myrmidon/budget-enforcement` — no restart; every change is
  audited, and the value's source (saved / environment / default) is shown.
  The environment override is `MYRMIDON_BUDGET_ENFORCEMENT_MODE`. Guide:
  [guides/budget-enforcement.md](guides/budget-enforcement.md).

### Maintenance: asynchronous exit and the post-deploy fleet check (EXIT-ASYNC + POST-DEPLOY-CHECK)

- Leaving maintenance mode is asynchronous (#268): the `exit` call returns as
  soon as the window is marked `leaving`, and the leave tail (resuming the
  queued wake backlog, the exit hook, retiring the window) runs on the
  maintenance tick (`MYRMIDON_MAINTENANCE_TICK_SEC`, default 5 s). `leaving`
  already reopens admission, so the fleet keeps working while the tail runs.
- The deploy waits on the state, not on the HTTP call: after the exit POST,
  `deploy.sh` polls the maintenance state until the instance window is `off`,
  bounded by `MAINTENANCE_EXIT_WAIT_SEC` (default 120 s). A timeout is logged
  loudly and does not fail an already switched and healthy deploy; a failed
  exit request still aborts it.
- The deploy ends with a read-only post-deploy fleet check (step 9,
  `post_deploy_fleet_check`): with `BOARD_API_URL` and `BOARD_COMPANY_ID` set
  it asks the board for issues that are `blocked` with an update since the
  deploy started and re-reads the maintenance state. A hit, an unreadable
  board or a window that did not retire prints `degraded: ...` and the run
  ends with `DEPLOY DEGRADED` — the verdict does not fail a switched and
  healthy deploy. Without the two settings the check is skipped.

### WIP limit (WIP-LIMIT parts A + B)

- The per-agent work-in-progress limit: a company-wide default and
  per-agent overrides edited on the "WIP limit" screen in Company Settings
  (sidebar item after Autonomy); each agent's live
  `in progress + in review` load shows in the screen's table, as a
  `wip/limit` badge on every agent row of the agents page (red over the
  limit, bare count when the limit is off, no badge without a status
  entry), and in the attention feed (source kind `wip_limit`, one card per
  over-limit agent). A periodic sweep on the heartbeat scheduler (300 s)
  writes one system-notice comment per over-limit agent per UTC day
  (dedup key `wip-limit:<agentId>:<utc-day>`) on the agent's most recent
  in-progress task. The settings live in
  `instance_settings.general.wipLimit` — no environment variables; an
  absent limit means count-only (status and badge still work, nothing
  signals). A lead (an agent with direct reports) has an implementation
  limit of 0 — any task it holds in flight is over the limit by
  definition. See [wip-limit](guides/wip-limit.md).

### Telegram notification settings UI (TG-NOTIFY-SETTINGS part F)

- The "Telegram notifications" panel on the System screen of the 2.0 UI: all
  five sections of the telegramNotify settings are visible and editable
  (digest, errors, owner messages, escalations, head-bot proactivity), every
  section off by default, with the settings change log rendered from the
  document the settings core serves. Saving sends one PATCH with only the
  changed fields. Depends on the settings core (part A); while that is not
  merged the UI is covered by tests against the mocked JSON contract.

### Voice STT, server core (VOICE-STT part A)

- The server-side speech-to-text core (#418): `server/src/myrmidon/stt/` with
  the `dashscope` (multipart `POST /v1/audio/transcriptions` on the shared
  LiteLLM gateway) and `deepgram` backends, a pure-TypeScript long-recording
  split (OGG page / MPEG frame boundaries, no ffmpeg) with timecode-offset
  merge and record-scale speaker renumbering, and the
  `transcribeAudio({companyId, bytes, mimeType, durationSec?})` contract with
  the stable error codes `stt_disabled`, `stt_unconfigured`, `audio_too_long`,
  `audio_too_large`, `stt_timeout`, `stt_upstream_error`. Off by default:
  without `MYRMIDON_STT_ENABLED` the path makes no outbound request. Backend
  keys are company secrets referenced by name only (read per call, never
  cached, never logged). Per-company runtime overrides live under
  `instance_settings.general.myrmidonSttCompanies[companyId]` and are managed
  through `GET`/`PATCH /api/myrmidon/companies/:companyId/voice-stt` (GET is
  company access, PATCH is board only; every save is journaled as
  `myrmidon.stt.settings_saved`). See [SETTINGS.md](SETTINGS.md), the VOICE-STT
  section.
## 1.6.2

### Run admission by host free memory and a start ramp (RUN-ADMISSION)

- The run admission gets a host free-memory floor, `minFreeHostMemoryMb`
  (`MYRMIDON_MIN_FREE_HOST_MEMORY_MB`, default 15360 MB): a new run, whatever
  woke it (on demand, assignment, idle pickup, swarm idle wake, automation),
  starts only while the host's `MemAvailable`, minus the per-run budget of runs
  started in the last 30 s, stays at or above the floor. Otherwise it stays
  `queued` and the 15 s queue pass retries it. The existing
  `minFreeMemoryMb` measures the server cgroup and cannot see the bot
  containers, which is how 23 concurrent runs exhausted the host while the
  server looked healthy.
- Host memory is read from `/proc/meminfo` (the host's file inside a Docker
  container without lxcfs); a container-scoped meminfo (lxcfs) is detected and
  refused, and `MYRMIDON_HOST_MEMINFO_PATH` points at a mounted host file.
- The start ramp `maxStartsPerMinute` now defaults to 5 (was off). An instance
  that already saved its run limits keeps its saved value; change it on the
  settings page.
- The swarm idle-wake pass wakes nobody while the floor is closed and logs the
  reason (at most once per 5 minutes).
- When the floor holds runs back for more than 10 minutes, the attention desk
  shows "Runs held: host memory" with the current free memory and the floor.
- Both values are edited without a restart on Instance → General "Run limits",
  Settings → "Runs & queue" and `PATCH /api/myrmidon/runtime-limits`. A stored
  row from an older version (without the new key) keeps working; the floor
  comes from the environment or the default until the next save.
- `0`/`off` switches the floor or the ramp off from the environment; a
  malformed value keeps the default. See [SETTINGS.md](SETTINGS.md) and
  [guides/run-limits.md](guides/run-limits.md).

## 1.6.2

### Bot language servers by role (BOT-LSP-DEFAULTS)

- Bots whose role writes code (by default the castes `engineer`, `qa`,
  `devops`, `reviewer`, `release`) run language servers in a **limited** mode:
  one TypeScript server per worktree (`tsserver.useSyntaxServer: "never"`),
  no automatic typings download, a 1024 MB heap cap (`maxTsServerMemory`) and
  a 120 s idle timeout instead of 600 s. Every other bot runs **none**
  (`lsp.enabled: false`). Monorepo typecheck still goes through the build
  server.
- The policy is an instance setting (Instance settings → General → "Bot
  language servers", `GET`/`PATCH /api/myrmidon/bot-lsp`): which roles write
  code, the mode of coding and other roles (`off` / `limited` / `full`), the
  idle timeout, the memory cap and excluded workspace roots. An agent card can
  pin its own mode ("Language servers" section).
- Changes apply without a server restart: the profile compiler re-reads the
  policy on every reconcile tick, and a changed `lsp` block is applied while
  the bot is paused, like a model change. On the first deploy every container
  bot gets the new block once (one restart per bot, under its pause).

## 1.6.1

### Role queues as instance settings (SWARM-SETTINGS-UI)

- The pilot of the per-role task queues is set in the interface, without a
  restart: the "Role queues (SWARM-CLAIM)" section of Instance → General
  (`GET`/`PATCH /api/myrmidon/swarm-claim`, board reads, instance-admin
  writes) holds the master switch, the pilot role set (the pilot on the dev
  team: comma-separated roles, e.g. `engineer`), the pilot company set, the
  lease TTL, the per-agent task ceiling, the sweep interval and the P0
  preemption. The server re-resolves the row on every claim, checkout, sweep
  tick and supervisor read: turning a role on takes effect within a minute,
  and turning the pilot off releases the live leases at once — the PATCH does
  it synchronously (the response reports the count) and the sweep repeats it
  on its next pass with the release reason `pilot_disabled`. The `MYRMIDON_SWARM_*`
  environment variables are now documented forced overrides: a set variable
  beats the stored value for its key only, and every key of the GET answer
  carries its source (`settings`, `env` or `default`) — both the settings
  screen and the Swarm supervisor screen render where each value came from.
  Every change appends a journal entry (who, what, when — newest first, kept
  under `general.swarmClaimJournal`) plus the `instance.swarm_claim.updated`
  activity row. The P0 preemption became a setting: off demotes the priority
  rank to a tie-break, the queue is strictly oldest-first. Under the hood the
  stored settings never survived the vendor general-settings write cycle (the
  key was dropped on every write, so the pilot could in practice only be
  enabled from the environment) — fixed together with the journal key.
  See [SETTINGS.md](SETTINGS.md).

### SWARM-IDLE-WAKE: Free agents wake when their role queue is not empty

- Third pass of the swarm supervisor (`sweep.ts`, after the release and free passes): on each tick, for each pair of "role + ready queue + free agents", wakes the missing number of agents, in batches ≤5 (`MYRMIDON_SWARM_IDLE_WAKE_BATCH`, default 5, clamp 1–25), each wake bound to the top task of the queue (P0 first — `orderSwarmQueueCandidates`). Pure modules: `idle-wake.ts` (policy: no live lease, under task ceiling, not paused/error, no live run, idempotency key) and `idle-queue.ts` (DB reads: role-queue pairs, live claim counts, coverage check). Assigned tasks go to the role of their executor; tasks without an executor are offered to every role with agents. The active task limit is respected, castes remain a gate on the claim side (`caste_excluded`, CUSTOM-CASTES B) — the point of control; the caste ceiling is respected. Supervisor metric: new total `freeAgentsWithQueue` — "free agents when queue is not empty" — which the pass should keep at 0 (unassigned tasks are now visible to roles with agents). Wakes go only through the existing `enqueueWakeup` (pause, maintenance, limits, budget — all gates preserved); the capture happens on checkout of the awakened run. The "one TTL + sweep interval" criterion is covered by a test (interval ≤ TTL/3). Docs: `MYRMIDON_SWARM_IDLE_WAKE_BATCH` in SETTINGS.md/SETTINGS.ru.md; skill `skills/paperclip/SKILL.md` supplemented with self-capture fallback (`POST /api/myrmidon/companies/{companyId}/swarm-claim/claim`).
### Grant-based actor permission checks (ADMIN-AGENT part B)

- Board-only actor-type checks on the company environments and
  tool-connections routes now follow the company permission grant: an agent
  actor passes when the company grants it the matching permission key —
  `environments:manage` for the environments routes (including reading the
  shared instance environment catalog), `tools:admin` for stdio command
  templates and tool gateway management, `tools:manage_connections` (or
  `tools:use` on the connection test routes) for connection testing,
  `tools:manage_runtime` for runtime slot control, and `tools:view_audit` for
  the raw gateway audit read. Board actors keep the exact previous semantics
  (instance admins and the local implicit board pass; signed-in members pass
  with the grant; viewers stay read-only), and an agent without a grant gets
  the same 403 as before the change, so enabling nothing changes nothing.
  Tool mutation activity-log rows now record the real acting principal — an
  agent-actor mutation writes `actorType: "agent"` with the agent and run ids
  instead of the old hardcoded board-user placeholder. Operator guide:
  [guides/actor-grant-routes.md](guides/actor-grant-routes.md).

### Custom castes, consumers (CUSTOM-CASTES B)

- The server-side consumers of the company caste directory (part A ships the
  directory itself): the agent role validator accepts any well-formed caste
  key (latin letters, digits, hyphens, 1–60) and the agent create/update
  service refuses a key that is not a caste of the company with a 400 that
  names the key; the swarm claim gate reads the claiming agent's caste —
  `swarmEligible=false` returns the new `caste_excluded` claim reason (a
  supervision caste never enters the claim pool), and a caste-set
  `maxActiveTasks` overrides the global swarm ceiling for that caste's
  agents. A role with no directory entry, and a build with no directory wired,
  behave exactly as before. The autonomy matrix and the authorization logic
  are unchanged — the caste key is the role string, the CEO checks stay
  byte-identical, and custom roles keep working through explicit grants.
  Regression tests pin all of the above, including "moving an agent to a
  caste changes no autonomy verdict". The behavior contract is documented
  in [SETTINGS.md](SETTINGS.md) (section "CUSTOM-CASTES B").

### Stale-block watchdog (STALE-BLOCK part B)

- Periodic module `myrmidon/stale-block`: every
  `MYRMIDON_STALE_BLOCK_INTERVAL_SEC` (default 300 s) it inspects blocked
  tasks and lifts a block whose every reason is dead — a blocker task that
  is done or cancelled (cancelled blockers never fire the
  blockers-resolved path), a passed `reasonRef.dueAt` date, or a cleared
  gate/event. Dead blocked-by edges are removed through the ordinary issue
  update path, the task returns to `in_progress`, and one system comment
  names the cause. A task with a live reason is untouched. Opt-in via
  `MYRMIDON_STALE_BLOCK_ENABLED` (default 0). Guide:
  [guides/stale-block.md](guides/stale-block.md).
- One new attention source kind `stale_block`: a lifted block raises one
  card for the lead and the operator, computed on the fly from a
  process-level signal registry (no new store); cards fade after
  `MYRMIDON_STALE_BLOCK_SIGNAL_TTL_MS` (default 24 h).

### Gateway-priced hermes runs (HERMES-USAGE-COST)

- hermes_gateway runs no longer land in the cost ledger as unpriced $0
  rows: after every LLM-gateway spend collection sweep, a reconcile pass
  fills each run's `cost_events` row with the gateway's own spend for that
  run (cost_status=reported) and refreshes the agent/company monthly
  counters. Only unpriced hermes_gateway rows are touched — adapter-priced
  rows and other providers are never overwritten, and a run with no
  collected spend stays unpriced instead of getting an invented price. The
  first sweep can look back up to 90 days
  (`MYRMIDON_LITELLM_FIRST_LOOKBACK_DAYS`), and
  `POST /api/myrmidon/companies/:id/litellm/sweep` accepts a `from` body
  for one-off month backfills. The UI-2.0 forecast chip shows
  "spent" only when no monthly budget is configured, ending the
  "$0 of $0" placeholder.

### Board administrators from agents (ADMIN-AGENT part C)

- The UI half of making an agent a board administrator. The agent card's
  **Permissions / Trust** tab gains a fourth flag, **Board administrator**:
  flipping it goes through the same permissions PATCH as the three sibling
  flags, the state comes from the agent detail API
  (`access.boardAdmin`, falling back to `permissions.boardAdmin`), and both
  readers are fail-closed — anything but an explicit `true` reads as "not an
  administrator". Operators see the toggle only with permission-management
  authority (owner or admin membership, instance admin, local implicit
  board); a 403 from the API becomes a plain-language note under the toggle.
  The Company Settings **Members** page names every agent administrator: one
  table row per non-terminated flagged agent, with a **Board administrator**
  badge and a link to the agent's Permissions tab. Operator guide:
  [guides/agent-board-admin.md](guides/agent-board-admin.md).

### Board administrator grant semantics (ADMIN-AGENT part A)

- The server half of the board-administrator switch. `PATCH
  /agents/:id/permissions` accepts an optional `boardAdmin` boolean: enabling
  grants the fixed operator set — the 17 keys of
  `BOARD_ADMIN_PERMISSION_KEYS` (`agents:create` … `joins:approve`), an
  explicit list that never silently widens when the global permission
  registry grows — and snapshots the set keys the agent already held into
  `permissions.boardAdminSavedGrantKeys`; disabling revokes only the keys the
  switch added, so personal grants (a separately issued `tasks:assign`)
  survive, and re-enabling keeps the original snapshot. `GET /agents/:id`
  resolves `access.boardAdmin` for the CEO, the stored flag, or a
  pre-existing full set (read-time migration — nothing is rewritten until
  the first toggle). Flipping the switch needs the company
  `users:manage_permissions` right (board actors) or the same grant (agent
  actors; an agent cannot grant board admin to itself — 403), and every flip
  logs `agent.permissions_updated` with the `boardAdmin` value and the acting
  principal. Same guide:
  [guides/agent-board-admin.md](guides/agent-board-admin.md).

### Parallel helpers without a hard cap (HELPERS-NO-CAP)

- The number of parallel helpers is a setting with **no built-in upper
  limit**; the default stays 2 (owner's decision, repeated 03.10). The hard
  cap of 50 that clamped even the owner's own settings value is gone: the
  company ceiling (`maxPerAgent`) and the per-agent limit are taken exactly
  as saved, from the interface, and the profile compiler resolves a card
  against the owner's number as written. Protection against a typo is a
  warning, not a clamp: the settings page shows a host-load note for a saved
  ceiling above 50 ("values this high put a real load on the host — make
  sure this is intended, not a typo"), and saving is never blocked. The
  agent card's limit field likewise accepts any whole number ≥ 1 and only
  rejects non-numbers. Settings documentation:
  [SETTINGS.md](SETTINGS.md) § PARALLEL-HELPERS.

## 1.6.0

### CTO chat planner (CTO-CHAT B)

- The board chat planner: one owner message in free text
  (`POST /api/myrmidon/cto-chat/plan`, or the same planning step entered from
  the owner's Telegram DM bridge) becomes a proposed epic with child tasks and
  per-task acceptance criteria. The proposal is shown as the board's existing
  `suggest_tasks` approval card on the standing conversation task, and
  accepting the card is what creates the issues — nothing exists before
  acceptance, no assignee is inferred, and a rejected or expired card creates
  nothing. The planner is off unless `MYRMIDON_CTO_CHAT_BASE_URL` and
  `MYRMIDON_CTO_CHAT_KEY_SECRET` are set; the gateway key is a company secret
  read per call and never logged. The default model is the free
  `dashscope-qwen-flash`; one proposal is capped at 8 child tasks (hard
  ceiling 20) and one planning call is never retried. Operator guide:
  [guides/cto-chat-planner.md](guides/cto-chat-planner.md). The portal chat
  screen (part A) is below.

### CTO chat (CTO-CHAT)

- The Commander chat screen of the 2.0 shell (route `commander-chat`, reached
  from the rail, the phone bottom bar and the `Ctrl K` "Tell the Commander"
  palette with the typed draft carried over): the owner writes one free-text
  request, the screen calls the board chat planner
  (`POST /api/myrmidon/companies/:companyId/cto-chat/plan`) and renders the
  proposed epic read-only — the epic, every child task, acceptance criteria
  line by line. The pending `suggest_tasks` approval card from the standing
  Agent Chat issue renders through the existing card component; accepting
  the card creates the issues, rejecting creates nothing. The same flow is
  reachable from the owner's Telegram DM. Operator guide:
  [guides/commander-chat.md](guides/commander-chat.md).

### Reference-task evals (EVALS-A part A)

- The evals path: a seeded corpus of neutral reference tasks for the pilot
  role `engineer`, an LLM judge behind the company's LLM gateway (a free
  DashScope model by default, one chat-completions call per task, strict JSON
  parsing — an unparseable response scores zero with a `parseError` flag, not
  invented points), per-task rubric scoring with the CI pass rate folded in
  for `code` tasks, and a promote/confirm/regress verdict where a drop beyond
  the threshold is only actionable after a confirmation run repeats it. The
  judge never executes code. Scores live in `myrmidon_eval_runs`; the optional
  Langfuse export is off by default and never blocks local scoring. Reads are
  company-scoped, run mutations need a board actor, and an unconfigured
  contour answers `503` with the names of the missing settings. The verdict
  seam for the skill lifecycle (`candidate → verified → deprecated`, with
  rollback) is exposed as `POST …/evals/verdict`; the merged lifecycle module
  does not wire it to the board yet. Guide: [guides/reference-task-evals.md](guides/reference-task-evals.md).

### Stack update screen (STACK-UPDATES part C)

- The «Stack» screen in the panel (Company → Stack, route `/stack`): every
  component of the stack registry with our version/commit/digest (or an honest
  `unknown` with the reason), where it runs, the latest upstream release, the
  release lag, the notable security/breaking lines of the release notes as a
  collapsible excerpt and the patch-closed verdict per carried delta; lagging
  components sort first, with a name filter. *Refresh data* and *Check
  releases* run the instance-admin `POST /api/myrmidon/stack/refresh` /
  `POST /api/myrmidon/stack/check` from the screen — a failure, including the
  503 of a broken probe, is shown in place without losing the table. The
  *Schedule update* button on a lagging row opens a dialog with a default plan
  (versions, our patches, notable lines, canary then production, rollback) and
  creates an unassigned backlog draft task through the existing issue-creation
  route — nothing is deployed from the screen. The release check itself
  (part B: the schedule, the excerpt rules and the patch-closed verdict) and
  the registry API are documented in the same guide. Guide:
  [guides/stack-registry.md](guides/stack-registry.md).

### alibaba-image connector (1.6 deployment)

- Free image generation and editing for agents through the company's DashScope
  key: the `alibaba-image` connector container from the private deployment
  repository (tools `generate_image` and `edit_image`, registry-checked
  qwen-image/wan/z-image models, async submit-then-poll, results into the
  calling agent's workspace with a JSON sidecar, audit of argument
  sizes only). Operator guide — bringing the container up in the deploy window
  (port 8083, read-only key mount, shared workspace root), registering it as
  an external MCP server and granting it to the work designer, the bbq SMM and
  the designer agents, plus the per-family live smoke:
  [guides/alibaba-image-connector.md](guides/alibaba-image-connector.md).

### Stack update cycle documentation (STACK-UPDATES part D)

- The stack-updates overview document (EN + RU) for the whole release-watch
  cycle: where «ours» comes from per probe (health-commit, docker-image,
  container-labels, env, manual, none) and where «latest» comes from (the
  anonymous GitHub releases/tags read), how the lag is counted and why an
  unmatched local version reads `unknown`, the notable-lines excerpt rules,
  the patch-closed verdict (closed/open/unknown per carried delta through the
  compare API, with the aggregate), the daily sweep behind
  `MYRMIDON_STACK_CHECK_INTERVAL_SEC` and the manual check, the
  `stack_update` attention card with its dedup key, the unassigned backlog
  draft the planner creates, both settings and the network-down behavior
  (transport failure → 503 with the previous cache intact; a per-source HTTP
  error → a per-component unknown). The screen-by-column screen guide is
  referenced, not duplicated. Document: [stack-updates.md](stack-updates.md).

### Company regulations in the wiki (WIKI-CORTEX)

- Regulation pages with a draft → approved lifecycle, revisions and rollback:
  an edit of a draft or of an approved regulation appends a new DRAFT revision
  and the resolver keeps serving the newest APPROVED one, so writing text
  never changes what the fleet reads without an explicit board approval; a
  rollback is one more revision that copies an earlier one (append-only
  history, the restore is itself restorable). Draft writes are open to any
  actor with access to the company — the wiki maintainer agent writes drafts —
  while approve and rollback are board-only. The approved regulations that
  apply to a role reach the agents through the compiled bot profile: one
  deterministic workspace `REGULATIONS.md` beside the agent's own instruction
  files, where the profile hash decides whether a bot restarts (same approved
  revisions — same bytes — no restart; the file never shadows a
  `REGULATIONS.md` the agent's own bundle ships). Roles are plain role keys
  with `*` meaning every role. Operator guide — the API, the delivery
  mechanics and the wiki-maintainer runbook:
  [guides/wiki-regulations.md](guides/wiki-regulations.md).

### Autonomy matrix

- Role-by-action-class verdicts that say what an agent of a role may do on its
  own and what needs the board: the matrix is stored as company regulations
  with revisions and is served through a REST API. The «Autonomy matrix»
  settings screen shows and edits the matrix; every change is a new revision,
  so the previous verdicts stay readable and restorable.

### Swarm claims (SWARM-CLAIM)

- Part A, per-role task queues with leased claims: an agent takes the top task
  of its own role's queue behind a lease (TTL plus heartbeat) recorded in the
  new `issue_claims` table. The run's checkout writes the claim and a finishing
  run releases it; a sweep returns expired leases, and leases of tasks that
  left the queue, to the queue and wakes the next agent of the role. A
  per-agent active-task limit keeps one agent from taking the whole queue, and
  a P0 (critical) task preempts the normal queue order. The claim path is off
  until `MYRMIDON_SWARM_CLAIM_ENABLED` is turned on; the lease TTL, the active
  task ceiling and the sweep interval are `MYRMIDON_SWARM_LEASE_TTL_SEC`,
  `MYRMIDON_SWARM_MAX_ACTIVE_TASKS` and
  `MYRMIDON_SWARM_CLAIM_SWEEP_INTERVAL_SEC`.
- Part B, the supervisor view and the pilot report over claims and leases: the
  queue and lease state per role, and a window comparison against the frozen
  baseline snapshot. The release fallback now also writes the release reason.
  The supervisor settings (`MYRMIDON_SWARM_SUPERVISOR_TASK_MAX`,
  `MYRMIDON_SWARM_PILOT_BASELINE_DOC`) are documented in
  [SETTINGS.md](SETTINGS.md).

### Skill lifecycle (SKILL-LIFECYCLE)

- The company skill lifecycle `candidate → verified → deprecated`, with
  approval-gated promotion and rollback. A `candidate` skill reaches only the
  agents listed in `MYRMIDON_SKILL_PILOT_AGENTS`; a `verified` skill reaches
  everyone. With the variable unset the pilot set is empty, so a candidate
  reaches nobody.

### Foraging (FORAGING)

- A source registry per company, snapshot comparison of the sources, skill
  candidates drafted from what changed, a per-pass cost budget and a screen.
  Foraging ships DISABLED: no timer is armed and no source is read unless
  `MYRMIDON_FORAGING_ENABLED=1` is set; any other value keeps it off, so a
  typo cannot turn it on.

### Baseline metrics (BASELINE part A)

- Six board metrics computed from the task history over any window, by
  project and by executor role: cycle time (todo → done, mean, median, p90),
  time in review, return rate (in review → in progress), time blocked with the
  top reasons, runs per task and LLM cost per task. They are served by
  `GET /api/myrmidon/companies/:companyId/baseline/metrics?from&to`. A periodic
  job, off unless `MYRMIDON_BASELINE_INTERVAL_SEC` is set, recomputes the last
  14 days per company and freezes one snapshot per pass in the additive
  `baseline_metric_snapshots` table, so a pilot can be compared with the
  measured «before». A failure of one company does not stop the others.

### Parallel helpers (PARALLEL-HELPERS)

- Agents can run parallel helper subagents. The agent card gets a «Parallel
  helpers» block: on/off, the maximum number of concurrent helpers within a
  company ceiling, and the helper model from the allow-list; a company default
  and a capacity hint sit beside it. The profile compiler writes the matching
  delegation section for bot containers. When neither the card nor the stored
  settings name a model, helpers run on `MYRMIDON_BOT_HELPER_MODEL`, or on the
  parent agent's model if that is unset.

### Quality and stack

- The Quality page: window metrics by project and by role, built on the
  baseline metrics above.
- The Stack screen's release lag, patch status and update planner (described
  in «Stack update screen» above) are documented in the stack guide, together
  with the LLM tracing card and the operator signal guide.

### Myrmidon 2.0 UI (behind `enableMyrmidonUi2`, off by default)

- The 2.0 shell and six re-skinned data screens, shown only when the
  `enableMyrmidonUi2` experimental flag is on; the denied lock fails closed
  and there is no client-side undo timer. A per-user board UI language (RU/EN)
  with catalogs and guards, an operator guide for the shell, and a fix of the
  i18n guard so that it accepts the flat re-skin catalog.

### Bot containers

- The run-bound GitHub broker capability is delivered to container runs of the
  gateway adapter; the token reaches only the agents listed in
  `MYRMIDON_BOT_CONTAINER_GITHUB_ENV_ALLOWLIST`. Bot-side media scripts ship
  under `tools/media-mcp/bot-scripts`, with a hygiene pass over them.
- The `dwg_convert` media tool for container bots: DWG/DXF input converted to
  DXF, SVG or PDF through the media service, restoring the dwg2dxf/dwg2SVG
  capability the bots had on the host (the bot image stays free of CAD
  utilities; a separate bot image is forbidden by CONVENTIONS §8). The worker
  image builds LibreDWG from the pinned GNU release and adds an ezdxf venv for
  DXF round-trips (version bump R12…R2018 on DXF input) and SVG rendering;
  PDF output needs LibreOffice in the worker image and the base image refuses
  it honestly (render SVG instead). The tool is synchronous (300 s timeout)
  with the same per-bot gating, quotas and output accounting as the other
  media jobs; the config sample lists it in `tools`. Docs:
  [media-tools.md](media-tools.md) (#381).

### Deploy and release

- `rollback.sh --local` rolls back to a local image without pulling.
- The GitHub Release is now published by CI from the `myr-v*` tag, using this
  file's section for the tag's version.

### Fixes

- The Telegram DM status is one edited message with live progress steps
  instead of repeated «working…» messages.
- Maintenance: leaving windows always retire, the tick isolates windows from
  each other, and the owner chat never waits on it.
- Closing a channel-bound task by its assigned agent notifies the bound chat.
- No run is dispatched for a task whose delivering PRs all merged (the wake
  guard); its settings are `MYRMIDON_TASK_PR_SYNC_WAKE_GUARD_*`, and the
  settle sweep and the guard have an operator guide.
- The gateway adapter joins the idempotency-keyed adapters for infra-interrupt
  relief.
- Secrets are masked in comment edits, issue descriptions and documents.
- CI: five flaky tests were made deterministic, two real races behind them
  were fixed, and three tests that blocked unrelated PRs were deflaked.

### Upgrade notes

- Additive migrations 0289–0295 (among them 0294, the baseline metric
  snapshots, and 0295, the issue claims); no vendor table is modified.
- Every new setting is off or closed by default; see [SETTINGS.md](SETTINGS.md)
  before enabling any of them.

## 1.5.0

### Tracing health (TRACING-HEALTH)

- The "LLM tracing" status card in Company settings and the operator attention
  signal: the board reads the health report of the LiteLLM → Langfuse v4
  tracing pipeline (`GET /api/myrmidon/tracing/health`, part C) and surfaces
  it two ways. The card (below the Server console section) shows the dot and
  state (`ok` / `ok (idle)` / `red` / `unknown` / `not enabled`), the reason
  line, one null-aware line per evidence probe and the window span, refreshing
  once a minute. A periodic sweep (`MYRMIDON_TRACING_SIGNAL_INTERVAL_SEC`,
  default 300 s, off with the check itself) evaluates the same report for
  every company and raises ONE attention card on the operator desk —
  `degraded` is high, `unknown` is medium, `ok`/`idle` raise nothing; the
  signal goes to the operator role, never the task owner. Dedup is by state:
  recovery clears the card without dismissal bookkeeping, and the journal gets
  one activity row per state transition only. Guide:
  [guides/tracing-health.md](guides/tracing-health.md).

### Client connectors (the browser bridge)

- The client connector gateway (EXTCASE-B): the board accepts an outbound
  WebSocket connection (`/bridge/v1`, JSON-RPC 2.0) from a browser extension on
  a client PC — the transport for platforms that exist only in the client's
  browser behind a local signing key. Pairing is a one-shot 15-minute code
  exchanged for a device-bound bridge token (only HMAC digests are stored,
  peppered by `MYRMIDON_BROWSER_BRIDGE_PEPPER`); revocation is fail-closed and
  drops the live socket. Every action is gated by the declared capability set
  and the company domain allowlist (checked at the gateway and again in the
  extension) and journaled — one row per action in the company activity log,
  page content never journaled. Signing follows the operator policy
  (`general.browserBridge.signing`: `enabled` / `auto` / `manual` / `types`)
  with a one-call emergency off; the signed bytes and the PIN never leave the
  client PC — the journal holds the document hash. Guide:
  [guides/browser-bridge-gateway.md](guides/browser-bridge-gateway.md).
- The connector panel (EXTCASE-PANEL), Company settings → Connectors: the
  device list with online status and capabilities, one-shot pairing codes shown
  once, revocation with confirmation, the domain allowlist, the signing policy
  with a daily signature limit per UTC day (the gateway refuses before the
  device is asked, `dailyLimitReached`) and the emergency stop, plus the bridge
  journal with filters (device, method, outcome, signatures only) and the
  document hash per signature. Guide:
  [guides/connector-panel.md](guides/connector-panel.md).
- The browser action primitives in the shipped extension (EXTCASE-D):
  `browser.fill` types a value into one field (input, textarea, select or a
  contenteditable node) and dispatches `input`/`change` so the page sees the
  change; `browser.download` fetches the file in the page's own session —
  the content script runs in the page's origin, so the request carries the
  browser's cookies — and returns its name, type, size and base64 bytes under
  a 25 MiB ceiling (`BROWSER_DOWNLOAD_MAX_BYTES`; a larger file is refused
  with `downloadTooLarge` before it crosses the bridge). An action the board
  marks `confirmation: "human"` runs only after a person on the client PC
  presses Confirm in the extension's confirm page: a refusal, the 180-second
  budget expiring — the gateway then sends the `browser.cancel` notification
  and the extension drops the pending step — or a build without the
  confirmation port is an `internalError` refusal (the step never reaches the
  confirmation flow), never a silent execution. The extension declares the `fill` and `download` capabilities and
  never `sign`. Site-specific selectors and recorded scenarios are built on
  top of these primitives and live outside the fork. Guide:
  [guides/bridge-extension.md](guides/bridge-extension.md).
- The signing host contract: a generic, client-free native-messaging contract
  for local signing helpers (`extension/src/native-host-contract.ts`) — a
  closed `actionType` enum (`sign` / `sign_and_submit` / `sign_attachment`), a
  document payload of bytes or a SHA-256 digest, a closed error-code set, and
  validators both sides compile against. A concrete helper (token middleware
  binding, PIN storage) is deployment-specific and lives outside the public
  fork. Guide:
  [guides/signing-host-contract.md](guides/signing-host-contract.md).

### OCR path

- `ocr.pdf` for every bot (EXT-CASE-OCR): a PDF received as a mail attachment
  or downloaded through the bridge is recognized into text in the bot
  workspace, with a structural excerpt for tender documentation (requirements,
  deadlines, positions). Backends: RAGFlow (MCP) or an OpenAI-compatible
  gateway (LiteLLM), selected by `MYRMIDON_OCR_BACKEND`; refusals carry stable
  codes and happen before the backend is contacted (size and page ceilings).
  The journal holds metadata only — never the text or the bytes. Guide:
  [guides/ocr.md](guides/ocr.md).

### External MCP connectors

- Any standards-compliant HTTP MCP server now plugs in without fork code
  through the vendor's generic connection surface (Apps → Connect an app →
  Connect your own MCP server, or Apps → Advanced → Paste a config):
  credentials become company secrets, per-agent grants default to deny, and
  tools arrive namespaced `mcp.<connection>:<tool>`. The operator runbook —
  entry points, grants, health checks, rotation:
  [guides/external-mcp-connectors.md](guides/external-mcp-connectors.md).

### UI 2.0 shell (flagged, UI-0a)

- The Myrmidon 2.0 shell behind the instance flag `enableMyrmidonUi2`
  (default off, Instance settings → Experimental → "Myrmidon UI 2.0 Shell"):
  a clean-room tree `ui/src/ui2/` — the 232px left rail, the top bar with the
  nest switcher, status chips and the "Tell the Commander" entry, and the
  390px phone frame (56px header + five-tab bottom bar). The 2.0 design-system
  tokens (`--myr-*`, light and dark) and the self-hosted Saira / Exo 2 / Inter /
  JetBrains Mono subsets land with it. Pages and routes stay shared with the
  1.x shell; turning the flag off restores it. The rail badge and status chips
  read the existing dashboard and sidebar-badges aggregates until the
  STATUS-STRIP endpoint exists. i18n keys `ui2.*` ship in en/ru (translated)
  and the other locales (English values until the translation pass). Operator
  guide: [guides/ui2-shell.md](guides/ui2-shell.md).
- The six re-skinned screens behind the same flag (Decisions, Costs, Agent
  overview, Runs and queue, System, Language) now render real data through
  the existing APIs — no new server endpoints. Each screen ships the full
  state set (skeleton, error with/without cache, empty, denied): a `403`
  answer renders the lock alone, never partial data. Decisions decide with
  option, inputs and an idempotency key; there is no client-side undo timer
  (the server-side hold is a later wave). Screen-by-screen details:
  [guides/ui2-shell.md](guides/ui2-shell.md).

### Task PR sync

- A task delivered by a pull request settles itself once its PRs merge
  (#315): a periodic sweep (`server/src/myrmidon/task-pr-sync/`, ships
  enabled) reads the task's own `pull_request` work products, refreshes each
  PR's state through the existing GitHub resolver, and closes the task with
  one neutral comment (PR refs, merge sha, time) when every PR is terminal
  with at least one merged and no post-deploy gate (a pending card, a pending
  approval or a future-scheduled monitor) is still open. Closed-without-merge
  PRs send the task back to its assignee; superseded PR rows are ignored. And
  the wake guard half (#339, post-1.5.0): an event-free wake to such a
  settle-pending task is skipped (reason `wake_skipped_pr_settle_pending`)
  instead of dispatching a run that would only race the settle. Operator
  guide: [guides/task-pr-sync.md](guides/task-pr-sync.md).

### Container GitHub access (CONTAINER-GITHUB-WRITE)

- An agent in a bot container can push to GitHub through the board's managed
  credentials (#363): when a run's GitHub identity is board-managed (the
  default, see `MYRMIDON_HOST_GITHUB_CREDENTIALS` in
  [SETTINGS.md](SETTINGS.md)), the heartbeat mints a run-bound
  `github_credentials` capability, and the `hermes_gateway` adapter now
  carries it to the container — the pair rides the `/v1/runs` request body
  (`github_broker`), is bound to that run alone (contextvars, never the
  process env shared by the gateway's concurrent runs) and reaches every
  terminal and `execute_code` subprocess of the run as
  `PAPERCLIP_GITHUB_BROKER_URL`/`PAPERCLIP_GITHUB_BROKER_TOKEN`. Inside the
  container, the dev image's `git` credential helper (URL-scoped to
  `github.com` over https, `ssh://git@github.com/…` remotes rewritten to
  https) and its `gh` wrapper resolve the credential on each invocation
  through the board's `POST /runtime-tools/github/credentials` broker and
  exec the real `git`/`gh`; the wrappers walk up to 6 broker address
  candidates (`PAPERCLIP_GITHUB_BROKER_URL` → `PAPERCLIP_API_URL` →
  `PAPERCLIP_RUNTIME_API_URL` → `PAPERCLIP_RUNTIME_API_CANDIDATES_JSON`
  items) and never print the token. A run without a capability — or a card
  whose GitHub identity is not board-managed — gets both names stripped and
  the wrappers fail open, exactly as before this change. A static
  `GH_TOKEN`/`GITHUB_TOKEN` inherited from the image profile no longer
  shadows the credential: while a capability is bound, those names are
  blanked in the run's subprocesses. This closes the gap that motivated
  `MYRMIDON_BOT_CONTAINER_GITHUB_ENV_ALLOWLIST` (see SETTINGS.md): the
  allowlist remains a fallback for dev bots on machines where the board's
  broker address is genuinely unreachable.

## 1.4.0

Everything merged between the 1.3.2 and 1.4.0 tags. Deploy this release's board,
dockergate and fleetd images together (see [deploy.md](deploy.md#deploy-the-board-and-the-release-components-together)).

### Memory and isolation

- "Memory" tab on the agent card (MEMORY-UI, plan 1.4 item 1): view, export (JSON)
  and removal of the entries of the agent's memory bank — resolved by the same bank
  rule the memory plugin fork applies. Removing one entry is reversible (invalidation
  with a reason); clearing the whole bank sits behind a typed confirmation; every
  action writes an activity log row. The section is enabled by the
  `MYRMIDON_HINDSIGHT_API_URL` + `MYRMIDON_HINDSIGHT_KEY_SECRET` pair.
  Guide: [guides/agent-memory-card.md](guides/agent-memory-card.md) (#258, #265).

### Cloud storage

- CLOUD-CONNECTOR part B: the owner connects a cloud from the panel — the connector
  builds the provider's authorization URL with a single-use state and PKCE, exchanges
  the code, and keeps the resulting token bundle in a company secret of the instance
  secret store. Only the secret id stays in the connector's own state, so no bot ever
  holds a cloud token and the token value never travels through the panel API (#252).

### Owner questions and instructions

- U2: question and confirmation cards (`ask_user_questions`, `request_confirmation`)
  reach the owner's Telegram DM when the company runs the Telegram DM bridge
  (`MYRMIDON_TELEGRAM_DM_CONVERSATIONS`) — the card is also answered from Telegram,
  including a callback that arrives for a task the authoring agent no longer owns.
  A task with its own live chat binding keeps its card in that conversation only.
  Guide: [guides/owner-telegram-cards.md](guides/owner-telegram-cards.md) (#277, #284, #287).
- H2: every change to an agent's instructions bundle (file put, file delete, patch)
  is snapshotted into the append-only `agent_instructions_revisions` history, and any
  earlier revision can be restored through the API — the restore itself becomes a new
  revision. Guide: [guides/agent-instructions-revisions.md](guides/agent-instructions-revisions.md) (#273, #299).

### Deploy and reliability

- Automatic rollback by health for the board and the bot fleet (R5-C). A failed
  health check after a deploy no longer leaves the board or the touched bots on the
  broken image. Board: the job moves to `rolling_back` and the host executor runs
  `rollback.sh` to the image the deploy remembered before the switch; the job ends
  `auto_rolled_back` (maintenance window closed) or `failed_rollback` (window kept
  for the operator). Bots: a failed canary or wave bot moves the rollout to
  `rolling_back`; every bot that received the new image gets its own card image
  re-applied, one at a time, and the rollout ends `rolled_back` with the original
  failure reason kept. Switches (both on by default): `MYRMIDON_DEPLOY_AUTO_ROLLBACK`
  for the board, `MYRMIDON_BOT_CANARY_AUTO_ROLLBACK` for the fleet; the host side
  of the board switch is `AUTO_ROLLBACK` in `deploy.env`, both sides must agree.
  Unattended auto-update stays off (`MYRMIDON_DEPLOY_AUTO_UPDATE=0`); see
  [SETTINGS.md](SETTINGS.md) (#261).
- Heartbeat: a queued-run start that re-enters the agent start lock no longer waits
  for itself. The lock body now runs in an async-context frame per agent, so a
  nested start from the same chain skips the wait and no longer stalls for
  `AGENT_START_LOCK_STALE_MS` (30 s) on every cancellation that promotes a queued
  run (#174).
- RELEASE-GATE: the board and the release's component images deploy together,
  enforced by the deploy script itself. `deploy.sh` resolves the dockergate and
  fleetd digests of the SAME release (the `myr-vX.Y.Z` tag from the board image
  version label, else the `sha-<short>` tag of its commit) and refuses a release
  whose components are missing from the registry before anything changes — the
  01.10 incident deployed the board alone while production dockergate still
  rejected the new `maxConcurrentRuns` marker key and every bot apply was denied
  for ~40 minutes. Each component now rolls out in the same run with its own
  health probe (`MYR_<COMPONENT>_HEALTH_URL`), and a post-deploy smoke
  (`bot-apply-smoke.sh`) waits for at least one bot container to re-apply, else
  the deploy reports DEGRADED with the rollback commands
  (`rollback-component.sh` per component). CI gained the applied-marker contract:
  the markers `serializeAppliedMarker()` writes are emitted from the server code
  of every commit and fed through the dockergate validator, so a marker the
  validator would deny turns CI red before any image exists (#276).
- AUTO-RESUME: the board itself resumes an agent left in `error` by a failed
  run — a sweep on the scheduler tick with a backoff of 1, 5 and 15 minutes,
  reusing the pause/resume wake chain so the resumed agent also wakes the work
  it was stranded on. After `MYRMIDON_AUTO_RESUME_MAX_ATTEMPTS` (default 3)
  failed resumes the board stops and escalates the agent's `agent_error_alert`
  card on the attention desk to severity `critical`; the operator's resume
  re-arms the counter. State lives in `agents.metadata.myrmidon_auto_resume`
  (no migration), every action writes an activity log row
  (`agent.auto_resume_issued` / `agent.auto_resume_exhausted`). Settings:
  `MYRMIDON_AUTO_RESUME_*` in [SETTINGS.md](SETTINGS.md); guide:
  [guides/auto-resume.md](guides/auto-resume.md) (#272).

### Telegram

- Telegram DM run status and inline split (U1). In a bridged Telegram DM
  (`MYRMIDON_TELEGRAM_DM_CONVERSATIONS`) a run can now show its "working on
  it" status as one editable message instead of milestone silence: the status
  is posted once when the run is queued, the same provider message is edited
  in place as the phase changes, and the run's final answer replaces it —
  the failure, admin-attention and completion milestones still publish, and
  the `/stop` terminal milestone stays suppressed. Separately, a long
  structured Markdown answer that the vendor sends as one `.md` attachment
  can split inline into ordered parts at paragraph/line/word boundaries.
  Both behaviors are opt-in and off by default:
  `MYRMIDON_TELEGRAM_DM_STATUS` and `MYRMIDON_TELEGRAM_SPLIT_MAX_PARTS` (a
  document needing more parts than the cap stays an attachment); see
  [SETTINGS.md](SETTINGS.md) and the guide
  [guides/telegram-dm-status.md](guides/telegram-dm-status.md) (#267, #313).

## 1.3.2

Everything merged between the 1.3.1 and 1.3.2 tags. Deploy this release's dockergate image
together with the board.

### Bot containers

- The reconciler no longer recreates bot containers whose template never changed. dockergate
  trimmed `HostConfig.Binds` out of the container inspect (A2) while the driver's template-drift
  check compared it, so every bot counted as drifted on every pass: production recreated all 51
  bots every 17–20 minutes, interrupting every run in flight. The A2 answer carries the bind list
  again, and a gate contract test checks that every field the drift check compares survives the
  trim (the field list is emitted from the driver's code, not hand-copied) (#253).
- Every drift writes an activity line naming the field and both values
  (`bot container template drift detected`, `details.fields`), so it is diagnosable from the log
  alone instead of costing another incident (#253).
- The state-DB descriptor probe on the gateway write path is bounded: the WAL/SHM generation
  check now has a budget, so a slow or stuck filesystem no longer stalls every bot write (#240).
- Bot image development variant: a third build target with a repository-cycle toolchain is
  available for development work (#238).

### Interface

- Live browser screen console core: the owner watches and drives the live browser that bots
  authorize in. Registry, screen sessions with safe timers, a two-contour bot pause, the
  session journal and site-data cleanup. See [guides/browsers.md](guides/browsers.md) (#210).
- Access hub server core: the server module for the Access section (secrets, grants, rotation,
  SSH keys) is merged. See [guides/access-hub.md](guides/access-hub.md) (#235).
- Stack registry guide: the seeded component list, `GET /api/myrmidon/stack` and
  `POST /api/myrmidon/stack/refresh`, the cache and the Docker socket setting. See
  [guides/stack-registry.md](guides/stack-registry.md) (#243).
- Access-hub guide aligned with the merged server module (#249).

### Cloud storage

- Owner-authorized cloud storage with per-agent folder grants: the owner connects one account
  per provider, keeps a list of reachable folders and grants them to an agent, a caste or
  everyone with a read-only or read-write mode. OneDrive provider and API under
  `/api/myrmidon/cloud-connector`. See [guides/cloud-connector.md](guides/cloud-connector.md)
  (#245).

## 1.3.1

Everything merged between the 1.3.0 and 1.3.1 tags. The release replaces 1.3.0 and ships
the two fixes 1.3.0 lacks.

### Bot containers

- dockergate accepts the applied-profile marker with the optional `maxConcurrentRuns` key
  (integer 1–50) that the board writes since CONCURRENCY-SYNC. The 1.3.0 dockergate
  demanded exactly three keys and refused every bot-container profile apply with
  `tar_content` (`applied_json`), which stops the whole fleet on a fresh install. Deploy
  this release's dockergate image together with the board; a hand-swapped dockergate image
  is no longer needed. See [dockergate.md](dockergate.md#the-applied-profile-marker) (#228).
- Canary rollout for the bot image: a new bot image is applied to a single canary bot
  first, its health (Docker HEALTHCHECK plus a settle window) and a smoke run against the
  canary gateway are verified, and only then do waves of `MYRMIDON_BOT_CANARY_WAVE_SIZE`
  (default 4) bots follow, one bot at a time. A failed canary stops the rollout without
  touching the rest of the fleet; a rollout can be aborted. Routes:
  `GET/POST /api/myrmidon/bot-canary[/preview|/:id/abort]` (reads: board; writes: instance
  admin). Everything is off by default (`MYRMIDON_BOT_CANARY`). Design:
  [design/bot-canary.md](design/bot-canary.md) (in Russian) (#222).
- Bot settings resolve per fleet host: a `MYRMIDON_FLEET_HOSTS` record can override the
  hindsight URL, the LLM gateway base URL, the board's extra host name, the volume root,
  the bot network and the image allowlist for the bots placed on that host; a field absent
  from the record takes the instance value. See [SETTINGS.md](SETTINGS.md) (#225).
- New guide: [guides/bot-container-card.md](guides/bot-container-card.md) — the agent
  card's Container section, the concurrent runs limit and the applied-profile marker
  (#219).
- The card read is reconciled at pass time, not at the sweep's snapshot (#237).

### Database

- The chat and recovery hot sweeps compare uuid columns as uuid-typed, guarded values
  instead of text. A text-cast column cannot use its primary-key index, so every sweep
  scanned the whole table; on production that drove the board database to 300–400 % CPU.
  No new indexes are needed — the comparisons are served by the primary-key indexes (#227).
- Migration `0286` drops the ad-hoc operator expression indexes
  `myr_hotfix_issue_comments_id_text`, `myr_hotfix_wakeup_id_text` and
  `myr_hotfix_heartbeat_runs_id_text`, created outside the migration history to stop the
  bleeding. They are no longer needed once the predicates are typed (#227).

### Interface

- "About Myrmidon" section in Instance → General (release version, commit, build date,
  image digest when set, the Paperclip base version, license and links) and a release
  version line in the sidebar footer. The data comes from the new route
  `GET /api/myrmidon/about` (board/agent; anonymous gets 403) (#216).
- Fleet server console: a company owner opens a terminal to a registered fleet server in
  the browser (Guacamole with a signed auth JSON). New routes
  `GET/PUT /api/myrmidon/fleet/servers`, `POST /api/myrmidon/fleet/console-token`,
  `POST /api/myrmidon/fleet/console-sessions/close`; the servers live in the new table
  `myrmidon_fleet_servers` (migration `0287`). The section is on the company settings
  page. Design: [design/server-console.md](design/server-console.md) (in Russian) (#232).
- Per-agent LLM gateway keys (`POST /api/myrmidon/companies/<companyId>/litellm/keys/<agentId>`,
  `…/rotate`; `GET` returns only the secret name and the value's sha256; issue/rotate is
  board-only) and a cycle check of the fallback model chains when an agent card is saved
  (#233).

### Reliability

- An undelivered agent-to-agent card no longer dies from the task status flip: the card is
  delivered once before the terminal transition finalizes it (#234).
- Stack registry core: `GET /api/myrmidon/stack` serves the seeded component list with its
  local state (version/commit/digest or an honest "unknown"), and
  `POST /api/myrmidon/stack/refresh` (instance admin only) rebuilds the cache from what
  the board process can see; a failed infrastructure probe keeps the previous cache and
  answers 503. See [guides/stack-registry.md](guides/stack-registry.md) (#212).
- Guides: the access-hub guide gained the availability notice (#214).

## 1.3.0

The 1.3 feature release: bot containers on fleet hosts, the deploy of the board from the
interface, maintenance windows, the operator guides set and the groundwork listed in
[ROADMAP.md](ROADMAP.md). The full entry list is in the git history between the 1.2.1 and
1.3.0 tags. Two defects shipped in this release are fixed by 1.3.1: the dockergate marker
refusal (#228) and the database hot-path scans (#227).

## 1.2.1

Everything merged between the 1.2.0 and 1.2.1 tags.

### Memory and isolation

- Local fork of the hindsight memory plugin (`packages/plugins/hindsight-paperclip`, same plugin
  id `paperclip-plugin-hindsight`, version `0.3.0-myrmidon.1`): each agent's memory resolves to
  its own bank from the card's `adapterConfig.hindsight.bankId` or the configuration's
  `bankByAgentId` map. An agent without a bank is closed: retain is skipped with a warning and
  recall returns nothing — there is no fallback bank. Retain metadata now carries the agent
  name. Install and upgrade from the repository path; CI gained the fork's test lane and
  host-side install checks (#150).

### Bot containers

- Bot Node.js image: `/scratch/npm-global/bin` is off `PATH` — a writable volume on `PATH` let
  a bot plant a binary, and the dockergate image contract rejects it. The preinstalled packages
  in `/opt/node-tools` are unaffected; the Dockerfile test now checks every stage's `PATH`
  against the dockergate policy (#167).

### Interface

- Myrmidon favicon everywhere: worktree-preview instances draw the Myrmidon ant instead of the
  vendor paperclip, and tab icons and the web manifest are served with no-cache so browsers
  revalidate them (#166).

### Internal

- The agent-assigned MCP tool set moved from `heartbeat.ts` into its own module
  (`agent-assigned-tools.ts`) with no behaviour change, so heartbeat and the bot-container
  profile compiler resolve the same assignment from one place (#120).

## 1.2.0

Everything merged after the 1.1.0 tag, including fixes that were never tagged on their own.

### Bot containers

- Per-bot board tool gateway: container bots reach the board through their own scoped gateway.
- Shared media tools MCP service for container bots, with fixes for filter-escape injection,
  job-directory quota counting, streamed conversions and spool ownership.
- `dockergate`: an allowlisting Docker proxy for bot containers.
- Bot image: Node.js variant (`runtime-node`), an ssh client, and a venv interpreter present
  for the bot user.
- Bot board API keys are issued with a responsible user.
- Configurable run-create timeout for the hermes gateway (default 60 s).
- Container startup feedback in the server tests no longer needs a real container.

### Memory and isolation

- Hindsight bank allowlist and observation scopes in bot profiles, plus a tool to split
  banks when transferring memory.
- Plugin `apiRoute` calls are bound to an invocation scope.

### Wakes and heartbeat

- Emergency stop for the runs a draining pause left finishing: the agent detail page shows a
  banner with a confirm-and-stop button while the agent is paused and live runs remain, and
  `POST /api/myrmidon/agents/:id/emergency-stop` cancels them immediately with the same
  `agent_paused` code a pause-cancel uses — the agent's own status is untouched (#173). Operator
  guide: [guides/emergency-stop.md](guides/emergency-stop.md).
- Continuation wakes: age-threshold sweep and direct-delivery settlement fixed.
- Tasks stranded by an operator pause are woken in batches when the pause is lifted.
- Configurable cap on cross-issue influence.
- Heartbeat logs an unreadable cgroup memory limit; the cap is documented.
- Kill-switch flag semantics are covered by a test matrix and a docs guard; documented that the
  L2 budget carry is L1-only and that the vendor retry budget restarts at the successor.

### Deploy

- Deploy lifts maintenance mode when the drain times out.
- Documented that database migrations must be additive-only.

### Process

- Plan intake procedure and text scanner for plan entries.
- Publish scan wrapper for PR and issue text.