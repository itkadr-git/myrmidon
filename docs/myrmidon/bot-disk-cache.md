# Shared package cache for bot containers (1.6.1-BOT-DISK-B)

Development bots download the same pnpm packages, Go modules and Gradle
dependencies again and again, each into its own volume. With the shared package
cache, every bot on the board's own host mounts one set of cache directories
read-write and the downloads are kept once.

## What a bot gets

When the instance setting is set, the local driver adds four binds to every bot
container on the default host, after the card's extra mounts:

| Host directory | Mount point in the bot | Variable written to `hermes/.env` |
|---|---|---|
| `<cache>/pnpm` | `/cache/pnpm` | `npm_config_store_dir` |
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

The path is an instance setting, `instance_settings.general.botDisk`:

- Instance → General, panel "Shared package cache for bots", or
- `GET /api/myrmidon/bot-disk` (any board member) and
  `PATCH /api/myrmidon/bot-disk` with `{"sharedPackageCachePath": "/abs/path"}`
  (instance admins only); `null` or an empty string turns the cache off.

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

## Bots on a fleetd host

A bot whose card names a fleetd host does not get the cache: fleetd builds its
own container template without the cache binds, and the path names a directory
on the board's host. The compiler leaves the variables out for such a bot, and
the fleetd driver logs once that the cache is not applied there.

## Trade-offs

All bots on the host share the cache read-write, so one bot can change what
another later reads from it. pnpm checks the integrity of what it imports from
its store, but Go's build cache and Gradle's caches are trusted as found. Turn
the cache on only for bots that already trust each other (the same team's
development bots); keep it off where bots must stay isolated.
