# Agent Runtime Image Family

Container images for running coding-agent harnesses in sandboxed environments (for example the kubernetes sandbox provider, stage 1 of the k8s contribution). Images are named `agent-runtime-{harness}:{version}` and published to `ghcr.io/itkadr-git/` by the `agent-runtime-images` workflow. The registry is overridable: every reference flows through the `REGISTRY` bake variable.

## Image Lineup

- **`agent-runtime-base`**: Foundation. Ubuntu 22.04 + Node 24 + git + tini + non-root user (uid 1000) + the agent shim.
- **`agent-runtime-opencode`**: Extends base with `opencode-ai` globally installed.
- **`agent-runtime-pi`**: Extends base with `@mariozechner/pi-coding-agent`.
- **`agent-runtime-codex`**: Extends base with `@openai/codex`.
- **`agent-runtime-gemini`**: Extends base with `@google/gemini-cli` plus headless auth-mode settings.
- **`agent-runtime-claude`**: Extends base with `@anthropic-ai/claude-code` (symlinked as `claude-code`).
- **`agent-runtime-hermes`**: Bake target; not in the workflow's publish target list.
- **`agent-runtime-omp`**: Standalone OMP runtime on Bun 1.4.3 with pinned `@oh-my-pi/pi-coding-agent` 18.9.2.

## Base Image Contents

**OS & Runtime:**
- Ubuntu 22.04
- Node.js 24 (via NodeSource APT repo)
- git
- tini (PID-1 init, ensures signal propagation)
- Non-root user `paperclip` (uid/gid 1000)

The NodeSource install puts `node` on the default `PATH`. The agent shim in this
image runs the harness directly with that `PATH`. The shim does not source a
login profile, and the runtime never writes a profile or an rc file. Some
sandbox providers instead wrap each command in a login shell. That shell sources
`/etc/profile` and the user profile files to read an owner-supplied `PATH`. No
exec path sources `nvm`. For the full exec-path contract, see
`packages/plugins/sandbox-providers/SANDBOX-REQUIREMENTS.md` and the
[SANDBOX-REQUIREMENTS Compliance](#sandbox-requirements-compliance) section below.

**Paperclip Binaries:**
- `/usr/local/bin/paperclip-agent-shim`: Go binary compiled from `tools/agent-shim/`. Reads `/run/paperclip/runtime-command.json` and `syscall.Exec`s the harness CLI.

**Defaults:**
- `USER`: 1000:1000 (paperclip, non-root)
- `WORKDIR`: `/workspace` (mount workspace volumes here)
- `ENTRYPOINT`: `/usr/bin/tini --` (PID-1 reaper, forwards signals)
- `CMD`: `/usr/local/bin/paperclip-agent-shim`

## Building Locally

All targets build `linux/amd64` by default (see `buildx-bake.hcl`). Derived images chain off the `base` target through bake `contexts`, so the literal registry in each `FROM` line is overridden at build time and the whole family builds in one pass without pushing intermediates.

```bash
docker buildx bake -f docker/agent-runtime/buildx-bake.hcl --load
```

### Custom tag or registry

```bash
REGISTRY=myregistry VERSION=mytag \
  docker buildx bake -f docker/agent-runtime/buildx-bake.hcl --load
```

## Quickstart Smoke Test

Build and verify the `agent-runtime-claude` image runs locally:

```bash
docker buildx bake -f docker/agent-runtime/buildx-bake.hcl base claude --load
docker run --rm ghcr.io/paperclipai/agent-runtime-claude:dev claude-code --version
```

## OMP Image

`docker/agent-runtime/Dockerfile.omp` uses `oven/bun:1.4.3-slim` directly (alpine is not suitable because `pi-natives` ships glibc binaries only and fails on musl with `Cannot find module pi_natives.linux-x64*.node`, OPE-7762). It does not inherit the Node/shim image and starts OMP as its container command (`CMD ["omp"]`). The process runs with uid/gid `1000:1000` (`USER 1000:1000`); `HOME=/home/paperclip` is set via `ENV`; `/home/paperclip` and `/workspace` are owned by `1000:1000`. `HOME`, XDG directories, and the OMP session directory are under `/home/paperclip`. `/workspace` is the working directory and workspace mount point. Ensure host-mounted writable directories are accessible to uid/gid 1000.

The Dockerfile runs smoke checks at build time without invoking a model or provider: exact Bun (`1.4.3`) and OMP (`18.9.2`) versions, `omp` on `PATH`, `omp --help`, and `omp models ls`.

## SANDBOX-REQUIREMENTS Compliance

Comparison of `agent-runtime-*` images against `packages/plugins/sandbox-providers/SANDBOX-REQUIREMENTS.md` based on Dockerfile instructions:

| Requirement | `base` | `claude` | `codex` | `gemini` | `opencode` | `pi` | `omp` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `node` on PATH | Ensured by Dockerfile (`RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x \| bash - && apt-get install -y --no-install-recommends nodejs`) | Inherited from base image `paperclipai/agent-runtime-base` — unverified by build (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-claude:<tag> -c 'command -v node sh tar'`) | Inherited from base image `paperclipai/agent-runtime-base` — unverified by build (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-codex:<tag> -c 'command -v node sh tar'`) | Inherited from base image `paperclipai/agent-runtime-base` — unverified by build (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-gemini:<tag> -c 'command -v node sh tar'`) | Inherited from base image `paperclipai/agent-runtime-base` — unverified by build (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-opencode:<tag> -c 'command -v node sh tar'`) | Inherited from base image `paperclipai/agent-runtime-base` — unverified by build (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-pi:<tag> -c 'command -v node sh tar'`) | Inherited from base image `oven/bun:1.4.3-slim` — unverified by build (`node` is not installed by `Dockerfile.omp`; `docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-omp:<tag> -c 'command -v node sh tar'`) |
| Required CLI on PATH (name) | Not ensured (image only contains `/usr/local/bin/paperclip-agent-shim` via `COPY --from=shim-build /out/paperclip-agent-shim /usr/local/bin/paperclip-agent-shim`, no agent CLI installed) | Ensured by Dockerfile (`RUN npm install -g @anthropic-ai/claude-code@latest ...`, `RUN CLAUDE_BIN="$(command -v claude)" && ln -s "$CLAUDE_BIN" /usr/bin/claude-code`, `RUN command -v claude-code >/dev/null 2>&1 \|\| ...`; name: `claude-code`) | Ensured by Dockerfile (`RUN npm install -g @openai/codex@latest ...`, `RUN command -v codex >/dev/null 2>&1 \|\| ...`; name: `codex`) | Ensured by Dockerfile (`RUN npm install -g @google/gemini-cli@latest ...`, `RUN command -v gemini >/dev/null 2>&1 \|\| ...`; name: `gemini`) | Ensured by Dockerfile (`RUN npm install -g opencode-ai@latest ...`, `RUN command -v opencode >/dev/null 2>&1 \|\| ...`; name: `opencode`) | Ensured by Dockerfile (`RUN npm install -g @mariozechner/pi-coding-agent@latest ...`, `RUN command -v pi >/dev/null 2>&1 \|\| ...`; name: `pi`) | Ensured by Dockerfile (`RUN ... bun add --global "@oh-my-pi/pi-coding-agent@${OMP_VERSION}" ... && ln -sf "$BUN_GLOBAL_BIN/omp" /usr/local/bin/omp ...`, `RUN ... command -v omp ...`; name: `omp`) |
| `sh` | Inherited from base image `ubuntu:22.04` — unverified by build (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-base:<tag> -c 'command -v node sh tar'`) | Inherited from base image `paperclipai/agent-runtime-base` — unverified by build (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-claude:<tag> -c 'command -v node sh tar'`) | Inherited from base image `paperclipai/agent-runtime-base` — unverified by build (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-codex:<tag> -c 'command -v node sh tar'`) | Inherited from base image `paperclipai/agent-runtime-base` — unverified by build (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-gemini:<tag> -c 'command -v node sh tar'`) | Inherited from base image `paperclipai/agent-runtime-base` — unverified by build (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-opencode:<tag> -c 'command -v node sh tar'`) | Inherited from base image `paperclipai/agent-runtime-base` — unverified by build (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-pi:<tag> -c 'command -v node sh tar'`) | Inherited from base image `oven/bun:1.4.3-slim` — unverified by build (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-omp:<tag> -c 'command -v node sh tar'`) |
| `tar` | Inherited from base image `ubuntu:22.04` — unverified by build (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-base:<tag> -c 'command -v node sh tar'`) | Inherited from base image `paperclipai/agent-runtime-base` — unverified by build (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-claude:<tag> -c 'command -v node sh tar'`) | Inherited from base image `paperclipai/agent-runtime-base` — unverified by build (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-codex:<tag> -c 'command -v node sh tar'`) | Inherited from base image `paperclipai/agent-runtime-base` — unverified by build (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-gemini:<tag> -c 'command -v node sh tar'`) | Inherited from base image `paperclipai/agent-runtime-base` — unverified by build (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-opencode:<tag> -c 'command -v node sh tar'`) | Inherited from base image `paperclipai/agent-runtime-base` — unverified by build (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-pi:<tag> -c 'command -v node sh tar'`) | Inherited from base image `oven/bun:1.4.3-slim` — unverified by build (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-omp:<tag> -c 'command -v node sh tar'`) |
| Writable workspace, HOME, cache directory, tmp directory | Ensured by Dockerfile for `HOME` and `~/.cache` (`RUN ... groupadd -g 1000 paperclip && useradd -u 1000 -g 1000 -d /home/paperclip -m -s /bin/bash paperclip`, `USER 1000:1000`); `WORKDIR /workspace` (no `chown`) and `/tmp` inherited from base image `ubuntu:22.04` — unverified by build (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-base:<tag> -c 'test -w /workspace && test -w "$HOME" && mkdir -p "$HOME/.cache" && test -w "$HOME/.cache" && test -w /tmp'`) | Inherited from base image `paperclipai/agent-runtime-base` — unverified by build (`USER 1000:1000`; `docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-claude:<tag> -c 'test -w /workspace && test -w "$HOME" && mkdir -p "$HOME/.cache" && test -w "$HOME/.cache" && test -w /tmp'`) | Inherited from base image `paperclipai/agent-runtime-base` — unverified by build (`USER 1000:1000`; `docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-codex:<tag> -c 'test -w /workspace && test -w "$HOME" && mkdir -p "$HOME/.cache" && test -w "$HOME/.cache" && test -w /tmp'`) | Inherited from base image `paperclipai/agent-runtime-base` — unverified by build (`USER 1000:1000`, additionally `RUN mkdir -p /home/paperclip/.gemini`; `docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-gemini:<tag> -c 'test -w /workspace && test -w "$HOME" && mkdir -p "$HOME/.cache" && test -w "$HOME/.cache" && test -w /tmp'`) | Inherited from base image `paperclipai/agent-runtime-base` — unverified by build (`USER 1000:1000`; `docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-opencode:<tag> -c 'test -w /workspace && test -w "$HOME" && mkdir -p "$HOME/.cache" && test -w "$HOME/.cache" && test -w /tmp'`) | Inherited from base image `paperclipai/agent-runtime-base` — unverified by build (`USER 1000:1000`; `docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-pi:<tag> -c 'test -w /workspace && test -w "$HOME" && mkdir -p "$HOME/.cache" && test -w "$HOME/.cache" && test -w /tmp'`) | Ensured by Dockerfile for workspace, HOME, and cache (`ENV HOME=/home/paperclip`, `ENV XDG_CACHE_HOME=/home/paperclip/.cache`, `RUN mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$OMP_SESSION_DIR" /workspace && chown -R 1000:1000 /home/paperclip /workspace`, `WORKDIR /workspace`, `USER 1000:1000`); `/tmp` inherited from base image `oven/bun:1.4.3-slim` — unverified by build (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-omp:<tag> -c 'test -w /tmp'`) |
| Login profiles unmodified | Ensured by Dockerfile (instructions modifying `/etc/profile` or rc files are absent in `Dockerfile.base`; `ENTRYPOINT ["/usr/bin/tini", "--"]`, `CMD ["/usr/local/bin/paperclip-agent-shim"]`) | Inherited from base image `paperclipai/agent-runtime-base` — unverified by build (no profile-modifying instructions in `Dockerfile.claude`; `docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-claude:<tag> -c 'ls -la /etc/profile "$HOME"/.profile "$HOME"/.bashrc 2>/dev/null \|\| true'`) | Inherited from base image `paperclipai/agent-runtime-base` — unverified by build (no profile-modifying instructions in `Dockerfile.codex`; `docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-codex:<tag> -c 'ls -la /etc/profile "$HOME"/.profile "$HOME"/.bashrc 2>/dev/null \|\| true'`) | Inherited from base image `paperclipai/agent-runtime-base` — unverified by build (no profile-modifying instructions in `Dockerfile.gemini`; `docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-gemini:<tag> -c 'ls -la /etc/profile "$HOME"/.profile "$HOME"/.bashrc 2>/dev/null \|\| true'`) | Inherited from base image `paperclipai/agent-runtime-base` — unverified by build (no profile-modifying instructions in `Dockerfile.opencode`; `docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-opencode:<tag> -c 'ls -la /etc/profile "$HOME"/.profile "$HOME"/.bashrc 2>/dev/null \|\| true'`) | Inherited from base image `paperclipai/agent-runtime-base` — unverified by build (no profile-modifying instructions in `Dockerfile.pi`; `docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-pi:<tag> -c 'ls -la /etc/profile "$HOME"/.profile "$HOME"/.bashrc 2>/dev/null \|\| true'`) | Ensured by Dockerfile (instructions modifying `/etc/profile` or rc files are absent in `Dockerfile.omp`; `CMD ["omp"]`) |

Each "Inherited from base image `<name>` — unverified by build" cell includes its per-image verification command (`<tag>` is `dev` for a local bake build or a verified CI tag/digest).

## Build and Test

The `omp` target is defined in `docker/agent-runtime/buildx-bake.hcl` for `linux/amd64`. Bake defaults are `REGISTRY=ghcr.io/itkadr-git` and `VERSION=dev`.

Build locally for validation (this does not publish):

```sh
docker buildx bake -f docker/agent-runtime/buildx-bake.hcl omp --load
docker run --rm --user 1000:1000 \
  --mount type=bind,src=<session-dir>,dst=/home/paperclip/.local/share/omp/sessions \
  --mount type=bind,src=<workspace-dir>,dst=/workspace \
  ghcr.io/itkadr-git/agent-runtime-omp:dev --help
```

Replace `<session-dir>` and `<workspace-dir>` with real host directories; the container needs write access. To test an image published by CI, use a tag or digest verified in the successful workflow run rather than assuming `dev` exists:

```sh
docker run --rm --user 1000:1000 \
  --mount type=bind,src=<session-dir>,dst=/home/paperclip/.local/share/omp/sessions \
  --mount type=bind,src=<workspace-dir>,dst=/workspace \
  ghcr.io/itkadr-git/agent-runtime-omp:<verified-tag-or-digest> --help
```

## OMP SSH Runner

`docker/agent-runtime/Dockerfile.omp-ssh` (bake target `omp-ssh`, image
`agent-runtime-omp-ssh`) is the execution target for `omp_local` agents. The
agent is attached to a board **SSH environment** that points at a container from
this image. The omp CLI, its tool calls and the builds they start run in that
container, under its own memory, CPU and process limits. The board container
only syncs the workspace and the runtime assets over SSH and streams the output.

The image adds Bun and omp (pinned exactly like the board image), pnpm (the
repository's `packageManager`), the GitHub CLI, a C toolchain and
`openssh-server` to `agent-runtime-base`. sshd listens on port 2222. It accepts
only key authentication, for the user `paperclip`. The board's public key is
mounted read-only at `/etc/ssh/omp-runner/authorized_keys`. The host key is
generated on the first start into the `hostkeys` volume and survives a
recreate.

### Shared package cache (OPE-12722)

The runner shares the board's package cache the way the bot containers do. Set
`OMP_RUNNER_CACHE_DIR` in the env file (optional): a directory on the bot data
disk, e.g. `/srv/myrmidon-cache` — the board's
`general.botDisk.sharedPackageCachePath`. Without it the compose file uses
`${OMP_RUNNER_DATA_DIR}/cache`, a cache private to the runner that holds no
board mirrors (the git wrapper then simply does nothing). The compose file binds
two subdirectories into the container. Create both **before the first start**:
docker creates a missing bind source as root.

- `<OMP_RUNNER_CACHE_DIR>/git` → `/cache/git` (read-only). The board's git
  mirrors live there (`git/<owner>/<repo>.git`); the board writes and refreshes
  them, so the directory must belong to the **board's user** and be
  world-readable: `install -d -o <board uid> -m 0755 <OMP_RUNNER_CACHE_DIR>/git`.
  If docker creates it as root instead, the board cannot write its mirrors
  there. The image installs a small wrapper at `/usr/local/bin/git`, which the
  PATH resolves ahead of `/usr/bin/git`: a plain
  `git clone https://github.com/<owner>/<repo>.git` runs as
  `git clone --reference-if-able /cache/git/<owner>/<repo>.git …`, so the clone
  borrows the existing objects instead of downloading a full pack again. The
  wrapper is consume-only: no mirror is created or refreshed here, and any
  clone without a mirror (another host, a storage-deciding option such as
  `--dissociate` or `--filter`) runs unchanged. A clone never fails because of
  the wrapper.
- `<OMP_RUNNER_CACHE_DIR>/pnpm-omp` → `/cache/pnpm` (read-write). The runners'
  **own** directory, owned by uid 1000:
  `install -d -o 1000 -g 1000 -m 0755 <OMP_RUNNER_CACHE_DIR>/pnpm-omp`. It is
  deliberately not `<OMP_RUNNER_CACHE_DIR>/pnpm`: the hermes bots (uid 10001)
  mount that one and their prepare step re-owns it, so a runner that chowned it
  would flip the owner back and forth and break one side. The entrypoint writes
  `/etc/profile.d/omp-runner-cache.sh` with both
  `npm_config_cache_dir=/cache/pnpm` (pnpm's metadata cache) and
  `npm_config_cache=/cache/pnpm` (npm's tarball and `_cacache` download cache;
  pnpm and npm read different names — pnpm `cache-dir`, npm `cache` — so the
  shared directory is exported under both and both tools' downloads land on
  the shared mount instead of per-runner `~/.npm`) when uid 1000 owns the
  mount (sshd does not pass container environment variables to logins, and
  profile.d is what every board-spawned SSH command and agent shell sources).
  It fixes only a root-owned directory (docker created it) and never chowns one
  of another uid: it logs a warning and leaves the default caches.

The pnpm **store** is on neither mount. The entrypoint writes
`/etc/profile.d/omp-runner-pnpm.sh` with
`npm_config_store_dir=/workspace/.paperclip-runtime/pnpm-store` and
`npm_config_package_import_method=clone-or-copy`, one store per runner, in the
`workspace` volume. A link cannot cross a filesystem boundary, so the store must
not sit on the `/cache` bind (BOT-DISK-D in the bot-runtime image); it must be on
the same mount as the clones. It sits inside `.paperclip-runtime` because the
board cleans the synchronized workspace on its own terms (`git clean -fdx -e
.paperclip-runtime`, emptying the directory except `.paperclip-runtime`, a
post-run cleanup that keeps only `.paperclip-runtime`) and never syncs that
directory; only `.paperclip-runtime/runs/` is pruned. A store at
`/workspace/.pnpm-store` would not have that protection. The reasoning is also
in the header of `omp-ssh/compose.yml`.

`clone-or-copy` makes pnpm reflink packages from the store where the filesystem
supports it (XFS with reflink enabled) and copy them otherwise. pnpm 9 does not
fail when a reflink or link is refused, whatever the method: it copies silently.
Nothing here turns a missing reflink into an error, so check the disk.

Measure the acceptance by the disk, not by `du`: `du` counts a reflinked or
hard-linked file at every path where it appears, so it reports far more than
the disk holds. Take
`df --output=used -B1M <OMP_RUNNER_DATA_DIR>` on the host before and after a
second task copy on the same runner, with no other run or runner writing to that
disk meanwhile. The delta should stay well under 700 MB (new objects and
packages only, not a second full clone and store); a delta close to the size of
the copy's `node_modules` means the reflink did not happen and pnpm copied. The
store only grows: `pnpm store prune` (as the user `paperclip`) drops packages no
project uses.

One runner per agent:

1. Make a key pair for the runner. Keep the private key out of the logs and the
   shell history.
2. Start the container from `docker/agent-runtime/omp-ssh/compose.yml`. Use an
   env file with `OMP_RUNNER_NAME`, `OMP_RUNNER_IMAGE` (a digest from a
   successful signed workflow run), `OMP_RUNNER_AUTHORIZED_KEYS` (the public
   key file) and `OMP_RUNNER_NETWORK` (the board container's network) and `OMP_RUNNER_DATA_DIR`: a directory on the bot data disk, not the root disk, with subdirectories `workspace/` (owned by 1000:1000), `home/`, `hostkeys/` and `tmp/` (mode `1777`, like a system `/tmp`: `install -d -m 1777 <dir>/tmp`; it is the container's `/tmp`, kept on the data disk so tests and temporary task files do not fill the root disk of the host; the host GC removes entries older than 24 h). Agents clone and build repositories there, gigabytes per agent. Create all of them **before the first start**: docker creates a missing bind source as root. A runner started before `tmp/` was added: create the directory, add the `tmp` volume to its compose file and recreate the container. Optionally
   `OMP_RUNNER_CACHE_DIR` (the shared package cache above; create its `git` and
   `pnpm-omp` subdirectories first). The
   limits default to 4 GB, 1 CPU and 1024 processes, as for an engineer bot
   container. Run
   `docker compose -p <runner-name> --env-file <file> -f docker/agent-runtime/omp-ssh/compose.yml up -d`.
3. Read the host key from the container log line `omp-runner: generated host key`,
   or with `ssh-keyscan -p 2222 <runner-name>` from the board network.
4. On the board, create an environment with driver `ssh`:
   - host `<runner-name>`, port `2222`, user `paperclip`;
   - remote workspace path `/workspace`;
   - the private key (the board stores it as a company secret);
   - known hosts `[<runner-name>]:2222 <host key>`, strict host key checking on.

   Run the environment probe.
5. Set the agent's default environment to that environment.

Check after the first run: `docker top <board container>` shows no `omp`
process during the run, and `docker top <runner-name>` shows it. The run log
names the SSH environment in its `Syncing workspace and OMP runtime assets to`
line.

### Updating a runner that already runs (shared cache rollout)

A runner started before the shared cache has no cache mounts and none of its
environment files. Per runner, one at a time, while its agent has no run in
progress (a recreate stops sshd and any run on it):

1. Set `OMP_RUNNER_IMAGE` in the runner's env file to the new digest of a
   successful signed workflow run.
2. Optional: add `OMP_RUNNER_CACHE_DIR=<the board's sharedPackageCachePath>`.
   Without the line the runner gets a private cache under
   `${OMP_RUNNER_DATA_DIR}/cache` and works as before.
3. Create the two directories (on the shared path; docker would create them as
   root): `install -d -o <board uid> -m 0755 <OMP_RUNNER_CACHE_DIR>/git` and
   `install -d -o 1000 -g 1000 -m 0755 <OMP_RUNNER_CACHE_DIR>/pnpm-omp`. The
   `git` directory is the board's mirror directory; if the board already
   mirrors there, it exists and nothing changes.
4. Recreate: `docker compose -p <runner-name> --env-file <file> -f docker/agent-runtime/omp-ssh/compose.yml up -d`.
   The `workspace`, `home` and `hostkeys` volumes are kept, so the pinned host
   key is unchanged and the board's SSH environment needs no edit.
5. Check: `docker logs <runner-name> 2>&1 | grep omp-runner:` shows
   `shared package download cache at /cache/pnpm` and
   `git mirrors at /cache/git: N repositories`
   (and no `WARNING /cache/pnpm is owned by uid`);
   `docker exec -u paperclip <runner-name> sh -c '. /etc/profile; command -v git; echo $npm_config_store_dir; echo $npm_config_cache_dir; echo $npm_config_cache'`
   prints `/usr/local/bin/git`, `/workspace/.paperclip-runtime/pnpm-store` and
   `/cache/pnpm` twice.

The pnpm store of the runner starts empty and fills on the first install.

## Publishing and Signing

`.github/workflows/agent-runtime-images.yml` runs for pushes to `main` and release tags `myr-v*` that touch configured paths, or manually through `workflow_dispatch`. A manual run accepts a version; otherwise the tag is `git-<commit-sha>`. The bake publish scope explicitly includes `base`, `opencode`, `pi`, `codex`, `gemini`, `claude`, `omp`, and `omp-ssh` (`linux/amd64`; `hermes` is not included). The workflow retrieves each pushed image digest and signs it with cosign keyless OIDC using its GitHub Actions identity.

No successful workflow run or published OMP tag/digest has been verified for this change. Before using a published image, verify the successful workflow run, its GHCR digest, and the signature.

## Agent Container (paperclip-agent-shim)

The main agent process runs as the shim (PID 1 under tini). The shim:

1. Reads `/run/paperclip/runtime-command.json` (path overridable via `-spec`), a JSON file mounted by whatever schedules the run
2. Parses `{ "command", "args" }`: the harness CLI and arguments
3. Resolves the command on PATH and `syscall.Exec`s it, replacing itself
4. SIGTERM from the kubelet propagates directly to the harness (no zombie processes)

**runtime-command.json Contract:**
```json
{
  "command": "claude-code",
  "args": ["--token", "xyz", "--workspace", "/workspace"]
}
```

The shim makes no assumptions about command structure; it is harness-agnostic. New harnesses swap the command/args; the base image stays the same.

## Security Model

- **Non-root execution**: user 1000:1000, no capability grants
- **PSS Restricted compatible**: no privileged containers, no host mounts; works with a read-only root filesystem (writable `/workspace` + `/tmp` mounts)
- **No secrets baked in**: API tokens and credentials come from per-run ephemeral Secrets mounted as env vars or files
- **Image signing**: cosign keyless OIDC in the publish workflow

## Publishing

`.github/workflows/agent-runtime-images.yml` builds and pushes the default scope (base, opencode, pi, codex, gemini, claude) on `workflow_dispatch` (with an explicit version tag) or on pushes to `master` touching these paths, then signs each digest with cosign keyless OIDC.
