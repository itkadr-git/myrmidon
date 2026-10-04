# Shared package cache and git objects for bot containers (1.6.1-BOT-DISK-B, 1.6.2-BOT-DISK-C)

Development bots download the same pnpm packages, Go modules and Gradle
dependencies again and again, each into its own volume. With the shared package
cache, every bot on the board's own host mounts one set of cache directories
read-write and the downloads are kept once.

## What a bot gets

When the instance setting is set, the local driver adds four binds to every bot
container on the default host, after the card's extra mounts:

| Host directory | Mount point in the bot | Variable written to `hermes/.env` |
|---|---|---|
| `<cache>/pnpm` | `/cache/pnpm` | `npm_config_store_dir` (only with `pnpmStore: "shared"`, see [Hard-linked node_modules](#hard-linked-node_modules)) |
| `<cache>/go-mod` | `/cache/go-mod` | `GOMODCACHE` |
| `<cache>/go-build` | `/cache/go-build` | `GOCACHE` |
| `<cache>/gradle` | `/cache/gradle` | `GRADLE_USER_HOME` |

The variables are written by the profile compiler and win over a card value of
the same name (a warning names the dropped card value). The gateway loads
`hermes/.env` with override, so they replace the image's defaults, which point
into the per-bot volume.

pip is not part of the cache: the bot image sets `PIP_NO_CACHE_DIR`, which
turns pip's cache off whatever its value, and a dotenv file cannot unset a
variable.

These are the only writable extra binds a bot may have. A card's extra mounts
stay read-only, and while the cache is set a card mount at `/cache` or under it
is refused.

## Setting it

The path is the `sharedPackageCachePath` field of the bot disk instance setting,
`instance_settings.general.botDisk` (the same key and API as the draft-directory
lifecycle of BOT-DISK A; a PATCH that names only one field keeps the others):

- Instance → General, panel "Shared package cache for bots", or
- `GET /api/myrmidon/bot-disk` (any board member) and
  `PATCH /api/myrmidon/bot-disk` with `{"sharedPackageCachePath": "/abs/path"}`
  (instance admins only, recorded in the activity log); `null` or an empty
  string turns the cache off.

The path must be a plain absolute directory (no `..`, no empty segment, no
trailing slash). No restart is needed: the local driver and the profile
compiler re-read the setting on every reconcile pass, so on the next pass every
bot is recreated with the new binds and restarted with the new variables.
Turning the cache off works the same way in reverse.

## Operator steps

1. Create the four subdirectories and give them to the bot user (uid and gid
   10001 in the bot image); Docker would otherwise create a missing one as root
   and the bot could not write to it:

   ```sh
   install -d -o 10001 -g 10001 /srv/package-cache/{pnpm,go-mod,go-build,gradle}
   ```

2. Set the same directory as `packageCacheRoot` in the dockergate configuration
   and send dockergate `SIGHUP` (the key is applied without a restart). Without
   it dockergate refuses every cache bind with `mount_source_not_allowed`, and
   the reconcile error names the bot. See [dockergate.md](dockergate.md).
3. Save the path in the instance setting.

The directory must not be inside the bot volume root.

## Duplication between clones (1.6.2-BOT-DISK-C)

A package cache keeps downloads once, but a development bot also holds several
full clones of the same repositories under `/workspace`, each with its own
object database and its own `node_modules`. Three parts remove that.

### Shared git objects

The board keeps one bare mirror per repository you list in
`gitMirrorRepos`, at `<cache>/git/<owner>/<repo>.git` on the host, and
refreshes it by `git fetch --prune` (each mirror at most once per
`gitMirrorRefreshMs`, one refresh at a time, with a lock directory next to the
mirror so a second board process or a manual run stays out; a new mirror is
built beside the final path and renamed into place, so a bot never sees a
half-made one). The board fetches over https; a private repository uses the
server's `GITHUB_TOKEN` (or `GH_TOKEN`), passed in the environment of the git
process only, never in its arguments or the mirror's config.

Bots mount `<cache>/git` **read-only** at `/cache/git`. Read-only is deliberate:
a clone made with an alternate reads objects from the mirror without
re-hashing them, so a writable mirror would let one bot change what another
bot's clone checks out. Only the board writes it. The mirror never loses an
object a clone may still borrow: automatic gc is off, the refresher's gc keeps
unreachable objects (`gc.pruneExpire=never`), and a branch deleted upstream
removes only the ref.

The dev image puts a `git` wrapper first on `PATH` (`/opt/paperclip/bin/git`).
For `git clone https://github.com/<owner>/<repo>[.git]` (also the ssh and
scp-like GitHub forms, which `/etc/gitconfig` already rewrites to https) it adds
`--reference-if-able /cache/git/<owner>/<repo>.git` when that mirror exists in
the container, so the clone's `objects/info/alternates` points at the mirror and
the clone stores only what the mirror lacks: the bot's own commits and whatever
arrived upstream since the last refresh. Nothing else changes: other
subcommands, other hosts, repositories without a mirror, and clones that already
choose their storage (`--reference`, `--dissociate`, `--shared`, `--local`,
`--mirror`, `--depth`, `--filter`) run the real git with the same arguments,
environment, streams and exit status. The credential helper
(`git-credential-paperclip`, installed in `/etc/gitconfig`) belongs to the real
git and is unaffected: a clone from the mirror still fetches the missing objects
through it. A bot that wants a self-contained clone runs `git repack -a -d` in
it, or clones with `--dissociate`.

Heavy builds run through `devbuild` in a separate build container. A clone that
borrows from `/cache/git` needs that path to read old history, and the build
container does not mount it: `pnpm install`, `tsc`, `vitest` and the like do not
read git history, but a build step that does (`git log`, a version stamp) should
run `git repack -a -d` first.

### Hard-linked node_modules

pnpm keeps one content-addressed store and links each project's
`node_modules` to it with hard links. A hard link cannot cross a mount point
(`EXDEV`), even when both mounts come from the same host filesystem. In a bot
container `/workspace` and `/cache/pnpm` are two separate binds, and so was the
image's previous default store, `/data/hermes/.pnpm-store`: with the store on
either of them, pnpm quietly **copied** every package into every clone.

The store therefore now sits on the same mount as the clones:

| `pnpmStore` | Store | Result |
|---|---|---|
| `workspace` (default) | `/workspace/.pnpm-store` | One copy of each package per bot, hard-linked into every clone of that bot, on any filesystem. The lifecycle sweep never treats the store as a draft |
| `shared` | `/cache/pnpm` | One copy per host, shared by all bots, but a different mount: pnpm is told `package-import-method=clone-or-copy`, so it reflinks where the filesystem supports it (XFS with reflink, btrfs; Linux allows a reflink across mounts of one filesystem) and copies on ext4. Choose it only on such a filesystem |

The image sets the same default (`npm_config_store_dir=/workspace/.pnpm-store`),
so a bot without the shared cache gets it too. A hard link is the same file: a
bot that edits an installed file in `node_modules` in place also edits the
store copy and its other clones (pnpm's store integrity check, on by default,
notices on a later install). The store is per bot, so this never crosses bots.

`docker/bot-runtime/pnpm-hardlink-check.sh` proves the behaviour: it installs a
local tarball package offline and prints the installed file's link count. The
dev image's build runs it as uid 10001 against the image's own pnpm and fails
the build on a copy, and `scripts/myrmidon/bot-runtime/pnpm-hardlink.test.mjs`
runs it in CI, including the negative case of a store on another mount.

### Clone hygiene in the draft lifecycle

The lifecycle of BOT-DISK A removed any top-level entry of a bot's
`workspace` or `scratch` volume idle longer than the TTL, judged by the
directory's mtime. For a clone that is wrong both ways: editing a tracked file or
committing does not touch the directory's mtime, so a busy clone looked idle, and
nothing told merged work from unpushed work. An entry that is, or holds, a git
repository (up to three levels down) is now judged per repository:

- **Removed** when the bot's own report says it is clean (no modified, staged or
  untracked file — ignored files do not count — no merge, rebase, cherry-pick or
  bisect in progress, no stash) and **fully pushed** (every commit of `HEAD` and of
  every local branch is on some remote-tracking ref, which covers "branch merged
  into origin's default branch" and "pushed with no local changes"), it is not the
  base of a linked worktree or the alternate of another clone, and nothing in it
  changed for longer than the idle TTL.
- **Kept, with an attention signal** (Attention queue, source
  `bot_disk_lifecycle`, one card per clone naming the bot, the clone's path, its
  branch and why) when it holds unpushed work — uncommitted changes, an operation
  in progress, a stash, or commits on no remote — and has been idle longer than
  the TTL. The card goes away when the work is pushed or discarded, the clone is
  touched, or it is removed. Nothing is ever deleted for such a clone.
- **Kept silently** otherwise: recently active, no report yet, or a failed
  inspection.

The board does not run git on a bot's directory itself: git executes programs a
repository's config names, which on the host would hand a bot code execution
outside its container, and the container paths (alternates under `/cache/git`,
linked worktrees under `/workspace`) do not resolve there anyway. The dev image's
`bot-clone-hygiene` (started by the entrypoint, every 15 minutes, `nice`d, read-only)
inspects the clones inside the container as the bot user and writes
`hermes/.myrmidon/clone-hygiene.json`; the board reads that file. A report can at
worst make the board remove a clean-looking directory of that same bot, so before
removing anything it checks that the path is a real directory inside the bot's own
volume reached through no symbolic link, and walks the tree to require that no
file or directory changed since the report was written or within the idle TTL
(node_modules is not entered, and a hard-linked file is judged by its mtime, since
another link to it changes its ctime). A bot on an image without the reporter
simply never has a clone removed.

One case is kept rather than removed: a branch merged by **squash** whose remote
branch was then deleted and pruned has commits on no remote-tracking ref, so it is
reported as unpushed work until the operator or the bot discards the clone. A
fetch that has not pruned the remote-tracking branch counts as pushed.

## Settings

All keys live in `instance_settings.general.botDisk` and apply on the next
reconcile pass or maintenance tick without a restart (`GET` and `PATCH
/api/myrmidon/bot-disk`, or Instance → General, "Shared package cache for
bots"); a PATCH that names one key keeps the others, and `null` returns a key to
its default:

| Key | Default | Meaning |
|---|---|---|
| `sharedPackageCachePath` | unset | The shared cache directory (above) |
| `gitMirrorRepos` | `[]` | `owner/repo` names to mirror; empty: no mirrors and no `/cache/git` mount. Needs `sharedPackageCachePath` |
| `gitMirrorRefreshMs` | `900000` (15 min) | How often each mirror is fetched, 1 min to 24 h |
| `pnpmStore` | `workspace` | `workspace` or `shared` (above) |
| `idleTtlMs`, `enabled` | 6 h, on | The draft lifecycle of BOT-DISK A, which the clone hygiene follows |

## Enabling git mirrors (operator steps)

1. The shared cache steps above are done (`packageCacheRoot` in dockergate).
2. Create the mirror directory owned by the **board's** user — it writes the
   mirrors — and world-readable, so bots (uid 10001) can read it through the
   read-only mount. Docker would otherwise create a missing bind source as root,
   and the board could not write into it:

   ```sh
   install -d -o <board user> -m 0755 /srv/package-cache/git
   ```

   The board process must see the same path (it reads and writes the cache
   directory directly); a board running in a container needs it mounted at the
   same path.
3. dockergate needs no new key: the `git` subdirectory of `packageCacheRoot` is
   accepted as a **read-only** bind to `/cache/git`, and a writable one is
   refused. Reload it (`SIGHUP`) only if you changed the root.
4. List the repositories: `PATCH /api/myrmidon/bot-disk` with
   `{"gitMirrorRepos": ["owner/repo"]}` (or the panel). For a private repository
   give the server a `GITHUB_TOKEN` that can read it.
5. The first refresh runs on the next maintenance tick (clones the whole
   repository once). Bots are recreated with the new bind on the next reconcile
   pass; their next `git clone` of a listed repository borrows the mirror. Check
   `ls /srv/package-cache/git/<owner>/<repo>.git/myrmidon-fetched-at` on the
   host, and `cat .git/objects/info/alternates` in a fresh clone.
6. Existing clones stay as they are. To drop their duplicate objects, a bot can
   re-clone, or run `git repack -a -l -d` after adding the alternate by hand.

Turning it off: `{"gitMirrorRepos": null}` (the bind goes away on the next pass).
**Do not delete a mirror while a clone borrows it** — the clone would lose
objects; empty the setting, let the bots' clones be removed or re-cloned, then
delete the directory.

## Expected savings

For a development bot with several clones of one repository (this repository's
object database is about 1.7 GiB packed):

- **Objects:** the first clone stays unchanged until the mirror exists; every
  clone after that, on any bot of the host, stores only its own objects, so
  *N* clones cost one mirror (about 1.7 GiB once on the host) plus a few
  megabytes each, instead of *N* × 1.7 GiB. Four clones on each of ten bots is
  about 68 GiB of object databases before, about 2 GiB after.
- **node_modules:** a copy per clone becomes a hard link per file, which costs a
  directory entry and an inode, not the content: the content is stored once per
  bot (`workspace`) or once per host (`shared` on a reflink filesystem). The
  saving per extra clone is the size of its `node_modules` (typically one to a few
  GiB for a monorepo of this size; not measured here).
- **Reclaiming:** clean, pushed, idle clones are removed instead of waiting for a
  human, and the lifecycle's removal of a clone with a hard-linked `node_modules`
  frees only the entries not shared with another clone or the store.

The savings are an estimate from the object and package sizes above; the
runtime proof is the hard-link check and the `git clone` alternates test in CI.

## Trade-offs of the mirrors and the workspace store

Git objects are shared read-only: no bot can change another's history. The
mirror is trusted as the board's own fetch (it is as trustworthy as the upstream
and the token). A clone made with an alternate depends on the mirror directory
for its history, which is why the mirror never prunes. With `pnpmStore: workspace`
the store belongs to one bot and grows with its installs; pnpm's own
`store prune` (run through `devbuild`) reclaims packages no clone uses.

## Bots on a fleetd host

A bot whose card names a fleetd host does not get the cache: fleetd builds its
own container template without the cache binds, and the path names a directory
on the board's host. The compiler leaves the variables out for such a bot, and
the fleetd driver logs once that the cache is not applied there. The same holds
for the git mirrors (no `/cache/git` mount, so a clone there is a full one) and
for the workspace pnpm store variable.

## Trade-offs of the shared cache

All bots on the host share the cache read-write, so one bot can change what
another later reads from it. pnpm checks the integrity of what it imports from
its store, but Go's build cache and Gradle's caches are trusted as found. Turn
the cache on only for bots that already trust each other (the same team's
development bots); keep it off where bots must stay isolated.
