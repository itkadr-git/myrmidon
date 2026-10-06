# Bot containers: extra read-only mounts

A bot container gets exactly three volumes from the driver: `/data/hermes`,
`/workspace` and `/scratch`. Everything a bot needs beyond that — shared source
trees, templates, common tools — used to be copied into each bot's
`/workspace/shared`, so every source update had to be pushed to every bot again.

This feature lets a card mount an operator-approved host directory into the
container as an extra **read-only** volume. The bot sees the files where they
live on the host; nothing is copied, and the bot cannot write to them.

Russian version: [bot-extra-mounts.ru.md](bot-extra-mounts.ru.md).

## Instance setting: `MYRMIDON_BOT_MOUNT_SOURCES`

The whitelist of host directories a card may mount. A comma-separated list of
absolute paths:

```
MYRMIDON_BOT_MOUNT_SOURCES=/srv/shared/sources,/srv/shared/tools
```

* Unset or empty means **no extra mount is allowed** (fail-closed).
* A card can only name a directory from this list, and only by its exact path —
  there is no prefix rule, so naming `/srv/shared` does not allow
  `/srv/shared/sources`.
* The value is read once at server start (`startBotContainers`, W2a). Changing
  it takes effect after the board server restarts; a bot whose mount set then
  differs from its card is recreated, because the bind list is part of the
  container template.

## Card setting: `adapterConfig.container.extraMounts`

```jsonc
{
  "container": {
    "enabled": true,
    "image": "ghcr.io/example/runtime@sha256:…",
    "memoryMb": 2048,
    "cpus": 1,
    "pidsLimit": 512,
    "extraMounts": [
      { "source": "/srv/shared/sources", "path": "/srv/shared/sources", "readOnly": true }
    ]
  }
}
```

* `source` — an absolute host directory; it must be listed in
  `MYRMIDON_BOT_MOUNT_SOURCES`.
* `path` — the absolute mount point inside the container.
* `readOnly` — optional, defaults to `true`. `false` is refused: a shared
  directory is never mounted writable.
* A missing `extraMounts` means the bot keeps its three fixed volumes only.

The driver builds the bind as `host:container:ro` and appends it after the three
fixed binds. The helper containers that prepare the volumes and apply the profile
never get an extra mount — they only touch the three bot volumes.

## A mount point inside the bot's own volume (1.6.5-BOT-DISK-H, class J)

`path` used to be refused anywhere inside `/data/hermes`. It is now allowed
under three subtrees of the bot's own volume — `.hermes/shared`, `media` and
`work` — and only there (the epic design's class J: a card hands the bot a
directory it could not otherwise reach, at a path the bot is used to).

The driver binds such a mount at that subtree's **real** path inside the bot's
own mount, not at the path the card wrote: `/bot/hermes/media/site` for a bot
with the single mount (`/bot`), `/bot-scope/<botKey>/hermes/media/site` for a
member of a shared isolation scope, and `/data/hermes/media/site` for a
contract-`1` image. The path the card writes is the one the bot reads, so the
entrypoint's own `/data/hermes` link keeps working either way.

Everything else under `/data/hermes` — `bin`, `lazy-packages`, `lsp`, the rest
of `.hermes` — stays refused, so a card can neither shadow the shared runtime
(see below) nor write into it; extra mounts are read-only in any case.

## The shared bot runtime (1.6.5-BOT-DISK-H, class C)

When the instance setting `general.botDisk.sharedBotRuntimePath` names a host
directory, the driver adds three read-only binds of its `bin`, `lazy-packages`
and `lsp` subdirectories over the bot's own runtime paths — the same three
paths, in the same real-path form as above, so one copy on the host replaces one
copy per bot (5–7 GiB each). The board's instance settings and the operator step
are in
[SETTINGS.md](SETTINGS.md#161--bot-disk-b-shared-package-cache-for-bot-containers).

## What is refused, and why

| Rule | Reason |
|---|---|
| source is not in `MYRMIDON_BOT_MOUNT_SOURCES` | the card must not reach a host directory the operator did not name |
| source is relative, has `..`, `//`, a trailing `/`, a backslash, a control character, or is `/` | two spellings of one directory would compare unequal, and `/` would hand over the host |
| `readOnly` is `false` | extra mounts are read-only by design |
| `path` is relative, unsafe, or is `/workspace`, `/scratch`, `/tmp`, `/data/hermes` itself, or a path inside one of them | the driver's own mounts and the image's tmpfs must not be shadowed — the three owner-data subtrees of `/data/hermes` are the exception above |
| the same `path` is used twice | Docker would refuse the create anyway |

A refused mount is an error of the reconcile pass (visible in the activity log);
the container is not created with it and the existing container is left alone.
Failure messages name the field, never a secret.

## dockergate

In production the board talks to the Docker daemon through
[dockergate](dockergate.md), which rebuilds every create body from its own
configuration and compares the bytes. Two things changed there:

* the configuration gained `mountSources` — the same list of host directories,
  enrolled on the dockergate side as well — and `botRuntimeRoot`, the host
  directory of the shared bot runtime;
* a create body for a bot may now carry, after its fixed bind, only reads:
  the cache pairs, the runtime pairs (`<botRuntimeRoot>/{bin,lazy-packages,lsp}`
  at the path the driver really uses inside the bot's own mount, read-only) and
  an allowlisted class J mount at its real path. Anything else is denied with
  `mount_source_not_allowed` (source not enrolled, or a writable bind that is
  not a cache pair) or `binds_mismatch` (reserved target, duplicate target,
  wrong target for the pair, wrong order).

The helper forms still require exactly the three binds.

## What the reviewer should check

* `buildBinds` appends `…:ro` for an allowlisted mount and throws for one that
  is not (server unit tests).
* `buildBinds` appends the three runtime binds at the real path inside the bot's
  own mount (single mount, shared scope, contract `1`), and returns the fixed
  bind alone when the instance setting is unset; the reserved-path check lets the
  three owner-data subtrees through and nothing else.
* dockergate accepts the runtime pairs only under `botRuntimeRoot` and only at
  that real path — another root, another subdirectory, another mount point or
  `rw` is refused — and accepts a class J mount at its real path while refusing
  the runtime subtrees (`policy` unit tests).
* `docker-driver` puts the extra mount into `HostConfig.Binds`, and
  `containerTemplateDrifted` reports a drift when the bind list changes (so a
  card edit recreates the bot).
* dockergate accepts an allowlisted read-only extra bind end to end and denies a
  source outside `mountSources` before anything reaches the daemon.

## Not in this change

* A writable extra mount (a shared directory that several bots write to needs its
  own design: ownership, locking, concurrent apply).
* Per-project (direction) defaults for `extraMounts`: the setting lives on the
  agent card, not on a project.
* A UI field for `extraMounts` in the card's Container section — the value is
  entered in `adapterConfig` for now.
* Mounting a single file (only directories are supported), and any mount whose
  source does not exist on the host (Docker would create it as root, 0755).