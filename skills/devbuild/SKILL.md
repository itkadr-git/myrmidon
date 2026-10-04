---
name: devbuild
description: >
  Run heavy builds, typechecks and tests for the current repository workspace
  on the shared build VPS instead of inside the CPU- and memory-limited bot
  container. Use when a command needs more than ~1 CPU core or ~3 GB RAM,
  times out locally, or needs a warm shared toolchain cache (pnpm, Go,
  Gradle). The local container stays for editing, git and pushing.
---

# devbuild: builds and tests on the build VPS

## When to use

- `pnpm -r typecheck`, `pnpm test`, `pnpm build`, `cargo build/test`,
  `go test`, `tsc --noEmit` — anything that OOMs or takes minutes in the bot
  container (its limits: 1 CPU, 3 GB RAM).
- You want to reuse the shared caches: one pnpm store, one Go module/build
  cache, one Gradle home for the whole team (under `/srv/devcache` on the VPS).
- You do NOT need devbuild for: editing files, `git add/commit`, opening PRs,
  reading code — do those locally in `/workspace`.

## The command

```
devbuild '<команда>'
```

It does three things: rsyncs `/workspace` to the VPS (`.git` included, so
commits made in the container travel with it; `node_modules`, `dist`,
`target`, `.cache` excluded), runs `<команда>` at the repo root on the VPS
with the shared caches exported, and returns the output and exit code
verbatim. Exit code of the remote command becomes the exit code of devbuild.

Examples:

```
devbuild 'pnpm install && pnpm -r typecheck'
devbuild 'pnpm --filter @paperclipai/db exec tsc --noEmit'
devbuild 'pnpm test:run'
devbuild 'go test ./...'
devbuild 'cd packages/paperclip-runner && cargo test --workspace'
devbuild 'uname -a'
```

## Connection settings (environment, never source code)

| Variable | Meaning | Example |
|---|---|---|
| `DEVBUILD_HOST` | VPS host or address | from the fleet operator |
| `DEVBUILD_USER` | ssh user on the VPS | `devbuild` |
| `DEVBUILD_BASE` | base dir on the VPS | `/srv/devbuild` |

Optional: `DEVBUILD_SSH_KEY` (default `/opt/devbuild-ssh/id_ed25519`),
`DEVBUILD_WORKSPACE` (default `/workspace`), `DEVBUILD_BOT_NAME` (default
`id -un` — the per-bot subdirectory of `DEVBUILD_BASE`), `DEVBUILD_KNOWN_HOSTS`.

The remote layout is `$DEVBUILD_BASE/<bot>/<repo>/` — each bot gets its own
repo copy; the caches are shared. The ssh key is mounted read-only by the
runtime template at `/opt/devbuild-ssh/id_ed25519`; ssh access is provisioned
by the fleet operator.

If `DEVBUILD_HOST`/`DEVBUILD_USER`/`DEVBUILD_BASE` are unset, devbuild exits 1
with a pointer to this skill — the connection env comes from the board's bot
profile, not from you.

## Shared caches (the whole point)

Before the remote command runs, devbuild exports:

| Variable | Path on the VPS |
|---|---|
| `npm_config_store_dir` | `/srv/devcache/pnpm` |
| `GOMODCACHE` | `/srv/devcache/go-mod` |
| `GOCACHE` | `/srv/devcache/go-build` |
| `GRADLE_USER_HOME` | `/srv/devcache/gradle` |

The directories are created on the first run. They are shared across all
bots — after the first bot runs `pnpm install`, the next one's install is
near-instant.

## Getting results back

- Output (stdout+stderr) and the exit code print directly in your terminal.
- Artifacts written inside the repo tree (e.g. `dist/`) come back with the
  next reverse sync — or just fetch them: `rsync` the file back, or read it
  through a second `devbuild 'cat path'` call.
- Commits: make them locally in `/workspace` (git works in the container);
  devbuild carries `.git` to the VPS, so the remote side sees your commits
  but you never need to pull anything back.

## Typical errors

| Symptom | Cause / fix |
|---|---|
| `DEVBUILD_HOST ... not set` and exit 1 | The bot profile has no devbuild env — ask the fleet operator (part D of BUILD-OFFLOAD). |
| `ssh key /opt/devbuild-ssh/id_ed25519 is missing` | The runtime template (part C) has not mounted the key yet. |
| `Permission denied (publickey)` | Key not authorized on the VPS — fleet operator's job. |
| `rsync: command not found` | Image too old; needs `rsync` in the dev runtime image. |
| First run is slow | Caches and the full repo (incl. `.git`) transfer once; subsequent runs transfer only the diff. |
| Command not found remotely | The command runs in the VPS's own shell; check the toolchain exists there (`devbuild 'node --version'`). |

## Limits

devbuild does not set CPU/memory limits for the remote command — that is the
fleet operator's configuration (part D of BUILD-OFFLOAD). It is transport
plus cache environment, nothing more.
