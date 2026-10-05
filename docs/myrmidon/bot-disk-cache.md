# Shared package cache and git objects for bot containers (1.6.1-BOT-DISK-B, 1.6.2-BOT-DISK-C, BOT-DISK-D, BOT-DISK-F)

Development bots download the same pnpm packages, Go modules and Gradle
dependencies again and again, each into its own volume. With the shared package
cache, every bot on the board's own host mounts one set of cache directories
read-write and the downloads are kept once.

## What a bot gets

Every bot container has exactly **one** bind for its own data (the bot's whole
directory under the volume root, mounted at `/bot`; see
[The bot's single mount](#the-bots-single-mount)). When the instance setting is
set, the local driver adds four more binds to every bot container on the default
host, after the card's extra mounts:

| Host directory | Mount point in the bot | Variable written to `hermes/.env` |
|---|---|---|
| `<cache>/pnpm` | `/cache/pnpm` | `npm_config_cache_dir` (a download cache only; the pnpm **store** is never here, see [Hard-linked node_modules](#hard-linked-node_modules)) |
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

### The bot's single mount

link(2) refuses to cross a mount point (`EXDEV`) even when two mounts come from the
same host filesystem (ext4 included). A bot container used to get three separate
binds (`hermes` at `/data/hermes`, `workspace` at `/workspace`, `scratch` at
`/scratch`) plus the cache binds, so a hard link from the pnpm store into a clone
failed everywhere, pnpm quietly fell back to **copying**, and every clone's
`node_modules` was a full copy (link count 1; a bot's disk grew by about 5 GB per
hour).

Now a bot container has **one** bind for its writable data: the bot's directory
`<volume root>/<bot key>` is mounted at `/bot`, and `hermes/`, `workspace/` and
`scratch/` are directories inside it. The three paths bots and tools know are links
made by the image, not mounts:

| Path in the container | Is |
|---|---|
| `/data/hermes` (`HERMES_HOME`, `HOME`) | link to `/bot/hermes` |
| `/workspace` (the working directory) | link to `/data/workspace`, which links to `/bot/workspace` |
| `/scratch` | link to `/data/scratch`, which links to `/bot/scratch` |

The host layout is unchanged (`<root>/<key>/{hermes,workspace,scratch}`), so
nothing on disk moves. The read-only and shared cache mounts stay separate binds
(`/cache/pnpm`, `/cache/go-mod`, `/cache/go-build`, `/cache/gradle`, `/cache/git`).
The profile, the applied-state marker and the clone-hygiene report are read and
written at their real paths under `/bot/hermes`. The helper containers that
prepare the volumes and lay the profile down keep their three narrow binds: they
only write files and never need a hard link. dockergate accepts the bot body
with the single `<root>/<key>:/bot` bind and the helper body with the three
narrow ones; `/bot` and `/data` are reserved container paths a card mount cannot
take.

### Hard-linked node_modules

pnpm keeps one content-addressed store and links each project's `node_modules`
to it with hard links. With the bot's tree one mount, the store sits inside it:

- **Store**: `/workspace/.pnpm-store` by default (setting `pnpmStoreDir`; any
  path under `/workspace`, `/data`, `/scratch` or `/bot`), set as
  `npm_config_store_dir` in the image, in the entrypoint's self-check and in the
  profile's `.env` (for bots with the shared cache) from the same setting. The
  lifecycle sweep never treats the store as a draft. A store outside the single
  mount is refused by the settings API.
- **Import method**: `package-import-method=hardlink` (setting
  `pnpmImportMethod`, default `hardlink`; `clone-or-copy` and `copy` are explicit
  opt-outs). `hardlink` makes pnpm try only hard links. It does **not** make a
  refused link an error: pnpm 9 (tested with 9.15) falls back to copying when the
  kernel returns `EXDEV`, silently, whatever the method. The guards that see it are
  the image build check and the start-time self-check below.
- **`/cache/pnpm` is a download source only**: it is the pnpm metadata cache
  (`npm_config_cache_dir`), never the store. The former `pnpmStore: "shared"`
  mode, which put the store there and copied on ext4, is gone; a stored
  `pnpmStore` value is ignored.
- The runtime writes no `.npmrc`; every pnpm run in the container reads the
  variables above (image `ENV`, the profile `.env`).

One copy of each package per bot is hard-linked into every clone of that bot,
whichever root the clone is in (`/data/hermes/cache/*`, `/workspace/*`,
`/data/hermes/work/*`, `/scratch/*`). A hard link is the same file: a bot that
edits an installed file in `node_modules` in place also edits the store copy and
its other clones (pnpm's store integrity check, on by default, notices on a later
install). The store is per bot, so this never crosses bots.

**Start-time self-check.** At every container start the entrypoint creates a file
in the pnpm store directory and tries to hard-link it into each clone root
(`/data/hermes`, `/workspace`, `/scratch`). A failure is logged as
`ERROR: hard-link self-check: ...` and written to
`/data/hermes/.myrmidon/hardlink-check.json`; the clone-hygiene reporter copies it
into its report (`hardlinkCheck`), and the board raises an attention card (source
`bot_disk_lifecycle`, one per failing root) that goes away when the bot restarts
and the check passes. The check never stops the gateway.

`docker/bot-runtime/pnpm-hardlink-check.sh` proves the behaviour from every clone
root: it installs a local tarball package offline into a project under each root
and prints the installed file's link count, one line per root. The dev image's
build runs it as uid 10001 against the image's own pnpm for `/data/hermes`,
`/workspace` and `/scratch` and fails the build on a copy, and
`scripts/myrmidon/bot-runtime/pnpm-hardlink.test.mjs` runs it in CI, including the
negative case of a store on another mount, which shows up as a copy (link count 1)
although the install succeeds.

### Migrating running bots to the single mount

Nothing on the host moves, so a bot only needs a new container. Per bot, with the
board running the reconcile pass (or by hand):

1. **Pause** the bot's agent in the board (no new runs; wait for open turns).
2. Roll out the new bot image and board (the container template changes: the
   three binds become `<root>/<key>:/bot`; the drift check sees it and recreates
   the container on the next pass, which also needs the matching dockergate: it
   refuses the new body otherwise, with `binds_mismatch`).
3. **Recreate** the container (the reconcile pass does it; a stopped bot is
   recreated by `recreate`).
4. **Verify**: `docker inspect` shows one bind `...:/bot` and no `/data/hermes`,
   `/workspace` or `/scratch` mounts; the container log has
   `hard-link self-check ok`; inside, `stat -c %h` on a file of an existing
   clone's `node_modules` stays 1 (old installs are still copies) while a fresh
   `pnpm install` gives a count above 1.
5. **Resume** the agent.

Existing clones keep their copied `node_modules` until they are reinstalled
(`rm -rf node_modules && pnpm install`) or reaped by the lifecycle; the store they
link into is the one at `pnpmStoreDir`, which is created on first use. Roll back
by deploying the previous image and dockergate (the host layout is the same).

### Isolation scope: who shares a disk

By default every bot keeps its own disk (the single mount above) and shares nothing. For
bots that work on the same code the owner can choose, per **scope instance**, to put the
members on one shared root (BOT-DISK-F): one directory with **one pnpm store** and a
subdirectory per bot, so a hard link works within a bot **and across the bots of the
instance**, and a package is stored once for all of them. Different instances never share
a directory: developers sharing a root cannot see a marketing bot's tree.

**Where an agent's scope comes from.** Seven levels, most specific first; the first level
whose scope instance has an explicit setting decides, and nothing configured means the default
(the agent's own disk):

| # | Level | Scope instance | Identified by |
|---|---|---|---|
| 1 | agent override | one agent | "keep isolated" on the agent (and its own choice between several groups or projects) |
| 2 | explicit named group | a group, any agents as members | the group's id |
| 3 | caste | everybody with one role | `agents.role` (a key of the company caste directory) |
| 4 | reporting subtree | a lead and everyone under it | the lead's agent id, through `agents.reports_to`; the nearest configured lead above an agent wins |
| 5 | project | agents working in one project | the project id (an agent leads a project or is a joined member of it) |
| 6 | installed catalog team | agents installed from one catalog team | `metadata.paperclip.catalogTeam.catalogId` |
| 7 | company | everybody | the company |

An instance set to **isolated** is an explicit "each member keeps its own disk" and stops the
search (a lower level that is shared does not apply to those members); **shared root** gives the
members one directory. The resolver is one pure module (`packages/shared/src/myrmidon-isolation-scope.ts`)
that other policies can reuse with their own settings: the container scope will use it later.

**Groups** are first-class: create, rename, delete and change the members in Instance settings,
"Disk isolation of bots" or through the API, with no restart; the group's page lists the members
and its isolation setting (*does not define isolation*, *isolated*, *shared root*). An agent may
be in several groups, but only one may define its isolation scope: when two or more of an agent's
groups have a setting the agent is flagged **group conflict** and the owner must choose which one
decides. An agent in several projects that each have a setting is flagged **project ambiguous**
in the same way. Until the choice is made the agent stays isolated (nothing is shared on a guess)
and cannot be applied. A conflict that a higher level already settles (an agent override, or a
group, caste or reporting subtree when the projects are in question) is not reported.

**Host layout.** A shared instance is the directory `<shared root>/<kind>-<id>/` with one pnpm
store (`.pnpm-store`) and one subdirectory per member bot:

```
<shared root>/caste-<company>-engineer/
  .pnpm-store/
  <botKey-1>/{hermes,workspace,scratch}
  <botKey-2>/{hermes,workspace,scratch}
```

The shared root is `MYRMIDON_BOT_SCOPE_ROOT` (default `<volume root>/.scopes`: a bot key never
begins with `.`; keep it on the **same filesystem** as the volume root, so a migration is a rename).
Caste and catalog ids are only unique per company, so their directory names carry the company id.

**In the container.** A member has ONE bind, the instance directory at `/bot-scope`, and no
`/bot`. A tmpfs over `/data` holds the three links `/data/hermes`, `/data/workspace`,
`/data/scratch`, which the entrypoint points into `/bot-scope/<botKey>/...` (the bot key arrives in
the one non-secret variable `MYRMIDON_BOT_SCOPE_SUBDIR`); `/workspace` and `/scratch` stay links
through `/data`. The profile writes `npm_config_store_dir=/bot-scope/.pnpm-store` for every member
(with or without the shared package cache); the start-time self-check runs from that store into the
member's three roots. The image must declare the label `myrmidon.bot-runtime.scope=1` (this image
does; its `WORKDIR` is now `/` because `/workspace` does not resolve before the links exist): the
driver refuses to create a member from an image without it.

**Restart required.** Changing a group, a setting or an agent's choice changes what the agent
*resolves to* at once, but the board keeps the container on the layout the owner last **applied**.
The difference shows on the agent as **restart required**. Nothing restarts by itself: the owner
presses *Apply and restart* (per agent) or *Apply to all*, and the reconcile pass then sees the
bind difference as a template drift and recreates the container through its maintenance window.

**Changing an agent's scope (what runs on restart, in order).**

1. *Pause*: the reconcile pass opens the agent's maintenance window and waits for the open runs.
2. *Check*: the migration plan is computed from the live container's binds (where it is now) and the
   applied layout (where it goes). The three directories move whole (`rename`) onto an **absent or
   empty** target; a target that holds data, a source that is a link or a file, or a volume root the
   board cannot see **refuses the whole change before anything is stopped**, and the bot keeps
   running on its old layout. Nothing is ever deleted or merged. An interrupted earlier run is
   recognised (the source is gone, the target is there) and completed.
3. *Prepare* the volumes of the new layout (the prepare helper also hands the instance directory
   to the bot's uid) and *create* the replacement with the new binds, **while the old container
   still runs**: a refusal by dockergate or the daemon (a bot not yet enrolled, a missing image)
   changes nothing. Then *stop* the old container, *move* the directories (a failing step undoes
   the ones before it and the old container is started again), and swap the replacement in.
4. *Self-check*: the new container checks hard links from the store at start; a failure is raised as
   an attention card like any other.
5. *Resume*: the maintenance window closes and the agent runs again.

The bot's old private pnpm store (`workspace/.pnpm-store`) moves along with its workspace and stays
unused; remove it by hand when convenient (the migration never deletes). If the board cannot see
the volumes (the usual production layout), do the move by hand with the bot paused and stopped:
`mkdir -p <shared root>/<instance>/<botKey>` then `mv <volume root>/<botKey>/{hermes,workspace,scratch}`
into it (or back), start the bot, and apply the change on the board.

**dockergate.** The gate accepts a shared-instance bind only for a bot enrolled for that instance
(`bots[].scopeInstances`) and only the instance's own directory, never the root or a sibling; see
[dockergate.md](dockergate.md#members-of-a-shared-isolation-scope-bot-disk-f). Enrol the bots
**before** applying.

**Trade-offs: read this before sharing a root.** The members of an instance run as the same uid and
each container mounts the whole instance directory, so a bot can read and write **every other
member's** `hermes/` (profile, `.env` with its keys), `workspace` and `scratch`. Share only between
bots that trust each other with that (the point of the levels is that a marketing bot is in another
instance than the developers). A hard link is the same file: editing an installed file in
`node_modules` in place edits the store copy and every clone of every member (pnpm's integrity check
notices on a later install). A shared store is also written by several bots at once; pnpm's store is
built for concurrent writers. A single failing disk or a full volume now affects the whole instance.

**Where agents' projects come from.** The board has no agent-to-project table; an agent is in a
project when it leads it or has a joined `project_memberships` row keyed by its id.

**API.** `GET /api/myrmidon/companies/:companyId/bot-scopes` (agents with their effective scope, source,
problems, applied layout and `restartRequired`; groups; configured instances); writes need instance-admin
rights: `POST|PATCH|DELETE .../bot-scopes/groups[/:groupId]`, `PUT|DELETE
.../bot-scopes/settings/:kind/:scopeId` (`{"mode":"isolated"|"shared"}`), `PUT .../bot-scopes/agents/:agentId`
(`isolate`, `groupId`, `projectId`), `POST .../bot-scopes/agents/:agentId/apply` and `POST
.../bot-scopes/apply-all`. Tables: `myrmidon_scope_groups`, `myrmidon_scope_group_members`,
`myrmidon_scope_settings`, `myrmidon_scope_agent_prefs` (migration `0300_bot_isolation_scope`).

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

**Where it runs.** The board server has no mount of the bot volumes (host mounts
were removed from it in 1.3.0), so it can neither inspect nor delete a clone: the
board-side sweep of BOT-DISK A finds no volume root, logs one warning and does
nothing, and zero bytes were ever reclaimed that way. The deletion therefore
happens inside each bot container, where the files are. The dev image's
`bot-clone-hygiene` (started by the entrypoint, every 15 minutes, `nice`d, as the
bot user) applies the policy itself: the profile compiler writes
`MYRMIDON_CLONE_IDLE_TTL_SEC` (the lifecycle's idle TTL, `0` when the lifecycle
is off) into the bot's `.env`, re-read on every pass, so a settings change applies
without a restart. In the same pass that inspects a repository it removes it only
if it is clean, fully pushed, not a worktree base or alternate, and nothing in it
changed for longer than the TTL (node_modules is not entered, and a hard-linked
file is judged by its mtime, since another link to it changes its ctime). It also
removes a top-level directory of `/workspace` that holds no repository and has
been idle past the TTL, unless it carries a `.heartbeat` marker or its name starts
with a dot (the pnpm store). A removal path must be a real directory inside the
root, reached through no symbolic link. The policy is written only for bots of the
`sharedCacheRoles` roles; a bot on an image without the reporter never has a clone
removed. The board only reads the report (the driver fetches
`/data/hermes/.myrmidon/clone-hygiene.json` from the running container; git is
never run by the board on a bot's directory, since repository config can name
programs to execute) and raises the attention cards. If the board can neither see
the volume root nor receive any report for 24 hours, it raises one card, "Lifecycle
not effective".

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
| `pnpmStoreDir` | `/workspace/.pnpm-store` | The pnpm store, a path under `/workspace`, `/data`, `/scratch` or `/bot` (above) |
| `pnpmImportMethod` | `hardlink` | `hardlink`, `clone-or-copy` or `copy` (above) |
| `sharedCacheRoles` | `engineer`, `reviewer`, `devops`, `release`, `qa` | Roles whose bots get the cache and mirror mounts; other bots get none and are not recreated when the cache is enabled |
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
  bot, on any filesystem including ext4. The
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
for its history, which is why the mirror never prunes. With the default store inside the bot's mount
the store belongs to one bot and grows with its installs; pnpm's own
`store prune` (run through `devbuild`) reclaims packages no clone uses.

## Bots on a fleetd host

A bot whose card names a fleetd host does not get the cache: fleetd builds its
own container template without the cache binds, and the path names a directory
on the board's host. The compiler leaves the variables out for such a bot, and
the fleetd driver logs once that the cache is not applied there. The same holds
for the git mirrors (no `/cache/git` mount, so a clone there is a full one) and
for the pnpm store variables. (A fleetd bot builds its own container, outside this single-mount layout.)

## Trade-offs of the shared cache

All bots on the host share the cache read-write, so one bot can change what
another later reads from it. pnpm checks the integrity of what it imports from
its store, but Go's build cache and Gradle's caches are trusted as found. Turn
the cache on only for bots that already trust each other (the same team's
development bots); keep it off where bots must stay isolated.
