# dockergate

> Russian version: [dockergate.ru.md](dockergate.ru.md)

A proxy in front of the Docker socket for the board's bot-container driver
(`server/src/myrmidon/bot-containers/`). Code: `tools/dockergate/` (Go, standard library
only), image: `docker/dockergate/Dockerfile`, publishing:
`.github/workflows/myrmidon-dockergate.yml` to `ghcr.io/itkadr-git/myrmidon-dockergate`.

## Why

The board server runs under the same uid as bots with a terminal. The board's access to the
Docker daemon socket equals host root for any such bot: a container with `Privileged`, with
`/` mounted, and so on is one call away. dockergate stands between the board and the daemon
and passes only the calls the driver makes, and only with the bodies the driver builds.
Everything else is denied (deny by default). The raw daemon socket is not mounted into the
board; the board gets the dockergate socket (`MYRMIDON_BOT_DOCKER_SOCKET`, see
[SETTINGS.md](SETTINGS.md)).

Extra read-only bot mounts (shared directories) are described in
[bot-extra-mounts.md](bot-extra-mounts.md); on the dockergate side the
`mountSources` key allows them. The shared package cache
([bot-disk-cache.md](bot-disk-cache.md)) is the one writable exception; the
`packageCacheRoot` key allows it, and the same key allows the board's git mirrors
(`<packageCacheRoot>/git` → `/cache/git`) as a read-only bind only.

## How it is enforced

1. **The caller.** A connection is accepted only when it was opened by the pinned board
   process (`SO_PEERCRED`, then the process is checked against `/proc`): the first child of
   the board container's main process with the expected `argv`. A foreign caller gets a
   static refusal or a silent close; it does not occupy a connection slot. The
   `caller.mode: uid` mode (uid and gid only) exists for CI and is refused by the
   configuration check with a production `volumeRoot`.
2. **Routes.** The raw request-target is matched without decoding percent-escapes; only the
   template literals are allowed. Method, API version (`v1.45` only) and headers are checked
   strictly.
3. **Bodies.** A container-create body is parsed by a strict schema (an unknown key, a
   duplicate key, `null`, a fractional number or an escaped letter are rejected), then
   canonically rebuilt and compared byte for byte with the received one. The rebuild takes
   values from `bots[]`, not from the request. Tar uploads (`ustar`) are checked byte for
   byte and rebuilt the same way: types, uid/gid, modes, paths, order, content. The
   `applied.json` marker inside the profile tar is data written by the board, so its
   content is not rebuilt; its form is checked (see
   [The applied-profile marker](#the-applied-profile-marker)).
4. **Bot consistency.** The `botKey` comes from the container name; the label, volumes,
   network and helper script must match it. Extra volumes beyond the three bot volumes are
   allowed only as read-only binds whose source is named in full in `mountSources` and
   whose mount point is free, plus the shared package cache: read-write binds accepted
   only as the fixed pairs `<packageCacheRoot>/{pnpm,go-mod,go-build,gradle}` →
   `/cache/{pnpm,go-mod,go-build,gradle}`, and the git mirrors as the one read-only pair
   `<packageCacheRoot>/git` → `/cache/git`; a helper gets no extra volume. Memory, CPU and
   process-count limits may not exceed what `bots[]` records.
5. **State.** Before a call, dockergate inspects the container itself and checks the
   preconditions (the bot label, status, the presence of `.next`).
6. **Responses are cut down** to the fields the driver reads, with a size cap. The A2 answer
   carries the state the driver reads plus every field its template-drift check compares —
   `Config.Image` and `HostConfig` `Memory`, `NanoCpus`, `PidsLimit`, `NetworkMode`, `Binds`.
   Trimming away a compared field is not a smaller answer: the board reads nothing there, calls
   the container different and recreates it on every pass (the 01.10 incident, `HostConfig.Binds`).
   A gate contract test checks the A2 answer against the field list the driver emits
   (`tools/dockergate/contract/emit-fixtures.ts`), so dropping one turns CI red.

## The allowed-call table

| ID | Call | Purpose |
|---|---|---|
| A1 | `GET /v1.45/images/<ref>/json` for `ref` from `images` | image labels (the bot-environment contract) |
| A2 | `GET /v1.45/containers/myrmidon-bot-<K>/json` | container state |
| A3 | `GET .../myrmidon-bot-<K>/archive?path=<applied-profile marker>` | read the marker |
| A4 | `POST /v1.45/containers/create?name=myrmidon-bot-<K>[.next\|.helper]` | create the bot, `.next` or the helper |
| A5 | `PUT .../myrmidon-bot-<K>.helper/archive?path=<volume>&noOverwriteDirNonDir=true` | write the profile through the helper (tar) |
| A6 | `POST .../myrmidon-bot-<K>[.helper]/start` | start |
| A7 | `POST .../myrmidon-bot-<K>.helper/wait?condition=not-running` | wait for the helper |
| A8 | `GET .../myrmidon-bot-<K>.helper/logs?stdout=true&stderr=true&tail=20` | helper log |
| A9 | `DELETE .../myrmidon-bot-<K>[.next\|.helper]?force=true&v=true` | delete |
| A10 | `POST .../myrmidon-bot-<K>/stop?t=30` | stop (only inside a recreate) |
| A11 | `POST .../myrmidon-bot-<K>/restart?t=30` | restart (rate-limited) |
| A12 | `POST .../myrmidon-bot-<K>.next/rename?name=myrmidon-bot-<K>` | finish the recreate |
| A13 | `GET .../myrmidon-bot-<K>/archive?path=<clone-hygiene report>` | read the bot's clone-hygiene report (one fixed file, like A3) |

`K` is a lowercase UUID. Any other path (including `exec`, `attach`, `commit`, `build`,
`images/create`, `volumes`, `networks`, `info`, `events`, `system`, `swarm`) gets 403
`route_not_allowed`.

## The applied-profile marker

Each profile upload ends with the applied-profile marker `applied.json`. It is an object
with exactly the string keys `restartHash` and `filesHash` and the string array `files`,
plus the optional integer `maxConcurrentRuns` (1..50) that the board records since
CONCURRENCY-SYNC. Any other key, a `maxConcurrentRuns` of another type or outside that
range, or a file over the size cap is refused with `tar_content` (`applied_json` /
`applied_keys` / `applied_size` in the log detail). A board older than CONCURRENCY-SYNC
writes the three-key marker; dockergate accepts both forms, and a marker written by an
older board does not block a profile apply.

## Configuration

A JSON file. An unknown key at any level, or a missing required key, prevents startup
(`check-config` and `serve` exit non-zero).

| Key | Meaning |
|---|---|
| `listen` | absolute path of the dockergate socket |
| `upstream` | absolute path of the daemon socket |
| `apiVersion` | `1.45` only |
| `caller` | required. `container` (the board container name), `containerLabels`, `uid`, `gid`, `argv`, `maxStartDelayTicks`, `mode` (`container-main-process` by default, `uid` for CI only) |
| `volumeRoot` | the host directory of bot volumes; a bot's volumes are `<root>/<botKey>/{hermes,workspace,scratch}`; the bot container gets ONE bind, `<root>/<botKey>:/bot` (hard links cannot cross mounts, BOT-DISK-D), while the helper containers keep three narrow binds of the same directories; `/bot` and `/data` are reserved container paths |
| `mountSources` | host directories a bot may mount in addition, read-only only (an empty or missing list allows none). Every extra bind in a create body must start with one of these paths in full, carry the `ro` suffix and use a mount point outside `/workspace`, `/scratch` and `/tmp` — the three owner-data subtrees of `/data/hermes` are the only exception and are accepted at their real path inside the bot's own mount (1.6.5-BOT-DISK-H11, see [bot-extra-mounts.md](bot-extra-mounts.md#a-mount-point-inside-the-bots-own-volume-165-bot-disk-h-class-j)); otherwise `mount_source_not_allowed` or `binds_mismatch`. The list is also applied on `SIGHUP` |
| `packageCacheRoot` | the host directory of the shared package cache, the same path as the board's instance setting (see [bot-disk-cache.md](bot-disk-cache.md)). Under it, and only there, a bot may mount the fixed subdirectories `pnpm`, `go-mod`, `go-build`, `gradle` read-write at `/cache/pnpm`, `/cache/go-mod`, `/cache/go-build`, `/cache/gradle`; any other writable bind is `mount_source_not_allowed`. The subdirectory `git` is accepted only as a **read-only** bind at `/cache/git` (the board's bare git mirrors, 1.6.2-BOT-DISK-C); `git` with `rw`, or at another mount point, is refused the same way. An absolute directory without `..`, `//` or a trailing `/`, outside `volumeRoot`. Empty or missing (the default) allows no cache bind. Applied on `SIGHUP` |
| `botRuntimeRoot` | the host directory of the shared bot runtime (1.6.5-BOT-DISK-H11; the board's instance setting `general.botDisk.sharedBotRuntimePath`, see [bot-extra-mounts.md](bot-extra-mounts.md#the-shared-bot-runtime-165-bot-disk-h-class-c)). Under it, and only there, a bot may mount the fixed subdirectories `bin`, `lazy-packages` and `lsp` as **read-only** binds at the path the driver really uses inside the bot's own mount (`/bot/hermes/…`, `/bot-scope/<botKey>/hermes/…`, `/data/hermes/…`); another root, another subdirectory, another mount point or `rw` is `mount_source_not_allowed`. An absolute directory without `..`, `//` or a trailing `/`, outside `volumeRoot`, not overlapping `scopeRoot` or `packageCacheRoot`, not a parent of either. Empty or missing (the default) allows no runtime bind. Applied on `SIGHUP` |
| `scopeRoot` | the host directory of shared isolation-scope instances (BOT-DISK-F, see [bot-disk-cache.md](bot-disk-cache.md#isolation-scope-who-shares-a-disk)): one subdirectory `<kind>-<id>` per instance. A bot may bind only an instance listed in its own `bots[].scopeInstances`. An absolute directory without `..`, `//` or a trailing `/`, not `volumeRoot` and not a parent of it, not overlapping `packageCacheRoot`. Empty or missing (the default): `<volumeRoot>/.scopes` (a bot key can never begin with `.`, so it cannot collide with a bot directory). Applied on `SIGHUP` |
| `network` | the single bot network |
| `images` | a non-empty list of images, by digest only (`name@sha256:...`); a tag is not allowed |
| `bots[]` | a bot record: `botKey`, `maxMemoryMb`, `maxCpus`, `maxPids`, and optionally `scopeInstances`: the shared scope instance directory names (`<kind>-<id>`, kind one of `group`, `caste`, `subtree`, `project`, `catalog`, `company`) this bot is a member of and may bind. Empty or missing: the bot is never a member of a shared instance |
| `limits` | limits and timeouts: header and body sizes, read and upstream timeouts, connection and in-flight call counts, the global rate, the per-process refusal rate, per-bot window rates (`createPerWindow`, `startPerWindow`, `restartPerWindow`, `stopPerWindow`, `putArchivePerWindow`, `rateWindowSec`). A missing key takes the default |
| `statsFile` | absolute path of the counters file |

`SIGHUP` re-reads the file; only `bots`, `images`, `network`, `volumeRoot`,
`mountSources`, `packageCacheRoot`, `botRuntimeRoot` and `scopeRoot` are applied. An
invalid file, or one that changes anything else, is rejected and the running configuration
stays.

## Log and counters

The log (JSON, one line per decision) carries the route, `botKey`, the decision, the reason
code and, for a body-field refusal, the field path, the value length and the first 12
characters of its sha256. Request and response bodies, names from tar files, environment
values, client headers and secrets are absent by construction. Events without a decision:
`caller_decoy`, `reject_flood`, `caller_resolve_failed`, `caller_not_board_main`,
`config_reload_failed`.

Reason codes: `caller_resolve_failed`, `caller_not_board_main`, `caller_pin_stale`,
`target_form`, `method_not_allowed`, `api_version`, `route_not_allowed`, `header_forbidden`,
`content_type`, `body_not_allowed`, `body_too_large`, `json_syntax`, `json_duplicate_key`,
`json_unknown_key`, `json_type`, `json_value`, `json_not_canonical`, `bot_not_enrolled`,
`image_not_allowed`, `image_contract`, `image_user`, `helper_image_mismatch`,
`name_label_mismatch`, `binds_mismatch`, `mount_source_not_allowed`, `network_mismatch`,
`limit_exceeds_enrollment`,
`script_mismatch`, `nonce_invalid`, `tar_syntax`, `tar_type`, `tar_owner`, `tar_mode`,
`tar_path`, `tar_nonce`, `tar_order`, `tar_content`, `tar_too_large`, `tar_not_canonical`,
`foreign_container`, `state_precondition`, `volume_root_invariant`, `rate_limited`,
`concurrency_limited`, `upstream_error`, `upstream_timeout`, `upstream_upgrade`,
`response_too_large`, `marker_too_large`.

`statsFile` (JSON, rewritten atomically) holds only numbers and names: allows and denials by
route and reason, `denyPeer`, `rejectDropped`, `resolveFailures`, `resolveDecoys`, upstream
errors, `markerTooLarge`, `rateLimited`, the pinning state, the daemon's answer to ping, a
duration histogram by route. No values from daemon requests and responses. Useful monitoring
signals: `denyPeer` or `resolveDecoys` growing, denials beyond the expected ones,
`pinned: false`, a stale `updatedAt`.

## Enrolling a bot

1. Prepare the bot's volume directory `<volumeRoot>/<botKey>`: the directory is owned by
   root and not writable by group or others (the `CheckVolumeRoot` check rejects modes with
   group/other write bits, i.e. 0755 or stricter); the `hermes`, `workspace`, `scratch`
   subdirectories are owned by root or by the bot user (uid 10001), also without group/other
   write. Do not touch the content. (uid 65532 is the user of the dockergate container
   itself; it is unrelated to the volume owner.)
2. Add a record to `bots[]` (a structural JSON edit, not a regex) with the memory, CPU and
   process-count caps.
3. If a bot needs extra read-only volumes, add their sources to `mountSources` (also a
   structural edit); a source that is not named there never reaches the daemon.
   If the instance uses the shared package cache, set `packageCacheRoot` to the same
   directory as the board's setting (also a structural edit).
4. Check: `dockergate check-config --config <file>`.
5. Send `SIGHUP` to the dockergate process.

## Members of a shared isolation scope (BOT-DISK-F)

By default a bot binds its own directory (`<volumeRoot>/<botKey>:/bot`). The owner may
set a scope instance (a group, a caste, a reporting subtree, a project, a catalog team or
the whole company) to *shared root*; its members then bind ONE directory, the instance's,
instead: `<scopeRoot>/<instance>:/bot-scope`. Inside it live one pnpm store and a
subdirectory per member (`<botKey>/{hermes,workspace,scratch}`), so a hard link works within
a bot and across the members. dockergate accepts exactly this, for exactly the bots enrolled
for the instance, and nothing broader:

- **Bot body.** Besides the isolated body, a body with the extra top-level key
  `"Env":["MYRMIDON_BOT_SCOPE_SUBDIR=<botKey>"]` (the only `Env` ever accepted; anything else
  stays `json_unknown_key`), the tmpfs `{"/tmp":"","/data":"uid=10001,gid=10001,mode=0755,size=1m"}`
  (the member's `/data` holds only links into its own subdirectory, made by the entrypoint)
  and **one** bind `<scopeRoot>/<instance>:/bot-scope` with no suffix. The instance name is
  read from the bind and must be listed in the bot's `scopeInstances`; the bind is rebuilt
  byte for byte, so a sibling instance, the scope root itself, a `..` name or a `:ro`/`:rw`
  suffix is `mount_source_not_allowed` or `binds_mismatch`. A card's extra mounts and the
  cache binds follow as before; `/bot-scope` and `/scope` are reserved container paths.
- **Helpers.** Their three narrow binds move inside the member's own subdirectory
  (`<scopeRoot>/<instance>/<botKey>/{hermes,workspace,scratch}`). The prepare helper of a
  member also binds the instance directory at `/scope` and runs its own constant script
  (`PrepareScriptShared`: the same loop with `scope` added), which hands the instance
  directory to the bot's uid so the container can create the pnpm store in it. The script
  must match the layout of the binds (`script_mismatch` otherwise).
- **Host invariants** (`CheckScopeDir`, on every create naming an instance): `scopeRoot`
  exists as a directory owned by root, not a link, no group/other write; the instance
  directory and the member's subdirectory, when they exist, are directories, not links,
  owned by root or uid 10001, no group/other write; `hermes`, `workspace`, `scratch` under
  the member's subdirectory as for an isolated bot. Violations are `volume_root_invariant`
  (`scope.root`, `scope.instance`, `scope.K`, `scope.<dir>`).
- **Marker.** The applied-profile marker of a member is read at
  `/bot-scope/<botKey>/hermes/.myrmidon/applied.json` (A3); only its own key's path is
  accepted.

To enrol a member: add the instance directory name to the bot's `bots[].scopeInstances`
(a structural edit) and send `SIGHUP` **before** the owner applies the scope change on the
board; the bot's recreate is refused (`mount_source_not_allowed`) until then. The board
shows each agent's directory name in Instance settings, Disk isolation. Contract fixtures
(`contract/testdata/scope/`, `scripts/prepare-shared.sh`) come from the same driver code as
the isolated ones.

## Deploy and rollback

1. The image comes from `ghcr.io/itkadr-git/myrmidon-dockergate` strictly by digest; the OCI
   label `org.opencontainers.image.revision` is checked against a `main` commit or a
   `myr-v*` tag.
2. The socket directory `/run/myrmidon-dockergate/` is created at boot (tmpfiles) and mounted
   into the board container; the raw daemon socket is not mounted into it.
3. dockergate runs as a separate unprivileged container: user 65532, a read-only file system,
   all capabilities dropped, memory and CPU limits set; only it gets access to the daemon
   socket.
4. In the board's environment `MYRMIDON_BOT_DOCKER_SOCKET=/run/myrmidon-dockergate/engine.sock`,
   restart the board (a window without rebuilding the bots).
5. Acceptance: `check-config`, a full driver cycle (status, create, writeProfile, start,
   restart, recreate) on one bot, no denials in the log beyond the expected ones.
6. Rollback: restore the previous `MYRMIDON_BOT_DOCKER_SOCKET` value, restart the board;
   stop dockergate. The bot containers' state is unchanged by this.

## Residual risks

- A process with the board's uid that makes the board's main process issue a call through
  ptrace or `/proc/<pid>/mem` gets the driver's powers over the bots enrolled in `bots[]`
  (not host root). Mitigation: `kernel.yama.ptrace_scope=1`; complete: bots outside the board
  container.
- A connection flood from a process with the board's uid can delay a legitimate call until
  the next reconciliation pass.
- Trust in the daemon and the images: an image is checked by the digest from `images` and by
  the contract label; the dockergate image itself is not signed.

## What is not done

The first PR did not include: fuzzing, integration tests with a real dockerd, a rules matrix
`RULES.md` checked in CI, host scripts (deploy, bot enrolment, compose edits, tmpfiles), two
board tests from the `agent-self-update` side, monitoring triggers. They come as separate
PRs.
