# Myrmidon changelog

> Russian version: [CHANGELOG.ru.md](CHANGELOG.ru.md)

Release notes for Myrmidon, newest first. The version comes from the git tag
`myr-v<major>.<minor>.<patch>` (CI stamps it into the image and `/api/health`); there is no
version file to edit. Base Paperclip version is in the image label
`io.github.itkadr-git.myrmidon.base.paperclip-version`. Details of the release procedure:
[ci.md](ci.md) and [deploy.md](deploy.md).

## Unreleased
### Server and CLI texts renamed to Myrmidon (REBRAND B, OPE-4155)

- User-visible text in the server and the CLI names the product Myrmidon:
  CLI `--help` and banner, onboarding/doctor/service/update messages, CLI
  HTTP client errors, OpenAPI summaries and descriptions, API error
  messages, onboarding documents for external agents, outgoing request
  user agents, the Node version warning, and the org-chart SVG wordmark.
  Details: [guides/rebrand-b-server-texts.md](guides/rebrand-b-server-texts.md).
- New guard tests keep the surfaces free of the vendor name:
  `cli/src/__tests__/cli-product.myrmidon.test.ts` and
  `server/src/__tests__/server-user-text.myrmidon.test.ts`.
- Identifiers are untouched for compatibility: the `paperclipai` package and
  bin, `PAPERCLIP_*` env vars, `X-Paperclip-*` headers, `@paperclipai/*`
  packages, `~/.paperclip` paths, MCP server names, the `/paperclip` Discord
  command, and frozen pre-rename snapshots.


## 1.6.6

### Central session history for gateway bots (MEMORY-CENTRAL-B)

- A bot's conversation history can now live in the board's central hindsight
  store instead of the container volume: with `MYRMIDON_BOT_CENTRAL_HISTORY=1`
  (off by default) the Hermes gateway adapter saves the final output of every
  completed run as a session-turn record in the bot's own hindsight bank
  (documents keyed by the session key, tag `myrmidon-session-history`), and on
  the next wake of the same session restores the last turns (default 20, card
  field `centralHistoryMaxTurns`) into the wake input under a visible
  "restored conversation history" header. Recreating the container volume no
  longer loses the history: a rebuilt container reads its turns back from the
  central store.
- Resolution order for the store address, bank and key (first hit wins): the
  agent card fields `adapterConfig.centralHistoryUrl` / `centralHistoryBankId`
  / `centralHistoryApiKey` / `centralHistoryMaxTurns`, then
  `MYRMIDON_BOT_HINDSIGHT_API_URL` / `MYRMIDON_BOT_HINDSIGHT_BANK` /
  `MYRMIDON_HINDSIGHT_API_URL` / `HINDSIGHT_API_KEY` (the bot-env pair the
  profile compiler already injects), then the same names in the server process
  environment. The bank defaults to the card's `hindsight.bankId`.
- Off or unconfigured, every path is untouched vendor behavior: no requests,
  no logs beyond the normal ones. While on, a store failure never blocks a
  run — a failed read continues the wake without the restored block, a failed
  save is logged and the run result stays as it was. Only the redacted final
  output of the run is stored (the same redaction the run result already
  gets), and the restored block is bounded by turn count and size.
- New files: `packages/adapters/hermes/src/gateway/server/central-history.ts`
  and its suite; `execute.ts` only gains three marked call sites.

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

### The company agent list ships without adapter_config; the config stays one request away (PERF-DIET G2)

- `GET /api/companies/:companyId/agents` no longer returns `adapterConfig`. The
  heavy, secret-bearing column (environment bindings, secret and API-access
  references) is not read from the database at all for this response: the list
  now selects the narrow projection and extracts the model in SQL
  (`adapter_config->>'model'`) into a new `adapterModel` field.
- The full configuration stays available exactly as before through
  `GET /agents/:id` (detail), `GET /agents/:id/configuration` and
  `GET /companies/:companyId/agent-configurations`; access rules
  (`filterAgentsForActor`, the restricted view) and spend hydration are
  unchanged. An actor without `agent_config:read` keeps the old disclosure:
  the restricted list view blanks `runtimeConfig` and `adapterModel` instead of
  blanking `adapterConfig`.
- The board UI follows: the agents list renders its model column from
  `adapterModel`; the new-issue dialog and the issue properties pane read the
  selected assignee's configuration on demand (only for a `paperclip_runner`
  provider or the required-user-secret warning); the secret-access section of
  Settings → Secrets reads the configuration endpoint for the whole company.
- The `paperclipai secrets migrate-inline-env` CLI command follows too: it reads
  `GET /companies/:companyId/agent-configurations`, because the slim list no
  longer carries the inline env bindings that command migrates.
- The bot-image rollout (`scripts/myrmidon/deploy/bot-image-rollout.sh`) follows
  on the same footing: bot cards — the `container` block included — are read from
  `GET /companies/:companyId/agent-configurations`, so the enrollment limits in
  `bots[]` and the card's current image still come from the board after the list
  went slim. Its fake-board test serves a list row with no `adapterConfig` at all,
  which pins the rollout to the configurations endpoint.

### The hermes_gateway adapter sends the task workspace in the run request (1.6.5 BOT-DISK-H, part H5a)

- A run of a task that has a repository now carries a `workspace` field in the
  `POST /v1/runs` body: `{key, repo, baseRef}` — the issue identifier, the
  project's repository as `owner/name` and the workspace ref (omitted when the
  workspace has none). The gateway uses it to open the task copy before the
  model starts.
- A task without a repository, or without a board identifier, sends no field.
  A `workspace` written into the card's `payloadTemplate` is overwritten, like
  `github_broker`: a card cannot forge it.

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

### Deferred bot image rollout applies itself when the bot frees up (BOT-ROLLOUT, part C)

- A bot that was busy when its image rollout reached it (a running turn, the
  owner in a chat conversation, or someone else's maintenance window) no longer
  waits for the next deploy to switch images: the reconcile pass records the
  deferral (the `myrmidonBotRolloutDeferred` key of `instance_settings.general`,
  row-locked like the maintenance and canary keys), and a watcher inside the
  same 60-second reconciliation sweep retries the recorded bots.
- A retry goes out as soon as the bot reports no running work (the same
  maintenance-port busy signal the rollout path itself reads): the apply runs
  through the regular `applyBotContainerNow` — same per-bot lock, same fresh
  card read — and on success the record is removed. The bot lands on the new
  image inside the rollout window, without a new deploy.
- A bot that stays busy longer than
  `MYRMIDON_BOT_ROLLOUT_DEFERRED_MAX_WAIT_SEC` (default 3600) stops being
  waited on: the retry goes without the busy gate, the reconciler opens the
  maintenance window itself, drains the in-flight run to its end (runs are
  never interrupted — the OPE-3638 rule) and switches the container right
  after the current turn.
- A record that never converged within a bounded grace (4× the max wait) is
  retired: it is dropped, the failure is written to the reconcile activity
  log and to the activity/audit feed (`myrmidon.bot_rollout.deferred_retired`)
  — a wedged record does not retry forever.

### A busy bot no longer holds the bot image rollout (BOT-ROLLOUT-SKIP-BUSY, OPE-5098)

- The batch pass of `bot-image-rollout.sh` no longer waits on a busy bot: a
  bot whose agent is not paused/idle (or whose apply answers `deferred`) moves
  to a tail list and its batch ends as soon as the free bots are switched —
  the next batch starts at once. Before this, one busy bot held its whole
  batch for the full `MYRMIDON_BOT_IMAGE_ROLLOUT_BOT_TIMEOUT_SEC` (the rc.3 /
  rc.5 fact: 15 batches stretched to 3.5–4 h).
- After the last batch a tail pass retries the deferred bots until the same
  deadline; a bot that frees up (paused/idle) switches at once, inside the
  same run.
- Past the deadline the optional force stage applies the still-deferred bots
  without the status gate: the reconciler's own pause-and-apply path opens
  the maintenance window and drains the in-flight run to its end — a run is
  never interrupted. Gated by the new
  `MYRMIDON_BOT_IMAGE_ROLLOUT_FORCE_DEFERRED_SEC` (default = the bot timeout;
  `0` disables the stage and keeps the pre-1.6.5 apply behaviour).
- The final report lists every bot still not on the release image with its
  reason (agent status / the deferred reason of the apply outcome), and the
  summary JSON gains `deferredBots: [{id, reason}]` (an addition only — no
  existing field renamed).

### docs: custom castes (CUSTOM-CASTES A) — the company agent-role directory

- A new guide (EN+RU) describing the agent_castes directory: the fields of a caste, the twelve seeded built-ins, the REST contract under /api/myrmidon/companies/:id/castes including the DELETE reassignTo flow, and live reads with no restart.
- The stale 'until part A lands' wording in the CUSTOM-CASTES B section of SETTINGS.md/SETTINGS.ru.md is corrected (part A is in; the directory section itself comes from the 1-6-1-custom-castes-a fragment). The guides table points at the new guide, and the wiki settings page mentions the Agent castes screen.

### DEVBUILD-IN-BOTS: env-delivered key, a start self-check and a local heavy-run fallback (DEVBUILD-IN-BOTS)

- The `devbuild` CLI accepts the build-server key as the secret env
  `DEVBUILD_SSH_KEY_DATA` (the key text itself) when the
  `/opt/devbuild-ssh/id_ed25519` file is not mounted — this is how the board
  hands the key to a bot whose container has no mount. The key is
  materialized into a per-process private directory (0700 dir, 0600 file)
  under the run scratch — never into `/workspace` — and removed on exit. A
  readable key file still wins over the env key; the missing-everything error
  is unchanged.
- The bot entrypoint runs a devbuild self-check at start: when
  `DEVBUILD_HOST` is set it probes `devbuild 'true'` and logs one line
  (`devbuild self-check ok: …` or `ERROR: devbuild self-check failed: …`),
  plus a machine-readable `${HERMES_HOME}/.myrmidon/devbuild-check.json` for
  the board. The check never stops the gateway; bots without `DEVBUILD_HOST`
  stay silent; `MYRMIDON_DEVBUILD_CHECK=0` disables the probe.
- Heavy build commands that pass the devbuild gate (a build container, or a
  direct binary path in an ordinary bot container) now run with a
  container-safe heap cap: the wrappers append
  `--max-old-space-size=2048` (override `MYRMIDON_LOCAL_NODE_HEAP_MB`, `0`
  disables) to the child's `NODE_OPTIONS` — a caller's own
  `--max-old-space-size` wins — and print one stderr warning pointing at
  `devbuild`. Version/help probes skip both. This is the fallback that keeps
  an uncapped tsc from OOM-killing the bot container while the offload is
  being rolled out.

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

### Memory is written once per run and run-start recall is conditional (1.6.5 PERF-DIET HS/D1)

- The memory fork (`packages/plugins/hindsight-paperclip`, version
  `0.3.0-myrmidon.2`) no longer writes one memory per ticket comment. A run's
  comments wait in run-scoped plugin state and are retained as one consolidated
  digest per bank when the run finishes: the document is headed
  `Run <runId> digest` and lists the comments with their author and ticket,
  and its metadata carries `kind: "run-digest"`, `runId`, `agentIds`,
  `issueIds` and `commentCount`. Duplicate comment ids collapse, bodies under
  200 characters and board-machinery comments (a `## …` heading, a status
  change, a wake notice, a `Review:` verdict) are dropped, and the buffer is
  cleared after the flush. A comment outside a run — a human's, or an event
  that carries no run id — is retained immediately, as before, because it is
  new input for whichever run picks the ticket up next. A failed retention is
  a warning in the plugin log; the run never fails because of memory.
- Run-start recall became conditional. The new plugin instance configuration
  field `recallOnRunStart` (not an environment variable) takes `new-issue`
  (the default), `always` or `never`. `new-issue` searches the agent's bank
  only when the agent has not already searched for this ticket, so repeated
  wakes of one ticket no longer pay for the same local rerank; `always` keeps
  the previous behaviour, `never` turns run-start recall off. The
  `hindsight_recall` tool still searches on demand.
- Memory bank routing is unchanged: the card's
  `adapterConfig.hindsight.bankId`, then `bankByAgentId`, then the agent stays
  closed.

### A task with a scheduled monitor is not picked up by idle pickup (IDLE-PICKUP-MONITOR)

- An issue whose `monitor_next_check_at` lies in the future no longer counts
  as a ready idle-pickup candidate: its wake already has an owner —
  `tickDueIssueMonitors` fires it exactly at the scheduled time (for the
  `in_progress`/`in_review` statuses). Until now the candidate prefilter never
  read the column, and such an issue burned a no-op run on every sweep pass
  until the monitor fired.
- The filter is one shared SQL prefilter, so both consumers follow at once:
  the periodic sweep and the WAKE-BIND binding (`findTopReadyIssueForAgent`),
  which picks the task a manual wake without an explicit issue binds to.
- An elapsed monitor (`monitor_next_check_at <= now`) is NOT excluded: the
  monitor tick owns that wake, and suppressing readiness there serves nothing.
- The behaviour is strict — no switch is added and none is needed.

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

### Merge queue: CI checks the candidate commit on top of fresh main (MERGE-QUEUE)

- `.github/workflows/myrmidon-ci.yml` and `myrmidon-hot-files-review.yml` gained the
  `merge_group: types: [checks_requested]` trigger. `plan` and `tests-affected` diff
  `merge_group.base_sha..head_sha` — the PR's own diff on top of the fresh main — so
  `plan`, `typecheck`, `build`, `tests-affected` and `ci-result` run on the queue candidate
  exactly as they do on the PR, and the `main-protection` ruleset requirements hold.
- A `merge_group` CI run is never auto-cancelled (`cancel-in-progress` off for that event):
  a cancelled run would evict the group from the queue.
- For `merge_group`, `hot-files-review` only reports success on the candidate: review is
  enforced on the PR via the `review-approved` label, the queue must not block on it.
- New guide `docs/myrmidon/merge-queue.md` (en; [русский](merge-queue.ru.md)): the queue
  process, reviewer/steward roles, `gh pr merge --auto`, what to do when a PR leaves the
  queue; the guide is listed in `docs/myrmidon/README.md`.

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

### Board process metrics: event loop delay, memory, live-event flow (PROCS-Q3)

`GET /metrics` now answers five more families: `myrmidon_board_event_loop_lag_seconds`
(p50/p99/max summary, measured between scrapes), `myrmidon_board_process_rss_bytes`,
`myrmidon_board_heap_bytes` (used/total), `myrmidon_board_live_events_total` and
`myrmidon_board_live_event_bytes_total` (per live-event kind, cumulative since boot).
This is the measurement half of этап 0 of the multi-process project: no scaling of the
board may be argued without these numbers first.

Nothing new stores or configures: the delay comes from Node's `monitorEventLoopDelay`
(read-and-reset, so a quantile describes exactly the scrape interval), the memory from
`process.memoryUsage()`, and the live-event flow from an ordinary subscriber of the
existing `services/live-events.ts` emitter — the publisher is not modified. The
observers start lazily on the first authorized scrape, so an endpoint nobody scrapes
costs nothing. A failing process read zeroes the five families by name in
`myrmidon_scrape_errors` and never kills the scrape, exactly as the DB families already
behave. Measured overhead of the per-event listener (Node 24, 100k events with JSON
payload serialization through the real `recordLiveEvent` path): **0.85 µs per event**,
85 ms total — at a sustained 1000 events/second that is 0.085 % of one CPU core, an
order of magnitude below the 1 % budget.

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

- The bot volume grew ~4 GB/h: every task clone copied the whole git history
  (~0.4 GB each) even with the board's `/cache/git` mirrors, because a bot
  terminal rebuilds PATH without `/opt/paperclip/bin`, where the 1.6.2 wrapper
  stood — a bare `git clone` ran the real git, and the wrapper itself died with
  127 outside the image PATH (`#!/usr/bin/env node`). The dev image now shadows
  git with a `/usr/local/bin/git` symlink (an element every rebuilt PATH keeps)
  and runs the wrapper with an absolute interpreter.
- The wrapper keeps a bare mirror per repository inside the bot's own mount —
  `${MYRMIDON_GIT_LOCAL_MIRROR:-<HERMES_HOME>/.myrmidon/git-objects}`, or the
  shared store `/bot-scope/.git-objects` the profile compiler gives to members
  of an isolation-scope instance (issue #574 scope: objects then live once per
  scope, not per bot) — and makes every clone after the first borrow its
  objects with `--reference-if-able`. The first clone of a repository pays one
  full fetch; later clones store only their working tree and their own
  commits. The mirrors never prune objects a clone may still borrow
  (`gc.pruneExpire=never`, `gc.auto=0`), the refresh is throttled behind a
  lock, the board's mirror still wins when mounted, and every failure falls
  back to a plain clone. The store lives in the bot's hermes home (or the
  scope root), so no clone lifecycle ever reaps it.
- The entrypoint runs a shared-objects self-check at every start, by the hard-link
  self-check's pattern: the shadow answers, the wrapper runs, the store is
  writable, and a real offline `--reference-if-able` round trip borrows
  objects. The result rides the clone-hygiene report (`gitRefCheck`); a failed
  check raises a `bot_disk_lifecycle` attention card per bot, gone at the next
  clean start.
- On the fleet the store stayed empty next to live GitHub task clones. The task
  clones on a bot name another local clone in their `objects/info/alternates`
  file, and only `--reference` (or `--shared`) writes that entry: the clone runs
  with `--reference <neighbour clone>`, and the wrapper read `--reference` as
  the clone's own storage decision, so it stepped aside — in silence, without a
  mirror and without a trace. Reproduced with the old wrapper: a
  `git clone --reference <neighbour> https://github.com/<owner>/<repo> <dir>`
  leaves the store empty and prints no line. The opt-outs are now only the
  options that pick the storage of the clone's own objects (`--dissociate`,
  `--shared`, `--local`, `--mirror`, `--filter`); a clone that names
  `--reference`/`--reference-if-able`/`--no-local`, a bounded clone (`--depth`,
  `--shallow-since`, `--shallow-exclude`) and a non-GitHub clone keep the store's
  mirror as one more alternate. The field command line through both wrappers:
  the old one leaves the store empty, the new one leaves
  `<store>/<owner>/<repo>.git` and an `alternates` entry.
- A clone the store does not serve is no longer silent: the wrapper prints one
  `[myrmidon-git]` line on stderr and writes
  `<HERMES_HOME>/.myrmidon/git-objects-last-error.json` (kind, reason, detail,
  the command line, one counter per kind). The clone still never fails because
  of the store.
- The start-time check gained two steps: `store-fills` runs the task clone's own
  command line (a bounded clone that also names a stale `--reference-if-able`)
  through the wrapper and requires a mirror in the store plus an alternates
  entry, and `store-in-use` fails when GitHub task clones exist below
  `/workspace` or `/scratch` and the store holds no mirror. The silent fleet
  state now raises the `gitref` card.
- `devbuild` follows the alternates: a borrowed mirror is synced once to the
  build host's `/srv/devcache/git` and the synced clone's `objects/info/alternates`
  is repointed at it, so git commands in a remote build keep working against
  reference-cloned task workspaces.
- Measured on this repository (full history, `myrmidon@29ae84e5`): a fresh
  clone without a store: 414 MB / 25.5 s, `.git` 144 MB; with the bot store
  mirrored: 272 MB / 1.1 s, `.git` 2 MB (the working tree of 270 MB is
  unchanged); the store itself 145 MB once per bot/scope. Each further clone
  of the same repository adds ~270 MB, not ~414 MB, and borrows the same
  history; before the fix every clone re-downloaded and re-stored ~144 MB of
  shared objects.
- Disable switches: `MYRMIDON_GIT_LOCAL_MIRROR=""` (no bot store),
  `MYRMIDON_GIT_LOCAL_MIRROR_REFRESH_SEC=0` (never refetch),
  `MYRMIDON_GIT_OBJECTS_CHECK=0` (skip the start-time check). See
  [bot-disk-cache.md](bot-disk-cache.md).

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
whole epic exists for: the gateway dies mid-run, and the team comes back by
itself. It carries no liveness logic of its own — every decision is taken by the
product passes (RUN-STALL by progress, AUTO-RESUME, IDLE-PICKUP) built exactly as
the server builds them; the runner seeds the situation, SIGKILLs the process,
steps the clock and reads the database back.

The verdict names three legs: the run is settled, the task is not left waiting
(it left `in_progress` and has a wake or a live run), the agent is not stuck in
`error` — all inside a budget (10 minutes by default), and the exit code carries
the result. `rehearse` is self-contained (throwaway embedded database, a real
gateway process) and writes the knobs through the instance settings API, so it
also shows a saved value taking effect without a restart. `watch` is read-only
against the live board database, for the real kill on the stand.

Runbook: [guides/team-liveness-stand-scenario.md](../guides/team-liveness-stand-scenario.md).

Note on the budget: the default stall threshold (20 min) is longer than the
10-minute budget, so a silent run is only noticed later. The rehearsal sets the
threshold below the budget through the settings area; a kill that takes the run
terminal immediately does not involve the threshold at all.

### Vendor-derived share in the release notes (1.6.5 VENDOR-SHARE-METRIC)

- Every release published by `publish-github-release.sh` now carries a
  `## Vendor-derived files` section: the share of files inherited from vendor
  code and its delta to the previous release —
  `Vendor-derived files: 6123 of 6812 (89.89%), Δ to myr-v1.6.4: +0.10 pp (+7 files)`.
  The numbers come from `scripts/myrmidon/vendor-share.mjs` (already in main),
  the previous line is parsed out of the previous release's own notes; a release
  published before the metric reads
  `нет данных (no vendor-share line in that release)`.
- The metric is advisory: when the share cannot be computed (no vendor base in
  the checkout, unreadable state file) the section says `не посчитано` with a
  warning and the release still goes out — a metric failure never fails a
  publish.
- `scripts/myrmidon/release/vendor-share-notes.mjs` (new) builds and parses the
  line; its unit contract is `vendor-share-notes.myrmidon.test.mjs` (11 tests),
  and the publisher integration lives in `release-publish.test.mjs` (3 more, the
  acceptance criteria of OPE-4152).

### A bot's card key follows the container, not the secret's head (1.6.6 BOT-KEY-401)

- The agent card's `adapterConfig.apiKey` secret_ref is now pinned to the exact
  numeric VERSION of the bot's API-server-key secret whose value the applied
  profile's `.env` carries — never `"latest"`. A version bump of that secret
  (a rotation, e.g. the gateway-token maintenance) only reaches the card after
  a pass whose container switch SUCCEEDED: a compile whose apply then fails
  (dockergate refuses the recreate, the maintenance window closes, the driver
  is unreachable) no longer leaves the old container running with the old key
  while the card already resolves the new one — the board's run calls answered
  401 "API server rejected invalid API key" from exactly that gap.
- The pin travels in the profile's restart hash: a key rotation with no other
  change is itself a reason to recreate the container, so the next successful
  pass puts the new key INTO the container and re-pins the card right after.
- Cards written before this pin existed (`version: "latest"`) are re-pinned to
  the version the RUNNING container carries on the next pass; nothing to do by
  hand.

### Telegram moves out of the core into a channel connector: the design (1.6.6, step 1)

- The design document for release 1.6.6 is approved and recorded in
  [design/chat-channel-connector.en.md](design/chat-channel-connector.en.md)
  (Russian original: [design/chat-channel-connector.md](design/chat-channel-connector.md)):
  everything that knows about Telegram moves into a
  `server/src/myrmidon/channel-connectors/telegram/` connector behind a hub,
  and the vendor `chat-channels.ts` keeps exactly one of our inserts instead
  of today's 66 channel inserts. Connect, configure and disconnect happen in
  the existing Chat endpoints UI with no server restart.
- The owner decisions are fixed in section 11: one on/off switch for the
  whole channel; the shared writer-access layer lands right after the switch,
  in this release; bridge topics move from lower risk to higher risk. The
  move runs as six steps, one PR each, accepted on a production-DB copy.
- This step ships no code: no behavior, settings, or schema changes until the
  implementation steps land.

### Knowledge module part K-9: the evals gate of knowledge (KNOWLEDGE-2.0 K-9)

- New `server/src/myrmidon/evals/knowledge-gate.ts`: the lifecycle hook —
  `rule.approved` / `skill.promoted` / `page.published` opens a judge run for
  the item (`eval_run` with `subject_kind` + `subject_ref`), and a drop beyond
  the threshold, **confirmed by the repeat run**, calls `knowledge.rollback`
  and leaves a card for the owner postfactum. A hallucination — a criterion
  named after the failure or the promise (`hallucination`, `no-invented-…`,
  `fabricat…`, `made-up`) scored zero — rolls back at once, without spending the
  repeat.
- New additive migration `0314_evals_knowledge_gate.sql`: nullable
  `subject_kind` / `subject_ref` on `myrmidon_eval_runs`, so a run names the
  knowledge item it gated. Runs that are not gate runs leave both null.
- The knowledge journal now carries a `knowledge.eval_gate` line per judged
  publication with `eval_run_id`, `delta`, `verdict` and `owner_notice`
  (`KnowledgeModule.recordGateJournal`), so the quality page answers "which
  judge run gated this item, and by how much did it move the caste".
- Budget by construction: at most two judge runs per publication (first +
  confirmation) — the threshold's repeat is the last run.
- Tests: `knowledge-gate.db.myrmidon.test.ts` — the decision table (pure) plus
  the end-to-end acceptance on a synthetic rule over embedded Postgres: a
  deliberately bad rule rolls back within ≤ 2 judge runs, a good rule stays on
  one run, a hallucination rolls back on one run, and the journal carries
  `eval_run_id` and `delta`.

### Knowledge module part A: domain and store (KNOWLEDGE-2.0 K-1)

- New server module `server/src/myrmidon/knowledge/`: `domain.ts` (pure
  domain: the revision state machine, invariants, `[[slug]]` link grammar,
  the deterministic markdown tree format, the `SearchIndex` port), `store.ts`
  (create/draft/submit/publish/approve/rollback/archive/supersede, link
  resolution and backlinks, tree export/import, events), `service.ts`
  (composition over a `Db`), `index.ts` (module barrel).
- New additive migration `0313_knowledge_module.sql`: tables
  `knowledge_items`, `knowledge_revisions`, `knowledge_links`,
  `knowledge_sources`, `knowledge_suggestions`, `knowledge_events` and the
  `knowledge_search` read model, all keyed by `nest_id` (today equal to the
  company id). FTS: a generated `tsvector` column plus `pg_trgm` indexes
  behind the `SearchIndex` port; an IMMUTABLE wrapper around `unaccent` keeps
  the generated column legal. No triggers, no dialect SQL inside the module.
- New `packages/db/src/knowledge-search.ts`: the Postgres implementation of
  the port (lexical rank + trigram tolerance, delivered revisions only).
- A new draft never moves `delivered_revision_id`; publishing a revision that
  requires approval without approval fails with HTTP 422; `approve` by an
  actor that violates the approver rules fails with HTTP 403; `rollback`
  copies the target revision forward and moves the delivery pointer;
  export → import → export is byte-for-byte.
- Every mutation writes a `knowledge.*` event into `knowledge_events` and an
  `activityLog` row.
- Tests: `knowledge-domain.myrmidon.test.ts` (20 tests, incl. a 1 000-page
  tree round-trip under 300 ms p95) and
  `knowledge-store.db.myrmidon.test.ts` (17 tests over embedded Postgres with
  real migrations). HTTP routes arrive with K-2.

### 1.6.6 LONG-TASK-CONTEXT: an ever-running task no longer kills its run on context compression (OPE-6816)

- The runtime's compression timeouts (`Context compression timed out:
  approximately 214 298 / 378 739 tokens`, `Context compression timed out
  without reducing this conversation`) now match the context-window signatures:
  such a run drops the task session and leaves the agent idle, instead of
  landing the agent in `error` until a human resets the session by hand.
- Live settings `instance_settings.general.longTaskContext` (`enabled`,
  `resetPct`, `fallbackWindowTokens`, `historyChars`): a task session already at
  `resetPct` (default 70%) of the model window is dropped BEFORE the next run
  resumes it — compression up to the threshold, not after it — and the reset is
  named in the run's own context.
- The launch payload's task history is bounded by volume as well as by count:
  `MYRMIDON_CONTINUATION_HISTORY_CHARS` (24k) of message text in total and
  `MYRMIDON_CONTINUATION_MESSAGE_MAX_CHARS` (8k) per entry; entries that do not
  fit are dropped and referenced through the issue API instead of travelling
  with every run of the task.
- Guide: [guides/long-task-context.md](../guides/long-task-context.md).

### Alert recovery: the owner task of an alarm and the automatic close (1.6.6-MONITORING-D)

- An alarm from Zabbix or Alertmanager now becomes a task of the owning role
  instead of a thread of messages: the task carries the numbered recovery steps
  of the runbook of that trigger, the link to its document, and the metric the
  owner checks when the steps are done. A trigger with no runbook of its own
  falls back to the generic runbook, which still ships steps and a document.
- The runbook registry (`server/src/myrmidon/monitoring/alert-recovery/runbook.ts`)
  selects by trigger key: an exact trigger match first, then the longest matching
  fragment (`disk`, `filesystem`, `space` → `disk-space-low`; `unreachable`,
  `icmp`, `zabbix agent` → `host-unreachable`; `scrape`, `prometheus` →
  `metrics-scrape-failing`). The documents live in `docs/myrmidon/runbooks/` and
  a test fails if a registered runbook has no document on disk.
- The task closes by itself once the alarm has stayed resolved for the hold
  (10 minutes by default): the scheduler tick closes it, comments the metric and
  the resolve time, and only ever writes to tasks it opened itself
  (`originKind = alert_recovery`), so a task a person took over is never
  overruled.
- A repeat alarm inside the recurrence window (60 minutes by default) comes back
  into the same task — a comment, the task is reopened if it had already closed —
  instead of opening a second one. A repeat before the hold is up cancels the
  automatic close and the hold restarts from the next resolve. A resolve event
  that arrives twice does not push the close away.
- Both numbers are instance settings, changed live through
  `GET`/`PATCH /api/myrmidon/monitoring/alert-recovery` (PATCH is instance-admin,
  the same rule as the rest of the instance settings), stored in
  `instance_settings.general.alertRecovery`, read over the environment on every
  event and every sweep pass. The GET reports, per key, whether the settings row,
  the environment or the default is in force, plus the runbook registry and the
  alert journal of the company with the due time of every automatic close.
- An operator or the intake can drive a real alarm through the lifecycle with
  `POST /api/myrmidon/monitoring/alert-recovery/events` — the normalized event
  (source, trigger, status, severity, hosts, time) that the Zabbix/Alertmanager
  intake of the monitoring part produces once an alarm fires again or resolves.
- Every settings change is written to the activity log for every company
  (`instance.alert_recovery.updated`).

### 1.6.6 MONITORING E: service keys of the linking components and the "I am alive" self-check (OPE-4973)

- New board key scope `monitoring_link`: the narrowest key on the board. A
  linking component (Zabbix aggregator, Alertmanager webhook, collector) gets
  its own key that can only create a task, update a task and report its own
  liveness — never the shared operator key.
- `POST /api/myrmidon/companies/:companyId/monitoring/links/pulse` — the
  link's "I am alive". The key identifies the link; a 200 is the board
  answering "I hear you". The pulse is the key's own `last_used_at`, so a
  second heartbeat store cannot disagree with the first.
- `GET /api/myrmidon/companies/:companyId/monitoring/links` — the live feed
  (`keyState`, `lastPulseAt`, `pulseAgeSec`, `staleAfterSec`, `verdict`,
  `unhealthy`) that the Zabbix item and the operator read.
- Board-side watchdog: a revoked or expired key, or a link that stopped
  pulsing, raises **one High task** for the observability role and closes it
  with a comment when the link is back. A task closed by a human while the link
  is still blind is reopened.
- Detection budget: the default 480s silence threshold plus the 60s pass and
  the 30s scheduler tick put the worst case at 570s — inside the ten minutes the
  issue asks for. A key that dies on the fly is caught on the next pass.
- A link key is confined to the company it was issued for and no longer follows
  its owner user's membership list into other tenants; an unreadable stored
  scope degrades to `read_only` instead of widening to full operator access.

### Assignment wakes are suppressed for closed issues (PLUGIN-REGISTRY 2/3)

- Ported the vendor guard from paperclipai/paperclip #13738: assigning or
  re-assigning an agent on an issue whose status is `done` or `cancelled`
  no longer queues a heartbeat wake. The check runs once, centrally, in
  `server/src/services/issue-assignment-wakeup.ts`, so every call point is
  covered at once — issue create, child create, accepted plan decomposition,
  interaction accept, status-card and summary-slot generation, chat, routine
  and secret-proposal wakes.
- `backlog` suppression stays as before; an explicit reopen transition
  (done/cancelled → todo) still wakes the assignee because the wake carries
  the issue's new status.

### The board database ships pgvector, and a fresh install switches the extension on (CORPUS-2.0 step 4)

- The board database image is now `pgvector/pgvector:0.8.7-pg17` in both the
  installer's generated compose and `docker/docker-compose.yml`, replacing
  `postgres:17-alpine`. The module of the knowledge corpus keeps its embeddings
  in a `vector` column, so the extension binary has to be in the image the
  database runs.
- The binary alone is not enough: the installer now enables the extension in
  the board database right after the database becomes healthy and before the
  board starts, checks the version the database reports and prints it. A version
  other than `0.8.7` fails the installation instead of leaving a board whose
  corpus cannot index. Immediately after a fresh install
  `SELECT extversion FROM pg_extension WHERE extname='vector'` returns
  `0.8.7` — the same version as the pilot and the production cluster.
  Re-running the installer is unchanged: the step is idempotent
  (`CREATE EXTENSION IF NOT EXISTS`) and only runs on a fresh install.
- Boards already installed on `postgres:17-alpine` keep the old image until
  their operator enables the extension by hand: the runbook
  [runbooks/pgvector-extension.md](runbooks/pgvector-extension.md) covers both
  cases — an image that already carries pgvector (one `CREATE EXTENSION IF NOT
  EXISTS vector;` in the board database, no image or cluster swap) and a plain
  `postgres:17-alpine` (maintenance window, `pg_dump -Fc`, move to the pgvector
  image, restore; an in-place image swap of a running cluster is not allowed).

### The board's process composition is a setting: `general.processes` (PROCS-J)

- The composition of the board — how many HTTP processes (`api`) and how many scheduler
  processes (`worker`) a deployment runs — is now read at startup from the instance
  settings key `general.processes`. An absent key (the usual case) means
  `{ api: 1, worker: 0 }` — today's single process — so a deployment that does not set it
  starts exactly as before.
- A composition that cannot be read refuses startup instead of being guessed: counts that
  are not whole numbers `>= 0`, or a row that asks for no process at all
  (`api + worker < 1`), stop the board with the key, the values and the fix in the log.
- PROCS-1.1 (the mode and the per-role gates of the same feature) stores its own fields in
  the same row; the counts are read on their own, so neither part of the feature refuses
  the other's row.

### PROCS-1.3: inter-process bus over Postgres LISTEN/NOTIFY (OPE-5410 ч.A)

- New `server/src/services/process-bus.ts` — the single bus the
  multi-process board design (OPE-5394 §3) routes through: one
  `sql.listen` per channel over postgres.js (its connection re-LISTENs
  itself after a reconnect and the `onlisten` callback becomes the
  `onReconnect` catch-up hook for subscribers), `publish` via
  `pg_notify`, an `origin = bootId` on every message so a process drops
  its own, a `schemaVersion` stamp validated on receive, and a hard
  refusal of any payload above the 8000-byte NOTIFY limit
  (`ProcessBusPayloadTooLargeError`).
- Channels: `run_queued`, `run_control`, `settings_changed`,
  `live_event`, `secrets_changed`, `bot_apply_requested`,
  `leader_changed`, wire-named `paperclip_bus_<channel>`.
- Default behavior is unchanged: nothing constructs or starts the bus
  until a later task (dispatcher, settings appliers) wires it behind the
  process-role profile.
- Unit tests cover the origin filter, the reconnect catch-up, the
  payload limit, the schemaVersion drop, malformed payloads, and the T6
  lost-NOTIFY case: a dropped signal is picked up by the periodic
  fallback sweep, with no double start once the fast path works again.

### PROCS-1.5: readiness of every process and the aggregate `/healthz` (ч.F)

- New `GET /internal/ready` on the app root: a process answers about itself,
  `200` when it can take traffic and `503` otherwise. The body names the role,
  the boot id, the `at` timestamp and the three cheap checks:
  `database` (one `SELECT 1` through the existing pool, with a 1 s deadline so
  a wedged connection cannot hold the request open), `migrations` (the in-memory
  boot phase of startup recovery, which only reaches `ready` after migrations
  ran) and `bus` (the subscription flag the bus wiring reports).
- New `GET /healthz` on the app root for the load balancer. With the process
  supervisor wired in (PROCS-1.2) it answers `200` only when **all N** api
  processes are ready and the supervisor's own checks pass — the supervisor is
  the process that applies migrations, so its state gates the switch to split.
  `startingSplit` is `503` by definition; the `single`, `emergencySingle` and
  `drainingToSingle` lanes answer with this process's own readiness, because in
  those lanes this process serves the board itself. Without a supervisor — in an
  api child, and on today's single process — the answer is this process alone
  and the body says `scope: "process"`.
- The aggregate body carries the counts an operator needs
  (`api: { desired, ready, starting }`), the supervisor state, the
  `reason` (`all_api_ready` / `api_not_ready` / `split_starting` /
  `process_ready` / `process_not_ready`) and the same check list as
  `/internal/ready`. Both endpoints set `Cache-Control: no-store`, read no
  credentials and expose no company data.
- The `bus` check is `not_applicable` — never blocking — until a process
  reports a subscription, so the check cannot report a healthy board as unready
  before a deployment that uses the bus exists. `bindProcessBusReadiness` wraps
  a bus so the flag turns on only after `start()` resolved and off before
  `stop()`.
- `createApp` takes an optional `processSupervisor` view; the split wiring of
  PROCS-1.2 passes it — or registers it once with `registerProcessSupervisor`,
  which the routes consult per request, because the split starts after the app
  is built. Default behaviour is unchanged: nothing new starts, and a
  process with no supervisor answers `/healthz` from its own checks.
- Unit tests cover the whole aggregate decision table (all lanes, the draining
  child, the N-th api still starting) and the route status codes and bodies of
  both endpoints. No process is spawned and no database is needed: the checks
  are injected, so the existing e2e harness of ч.C stays the only place that
  boots real processes.

### Owner answers to running-agent cards join the message queue: Wait / Steer / Interrupt (1.6.6 UPSTREAM-STEER, part A — server)

- A resolved interaction card (accept / answer / reject) submitted while the
  agent's run is active is now projected into the issue message queue as one
  immutable queue entry (`source.kind = "interaction"`): it cannot be edited,
  discarded or reordered, and the exact saved decision (selected options,
  approval revision) is what gets delivered.
- Delivery is explicit: ordinary run completion promotes the saved response
  (Wait), an explicit queue Steer delivers it into the compatible native turn
  with interaction provenance, and Interrupt stops the current turn and starts
  a fresh continuation — required for card answers that force a fresh session
  (e.g. plan approvals), which can no longer be steered.
- Answers to older questions no longer steer a different active run
  implicitly: the implicit steer path in question-response-delivery was
  removed (vendor PR #13539 behavior). A provider blocked on its own native
  question request still resolves that request directly.
- Anti-reassign guard: a card resolved by the finishing run — or a queued card
  response waiting for that agent — is a live review path, so an agent can no
  longer hand its issue back and orphan the owner's accepted response. The
  continuation wake is awaited (not fire-and-forget) before the queue projects
  it, and interaction receipts never coalesce with comments or other cards.

### Owner answers to running-agent cards join the message queue: Wait / Steer / Interrupt (1.6.6 UPSTREAM-STEER, part B — UI)

- The task-chat message queue now recognizes queue entries projected from a
  resolved interaction card (`source.kind = "interaction"`): such an entry is
  immutable — its drag handle and actions menu are disabled, no edit or
  discard is offered, and the row shows the first line of the saved response
  as its label.
- A fresh-session card answer (`source.requiresFreshSession`, e.g. a plan
  approval) or any entry on the legacy protocol offers Interrupt only; other
  interaction entries keep the Steer / Interrupt pair of the current
  steering rules.
- While an immutable interaction entry sits in the queue, reordering is
  frozen: a reorder request returns no change and positions are not
  rewritten.
- Normal queue behavior for ordinary comments (edit, discard, reorder, Steer
  / Interrupt rules) is unchanged; regression and interaction scenarios are
  covered in `ui/src/lib/issue-queued-comment-queue.test.ts` and
  `ui/src/components/task-chat/TaskChatQueuedMessages.test.tsx`.
- Ported from upstream Paperclip PR #13539 (commit d0b67bfe7), marked with
  `myrmidon(UPSTREAM-13539)` in the touched code.

### A wake guard now also checks the issue version: a stale delivery no longer starts a turn (1.6.6 UPSTREAM-HANDOFF, part B)

- `issueStateGuard` gained the vendor's optional `statusVersion` (vendor PR
  #13686, commit `d82fbb0f`): a wake enlisted for an issue is admitted only
  while the issue still carries the version the wake was built for, so a
  delivery that waited behind a running turn and arrives after one or more
  later handoffs is dropped instead of starting an extra turn.
- The board's own queued-comment delivery now records the version it saw, and a
  dropped wake names `expectedStatusVersion` / `actualStatusVersion` beside the
  status and the assignee it already reported.
- A guard without the version keeps the previous behaviour, so every existing
  guard site stays unaffected.

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

### Bot disk panel and working-copy line (1.6.5 BOT-DISK-H, part H4d)

- Instance → General, "Bot disk": a physical section (partition, quota, other consumers) and a per-bot table: quota and usage, number of E/G/X copies, archives, report age (stale after 30 minutes is flagged), image generation; expanding a bot lists its copies with key, task status, branch, clean/pushed state and age.
- New `BotDiskWorkspaceRow`: on a task, "working copy: bot, path, state" and "archive: path, size, retention". Old reports without some fields render without errors.

### Release freeze gate sees the tag CI (1.6.5)

- `scripts/myrmidon/release/release-freeze.sh` now selects the tag CI by
  `myrmidon-ci-tag.yml` runs with `head_branch == the tag` (the pipeline that
  runs on the tag itself), with `myrmidon-ci.yml` main-branch runs of the
  same commit kept as a fallback. Previously the gate filtered on
  `myrmidon-ci.yml` only, so the verdict stayed "missing" forever and the
  release freeze never cleared even with a green tag CI.
- `scripts/myrmidon/release/release-body.mjs` now refuses a release body over
  GitHub's 125000-character limit BEFORE the publish step, naming the byte
  count, instead of dying at `gh release create` with a bare HTTP 422 after
  all CI gates already passed.

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
  (`server/src/services/conversation-continuation.ts`) now selects only the
  columns it checks and returns (`id`, `agent_id`, `process_pid`,
  `process_group_id`, `process_started_at`) instead of the full
  `heartbeat_runs` row. The full-row select dragged the multi-KB
  `result_json` / `runner_profile_json` / `context_snapshot` through the
  executor about 10 times per run; planning alone took 74 ms on production.
- Migration `0302_heartbeat_runs_company_issue_coalesce_created_index.sql`
  persists the expression index
  `heartbeat_runs_company_issue_coalesce_created_idx` on
  `(company_id, coalesce(native_issue_id::text, context_snapshot->>'issueId'), created_at desc, id desc)`.
  The operator created this index manually on production (OPE-4106); the
  migration makes it part of the managed schema. `IF NOT EXISTS` keeps the
  manual index in place and makes a re-run a no-op.
- New migration test
  `packages/db/src/heartbeat-runs-company-issue-coalesce-index.myrmidon.test.ts`:
  the full chain applies, EXPLAIN uses the index for the blocker predicate,
  and replaying the migration statements is a no-op.
- DIVERGENCE row: `OPE-4131-B`.

### Run admission decides on CPU utilisation, not load average (1.6.5 RUN-ADMISSION, rc.3)

- The decision to admit new runs moved from the host load average to measured
  CPU utilisation: the non-idle share of all cores read from `/proc/stat` over
  a short window (the delta of two readings the admission keeps, a window of
  at least 250 ms), and optionally the PSI cpu pressure — the `some avg10`
  field of `/proc/pressure/cpu`. Load average remains in the gate report only
  as an auxiliary number. The reason: on 06.10 the host carried load1 65.7 on
  16 cores (203 % above the background floor), which held 11 runs, while the
  CPU was only 60–75 % busy and 15–25 % idle — load average counts blocked
  tasks too, so waiting on disk or a lock looks like overload.
- Two new run limits: `maxHostCpuBusyPercent`
  (`MYRMIDON_MAX_HOST_CPU_BUSY_PERCENT`, default 90, default-on) — an absolute
  percent of the whole CPU (not per core above background: utilisation
  already measures real work); and `maxHostCpuPsiSomeAvg10`
  (`MYRMIDON_MAX_HOST_CPU_PSI_SOME_AVG10`, off unless the operator sets it).
  The ceiling closes when the busy percent reaches the first threshold, or —
  when the PSI ceiling is set — when `some avg10` reaches the second.
- A settings row saved before rc.3 carries neither new key, and an absent key
  means off: such a row keeps deciding on load average exactly as in 1.6.5
  (deprecated, kept working). The moment either CPU ceiling is set, it decides
  and the load average only reports. An unreadable `/proc/stat` (or an
  unreadable `/proc/pressure/cpu` while its ceiling is set) leaves the gate
  `unknown`, the ceiling inactive, the reason logged once — like loadavg
  before. Paths overridable with `MYRMIDON_HOST_PROCSTAT_PATH` and
  `MYRMIDON_HOST_PRESSURE_CPU_PATH`.
- The gate report (`GET /api/myrmidon/runtime-limits`, the attention card)
  gained `cpuBusyPercent`, `busyThresholdPercent`, `psiSomeAvg10`,
  `psiThresholdPercent` and `source` (`cpu-busy` / `load-average`); all old
  fields keep their meaning.

### Run admission by host CPU load (1.6.5 RUN-ADMISSION)

- The run admission gets a host CPU ceiling, `maxHostLoadPercentPerCore`
  (`MYRMIDON_MAX_HOST_LOAD_PERCENT_PER_CORE`, default 90): a new run, whatever
  woke it, starts only while the host's 1-minute load average per core stays
  under 90 % of one core. Otherwise it stays `queued` and the 15 s queue pass
  retries it. The night of 05.10: 43+ runs started at once while the host
  memory floor was still open, the host ran load 95 on 16 cores, and the
  board's own API answered 3+ s until it fell over on timeouts — a saturated
  CPU queue is invisible to every memory reading.
- The load is read from `/proc/loadavg` and the visible core count from
  `os.cpus()` (the host's values inside a plain Docker container); an
  unreadable reading logs once and leaves the ceiling inactive,
  `MYRMIDON_HOST_LOADAVG_PATH` overrides the path.
- The ceiling lives in the same Run limits settings (Instance → General,
  Settings → Runs & queue, `PATCH /api/myrmidon/runtime-limits`) and changes
  on the fly without a restart; a row saved before 1.6.5 keeps working and
  takes the environment value or the default.
- The swarm idle-wake pass wakes nobody while the ceiling is closed. A hold
  over 10 minutes raises the attention card «Runs held: host CPU load», gone
  on the first admitted run. See [SETTINGS.md](../SETTINGS.md).
- rc.2: the ceiling is counted ABOVE the host's own background load. rc.1
  compared the absolute reading, so a bot host whose background services
  (RAGFlow, hindsight, Langfuse) hold 100–145 % of a core per core was held
  shut from the first second — 05.10 17:34: 4 runs going, 34 waiting, and the
  threshold cleared by hand to 200. The background floor is the lower of the
  1- and 15-minute load averages per core, kept as the lowest value seen and
  rising at most 1 % of a core per minute: a burst of runs cannot raise it,
  the 15-minute average carries it across a restart of the server, and a host
  that became genuinely busier is followed within tens of minutes.
- Settings → «Runs & queue» now shows the current host load next to the
  ceiling field — the reading, the host's background floor, the load above it
  and whether the ceiling is open or closed.

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

### A fair queue for the global run cap, and the wait reason on the run itself (1.6.5 RUN-FAIRNESS, part 1)

- While the global concurrency ceiling is busy, a freed slot now goes to the
  longest-waiting queued run, not to the agent the sweep happens to visit
  first. The queued-run sweep visits the agents in the order of each agent's
  OLDEST queued run (the queue read is already ordered by run creation), and
  a per-agent share gate (`maxPerAgentStartSharePercent`, default 15) holds an
  agent that already took its share of the starts of the sliding 10-minute
  window while runs of other agents wait. A lone queue is never throttled by
  the share, and a queue shorter than one full share step lets everyone
  through.
- A run that stays queued because of an admission gate now says why: the
  queue pass writes `waitReason` into the run's `contextSnapshot` —
  `global_cap`, `start_ramp`, `memory`, `host_memory`, `host_cpu`,
  `agent_fair_share` or `agent_concurrency` (the per-agent ceiling is full) —
  and removes it on the claim that starts the run.
- The run admission reports the gate that closed the last reservation
  (`lastDenialReason`), so the sweep writes the reason of the gate that
  actually held the runs back, and counts the starts of the window by agent
  (`agentStartShare`) for the share gate.

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

### Channel allowlist — who may write to the bots (CA-A, OPE-4949)

- New general-channel-layer mechanism, not Telegram code: the board keeps a
  list of admitted channel writers. Admission is by the channel identity
  (numeric Telegram id, matched case-insensitively by @username too) — a
  board account is NOT required (owner clarification 06.10); when a person
  does have one, the row may store the link. One row covers all bots of the company
  or one specific bot endpoint; revoked rows never admit and stay for audit.
- New instance channel setting `channelAccessMode`
  (`MYRMIDON_CHANNEL_ACCESS_MODE`, default `sponsor`): `sponsor` keeps the
  vendor guest-sponsorship path byte-for-byte, `allowlist` makes the board
  list the sole decider for unlinked writers (linked members are untouched).
  Read live per message — a toggle applies without a restart.
- A writer whom neither mechanism admits is not served: their message does
  not execute, they get one refusal line without details, and the owner (or
  the admin tier, then operator — Part C adds a designated admin) receives a
  board access-request card with the channel identity needed to admit. One
  card and one notice per sender per UTC day; every refusal is journalled
  (`channel_allowlist.access_requested`).
- Board screen «Who may write to the bots» (Settings → Channel allowlist,
  `/company/settings/channel-allowlist`, EN+RU): mode select, admitted list
  with scope and revoke/restore, add-a-person form. API
  `/api/myrmidon/channel-allowlist` (GET/POST/PATCH, board-only, audited).
- Rights on the writer, the approve/deny buttons on the card, and the
  per-message audit marking arrive in the follow-up parts of OPE-4949 (B–D).

### Board measurement instrumentation: load lanes, api-load p95, pg_stat_statements, cpu-profile (PROCS-0.3A, stage 0 of OPE-5394)

- `server/src/myrmidon/monitoring/board-load/lanes.ts` — the load lanes of the
  board as an `AsyncLocalStorage` seam: `http_route`, `heartbeat_tick`,
  `chat_reconcile`, `execution_control`, `bot_reconcile`, `run_supervision`.
  Work outside every lane is reported as `untagged` instead of being spread
  over the lanes, `laneInterval()` wraps a periodic pass in its lane without
  touching its period or `unref`-ability, and `resolveLaneMetricsSource()`
  mirrors the process-metrics source seam.
- `server/src/myrmidon/monitoring/board-load/request-load.ts` — a bounded ring
  journal of finished `/api` requests and the p50/p95/p99/max summary per
  route over a window. Percentiles are nearest-rank (the reported p95 is a
  request the board actually served), route labels collapse ids
  (`/api/issues/<uuid>/comments` → `/api/issues/:id/comments`) and keep the
  words that name the endpoint, and `boardRequestLoadMiddleware()` tags and
  journals every request on the api router.
- `server/src/myrmidon/monitoring/board-load/cpu-profile.ts` — capture of a
  `--cpu-prof`-shaped profile through the board itself: `inspector` session,
  60 s ceiling, one capture at a time (`CpuProfileBusyError`), and the last
  capture retained in memory for download. Nothing is armed until an operator
  asks for a capture, so the default behaviour of the board does not change.
- `server/src/myrmidon/monitoring/board-load/pg-stat-statements.ts` — the
  top-N statements by total time read off `pg_stat_statements`, with the three
  ways it can be missing (`extension_missing`, `extension_not_loaded`,
  `no_privilege`) answered as a report the operator can read rather than as an
  error. Installing the extension stays part B.
- `server/src/myrmidon/monitoring/board-load/routes.ts` — the operator surface
  under `/api/myrmidon/board-load/*`: `lanes`, `api-load`,
  `pg-stat-statements` (each read behind board-org access), `cpu-profile`
  status/capture/download (behind instance admin; `MYRMIDON_CPU_PROFILE_ENABLED`
  set to `false` takes the capability off the board without a deploy).
- `server/src/myrmidon/monitoring/board-load/index.ts` — the mount point:
  `boardLoadApp(db)` next to the other myrmidon routers, plus the request-lane
  middleware in front of everything the api router serves.
- `server/src/myrmidon/monitoring/metrics/metrics.ts` — the exposition gains
  `myrmidon_board_db_queries_total{lane}` and
  `myrmidon_board_lane_busy_seconds_total{lane}`, read through the same
  guarded scrape as the process families (a throwing lane read zeroes the
  families and names them in `scrape_errors` instead of failing the scrape).
- `packages/db/src/query-observer.ts` — `createDb({ onQuery })`, which reports
  each issued statement to the caller's lane. Statements issued inside
  `db.transaction(...)` do not pass through it (documented limitation).
- Wiring: the heartbeat tick, the chat-reconcile fallback, the
  execution-control sweep and the bot reconciliation timer run in their lanes;
  the run-event write is `run_supervision` when nobody else owns the context.
- Tests: `lanes.myrmidon.test.ts`, `request-load.myrmidon.test.ts`,
  `routes.myrmidon.test.ts` and two cases in `exposition.myrmidon.test.ts`;
  `selfcheck.myrmidon.test.ts` counts the seven board-process families.

### Project token quotas: limits, usage counters, enqueue-time refusal (QUOTA-V2, OPE-6877)

- `packages/db/src/schema/project_token_quotas.ts` — the `project_token_quotas`
  table: one row per project (company scoped) with `daily_token_limit` /
  `weekly_token_limit` (null = that window is unlimited), the running
  `daily_tokens_used` / `weekly_tokens_used` counters, and the
  `daily_window_start` / `weekly_window_start` stamps that say which window
  each counter belongs to. Migration `0312_project_token_quotas` (additive:
  one table, two indexes).
- `packages/shared/src/myrmidon-project-token-quota.ts` — the shared contract:
  `projectTokenQuotaSchema` (PUT body: both limits at once, null = unlimited),
  `ProjectTokenQuota`, `ProjectTokenQuotaBlock`, the stable
  `PROJECT_TOKEN_QUOTA_EXCEEDED` code, and
  `projectTokenQuotaRejectionMessage()` — the code first, then a readable
  sentence (project, window kind, used-of-limit, when it resets).
- `server/src/myrmidon/project-token-quota/service.ts` — read/upsert/status
  (upsert validates weekly >= daily, rejects lower), the enqueue check
  `getProjectTokenQuotaBlock()` (no row / null limits = pass; daily checked
  before weekly; a counter from a previous window reads as zero), and the
  cost-event hook `recordProjectTokenUsage()` that folds run tokens into the
  counters and rolls the window columns over.
- `server/src/myrmidon/project-token-quota/routes.ts` —
  `GET /api/myrmidon/companies/:companyId/projects/:projectId/token-quota`
  (any company member: quota + live counters) and `PUT` (instance admin,
  validated body).
- Enqueue gate: the heartbeat run-enqueue path checks the quota after the
  budget gate; an over-limit project refuses the run with 409 +
  `PROJECT_TOKEN_QUOTA_EXCEEDED`, a skipped-request event
  (`project.token_quota_exceeded`) and the readable reason. Usage is recorded
  when the run's cost event is attributed to a project.
- Windows: daily = the UTC day, weekly = the ISO week (Monday 00:00 UTC) —
  the same anchors the heartbeat daily cap uses.
- Tests: `project-token-quota.myrmidon.test.ts` (windows, token arithmetic,
  body validation, enqueue-check decisions incl. window rollover, usage-hook
  set, refusal message) — no database, per the `*.myrmidon.test.ts` style.

### CONNECTORS S1: the channel connector contract, registry and hub (1.6.6)

- New `server/src/myrmidon/channel-connectors/` module. `contract.ts` fixes what
  one channel connector is — lifecycle (`start`/`stop`/`status`), links
  (`conversationKey`/`conversationUrl`/`route`/`bind`), inbound
  (`normalize`/`admit`/`intakeMedia`), outbound (`plan`/`send`), the media
  limits and settings (`keys`/`resolve`) — and it reaches the data only through
  one seam (`ChannelConnectorStore`), so no connector writes SQL of its own and
  every method takes an explicit context instead of module state.
- `registry.ts` — `registerChannelConnector(provider, factory)` and
  `getChannelConnector(provider, deps)`. A provider with no connector answers
  `null` and stays on the vendor path.
- `hub.ts` — `myrmidonChannelConnectorHub(db, deps)` routes inbound, outbound,
  lifecycle and settings by `endpoint.provider`. An unregistered provider, an
  unreadable endpoint and a connector that throws all pass through without
  decisions (fail-open, journaled).
- Default behaviour is unchanged: no connector is registered and no vendor file
  is touched, so the running board sends and receives exactly as before. The
  watchdog tests cover the contract structure, the registry and the hub
  routing.

### 1.6.6 SETTINGS-UI B: the bot-disk lifecycle screen, the agent daily caps (OPE-6258)

- Settings → instance now edits the whole `general.botDisk` object: alongside the
  cache/runtime fields the panel gained the lifecycle section — the sweep switch,
  the draft TTL, the mirror refresh interval, the shared-cache roles and the five
  workspace-lifecycle numbers (closing grace, scratch TTL, the three partition
  percents). Before this part a PATCH of any key silently dropped those five from
  the stored object; they now validate, merge and audit like the rest, and GET
  reports the value in force per key. New read routes power the screen:
  `GET /api/myrmidon/bot-disk/physical` (relays the dockergate C5 disk answer —
  partition, per-bot quota/used, no gate configured is a 200 with "no data",
  never an error) and `GET /api/myrmidon/bot-disk/reports` (the stored C4 per-bot
  reports with the board's receive time); `POST /api/myrmidon/bots/me/disk-report`
  (contract C4, implemented in 1.6.5 but never mounted) is mounted now.
- The agent card's Run Policy section gained the fields the heartbeat engine has
  always read: Max runs per day (`runtimeConfig.heartbeat.maxDailyRuns`), Max
  daily cost in cents (`maxDailyCostCents`) and the Skip-timer-when-no-actionable-work
  switch (`skipTimerWhenNoActionableWork`). 0 or empty in the cap fields means
  "no limit" — stored as `null`, never as `0` (a stored 0 blocks every run).
- Input limits: verified covered, no new UI — the prompt input budget is the
  model's `maxInputTokens` window with the warn/crit percents already editable
  in PromptBudgetSettingsPanel (1.6.3 PROMPT-BUDGET B); no env-only input-limit
  knob exists in `server/src/myrmidon/prompt-budget`.

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

- The instance backup-retention policy grows an optional `keepLastOnly` flag
  (`instance_settings.general.backupRetention.keepLastOnly`, default off).
  When it is on, a database backup run ignores the daily/weekly/monthly tier
  presets: after the new `<prefix>-<timestamp>.sql.gz` dump is written, it is
  stream-verified (full gunzip pass plus a check that the decompressed tail
  carries a dump completion marker — the closing `COMMIT;` of the JavaScript
  logical dump or the `-- PostgreSQL database dump complete` trailer that
  `pg_dump --format=plain` ends with — OPE-4832) and only then every previous
  `<prefix>-*` backup file in the backup directory is deleted. Verification
  never materializes the dump — it holds a 64 KiB tail buffer, so multi-GB
  backups verify in streaming mode.
- A new dump that fails verification is deleted on the spot, all previous
  backups are kept untouched, and the run reports a failure with the reason —
  the mode can never trade a good old backup for a bad new one.
- Both backup engines honor the mode: the pg_dump path and the JavaScript
  logical-dump path verify and prune identically. A verification failure is
  never retried on the other engine (it is reported as `BackupVerificationError`
  and fails the run loudly); a JavaScript fallback after a genuine pg_dump
  child failure opens a fresh dump writer instead of emitting into the
  aborted one (OPE-4832).
- Independent of the mode, the pruning pass now first removes orphaned
  unfinished plain `.sql` files older than one hour — leftovers of interrupted
  runs (a dump is written as `.sql`, then gzipped; a crash strands the
  `.sql`). The live run's own in-progress `.sql` is never touched (the cutoff
  is strictly older than one hour and the writer keeps its mtime fresh), and
  removed orphans count into the run's `prunedCount`.
- The setting is additive: settings payloads written before 1.6.5 parse
  unchanged, and an absent flag keeps the previous tiered behavior. The UI
  toggle ships separately (part B); the server contract is
  `{"backupRetention": {"dailyDays": 3, "weeklyWeeks": 1, "monthlyMonths": 1, "keepLastOnly": true}}`
  on `PATCH /api/instance/settings/general`.

### Container bot cards are complete, and the image rollout names every bot (1.6.4-BOT-CONTAINER-CARD)

- Migration `0299_bot_container_card_complete`: every agent whose card has an
  `adapterConfig.container` block gets `enabled: true` when it is absent and the
  product defaults for any missing limit (`memoryMb` 2048, `cpus` 1, `pidsLimit`
  512 — the card form's defaults; one set for every bot image family). Values
  already on the card win, including `enabled: false`. Before it, such cards were
  refused at apply (`container.enabled is not true`, then `container.memoryMb must
  be a positive number`) and skipped by the release bot-image rollout.
- Saving a `hermes_gateway` card with a `container` block that has no `enabled`,
  or is enabled without positive `memoryMb`/`cpus`/`pidsLimit`, is refused with
  422 and a message naming the missing fields and the defaults. In the card the
  Container section shows the fields of such a legacy block and says what is
  missing; turning it on fills the limits.
- The bot-container status API (`GET /api/myrmidon/agents/:id/bot-container/status`)
  carries `imageTracking`: `tracks_release`, `pinned` (with the pinned image) or
  `not_applicable` (with the reason); the card shows it. The bot-image rollout
  (`bot-image-rollout.sh`) reports every container bot in one of these categories:
  it logs and journals each pinned and not applicable bot, prints the count of
  each, and writes `pinnedBots` / `notApplicableBots` and `notApplicable` into its
  summary. Its card PATCH now sends the whole `container` block with the new image
  (the board merges `adapterConfig` one level deep, so an image-only patch dropped
  `enabled` and the limits).
- Clone-hygiene reports are collected per bot: the sweep takes the bots from the
  agent cards and asks the runtime about each by name (inspect, then the report
  read). The earlier container listing (`GET /containers/json`) is on dockergate's
  closed list and answered 403 on every sweep, so no report was ever collected. The
  driver's `list` now takes the bot keys.
- dockergate gets one narrow read-only route, A13: `GET .../myrmidon-bot-<K>/archive?path=<clone-hygiene report>`
  (one fixed file of the main container, like the applied-state marker A3); the
  report read was refused too. No other route changed.
- Contract test board <-> dockergate: every Docker API path in the board driver's
  request sites must be allowed by the route table
  (`tools/dockergate/contract/allowed-routes.json`, kept equal to the Go
  route parser by a Go test); it fails on a container listing.

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

### Selectable disk isolation scope for bots (BOT-DISK-F)

- Each bot keeps its own disk by default, exactly as before. The owner can now set a **scope
  instance** (an explicit named group, a caste, a reporting subtree, a project, an installed
  catalog team, or the whole company) to **shared root**: its members use one host directory
  with **one pnpm store** and a subdirectory per bot, so hard links work within a bot and across
  the bots of the instance, and a package is stored once for all of them. Different instances never
  share a directory. The most specific level wins: the agent's own override, group, caste,
  subtree, project, catalog team, company; an instance set to *isolated* stops the search.
- **Groups** are a first-class entity: create, rename, delete and change members in Instance
  settings, "Disk isolation of bots" (and through `/api/myrmidon/companies/:id/bot-scopes`), with no
  restart. An agent may be in several groups but only one may define its scope; an agent in several
  groups (or projects) that each define one is flagged and the owner must choose which decides.
  The resolver is one shared module other policies (the container scope, later) can reuse.
- A change marks the affected bots **restart required**; nothing restarts by itself. *Apply* runs,
  per bot, in order: pause (maintenance window), check the move (refuses on any conflict before
  anything stops; never deletes or merges), build the replacement while the old one still runs (a
  gate refusal changes nothing), stop, move the three directories by `rename`, swap in the new
  container, start-time hard-link self-check, resume. Not run on any host by this change.
- Container: a member has one bind, `<shared root>/<instance>:/bot-scope`, and a tmpfs over `/data`
  with links into its own `<botKey>/` subdirectory, made by the entrypoint from
  `MYRMIDON_BOT_SCOPE_SUBDIR`; the profile points pnpm at `/bot-scope/.pnpm-store`. Image: new label
  `myrmidon.bot-runtime.scope=1`, `WORKDIR /` (the entrypoint enters `/workspace`), `/bot-scope`
  write-safe. Rebuild the bot image before the first shared bot.
- dockergate accepts the shared bind only for a bot enrolled for that instance
  (`bots[].scopeInstances`, new `scopeRoot`), and only the instance's own directory; the gate
  checks the instance tree like a volume root. Deploy the gate and the board together and enrol
  the bots **before** applying a scope change. See [bot-disk-cache.md](../bot-disk-cache.md) and
  [dockergate.md](../dockergate.md).
- **Trade-off:** members of one instance run as one uid and mount the whole instance directory,
  so each can read and write the others' `hermes/` (keys included), `workspace` and `scratch`.
  Share only between bots that trust each other.
- DB: tables `myrmidon_scope_groups`, `myrmidon_scope_group_members`, `myrmidon_scope_settings`,
  `myrmidon_scope_agent_prefs` (migration 0300).

### The driver normalizes the bot root's traversal at apply; a blocked /bot fails with its own error (BOT-ROOT-TRAVERSE)

- After the single-mount rollout (myrmidon #572, rc.1) a bot mounts its whole
  host directory `<volumeRoot>/<botKey>` at `/bot`, but the prepare helper only
  ever chmod'd/chown'd the three subdirectories behind it. A root left by an
  external operation as `root:65532 0710` (51 of 74 production bots — no code
  in this repository sets 0710; it predates the deploy scripts now in the
  private deploy repo) hides everything under `/bot` from the bot's uid 10001,
  and the entrypoint surfaced that as a misleading "API_SERVER_KEY is required".
  Production was hand-fixed to 0711 on 05.10; this is the product fix.
- `server/src/myrmidon/bot-containers/docker-driver.ts` +
  `template.ts` (mirrored byte-for-byte in
  `tools/dockergate/internal/policy/scripts.go` and the contract fixtures):
  the prepare helper now also binds the bot's root itself (the same
  `<volumeRoot>/<botKey>:/bot` bind string the bot container carries) and its
  script ends with one non-recursive `chmod 0711 bot` — the bot's uid can enter
  `/bot` (x) without browsing it (no r), the owner stays root (the gate's
  volume.K invariant), the content is never listed, written or chowned, and the
  text stays a constant with no recursion, find, glob or links (RT1-2).
  Idempotent: any external 0710/0700 stops being fatal at the next apply.
  The shared-scope layout needs no extra line: its tree root IS the instance
  directory the script already chmods 0700 and chowns to uid 10001.
- `tools/dockergate/internal/policy/create.go`: the isolated prepare helper
  accepts exactly the four binds (three narrow + the `/bot` root); everything
  else stays a `binds_mismatch` denial. `volume.go` documents why the gate
  deliberately does not require bot traversal of `volumeRoot/K`: the incident
  mode 0710 must pass the gate so that the prepare helper can reach and fix it.
- `docker/bot-runtime/entrypoint.sh`: when the isolated bot root exists but is
  not executable by the bot's uid, it fails in one line naming the traversal
  problem and the fix (recreate the bot) instead of falling through to the
  API-key error. Tests: `scripts/myrmidon/bot-containers/prepare-root-traverse.test.mjs`,
  `scripts/myrmidon/bot-runtime/entrypoint.test.mjs`, driver/scope/gate unit tests.

### Auxiliary calls of a bot have a cheap ceiling, never a paid fallback (1.6.5 BOT-RUNTIME-TUNING-AUX-CEILING)

- Profile cards now have a company-level fallback ceiling for auxiliary calls:
  `MYRMIDON_BOT_AUX_FALLBACK_MODELS` (a list of gateway model aliases, instance
  setting). The profile compiler writes it as
  `auxiliary.title_generation.fallback_chain` and
  `auxiliary.compression.fallback_chain` in the bot's `hermes/config.yaml`.
- Hermes walks an auxiliary task's `fallback_chain` before the main chain — the
  card's `models.fallbacks` and then the gateway's own LiteLLM ladder — so an
  auxiliary call whose own model refuses the request is served by another model
  of the same cheap class instead of climbing into a paid model. This is the
  fact of 02.10: the session title generator (`auxiliary.title_generation`) ran
  on the main provider with `response_format: json_schema`; the model rejected
  the schema, and the LiteLLM fallback chain served the title from a paid model.
- The entry route is resolved per profile: the card's own provider when it names
  one, otherwise the instance gateway endpoint with `base_url` and `key_env`
  spelled out (Hermes resolves a fallback entry on its own and inherits neither
  from the task's `model`). An entry that repeats the task's own model is
  dropped — it is not a fallback — and when no route can be resolved the chain
  is dropped with a compile warning while the auxiliary model itself is still
  written. The ceiling never covers `auxiliary.vision`: those entries must be
  vision-capable models, a class the list cannot vouch for.
- Dropping `response_format: json_schema` where a model does not implement it
  needs no Myrmidon change: Hermes keeps a per-route memo of rejected
  structured-output types (plus the provider profiles' declared unsupported
  formats) and drops the field before the first request, and the title
  generator falls back from strict JSON to a loose scan and then to first-line
  prose. What was missing was the routing: an auxiliary call now has its own
  cheap ceiling instead of the main chain.
- Example — a bot whose card pins no models, company defaults
  `MYRMIDON_BOT_AUX_TITLE_MODEL=myr-cheap-chat`,
  `MYRMIDON_BOT_AUX_FALLBACK_MODELS=myr-cheap-chat,myr-cheap-long`,
  `MYRMIDON_BOT_LLM_BASE_URL=https://llm.example.com/v1`,
  `MYRMIDON_BOT_LLM_API_KEY_ENV=MYRMIDON_BOT_LLM_API_KEY`:

  ```yaml
  auxiliary:
    title_generation:
      fallback_chain:
      - base_url: "https://llm.example.com/v1"
        key_env: "MYRMIDON_BOT_LLM_API_KEY"
        model: "myr-cheap-long"
        provider: "custom"
      model: "myr-cheap-chat"
  ```

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

- The thresholds of the model fallback signal are now instance settings, not
  deployment values read once at startup: `GET`/`PATCH
  /api/myrmidon/model-fallback/settings` read and write
  `instance_settings.general.modelFallbackSignal` (board reads, instance-admin
  writes), and every key of the answer carries its origin — `settings`, `env`
  or `default`. The sweep re-resolves the row on every tick and schedules the
  next pass with the interval it returns, so an operator changes N%, the
  window, the minimum call count or the sweep period and the next pass obeys,
  without a restart of the board. The `MYRMIDON_MODEL_FALLBACK_*` variables
  keep working as per-key overrides.
- The signal is now visible on the agent's own card, not only in the attention
  feed. `GET /api/myrmidon/companies/:companyId/model-fallback/status` returns
  the last sweep's rows — per agent: attributed calls, fallbacks, share, the
  models that actually served, and whether the agent is above the threshold —
  together with the effective numbers; the agents list renders a
  `fallback N%` badge on an agent that is above the threshold and nothing at
  all for a healthy bot.
- With the switch off the sweep does no gateway request at all: the loop stays
  armed, reads one settings row per interval and clears both registries, so a
  card or a badge from an earlier window cannot linger after the signal is
  switched off, and turning it back on takes effect within one interval.
- Nothing was duplicated from the 1.6.1 delivery of this signal (module
  `server/src/myrmidon/litellm-fallback-signal/`, attention kind
  `model_fallback_alert`): this change adds the settings and the per-agent
  status on top of it, and the existing policy tests stay green.

### One mount per bot container, hard-linked node_modules (BOT-DISK-D)

- A bot container now has **one** bind for its writable data: `<volume root>/<bot key>`
  at `/bot`, with `hermes/`, `workspace/` and `scratch/` inside it. `/data/hermes`,
  `/workspace` and `/scratch` are links the image makes into it. link(2) cannot cross a
  mount point even on one ext4 filesystem, so with three separate binds (and the pnpm
  store on a fourth) every `pnpm install` silently copied each package into each clone
  and a bot's disk grew by about 5 GB per hour. The host layout is unchanged; helper
  containers keep their three narrow binds; dockergate accepts the single-bind bot body
  (deploy dockergate and the board together, as in ONE-DEPLOY).
- The pnpm store lives inside that mount (`/workspace/.pnpm-store` by default) and pnpm
  runs with `package-import-method=hardlink`. Note: pnpm 9 still copies silently when the
  kernel refuses a link, whatever the method, so the guard is the start-time self-check
  below, not pnpm. `/cache/pnpm` stays a download (metadata) cache only. Settings
  `general.botDisk.pnpmStoreDir` and `pnpmImportMethod` replace `pnpmStore`
  (`workspace`/`shared`); they apply on the next reconcile pass without a restart
  (Instance → General).
- Every container start checks that a hard link from the store into `/data/hermes`,
  `/workspace` and `/scratch` works; a failure is logged and shown on the board as an
  attention card (source `bot_disk_lifecycle`) via the clone-hygiene report. The image
  build checks all three roots, and the repository test runs the same script.
- Migration of running bots (pause, recreate with the new mount, verify, resume) is in
  [bot-disk-cache.md](../bot-disk-cache.md#migrating-running-bots-to-the-single-mount).
  Removed: the former `pnpmStore` key (a stored value is ignored) and its `shared` mode.

### The bot runtime entrypoint sets umask 077: run files are born owner-only (BOT-UMASK)

- `docker/bot-runtime/entrypoint.sh` sets `umask 077` right after its `set
  -euo pipefail` prologue, before the first mkdir/write of the bot tree, and
  logs one line (`[bot-runtime] umask 077 (run files owner-only)`). The umask
  is inherited by every child of the entrypoint (gateway → session →
  terminal/tool processes), so every file a run creates — scratch dumps,
  cache, tmp helpers written by plain shell redirection — is born `0600`
  (directories `0700`) without any cooperation from the workload.
- Why: every bot on a host runs as uid `10001`; the mode bits are the only
  barrier between one run's scratch/cache and another bot's processes, and
  the default umask 022 made run artifacts world-readable inside the shared
  uid. There is no `UMASK` environment variable and no pam-umask (no login
  session), so the entrypoint is the only point that covers all children.
- Tested in `scripts/myrmidon/bot-runtime/entrypoint.test.mjs`
  (`docker/bot-runtime/entrypoint.sh umask 077` describe): a static ordering
  check that the umask line precedes the first file write, and a behavioural
  probe that exec's a stub hermes recording its inherited umask — `0077`,
  with a file born `0600` and a directory `0700`. The probe is red on the
  base revision and green with the fix.

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

### Review-wait cancellations no longer create execution holds (CONTINUATION-WAIT-HOLD)

- A legacy continuation cancelled while waiting for reviewer feedback or an
  unresolved response no longer creates `legacy_execution_requires_reconciliation`.
- The task therefore remains eligible for the normal idle-pickup path instead of
  requiring an operator to clear a hold for a provider that never started.

### The knowledge corpus has a screen (1.6.6 CORPUS, part E — web)

- Company Settings has a new **Knowledge corpus** section
  (`/company/settings/corpus`): the module switch, the settings of the module
  (address of the document-parsing service, embedder model, upload, document and
  chunk limits) and the datasets with their documents and a trial search.
- The settings are written back as one object, so fields the screen does not
  edit survive a save. The whole object is read back after a save instead of
  being assumed.
- Datasets can be created and deleted; each dataset lists its documents with the
  parse status (`queued` / `parsing` / `embedding` / `ready` / `failed`). While a
  document is still moving the list refreshes itself, so `ready` appears without
  a page reload. A file can be uploaded, a `failed` document retried and any
  document deleted.
- Trial search runs a query over the open dataset and shows the top-k chunks with
  their score and the document they came from.
- With the module switched off the screen says so and offers no parsing,
  embedding or search; a server that does not serve the corpus routes at all
  shows the screen as unavailable.

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

### Deploy hardening: a deploy that fails early and says why (DEPLOY-HARDENING)

- **One source of truth per component image.** The generated override file of each local
  release component is what the deploy writes, the rollback restores and the boot unit reads
  (the canonical unit lists the component overrides; `SYSTEMD_UNIT_INSTALL=1` replaces the unit
  of the previous release, a foreign unit is still refused). The "previous" image is the image of
  the running container (`docker inspect`), not a file; a stale override is corrected to the image
  that runs before the deploy starts. The compose project of every component check includes the
  board image override, so a valid project is no longer reported as "not a service", and an
  invalid one is reported with compose's own error text.
- **`--dry-run` runs the real preflight.** Before the first pull and the dump, in a dry run and a
  real run alike: the compose project, the CI image checks, the boot unit, every component's service
  and health setting, the dockergate config check of the edited config (by the new binary, as its
  own user, on a copy keeping the file's owner and mode). The dry run fails
  exactly when the real run would.
- **dockergate health without a ping the host cannot make.** dockergate's socket answers only the
  board's main process, so the documented `_ping` probe from the host could never pass. dockergate is
  now proven by its log: the container runs and its newest `self-check ok` / `config_reloaded` line
  reports the new version and the hash of its config. dockergate logs `configHash` on both lines.
  `MYR_DOCKERGATE_HEALTH_URL` is no longer used. The rollback uses the same proof.
- **Config writes keep owner and mode, and a reload is verified.** Edits of the dockergate config,
  the fleetd config and the override files keep the owner and mode of the file they replace (a strict
  `umask` no longer turns the config into `0600 root`, which dockergate's user could not read); after
  SIGHUP the deploy checks that dockergate loaded the new config hash and fails loudly otherwise.
  The output of `dockergate check-config` is logged when it refuses.

### PREDEPLOY-DB-CHECK: the board image is proven on a copy of the production database before the window; the components roll out before the board; rollback without a live board

- `scripts/myrmidon/deploy/predeploy-board-check.sh` (new) — before the
  maintenance window the predeploy dump is restored into a throwaway Postgres
  and the new board image is started next to the NEW dockergate of the same
  release, on its own docker network (no bot container, no production
  dockergate). The check waits for `/api/health` `status: ok` with the version
  and commit of the image and then walks the attention list and the main company
  routes; any failure stops the deploy BEFORE the window with nothing on
  production changed. The 05.10 incident it exists for: the 1.6.3 board started
  fine against the empty CI database and crashed on production DATA (an
  attention card whose key was not a uuid) inside the window.
- `scripts/myrmidon/deploy/deploy.sh` — step 3b runs that check before the
  deploy window marker; the changed release COMPONENTS now roll out inside the
  window BEFORE the board is switched (DOCKERGATE-FIRST), so the board is
  verified against the new dockergate and not the running one (the 1.6.3 board
  never became `ok` against the old dockergate: `route_not_allowed`, and
  dockergate rolled out only after the board check); the all-or-nothing rollback
  rolls the board back only when its image line was actually written.
- `scripts/myrmidon/deploy/rollback.sh` — ROLLBACK-WITHOUT-BOARD: entering and
  leaving maintenance no longer requires the board API to answer. A rollback
  usually runs BECAUSE the board is down; a failed enter/exit is logged loudly
  and the rollback continues, the image switch and the health check still decide.
- `scripts/myrmidon/deploy/lib.sh` — `maintenance_enter` reports an enter that
  did not happen (api: the POST did not answer; hook: the command failed)
  instead of logging `entered` over a failed POST.
- `scripts/myrmidon/deploy/deploy.env.example` — the new `MYRMIDON_PREDEPLOY_*`
  settings; the check is on by default.
- Tests: `scripts/myrmidon/deploy/predeploy-board-check.test.mjs` (new) walks
  the whole throwaway stack against fake `docker`/`curl`; the deploy,
  release-gate, bot-image-rollout, deploy-from-job and tracing harnesses grew
  the pre-window check, the component-before-board order, the board-less
  rollback and the copy-teardown cases.

### The board no longer storms dockergate; a fleet rollout fits the gate's limit (1.6.5-DOCKERGATE-A2A3-STORM)

- On 05.10 (1.6.5-rc.1) the board sent 5 395 allowed A2/A3 requests to
  dockergate in three minutes (~30/s against the gate's global bucket of 50/s,
  plus 394 `rate_limited` refusals) and a five-bot rollout batch took 6–10
  minutes with most applies failing on 429. The storm had four stacked causes,
  all fixed: the clone-hygiene report collector ran on the maintenance tick
  (5 s by design, `MYRMIDON_MAINTENANCE_TICK_SEC`) and asked every bot every
  tick (inspect + marker read, 74 bots ≈ 30 req/s); the reconcile pass asked
  each bot twice (`status` inspect, then `templateDrift`'s second inspect);
  the post-apply health wait polled every second; and a 429 simply failed the
  pass, only to be hammered again on the next tick.
- The collector moved onto its own timer (`MYRMIDON_CLONE_REPORT_INTERVAL_SEC`,
  default 300 s — a report is valid for 24 h) and reads each bot under the
  per-bot lock, so a report read and a rollout of the same bot never run side
  by side. The reconcile pass now probes status and template drift from a
  single inspect (`statusWithDrift`): 2 gate requests per bot per pass instead
  of 3, which puts the planned 74-bot sweep at ~2.5 req/s. The health wait
  polls every 5 s (was 1 s) within the same timeout. The dockergate client
  gained a token bucket (`MYRMIDON_DOCKERGATE_MAX_RPS`, default 20/s across all
  loops) and a 429 retry: exponential backoff with full jitter, a server
  `Retry-After` honoured when present, up to 5 retries before the pass reports
  the refusal as before.
- Meter (new test `server/src/myrmidon/bot-containers/dockergate-a2a3-storm.myrmidon.test.ts`,
  a counting fake gate): requests per bot per sweep pass 3 → 2; inspects in a
  30 s health wait 31 → ≤8; the collector 29.6 req/s → 0.5 req/s at default
  settings; a full 74-bot rollout fits its request budget into under 2 minutes
  of paced traffic at 20 req/s with the retry budget absorbed client-side, so
  the gate's own buckets see less than half their rate.

### Cross-family judge for reference-task scoring (EVALS-JUDGE-FAMILY)

- The judge of an eval run is now picked from a model **family different from the evaluated agent's** model. `server/src/myrmidon/evals/model-family.ts` maps model ids to families (qwen, gpt, claude, glm, deepseek, kimi, gemini, llama, mistral, yi, phi, o1, o3 …; the table is extensible in code). Matching is token-anchored: a substring counts only at a token boundary (`deepyida` is not yi, `chaos` is not o3, `mystique`/`dolphin` are not phi).
- A prioritized judge list (UI setting / env forced override) is scanned top-down; the first entry whose family differs from the agent model family judges the run. Default list: the free models this deployment's gateway actually serves (`qwen-plus-free, qwen-max-free, qwen-turbo-free` — `SERVED_FREE_GATEWAY_MODELS`, the same trio `DEFAULT_EVALS_MODEL` verifies); a paid model judges only when the operator explicitly lists it.
- A gateway failure of the selected judge no longer aborts the run: the next candidate is tried, and when every priority candidate fails, the configured `MYRMIDON_EVALS_MODEL` gets a last chance. The run fails only if the whole chain fails; the last error is then re-thrown.
- When no cross-family candidate exists, the run is still scored and every task carries `sameFamily: true` in the result plus a server-log warning — the owner sees that the judge rated "its own". The same flag marks tasks judged on the last-chance configured model.
- The evaluated agent model and the judging model are reported per task; the agent model is resolved at run time from the subject role (`subjectModelFor`), so no schema change is needed.
- Guides: [evals-judge-family-selection.md](../guides/evals-judge-family-selection.md) / [RU](../guides/evals-judge-family-selection.ru.md).

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

- The 1.6.5 shared store could not be accepted: on 06.10 the store on the bot
  host was empty, every clone copied the whole history and the bots' section sat
  at 95 %, yet neither the board nor the lead could see the store's state. The
  only channel that carried it (the attention feed) is board-only and answers an
  agent key with 403, and the check itself needed an `ssh` into a bot.
- The start-time self-check now records the store's actual state beside its four
  checks: `storeState` in `git-objects-check.json` — `path`, `enabled`,
  `mirrorCount`, `totalBytes` and `repos[]` (owner/repo, only directories that
  pass the wrapper's mirror test, bounded by `MYRMIDON_GIT_STORE_STATE_MAX`,
  default 200). An absent store is reported as `enabled: true, mirrorCount: 0`,
  not as a failure of the check itself.
- The same facts ride the hygiene report: the in-container reporter adds
  `gitStore` (the same field names) to the clone-hygiene report, and the board
  parses both — `clone-hygiene.ts` gained `parseGitStoreState`, the report's
  `gitStore` and the self-check's `storeState`. An older image carries none,
  which reads as `null`, never as an error.
- `GET /api/myrmidon/agents/:id/bot-container/git-store` answers the store's
  facts to a reader with an agent key — the facts, the start-time snapshot and,
  in `note`, why a field is missing (flag off, no bot key, no report yet, a
  report from an older image, an unreadable report). It reads the report file
  only: no exec into the bot. It is the one bot-container route that is not
  board-only, behind the same agent-key and company boundary as the status
  route; the board's attention feed keeps its own rules.
- Acceptance is one command on the board host:
  `scripts/myrmidon/deploy/git-objects-live-acceptance.sh --bot <container>`
  (`--list` shows the candidates). It clones a repository twice inside one live
  bot and checks the criteria from the fix's own ticket: the store is not empty
  (a mirror is there and the store is at least `--min-store-mb`, default
  100 MiB; the myrmidon store measured ~145 MB) and the second clone borrows
  from it (`.git/objects/info/alternates` names the store, `.git` at most
  `--max-clone-git-mb`, default 20 MiB, and under a quarter of the first
  clone). It prints `PASS`/`FAIL` per criterion, exits 0/1/2, and removes its
  scratch directory afterwards (`--keep` leaves it). This is the manual fallback
  for the window before the image carrying the two facts above is on the host.

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

- The wake path asks one question before it lets a task run:
  "does this task still have a terminal legacy run of a conversation adapter
  that may own a process or an environment lease?"
  (`getConversationOwnershipBlocker`, `server/src/services/conversation-continuation.ts`).
  The statement filters one company, `runtime_mode = 'legacy'`, the run's issue
  reference and four terminal statuses, then ORs two JSON evidence fields and a
  correlated `exists` over `heartbeat_run_events`, plus an `exists` over
  `environment_leases` per row. No index carried the issue reference together
  with the terminal-legacy filter, so the planner read the whole runs table and
  ran the `exists` predicates per row.
- Migration `packages/db/src/migrations/0301_heartbeat_run_ownership_index.sql`
  adds one partial index on
  `heartbeat_runs (company_id, coalesce(native_issue_id::text, context_snapshot->>'issueId'), created_at DESC, id DESC)`
  where `runtime_mode = 'legacy' and status in ('failed','timed_out','interrupted','cancelled')`.
- That index makes the equality selective and the statement's `ORDER BY` free,
  so the OR over the JSON evidence and the correlated `exists` predicates are
  evaluated on the matched rows only. No query, no schema and no behaviour
  change.
- The evidence branch of the OR keeps the existing
  `heartbeat_run_events (company_id, run_id)` index. A third `event_type` column
  would mean a `CREATE INDEX` on the run log — a known-large, append-heavy table
  — inside a migration transaction, which holds `ACCESS EXCLUSIVE` for the whole
  build; if that refinement is ever wanted, apply it by hand with
  `CREATE INDEX CONCURRENTLY`.
- Guard: `packages/db/src/heartbeat-run-ownership-index.myrmidon.test.ts` seeds a
  runs table, measures the probe with and without the index and fails if the
  probe sequential-scans `heartbeat_runs` again.

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

- hermes_gateway adapter now reconciles Paperclip-managed skills before POST
  /v1/runs: the run carries its desired skills in the paperclip_skills body
  field, the gateway materializes them into the agent profile's
  skills/paperclip-managed segment before the model starts, and the run fails
  with "Cannot start without the required Paperclip-managed skills" unless
  every desired entry is verified on the gateway side. Previously gateway
  agents silently ran without any company skills.

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

- A review verdict that returns a pull request used to hang: no rework task
  appeared, the review stayed in `todo`, and the reviewer was woken every
  10–30 minutes on an unchanged lane (OPE-4417 waited 7 hours on PR #484 like
  this; OPE-4360 kept a todo card on an already-merged PR). Now a sweeper
  (every 60 s, per company) reads the verdict — a `VERDICT …#<N>: RETURN`
  marker on the review task, or the PR's aggregate GitHub `CHANGES_REQUESTED`
  decision, the newest word wins — and:
  1. opens a rework task (a child of the review, linked to the verdict's
     comment and head sha) with the executor chosen down the ladder: the
     review's return assignee (the PR's author) → the assignee of the task the
     PR delivers → the instance fallback setting → nobody, which leaves the
     task in the role queue for SWARM-CLAIM; the executor is woken;
  2. moves the review task to `blocked` pointing at the rework, so the
     reviewer stops being woken while the work is out;
  3. when the PR head moves past the recorded baseline, lifts the block back
     to `todo`, records a `HEAD-ACK <pr>: <sha>` line (which retires the
     verdict signal) and wakes the reviewer with the new head;
  4. closes the review (`done`) when every linked PR is merged or closed, and
     reopens the same rework task — never a duplicate — when a newer RETURN
     lands on a settled one.
- Instance → General gains a "Review-return loop (REVIEW-REWORK)" section: the
  master switch and the fallback executor, `GET`/`PATCH
  /api/myrmidon/review-rework`, stored in `instance_settings.general.reviewRework`
  with a change journal; the sweep re-reads the row every pass, so a change
  applies without a restart. Off restores the old behaviour exactly.
- An unresolvable PR (no token, GitHub outage) moves nothing: the loop never
  invents a merge, a head move, or a verdict.

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

- A run whose execution target is local or SSH — the development agents on the
  build machine, and the bots whose container `fleetd` starts on a second
  machine — had no GitHub credential path of its own: the launcher that the
  board stages for such a run asked the broker without naming a repository, so a
  run whose only identity is a self-hosted GitHub App never received a token,
  and the agents kept pushing with a static token from their environment.
- The launcher now stages `git-credential-paperclip` next to its `git` and `gh`
  and gives Git the same configuration the bot image installs in
  `/etc/gitconfig`: the leading empty `credential.helper`, ours scoped to
  github.com over https, and `useHttpPath = true`. git then hands the helper the
  repository path of the operation and the helper asks the broker for exactly
  that `owner/repo`; the `gh` wrapper names the repository from `-R`/`--repo`,
  `GH_REPO` or the `origin` remote, and a `git` command names the remote written
  into its arguments or the `origin` remote of its working directory.
- An operation that names no usable repository, or one no App serves, stays
  without managed credentials: git and `gh` keep working exactly as before.
  Only the token, the terminal-prompt switch and the commit identity are taken
  from the broker's answer, so a broker-supplied credential helper can never
  replace the staged one. No token, static or minted, is written to a file.
- After the agents of the second list are moved over, their static GitHub tokens
  (`env.GITHUB_TOKEN`, `~/.git-credentials`) are removed, so one path serves
  every development agent.

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

### Gateway run reattach is lease-guarded and periodic (T1.6)

- A board process no longer steals gateway runs that belong to a live
  controller. The reattach sweep (startup and the new 30-second periodic
  pass) only claims runs whose legacy controller lease is absent or expired;
  a live lease under another boot id is reported as skipped and left to its
  owner. This removes the "Legacy controller lease lost" abort when a second
  board process starts alongside a running one.
- A graceful hot restart still adopts its predecessor's runs immediately:
  the departing process records its controller boot id in the restart-intent
  shutdown snapshot, and the successor's startup pass marks it adoptable, so
  no run is waited out or duplicated.
- When an executor process dies, its gateway runs are reattached on a live
  process by the periodic pass once the lease expires — before the orphan
  reaper's stale window finalizes them as "Process lost".
- Single-process boards keep the previous behavior: startup reattach runs
  exactly as before, plus the same sweep now also ticks periodically.

### Review-return loop: a work product without a repo no longer fails the pass (REVIEW-REWORK)

- A `pull_request` work product whose metadata has no `repo` (an older record
  that carries only a number or a URL) used to crash the sweep with
  `TypeError: Cannot read properties of undefined (reading 'toLowerCase')`
  while the PR coordinates were being collected, so the whole task failed
  every pass. Now the loop reads the repo from the work product's
  pull-request URL when the metadata has none, and silently skips the entry
  when neither the metadata nor the URL yields coordinates — one bad record
  never fails the task's pass again.

### 1.6.5 STACK-UPDATES: optional GitHub token for the stack release check (OPE-5564)

- `MYRMIDON_STACK_GITHUB_TOKEN` (secret class): an optional read-only GitHub
  token (fine-grained PAT with public-repo read, no scopes needed) for the
  scheduled and manual stack release check. When set, every api.github.com
  request of the check (release/tag lists and the compare API — one shared
  JSON port) carries `authorization: Bearer <token>`.
- Anonymous behaviour is the default: unset or blank env → no authorization
  header, the 60 requests/hour per egress IP budget. A valid token lifts the
  budget to 5000 requests/hour.
- An invalid or revoked token is ordinary data: GitHub answers 401/403 and the
  status is recorded per component as an HTTP error, the previous cache is
  kept — exactly like any other HTTP status. The value is never logged and
  never returned by any route.

### Fleet dashboard data from VictoriaMetrics + Zabbix (1.6.6 MONITORING C)

- `GET /api/myrmidon/monitoring/dashboard` aggregates one fleet snapshot:
  host cards (CPU / memory / swap / disk percent) from VictoriaMetrics
  (node_exporter PromQL, VM wins per host) merged with Zabbix `host.get` /
  `item.get` readings, bot container usage (cAdvisor), the LiteLLM proxy
  rollup and the build-VPS rollup; every host card carries a `runbookKey`
  for the "create task with runbook" CTA of the fleet screen.
- Connection settings live under `GET/PATCH /api/myrmidon/monitoring`
  (instance-settings pattern): VM / Zabbix addresses, `env:`/`file:` token
  references and the VM job selector. Secret values are never returned and
  never logged; both sources are read-only (instant queries, `apiinfo.version`,
  `host.get`, `item.get` — no writes).
- `GET /api/myrmidon/monitoring/dashboard/selfcheck` probes every configured
  source and answers `{ok, vm_ok, zabbix_ok, sources:[{name, ok, latency_ms}]}`
  without any secret material.

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

### Asymmetric debates engine (DEBATE-ASYM A)

- The board runs a structured disagreement about a task question between
  models of different families: a generator (constructive pole), a critic
  (adversarial pole, told it is penalized for a missed error), and a judge
  outside the dispute (a third family). The first answers are independent —
  neither debater sees the other's before the exchange starts. At most three
  rounds; the exchange stops early when the critic writes the `[AGREE]`
  marker, or when the total token ceiling is reached (a call that crosses the
  ceiling is recorded but not charged). The result — positions, the judge's
  verdict and the cost per role — lands on the task as a `debate-result`
  document, and the spend is written as task-level cost events, so the budget
  enforcement (BUDGET-CONFIG) sees it.
- The role configuration is live: `GET`/`PATCH /api/myrmidon/debate/settings`
  and Instance → General → "Asymmetric debates" (board reads, instance admin
  writes, the source of the value shown). A symmetric configuration (both
  debaters from one family, or the judge sharing a debater's family) is
  refused with the exact reason; `MYRMIDON_DEBATE_CONFIG` is the forced
  environment override only while nothing is saved.
- Start a debate for a task: `POST /api/myrmidon/companies/:companyId/debates/
  issues/:issueId/run`. The board runs it directly; an agent caller is gated
  on the `spend_above_threshold` class of the autonomy matrix (a debate
  spends gateway calls) — forbidden answers 403, approval_required answers 403
  with the approval code. Models default to free ones: qwen generator, glm
  critic, deepseek judge. The gateway contour falls back to the evals one
  (`MYRMIDON_EVALS_BASE_URL` / `MYRMIDON_EVALS_KEY_SECRET`) when the debate
  variables are unset.
- Model families come from one extensible table (the same rules
  EVALS-JUDGE-FAMILY introduced), so the cross-family check answers
  "which family is this model" identically in both contours.

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

- `scripts/myrmidon/install/install.sh` (new) — the installer of a fresh
  installation. It checks the machine against the system requirements and names
  what is missing in plain language (root, Ubuntu 24.04 / Debian 13, arch, 2 CPU,
  4 GB memory, 10 GB free disk, a free port), installs Docker and the compose
  plugin when they are absent, resolves the latest release
  (`releases/latest` or `--version myr-vX.Y.Z`) and its machine-readable
  manifest `release-components.json`, and pins the board, dockergate and bot
  images BY DIGEST — the CI-only rule the deploy scripts enforce, with no flag
  that skips it. It generates every secret (database password, session secret,
  tool-action signing secret), writes `deploy.env` (mode 0600), `compose.yml`
  and the dockergate configuration, brings up the database, the board and
  dockergate, waits for `/api/health` `status: ok` and prints the address, the
  first-administrator link and the paths of the files it wrote.
- Re-running the installer is the update path: it resolves the latest release,
  dumps the database before the image line changes, switches the digests, checks
  health and rolls back to the digests that ran before when the new board does
  not become healthy. `--uninstall` stops and removes the stack (data kept);
  `--uninstall --purge` also deletes the database volume and the install
  directory. The installer asks nothing by default (`--interactive` turns the
  three questions on) and speaks Russian or English according to the locale
  (`--lang`).
- `scripts/myrmidon/release/publish-github-release.sh` — every release now
  carries the installer as the asset `install.sh`, so
  `https://github.com/itkadr-git/myrmidon/releases/latest/download/install.sh`
  always serves the installer of the latest release. The committed file is the
  single source of truth.
- Tests: `scripts/myrmidon/install/install.test.mjs` (new) runs the real script
  against fake `docker`, `curl`, `ss`, `systemctl` and `apt-get` placed first in
  `PATH`: a fresh install pins the digests and generates the secrets, a re-run
  against a newer release dumps the database and switches the digests, an
  unhealthy new release rolls back to the previous digests, a release that
  already runs changes nothing, a foreign directory is refused, `--uninstall`
  keeps the data and `--purge` removes it, the Russian locale is honoured and a
  malformed `--version` is refused. No test touches GitHub, a registry or a
  docker daemon.

### Dockergate poll storm removed (OPE-4789, second half of OPE-4752)

The board's container layer talked to dockergate far more often than the
planned once-a-minute sweep: the clone-hygiene report collector rode the 5 s
maintenance tick (per-bot inspect + archive read per tick), the reconciler
paid two inspects per bot per pass (status and the drift check each read
their own), the drift check re-read the shared-cache/scope settings three
times per pass, the health wait after a start polled inspect once a second
while the image's own HEALTHCHECK runs every 30 s, a canary wave pass and
the sweep pass for the same bot duplicated each other, and a 429 from the
gate was a terminal error every caller retried at once. On a 74-bot fleet
this summed to ~30 requests/s against the gate's global limit and 1.5-hour
fleet rollouts with 28 refusals.

- The clone-report collector runs at most once a minute now (the reports
  feed hourly-TTL attention signals; nothing an operator can act on is
  lost) and asks the driver for running bots only, so a stopped bot's
  inspect+marker pair is not paid on every pass.
- One reconcile pass costs one inspect and one marker read: the drift check
  reuses the inspect the status read already paid for
  (`BotContainerStatus.inspect`), and the template context behind the
  create body (shared package cache path, git-mirror flag, scope layout) is
  cached per bot for 60 s instead of being re-read three times per pass.
- The health wait after a (re)start polls every 3 s, matching the image's
  own 30 s HEALTHCHECK cadence instead of polling 30× between two verdict
  changes.
- A second `applyBotContainerNow` for one bot within 30 s of a pass
  (sweep × canary wave tick) is answered from freshness instead of
  re-reading everything; the card's "Apply now" button, secret-rotation
  restarts and the canary wave itself pass `force: true` and always run a
  real pass — a rollout asks for a change by definition, so the window
  must not answer it from freshness and mark the bot done on the old
  image. A pass that
  errored never stamps, so a transient docker failure is retried on the
  next tick.
- A 429 from dockergate is retried by the call that got it — after the
  gate's `Retry-After` hint when one arrives, otherwise after a growing
  backoff (1 s, 2 s, 4 s, capped at 8 s, at most 4 attempts) — instead of
  failing the pass into an immediate caller retry.

Measured on the fake daemon (docker-driver.myrmidon.test.ts, OPE-4789
suite): an unchanged sweep pass over one bot costs 2 dockergate requests
(was 3+), a canary-overlapped pass costs the same 2 (was 6), and a burst
that hits the gate's limit resolves in place instead of multiplying.

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

### Deploy hygiene: the deploy no longer fills the disk it deploys from (OPE-5107)

On 06.10 the root filesystem of the deploy host moved from 86 % to 92 % in
the hour one deploy of rc.3 took. Three separate leaks summed to it: the
predeploy database copy kept its Postgres data in an anonymous volume that
`docker rm -f` never removes (3.4 GB left by the 05.10 check, 3.6 GB more by
rc.3, both orphaned), the component images of past releases were never
deleted (four board generations at ~7.3 GB each plus three to four bot image
generations, about 33 GB), and the deploy started pulling the new images
without checking the disk could hold them.

- PREDEPLOY-DB-CHECK: the copy's data now lives in a NAMED volume of the run
  (`myr-predeploy-dbvol-<digest8>-<pid>`), mounted into the throwaway
  Postgres and removed by the same EXIT trap that removes the containers —
  on success, on failure and on an interrupt alike.
  `MYRMIDON_PREDEPLOY_KEEP=1` keeps the volume together with the stack and
  prints its name.
- Disk precheck: before the first image pull and the database dump,
  deploy.sh (and a standalone bot-image-rollout.sh or rollout-component.sh
  run) verifies the free space of the filesystem that holds /var/lib/docker
  (`df -P`). Below MYRMIDON_DEPLOY_MIN_FREE_GB (default 15 GiB) the deploy
  stops before anything changed and names the requirement, the current
  value and the cleanup candidates (`docker system df`). 0 switches the
  check off; a dry run prints the check with the current value instead of
  refusing.
- Image retention: after a SUCCESSFUL deploy (deploy.sh after its
  post-deploy steps; bot-image-rollout.sh after the bots moved) the local
  images of the deploy's component repositories older than
  MYRMIDON_DEPLOY_IMAGE_KEEP previous releases are removed by creation date
  (default 1: the current release plus the one before it, kept for a
  rollback; 0 switches the cleanup off). The repository list is
  MYRMIDON_DEPLOY_IMAGE_REPOS (default: the board, dockergate, fleetd and
  the three bot images). An image used by ANY container, running or
  stopped, is never removed — it is skipped with a log line and does not
  eat the keep budget. A cleanup failure is a WARNING, never a failed
  deploy.

### UI copy debranded: visible "Paperclip" strings renamed to Myrmidon (DB1)

- All user-visible "Paperclip Cloud"/"Paperclip Labs"/"Paperclip EE"/"Paperclip Enterprise" strings across the web UI (pages, components, connection flows, OAuth handoff errors, placeholder examples) now read "Myrmidon …". Locales en/ru and the shared locale catalogs were swept in every language; MIT attribution lines (`about.base`, `about.attribution`) are untouched verbatim. Wire identifiers (`paperclip.*.v1` localStorage keys, adapter types, `paperclip_vault`, `X-Paperclip-*`, `@paperclipai/*`) keep their names until DEBRAND part c / stage 4.
- The branding-guard test (`ui/src/lib/myrmidon-branding-guard.myrmidon.test.ts`) tightened to a bare `\bPaperclip\b` scan: the vendor-product-word exceptions (Cloud/Labs/EE/Enterprise) are removed from its allowlist, so any new visible "Paperclip …" copy fails CI.

### Corpus knowledge module core: ports, domain, migrations, PostgreSQL store/queue (CORPUS-A)

- `packages/corpus` (new, MIT) — the knowledge corpus module core: pure domain
  model and company-scoped ports (CorpusStore, SearchIndex, WorkQueue,
  BlobStore, DocumentParser, Embedder) plus PostgreSQL implementations of the
  store, the parse-job queue (idempotent on document+parser version, retries
  with backoff) and per-company settings, and a local-directory blob store.
- `packages/db` — additive migration `0309_corpus_module`: `corpus_datasets`,
  `corpus_documents`, `corpus_chunks` (pgvector `vector(1024)` with HNSW
  m=16/ef_construction=64, generated `tsvector` FTS with GIN, trigram GIN),
  `corpus_parse_jobs`, `corpus_settings`; requires `vector` and `pg_trgm`
  extensions (created by the migration itself).
- Tests: store/queue lifecycle on embedded PostgreSQL 18 with pgvector
  (queued → parsing → embedding → ready, enqueue idempotency, failed-job
  re-queue), domain invariant tests, local blob store tests.

### Knowledge corpus, server side: REST API, the instance block and the parse sweep (CORPUS-2.0 C)

- The board now serves the knowledge corpus over HTTP: datasets (`GET`/`POST`
  `/api/myrmidon/companies/:companyId/corpus/datasets`, `GET`/`PATCH`/`DELETE`
  `…/datasets/:datasetId`), documents (`GET`/`POST
  `…/datasets/:datasetId/documents`, `GET`/`DELETE …/corpus/documents/:id`) and
  search (`POST …/datasets/:datasetId/search`, a proxy to the `SearchIndex`
  port), plus `GET …/corpus/stats` for the screen counters.
- `corpus` is an additive block in `instance_settings.general`: eleven fields
  (module switch, parse-service base URL and timeout, embedder model /
  dimensions / base URL, document and dataset limits, parse concurrency and
  attempts, search top-K). An environment variable is the default at first
  start; afterwards the stored block is the truth, and every save writes one
  activity row per company naming the changed keys.
- The parse worker is a board sweep: it claims queued jobs, parses through the
  parser port, indexes the chunks and settles the document `ready`; a failure
  requeues the job until `maxParseAttempts`, then marks the document `failed`.
  A disabled module — or a process without wired ports — makes the pass a
  no-op, and the API answers 503 instead of pretending an empty corpus.

### Agents can resolve their own interaction cards on automation runs (1.6.6 OPE-6547)

- Accept/reject/respond/verdicts on an issue-thread interaction (`POST
  /api/issues/{id}/interactions/{interactionId}/...`) no longer require the run
  named in `X-Paperclip-Run-Id` to record the same responsible user as the agent
  API key that authenticates the call.
- Automation (heartbeat) runs record the issue's responsible user, a steering
  comment's author, or the company default — a service account — while a key is
  issued to a person, so every key-authenticated resolution was rejected with
  422 `interaction_run_attribution_required` and agent `request_confirmation`
  cards stayed pending forever.
- The gate keeps its real checks (the run exists, belongs to the same company
  and to the authenticated agent); who may resolve is still decided by the
  resolver audience (addressee, creator exclusion, human-only, governed
  actions), as it already was for the withdraw route.

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

### Owner-DM delivery filter, part B: the mode switch (OWNER-DM-FILTER)
- Company Settings has a new **Owner Telegram delivery** section. It picks which cards an agent raises are sent to the task owner's Telegram DM: **Owner decisions only** (the default — only the cards that wait for the owner) or **All cards** (everything, the behaviour before this change).
- The current mode is read with `GET /api/myrmidon/owner-delivery` and saved with `PATCH /api/myrmidon/owner-delivery` (`{ mode }`, instance administrator). A missing or unreadable setting shows `owner_decisions_only`.

### Plugin registry: connectors stay fail-closed by default; the agent permission-mode selector is pinned to three modes (PLUGIN-REGISTRY 3/3)

- Connector fail-closed properties (upstream #13758 pattern) are now pinned by
  tests in `server/src/__tests__/bundled-plugins.test.ts`
  (`describe("connector fail-closed properties")`):
  1. A self-hosted instance with no managed config auto-installs exactly
     `SELF_HOSTED_AUTO_INSTALL_KEYS = ["kubernetes"]`; the other six catalog
     entries (cloudflare, daytona, e2b, exe-dev, modal, novita) are never
     installed or loaded implicitly — not via `installPlugin`, not via the
     lifecycle loader, not even via a registry query.
  2. `ensureBundledPlugins` can never deinstall anything: the provisioner
     dependency surface exposes no uninstall/unload/remove capability, and
     with every connector already present, ensuring only `kubernetes`
     produces zero registry writes, zero lifecycle calls, and queries only
     its own key. Removing a connector or plugin record stays an explicit
     operator action in the plugin registry UI/API. No entitlement behavior
     changed: the myrmidon(PLUGIN-ENTITLEMENT C) gate in the plugin loader
     remains the only intersection point and was left intact.
- The agent card's "Permission mode" selector maps onto the three existing
  `permissionMode` values only: `approve-all` (full auto), `approve-reads`
  (restricted, the ACPX default), `deny-all` (forbidden). The operator-facing
  ACPX labels were renamed accordingly ("Allow Paperclip reads" →
  "Restricted (approve reads)", "Deny all" → "Deny all (forbidden)"); the
  runtime values are unchanged. The vendor's fourth mode
  (`approve-paperclip`) is deliberately not offered — it names vendor tools
  that do not exist in Myrmidon, and any such unknown value still fails
  closed to the provider default.
- Conscious Myrmidon defaults stay untouched: ACPX `approve-reads`, OpenCode
  `ask`, Codex `never`.
- The selector's hint now states explicitly that the chosen mode cannot
  relax the myrmidon(1.6-AUTONOMY) role × action-class gate: that server-side
  gate is stronger than any UI mode and denies or holds actions
  independently of this setting.

### Auto-update of auto-merge PRs without a GitHub merge queue (PR-AUTOUPDATE)

- `.github/workflows/myrmidon-pr-autoupdate.yml` — on every push to `main` (and
  every 30 minutes, and by hand) merges `main` into the oldest open PR that has
  auto-merge on and is behind `main`, then dispatches CI and `hot-files-review`
  on the new head. PRs in conflict get the `needs-rebase` label and a comment.
- `myrmidon-hot-files-review.yml` accepts `workflow_dispatch` with the PR number.
- The `main-protection` ruleset requires PRs to be up to date before merge.

### Board processes: the process registry and the «Processes» panel (PROCS-0.1)

- A board process now says that it is alive. The new table `board_processes` holds one row per
  running process — boot id, role, pid, host, container, version, start time, last pulse, api port
  and the measurements of the last pulse (event-loop lag and RSS). The boot id is a random UUID per
  process, exactly like the controller boot id, because a pid and a hostname survive neither a
  container restart nor a filename collision.
- Every process refreshes its own row every 10 seconds; rows older than two minutes are reaped by
  the process that owns the background timers. This is the fourth brick of the multi-process project
  (design §5.1): the split cannot be argued without a place that says which processes exist and
  which of them still answer, and ownership checks ("is the owner of this row alive?") need exactly
  this row.
- Instance → General carries the «Processes» panel: role, boot id, pid/host/container, api port,
  version, uptime, the age of the last pulse, the loop lag and the RSS of each process, with the
  process that answers the request marked as "this process". The panel polls at the pulse cadence,
  so a process that stops answering turns amber within one tick — no restart needed. A warning
  appears while this very process has no row of its own yet.
- `GET /metrics` answers one more family: `myrmidon_board_event_loop_utilization`, the share of the
  event-loop window the process was busy (0..1), from `performance.eventLoopUtilization`,
  read-and-reset so the number describes the interval between scrapes.
- The container name of a process is the container id Docker writes into `HOSTNAME`; the deployment
  setting `MYRMIDON_PROCESS_CONTAINER` overrides it when the operator's own container name is the
  one to show (the split layout of T1.1). Unset — the runtime name is used.
- The default mode does not change: with `mode=single` the one process writes one row with role
  `all` and does the reaping itself, so the behaviour of the board today is exactly what it was.
  Roles `worker`/`api` of T1.1 arrive with the same table and the same pulse; an `api` child writes
  its row and deletes nothing.

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
skill lifecycle delivery of the company, the runtime skill catalogue and its
files, and the instance settings (compression defaults, helper ceiling,
language-server policy, shared package cache, pnpm store, clone TTL). All of it
was read again for every bot, so a fleet of N bots paid N times a minute.

- A sweep now shares one pass: the first bot of a tick reads those values and
  every other bot of the same tick gets what it read. The pass is dropped at the
  end of the sweep — a settings or skill change still reaches the bots within
  one reconcile interval, exactly as before, and nothing is cached between
  ticks. A skill carried by several bots is also read from disk once per pass.
- `pnpmSettings` was read twice per bot inside one compile (once for the
  package-cache variables, once for the scope instance's store path); it is now
  read once per pass.
- The agent card behind a profile is read as a single row by id instead of the
  board's own `getById`, which also hydrates the whole company and the agent's
  month spend — three queries where the profile needs the columns. Name
  normalization and the cost view are for the agents list, not for a container
  profile.
- The card's "Apply now" and the canary wave reconcile one bot: they pass no
  shared pass and behave as before. The reconciler log, the interfaces and the
  UI are unchanged.

Measured with counting fakes over a sweep of three bots: 21 instance-scoped
port calls before, 6 after (one per reader; six of the "before" are the doubled
pnpm read); the skill catalogue 3 -> 1, the lifecycle's company-wide reads
3 -> 1, a skill directory carried by two bots 2 -> 1, and the card read 3 rows
instead of 3 x 3 queries.

### The release cut cannot forget the changelog version section (RELEASE-CUT-CHANGELOG)

- On 05.10 the `myr-v1.6.3` tag was pushed without a `## 1.6.3` section in
  `docs/myrmidon/CHANGELOG.md` — the notes still sat under `## Unreleased`
  and the release publish refused with "release body could not be built
  (missing notes)"; the release page was published by hand. The cut step now
  fails before that can happen again.
- `node scripts/myrmidon/release/collect-fragments.mjs --version X.Y.Z`
  verifies the collected changelogs before writing anything: a non-empty
  `## X.Y.Z` section and an empty `## Unreleased` / `## Без выпуска`, in EN
  and RU alike. A cut that would not pass CI fails locally.
- The new `--check` mode is the CI gate of a release tag:
  the `checks` lane of `myrmidon-ci-tag.yml` (the tag CI) fails
  a tag whose commit has no version section (or leftovers in the unreleased
  heading) — the tag is red before the image build and the release publish
  start.
- Guard tests: `scripts/myrmidon/release/collect-fragments.test.mjs` (the
  1.6.3 tag state fails, the 1.6.4 tag state passes, a non-empty unreleased
  section fails, an empty version section fails).

### Release freeze: merges into main wait until the release tag's CI is green (RELEASE-FREEZE)

- A new PR check, `freeze` ("Release freeze gate"), fails while the newest
  release tag (`myr-vX.Y.Z` or `myr-vX.Y.Z-rc.N`) has no green Myrmidon CI.
  The tag workflow opens one issue `release-freeze: <tag>` at the cut and
  closes it when the tag CI succeeds. The gate fails closed on lookup errors.
- This prevents the 1.6.4 incident: merges right after the cut cancelled the
  tag's CI run and the publish gate refused the release.
- Operator step: add the `freeze` check to main's required status checks to
  make the freeze binding.

### Review routing: pull-request events and merge steward settings UI (REVIEW-ROUTING PR-events UI)

- The Review routing settings screen gains a "Pull request events" section: a
  toggle for creating review tasks from green pull requests, a `owner/repo`
  list editor (empty — every repository the board sees), limits for open
  reviews per reviewer and new assignments per pass, and the poll interval.
- A "Merge steward" sub-section edits the steward toggle, its caste roles
  (comma-separated) and its per-pass merge limit; the role and limit inputs
  disable while the steward is off.
- The screen reads and writes the settings through the existing review-routing
  settings API with full-object semantics: the PUT preserves every key the
  screen does not own. Client-side validation rejects malformed repository
  entries and out-of-range numbers before the save is sent.
- The `prWatch` block is sent only when the loaded settings already carry it
  (the server schema is strict, so a pre-PR-lane server would reject the key
  with 400): against such a server the "Pull request events" and "Merge
  steward" sections stay hidden and the task-lane save works unchanged. The
  client-side `owner/repo` validation mirrors the server's repository pattern
  exactly (`[A-Za-z0-9_.-]+` halves).

### Review routing by pull-request events (REVIEW-ROUTING-PR-A)

- The review-routing sweep now also watches pull requests, so a review task is
  born the moment a PR turns green instead of waiting for the next manual
  "work through the PR queue" round. The shared `reviewRouting` settings gain a
  `prWatch` block (`enabled`, `repositories`, `maxOpenReviewsPerReviewer`,
  `maxNewAssignmentsPerPass`, `pollIntervalSec`, `steward.{enabled, roles,
  maxMergesPerSteward}`); every field absent or malformed falls back to its
  default without blanking the sibling keys, the same rule the outer block
  already follows.
- A pass resolves each open PR's head through GitHub (combined commit status —
  no statuses at all counts as green for repos without CI — plus the review
  decision derived from `GET /pulls/{n}/reviews`: latest verdict per reviewer on
  the current head; the REST PR object has no such field). The status read is
  cached per (repo, number, head sha) for 300 s, reviews are read fresh. A green head
  with no verdict on that exact head gets a review task assigned to the
  least-loaded eligible reviewer (board load and open PR-review load both
  capped, never the PR author's linked agent, never a non-invokable agent); an
  APPROVED green head additionally gets a merge-steward task for the
  least-loaded agent of the steward roles. Tasks are created through the normal
  issue path (activity log, checkout locks, review-stage machinery), carry a
  `pull_request` work product stamped with the head sha and the routing kind,
  and wake their assignee the same way board routing does.
- Pushing a new commit supersedes the open task of the same lane: it is
  cancelled with a system comment naming the new head, and the new head gets
  its own task on the same pass. Closed or merged PRs are left to PR-sync — the
  lane never settles them. When GitHub is unreadable the lane is inert: an
  unknown head creates nothing, closes nothing and counts no failure.
- New attention cards when nobody is eligible: `no_reviewer` for a green PR
  without a free reviewer, `no_steward` for an approved PR without a free
  steward, each carrying the PR coordinates (repository, number, head) for the
  settings screen and the attention desk. Activity actions
  `issue.review_routing.pr_task_created` and
  `issue.review_routing.steward_task_created` mark every created task, and the
  sweep result gains `prScanned`, `prTasksCreated`, `stewardTasksCreated` and
  `prSuperseded` counters.
- `pollIntervalSec` throttles only the PR lane; the board-task lane keeps its
  existing 60 s behavior, and a settings change applies on the next pass
  without a restart.

### Settings UI: attention feed windows screen (SETTINGS-UI C-4)

- The attention feed windows are editable from the instance settings: a new
  "Attention feed" panel edits how far back the feed looks for an unresolved
  failed or timed-out run (1–365 days, default 7) and how long it reuses the
  feed it built per company (0–300 seconds, default 45; `0` turns the cache
  off). The panel shows the bounds and the built-in default of each field, and
  marks whether the value in force comes from the saved settings row or from
  the default.
- The panel reads and writes through `GET`/`PATCH
  /api/myrmidon/attention-feed`, backed by the instance settings row
  (`attentionFailedRunHorizonDays`, `attentionFeedCacheTtlSeconds` in the
  general block). A save is a partial write: only the window the operator
  changed is written, and the change is audited per company. The feed picks the
  new value up on its next build — no restart. Neither window has an
  environment variable, so the stored row (then the built-in default) is the
  only source; a hand-edited value that is not a whole number within the bounds
  reads as the default, the same fallback the feed itself applies.
- The two windows are the stored keys introduced by the ATTENTION-WINDOW-CACHE
  change; this screen is their operator entry point, and the keys are defined
  once in `packages/shared/src/myrmidon-attention-feed.ts` so the feed, the
  route and the screen cannot drift apart.
- The panel is mounted in the instance general settings next to the other
  myrmidon panels; the other attention behaviours (the `AUTO-RESUME` and
  `EXECUTION-HOLD` attention passes) keep their own screens and are untouched
  here.

### Settings UI: document signing re-enable on the Browsers page (SETTINGS-UI C-3)

- The Browsers settings page now shows whether document signing is on. The
  block reads the bridge settings (`GET /api/myrmidon/browser-bridge/settings`)
  and says either that signing is on and the bridge signs under the policy of
  the connector panel, or that an emergency stop turned it off and every sign
  action is refused until it is turned back on.
- While signing is off, the block offers "Re-enable signing": the button opens
  a confirmation step first, and only the confirm writes — `PATCH
  /api/myrmidon/browser-bridge/settings` with `signing.enabled: true` plus the
  mode, types and daily limit that are stored right now, so a re-enable never
  rewrites the signing policy behind the operator's back. Cancel closes the
  step and writes nothing.
- The stored settings are re-read after a successful write, a write in flight
  disables the confirm and the cancel button, and a failed write is reported in
  the block while the displayed state stays as read.
- This is the operator counterpart of the kill switch in the connector panel
  (`POST /api/myrmidon/browser-bridge/signing/disable`), which until now could
  only be undone by hand-editing the instance settings row. Nothing on the
  server side changed: the settings `PATCH` already accepted `enabled: true`,
  and the bridge keeps auditing the change of `enabled` exactly as before.
- The block stays on screen while the browser registry is loading or has
  failed, so a stopped bridge is visible on the page even when the registry
  cannot be read; a failed read of the bridge settings is shown inside the
  block and does not take the registry down with it.

### Guide: address any agent from one Telegram chat (TG-MULTI-AGENT)

- New operator guide
  [telegram-multi-agent](guides/telegram-multi-agent.md):
  `@`-mention addressing and the `/agents`, `/to`, `/who` commands of the
  bridged Telegram DM — aliases (`telegramAliases` in the agent card), the
  sticky default addressee (`telegramStickyAgentId`), and the protection
  rules (own bridged conversation only, same-company agents only, polite
  list of valid aliases for an unknown alias). X9a/X9b are already in main;
  X9c ships with the code PR.

### Telegram group topics as a task inbox (TG-NOTIFY part D)

- A message in a forum topic of a connected Telegram group can now become
  work on the board: the message continues the task already bound to that
  topic, or a new task is created with the first words of the message as the
  title and the thread link in the body. Both switches
  (`telegramNotify.inbound.enabled`, `telegramNotify.inbound.requireMention`)
  are off by default; the require-mention default keeps the group privacy
  contract, so commands in a topic work only when the bot is addressed. See
  [telegram-topic-inbound](../guides/telegram-topic-inbound.md).

### Voice STT runtime settings: full contour over the API (VOICE-STT A1-fix)

- `PATCH /api/myrmidon/companies/:companyId/voice-stt` now accepts `baseUrl`,
  `keySecret` and `deepgramKeySecret` on top of the previous fields
  (`enabled`, `backend`, `model`, `language`, `diarization`,
  `maxDurationSec`): the whole STT contour (gateway/Deepgram address and the
  secret names) can be set per company without an env change or a restart.
  The fields share the null-semantics of `model`: an explicit `null` clears
  the stored value back to the environment default, an omitted field keeps
  the current one. The GET response (the `settingsView`) keeps `baseUrl` but
  does not return `keySecret` / `deepgramKeySecret` — secret names are
  write-only over the API, secret values are never returned. See
  [SETTINGS.md](SETTINGS.md), the VOICE-STT section.

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

### Bot runtime tuning from the profile compiler (BOT-RUNTIME-TUNING part B)

- The bot profile compiler writes three settings into each bot's
  `hermes/config.yaml` that it never wrote before:
  `compression.threshold_tokens` (an absolute token cap — Hermes compresses
  at the lower of its ratio threshold and this count, so a long session on a
  large-window model no longer grows to half the window before compacting),
  `model.context_length` (the context window of the card's model, from the
  card's own `models.contextLength` or the instance's
  `MYRMIDON_BOT_MODEL_CONTEXT_LENGTH` alias map), and the auxiliary models
  `auxiliary.title_generation.model` / `auxiliary.compression.model` (the
  title generator and the compression summarizer stop riding the main,
  expensive model). Instance settings:
  `MYRMIDON_BOT_COMPRESSION_THRESHOLD_TOKENS`,
  `MYRMIDON_BOT_MODEL_CONTEXT_LENGTH`,
  `MYRMIDON_BOT_AUX_TITLE_MODEL`, `MYRMIDON_BOT_AUX_COMPRESSION_MODEL`.
  The card's entry always wins over the instance setting; unset stays unset
  (no compiler-invented defaults). Values are validated in ranges at compile
  time (10 000–2 000 000 for the token cap, 8 000–10 000 000 for the context
  window): an out-of-range or non-integer value is dropped with a profile
  warning in the container activity log — never a compile failure. Settings
  are read on every profile build, and a change restarts the affected bot
  containers on the next pass. Settings documentation:
  [SETTINGS.md](SETTINGS.md) § Bot containers.

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
  `/api/myrmidon/cloud-connector`. See [guides/cloud-files-connector.md](guides/cloud-files-connector.md)
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