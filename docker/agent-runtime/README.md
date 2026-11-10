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
`packages/plugins/sandbox-providers/SANDBOX-REQUIREMENTS.md`.

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

`docker/agent-runtime/Dockerfile.omp` uses `oven/bun:1.4.3-alpine` directly. It does not inherit the Node/shim image and starts OMP as its container command (`CMD ["omp"]`). The image creates the `paperclip` user at uid/gid `1000:1000`; `HOME`, XDG directories, and the OMP session directory are under `/home/paperclip`. `/workspace` is the working directory and workspace mount point. Ensure host-mounted writable directories are accessible to uid/gid 1000.

The Dockerfile runs smoke checks at build time without invoking a model or provider: exact Bun (`1.4.3`) and OMP (`18.9.2`) versions, `omp` on `PATH`, `omp --help`, and `omp models ls`.

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

One runner per agent:

1. Make a key pair for the runner. Keep the private key out of the logs and the
   shell history.
2. Start the container from `docker/agent-runtime/omp-ssh/compose.yml`. Use an
   env file with `OMP_RUNNER_NAME`, `OMP_RUNNER_IMAGE` (a digest from a
   successful signed workflow run), `OMP_RUNNER_AUTHORIZED_KEYS` (the public
   key file) and `OMP_RUNNER_NETWORK` (the board container's network). The
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
