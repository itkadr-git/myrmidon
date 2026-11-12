# OPE-12869 — design exploration (NOT a commit candidate; delete before final)

## The mechanism (from template.ts / docker-driver.ts / myrmidon-bot-disk.ts)

- A bot container gets ONE bind: `<MYRMIDON_BOT_VOLUME_ROOT>/<botKey>:/bot`.
  /data/hermes, /workspace, /scratch are image-made links into it.
- pnpm store default (since #2936): `/workspace/.pnpm-store` = inside that
  per-bot tree => per-bot store size (~2.4-2.6 GB each) on the clones' volume.
  Written into profile env as `npm_config_store_dir` (profile-compile.ts via
  packageCacheEnv/pnpmEnv) AND baked into image default (Dockerfile ENV,
  entrypoint.sh fallback).
- The env var only reaches a bot's profile when `sharedPackageCachePath` is
  configured (profile-compile.ts line ~490); otherwise image default applies.
- Import into node_modules: `npm_config_package_import_method=clone` (reflink,
  strict). Hardlinks can't cross a mount point (EXDEV), which is why the 1.6.5
  `/cache/pnpm-store` (root disk, separate bind) made pnpm COPY (~3GB/clone).
- Reflinks DO work across bind mounts of the same XFS filesystem (same
  superblock). The 1.6.5 failure was because the store sat on the ROOT disk
  (different filesystem from /srv/myrmidon-xfs), not because it was a separate
  bind.
- dockergate allows rw binds ONLY as fixed PackageCacheMounts pairs
  `<PackageCacheRoot>/<subdir>:<containerPath>`; `/cache/pnpm-store` is free
  again (retired in #2936, both sides).

## Options

A) Restore shared store as 6th PackageCacheMount: host
   `<sharedPackageCachePath>/pnpm-store` (must be ON the bot-volume XFS volume,
   NOT root disk) bound rw at `/cache/pnpm-store`; keep import `clone`
   (reflink). Growth = one store ~3 GB. Ops: operator moves/creates the cache
   root on the XFS volume. Matches НАМЕРЕНИЕ "один общий на всех ботов (или на
   группу)". Acceptance mentions "жёсткими ссылками" but with a shared store on
   the same fs reflink gives the same one-copy effect; hardlink would require
   the store INSIDE the bots' bind (impossible to share across bots) — so
   reflink is the only sharing mechanism that satisfies "one store, many bots".
B) Group stores per scope instance (BOT-DISK-F style): one store per instance
   dir — already exists for shared-scope bots; extending to all bots = new
   grouping machinery, much bigger change.
C) Keep per-bot stores but hardlink-cap total via periodic dedup — not
   structural.

A is the НАМЕРЕНИЕ. Key detail: the host cache root must live on the same
filesystem as the bot volumes (/srv/myrmidon-xfs). The 1.6.5 defect was root
disk placement. Validation `botDiskCachePathProblem` must refuse a cache root
INSIDE MYRMIDON_BOT_VOLUME_ROOT? Actually docs say "The directory must not be
inside the bot volume root" (else it would be swept/moved with bots? and
prepare helper would chown it per bot). On production the operator chooses e.g.
/srv/myrmidon-xfs/package-cache (same fs, outside bot volume root).

## Tests to write
- template test: two bots' builds produce the same store mount point
  (`<cache>/pnpm-store:/cache/pnpm-store`) and same store env var.
- wrapper test: existing pnpm-wrapper-purge covers purge flag; add none?
- dockergate policy fixture: PackageCacheMounts regains "pnpm-store" pair =>
  prepare script installs 6 dirs again => script_test counts 13->14 lines,
  5->6 installs; traffic.json regeneration needed (emit-fixtures).

## Files to touch (per МЕСТО ПРАВКИ)
- server/src/myrmidon/bot-containers/template.ts: PACKAGE_CACHE_MOUNTS +
  PNPM_STORE mount constant + DEFAULT_PNPM_STORE_DIR back to /cache/pnpm-store;
  doc comments.
- packages/shared/src/myrmidon-bot-disk.ts: BOT_DISK_DEFAULT_PNPM_STORE_DIR,
  roots/validation (store no longer a stored setting? keep setting but default
  to the mount; refuse /workspace/.pnpm-store? no — migrate it), migration of
  stored /workspace/.pnpm-store -> mount path.
- docker/bot-runtime/build-wrappers/pnpm: no change needed for store path (env
  driven); keep purge flag.
- docker/bot-runtime Dockerfile ENV + entrypoint.sh fallback: default store ->
  /cache/pnpm-store; reflink self-check roots unchanged; pnpm-hardlink-check?
- tools/dockergate/internal/policy/create.go PackageCacheMounts + script_test
  counts + traffic.json regenerate.
- docs bot-disk-cache.md (+ru), SETTINGS docs, changes fragment, CHANGELOG?
- Tests: bot-disk-cache.myrmidon.test.ts (template+shared), dockerfile.test.mjs
  (npm_config_store_dir=/cache/pnpm-store), entrypoint.test.mjs, profile-compile
  test (store var always present with cache), dockergate fixtures.

## Risk: import method
`clone` = reflink, strictly loud. On XFS reflinks exist (pmem? no — XFS has
reflink since 4.9 with reflink=1). The volume is XFS (/srv/myrmidon-xfs).
1.6.5 used hardlink+shared mount (EXDEV => copy). Default today is clone with
strict refusal — pnpm-reflink-check exists in image. So shared mount + clone is
sound: bots share one store, node_modules are reflinks (CoW), no growth per
bot.
