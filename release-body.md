**Release candidate 2 of 1.6.5.** Trial run: deploy it to our production, verify (health, attention list, the fleet taking tasks, bot images), then cut the final `myr-v1.6.5` on the same commit (no rebuild — the images are the ones below) and mark it Latest with `scripts/myrmidon/release/promote-latest.sh`.

Myrmidon 1.6.5-rc.2 replaces 1.6.4. Deploy the board, the release component images (dockergate, fleetd) and the bot images from this tag together (one deploy: `deploy.sh --release <tag>`); see [docs/myrmidon/deploy.md](docs/myrmidon/deploy.md), "Upgrading from 1.6.4 to 1.6.5-rc.2".

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

### LLM Wiki plugin install/upgrade guide and release wiring test (WIKI-PLUGIN-RELEASE)

- `docs/wiki-plugin-install-guide.md` — installation, folder configuration,
  upgrade and troubleshooting steps for `@paperclipai/plugin-llm-wiki`.
- `scripts/myrmidon/wiki-plugin/wiki-plugin-release.test.mjs` — static
  `node:test` contract that pins the plugin's release wiring (esbuild build
  script, SDK from the repository workspace, `paperclipPlugin` entry points,
  packaged file list, esbuild config, guide presence) inside the cheap
  `checks` tier, without running a build.

## Component images (digests)

| Component | Image (digest) |
|---|---|
| board | `ghcr.io/itkadr-git/myrmidon@sha256:beb1459ea7c52b008c3df2325c022ad7d81fa0542f2fecc8c1816ce8c72f466a` |
| dockergate | `ghcr.io/itkadr-git/myrmidon-dockergate@sha256:942bf13c0c7f69bf04245a6a5b79ed2bf40dcc4d6bc2a383d54c151640edc9f0` |
| fleetd | `ghcr.io/itkadr-git/myrmidon-fleetd@sha256:efd9e144f51b21cd9ceb46e0bc9e0f0605ece54a9c7e517dc0f85db3a6be55c5` |
| bot | `ghcr.io/itkadr-git/myrmidon-hermes@sha256:edfd1c9ecc67086c409534d04636e802ca6d0b1bda942c7b3dd29fca1ea976b1` |
| hermes-dev | `ghcr.io/itkadr-git/myrmidon-hermes-dev@sha256:0be36128c9630d68cc784b282d8ec2f4dd60613bbbbfbbe0078157aea7762a49` |
| hermes-node | `ghcr.io/itkadr-git/myrmidon-hermes-node@sha256:37ebb39fc22b6842198776123033e23471c5935e02ec2b37d04dcefb17f469b2` |

Cross-check: `scripts/myrmidon/dockergate/check-release-support.sh --from-tag 1.6.5-rc.2` prints the same dockergate and fleetd digests (run against the live registry). A release whose components are missing is refused by `deploy.sh` itself before anything changes.
