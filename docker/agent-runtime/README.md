# Agent Runtime Image Family

Container images for running coding-agent harnesses in sandboxed environments (for example the kubernetes sandbox provider, stage 1 of the k8s contribution). Images are named `agent-runtime-{harness}:{version}` and published to `ghcr.io/paperclipai/` by the `agent-runtime-images` workflow. The registry is overridable: every reference flows through the `REGISTRY` bake variable.

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

The `omp` target is defined in `docker/agent-runtime/buildx-bake.hcl` for `linux/amd64`. Bake defaults are `REGISTRY=ghcr.io/paperclipai` and `VERSION=dev`.

Build locally for validation (this does not publish):

```sh
docker buildx bake -f docker/agent-runtime/buildx-bake.hcl omp --load
docker run --rm --user 1000:1000 \
  --mount type=bind,src=<session-dir>,dst=/home/paperclip/.local/share/omp/sessions \
  --mount type=bind,src=<workspace-dir>,dst=/workspace \
  ghcr.io/paperclipai/agent-runtime-omp:dev --help
```

Replace `<session-dir>` and `<workspace-dir>` with real host directories; the container needs write access. To test an image published by CI, use a tag or digest verified in the successful workflow run rather than assuming `dev` exists:

```sh
docker run --rm --user 1000:1000 \
  --mount type=bind,src=<session-dir>,dst=/home/paperclip/.local/share/omp/sessions \
  --mount type=bind,src=<workspace-dir>,dst=/workspace \
  ghcr.io/paperclipai/agent-runtime-omp:<verified-tag-or-digest> --help
```

## Publishing and Signing

`.github/workflows/agent-runtime-images.yml` runs for pushes to `master` that touch configured paths, or manually through `workflow_dispatch`. A manual run accepts a version; otherwise the tag is `git-<commit-sha>`. The bake publish scope explicitly includes `base`, `opencode`, `pi`, `codex`, `gemini`, `claude`, and `omp` (`linux/amd64`; `hermes` is not included). The workflow retrieves each pushed image digest and signs it with cosign keyless OIDC using its GitHub Actions identity.

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
