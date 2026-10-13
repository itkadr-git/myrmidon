# Bot runtime image (G1)

A container image that runs one long-lived `hermes gateway run` process,
serving its OpenAI-compatible API server (`platforms.api_server`) on
`:8642` for the board's `hermes_gateway` adapter to talk to. This is the
per-bot / per-project process described as "variant B" under item C1/H3 in
`docs/myrmidon/ROADMAP.md` — the board itself no longer spawns or owns
hermes processes; it reconciles a desired profile into this container's
volumes and talks to the running gateway over HTTP. The fuller design
write-up behind that decision is maintainer-side material and not part of
this repository (`ROADMAP.md` says the same under C1).

This image does **one** job: run the gateway. It does not run cron, a
dashboard, or any messaging platform other than `api_server`. It has no
Docker socket, no host mounts, and no media tools. (The optional Node.js variant below adds Node.js, not media tools.)

## What's in the image

- Base: `python:3.13-slim` in both build stages. The hermes venv is pinned to
  that stage's own interpreter (`uv sync --python /usr/local/bin/python3`,
  `UV_PYTHON_DOWNLOADS=never`): hermes' `.python-version` (3.11) would
  otherwise make `uv` download a managed CPython into the builder's `/root`
  and link the venv to it, and that link does not exist in the runtime
  stage. A build-time check in the runtime stage, run as the `bot` user,
  asserts that `/opt/hermes-src/.venv/bin/python` resolves outside `/root`
  and imports `hermes_state`.
- `hermes-agent`, pinned to a git tag (`HERMES_VERSION`/`HERMES_GIT_REF`
  build args, default `0.21.5` / `v2026.9.24`), installed **editable** from
  a clean clone of the author's repository `https://github.com/NousResearch/hermes-agent`
  at the pinned commit (`HERMES_GIT_SHA`); our own hermes changes live in
  `docker/bot-runtime/patches/` in this repository — see
  "Why editable, not pip install" below. hermes tags releases by date
  (`vYYYY.M.D`); `v2026.9.24` is the tag we confirmed (via the GitHub API
  and `git ls-remote --tags`, checking `pyproject.toml` on every recent
  release tag) actually carries `version = "0.21.5"` — the two numbers do not
  share a scheme, so a future version bump needs the same lookup, not an
  assumed `v<version>`.
- `aiohttp`, pinned to the exact version hermes' own optional extras use at
  this release (`HERMES_AIOHTTP_VERSION`, default `3.14.3`).
  `gateway/platforms/api_server.py` is built on `aiohttp.web`, but aiohttp
  is not one of hermes' core dependencies — most of the extras that pull it
  in also pull in `python-telegram-bot`/`discord.py`/`slack-bolt`, which
  this image does not need. `pyproject.toml`'s `sms` extra resolves to
  exactly `aiohttp==3.14.3` and nothing else, so the build installs through
  `uv sync --frozen --extra sms --extra mcp` — the same
  hash-verified `uv.lock` path every other dependency in this image goes
  through, rather than a separate unlocked `uv pip install aiohttp==...`
  that could pull an untampered-looking but unverified wheel. A build-time
  check fails loudly if that extra ever stops being exactly
  `aiohttp==${HERMES_AIOHTTP_VERSION}`.
- `mcp` (the `mcp` extra) and the Hindsight memory provider, baked in
  rather than left to hermes' own lazy install
  (`tools/lazy_deps.py`/`HERMES_LAZY_INSTALL_TARGET`, below): every
  G2-compiled bot profile writes both an `mcp_servers` block and a
  `memory.provider=hindsight` config, and this image's sealed venv cannot
  reliably lazy-install into itself at runtime (see "Sealed image" below).
  Without the extra hermes does not error — it silently disables MCP tools
  (`tools/mcp_tool.py`, gated on `importlib.util.find_spec('mcp')`) — so the
  builder also runs `python -c 'import aiohttp, mcp, hindsight_client'`
  against the synced venv, to fail the build instead of shipping that silent
  regression. A second smoke imports every module a patch in `patches/`
  changes (`hermes_state`, `tools.environments.base`,
  `tools.environments.base_session_env`, `gateway.run`), because `git apply`
  only proves the hunks land, not that the patched module still imports.
- **Hindsight from the plugin catalog, not from the hermes tree.** From
  0.21.5 the memory provider no longer ships inside hermes-agent: it lives in
  the hermes plugin catalog (`plugin-catalog/hindsight.yaml`, kept in this
  image) and is maintained by its authors. The builder clones the exact
  commit the catalog entry pins (verifying it, like `HERMES_GIT_SHA`), copies
  it to the sealed, root-owned `/opt/hermes-plugins/hindsight`, and installs
  the dependencies the plugin declares through hermes' own plugin installer
  (`hermes_cli.plugin_python_deps.install_for_plugin_dir`, the same path
  `hermes plugins install` runs, so they are resolved against hermes' core
  constraints). At container start the entrypoint links that directory into
  the bot's writable `${HERMES_HOME}/plugins/hindsight` — the place hermes
  resolves a user memory provider from — and leaves any existing entry
  alone. The catalog pin is read from the catalog file, so bumping it is a
  one-line change; the two patches this image used to carry against the
  in-tree provider are gone (`patches/README.md`, and
  `docs/myrmidon/hermes-deltas.md` for the delta list and its upstream
  offers).
- Bundled skills (`skills/` in the hermes source tree — 14 categories at
  `0.21.5`/`v2026.9.24`), read-only. They are **not** shipped via PyPI package-data
  (hermes' `pyproject.toml` package-data list does not include `skills/**`
  at all — see "Why editable, not pip install"); the editable install
  keeps the full source tree in the image, which is what
  `tools/skills_sync.py`'s `get_bundled_skills_dir()` call resolves
  against via `Path(__file__).parent.parent / "skills"`. We also set
  `HERMES_BUNDLED_SKILLS` explicitly to the same path as a second,
  independent way to find it, in case some other bundled-asset lookup
  turns out not to route through that one call site.
- `tini` as PID 1 (`ENTRYPOINT`), `git`, `jq`, `ripgrep`, `openssh-client` (ssh with `-i` and
  `-o UserKnownHostsFile=` under `/scratch`; the root is read-only), `curl`
  (health check only), `ca-certificates`. No `ffmpeg`, no media tools — forbidden by
  `docs/myrmidon/CONVENTIONS.md` §8; media handling is a separate service
  outside this fork.
- Non-root user, uid/gid `10001`.

## Variant with Node.js

`Dockerfile` has a second final stage, `runtime-node`, built `FROM runtime`. It is
published as a separate image, `ghcr.io/itkadr-git/myrmidon-hermes-node`, by the same
workflow with the same gating (push to `main` and `myr-v*` tags only; a pull request
builds and checks it, never pushes). The default `runtime` target and the
`myrmidon-hermes` image are unchanged and do not contain Node.js.

This is an **interim measure** until a per-task sandbox exists. It is meant for the few
bots whose work is node scripts (presentations and documents, diagram and image
rendering); the roles that use it are listed in `docs/myrmidon/ci.md`. Every other bot
should keep using `myrmidon-hermes`.

What differs from `runtime` (everything else — uid/gid `10001:10001`, read-only root,
volumes, entrypoint, health check, and the `myrmidon.bot-runtime.contract="1"` label
inherited from `runtime` — is the same; the variant only adds the label
`io.github.itkadr-git.myrmidon.variant="node"`):

- Node.js 22 LTS from the official `nodejs.org` tarball, pinned by exact version and
  sha256 (`NODE_VERSION` / `NODE_SHA256`; bump together, the build fails on a mismatch),
  with the npm that ships in it, under `/opt/node`.
- Packages, installed from a lockfile with `npm ci` into the sealed `/opt/node-tools`
  (`node-tools/package.json` pins exact versions, `package-lock.json` every transitive
  package with its integrity hash). Only what the bots' node scripts actually import:
  `pptxgenjs` (presentations), `@napi-rs/canvas` (rendering diagrams and layouts),
  `sharp` (image processing), `image-size`, `pdf-lib` (building PDF) and `pdfjs-dist`
  (reading PDF). The native ones (`sharp`, `@napi-rs/canvas`) ship prebuilt binaries,
  so no compiler is in the image. `docx`, `tesseract.js`, `puppeteer-core` and any
  browser are deliberately not included.
- Fonts (Liberation, DejaVu) copied from a build stage: `@napi-rs/canvas` draws with
  system fonts only, and the slim base has none.
- `NODE_PATH=/opt/node-tools/node_modules`, so `require('pptxgenjs')` works from any
  working directory. **ES module `import` ignores `NODE_PATH`**: an `.mjs` script has to
  import by absolute path (`$NODE_TOOLS_DIR/node_modules/...`) or go through
  `createRequire`. `pdfjs-dist` is ES-module only.
- The root is read-only, so npm and node write only to volumes: `NPM_CONFIG_CACHE` is
  `/scratch/npm-cache`, `NPM_CONFIG_PREFIX` is `/scratch/npm-global` (its `bin` is on
  `PATH`, its `lib/node_modules` on `NODE_PATH`), `$HOME` is `/data/hermes`. A local
  `npm install` in `/workspace` works; a global one lands in `/scratch` and disappears
  with that volume.

Checks: the last build step runs `node /opt/node-tools/smoke.cjs` as uid `10001` (writes a
`.pptx` to a temp file, renders Cyrillic text on a canvas, re-encodes it with `sharp`,
reads its size, builds a PDF, imports `pdfjs-dist`), so a package that does not load
fails the build. On pull requests the workflow repeats it on the finished image with
`--read-only`, `--user 10001:10001` and `tmpfs` in place of the volumes, and checks that
npm's cache goes to `/scratch`.

The workflow builds the default image with an explicit `target: runtime`, so adding a
stage to the Dockerfile can never silently change what `myrmidon-hermes` is. A plain
`docker build docker/bot-runtime` (no `--target`) would produce the last stage in the
file — the development variant, below; always pass `--target`.

## Variant for the development team

`Dockerfile` has a third final stage, `runtime-dev`, built `FROM runtime` and published as
`ghcr.io/itkadr-git/myrmidon-hermes-dev` by the same workflow with the same gating (push to
`main` and `myr-v*` tags only; a pull request builds and checks it, never pushes).

It exists for the company's development-team bots. A bot container has no Docker of its
own: dockergate refuses arbitrary containers on purpose, so the team cannot open a
throwaway `node:24` container the way it does on a separate sandbox host. This variant
puts the same toolchain inside the bot image, so a full repository cycle — install,
typecheck, test, `git push` — runs from the container.

What it adds (everything else — uid/gid `10001:10001`, the read-only root, the three
volumes, the entrypoint, the health check and the inherited
`myrmidon.bot-runtime.contract="1"` label — is identical; the variant only adds the label
`io.github.itkadr-git.myrmidon.variant="dev"`):

- **Node.js 24 LTS** from the official `nodejs.org` tarball, pinned by exact version and
  sha256 (`NODE24_VERSION` / `NODE24_SHA256`), with the npm that ships in it, under
  `/opt/node24`. The repository requires Node 24 (its CI lane and `CONVENTIONS.md` §13).
- **pnpm** at the repository's pinned `packageManager` version (`PNPM_VERSION`), installed
  with that npm into a sealed `/opt/pnpm` — not into `/scratch`, because dockergate refuses
  an image whose `PATH` holds a writable-volume element. `corepack` is not used: it is not
  available on the base image.
- **Go** from the official `go.dev` tarball, pinned by version and sha256 (`GO_VERSION` /
  `GO_SHA256`), under `/opt/go`. The repository's `tools/dockergate` and `tools/fleetd` are
  Go modules with their own CI lanes (`gofmt`, `go vet`, `go test`).
- **Rust** via the version-pinned, checksum-verified rustup installer under
  `/opt/rustup` + `/opt/cargo`, with the compiler channel taken from
  `packages/paperclip-runner/rust-toolchain.toml` (`RUST_CHANNEL`) — the same single owner
  the repository's own build Dockerfile reads. A guard test fails if the two drift.
- **Build tools**: `gcc`, `g++`, `make`, `pkg-config`, `libc6-dev` (native addons and
  `node-gyp`; the base already carries `python3`), plus `git`, `gh`, `jq`, `zstd`, `unzip`,
  `xz-utils`, `openssh-client`, `ripgrep`.
- **Docker CLI, client only** (`DOCKER_CLI_VERSION`/`DOCKER_CLI_SHA256`): only the `docker`
  binary is copied out of the static release tarball into `/opt/docker-cli/bin`. The tarball
  also ships `dockerd`, `containerd` and `runc`, and none of them enter the image — the bot
  container runs no engine, on purpose. The engine the team uses is the sandbox VM's,
  reached over mutual TLS (see `docs/myrmidon/dockergate.md`).

Every downloaded toolchain is pinned by exact version and verified by sha256 before use; a
mismatch fails the build, the same rule the Node.js variant states above.

**Where things write.** The root filesystem is read-only at run time and the bot's writable
directories are exactly its single `/bot` mount (BOT-DISK-D), so:

- the pnpm store defaults to `/workspace/.pnpm-store` via `npm_config_store_dir`, inside that
  mount like every clone root, because pnpm hard-links `node_modules` into its store and a hard
  link cannot cross a mount (a store on a separate bind made pnpm copy every package into every
  clone). `npm_config_package_import_method=hardlink` is set too; pnpm 9 still copies silently
  when the kernel refuses a link, so `pnpm-hardlink-check.sh` proves the link from `/data/hermes`,
  `/workspace` and `/scratch` at build time and `entrypoint.sh` repeats the check at every start
  (`/data/hermes/.myrmidon/hardlink-check.json`, shown on the board). `/cache/pnpm` is a download
  cache only, never the store; the paths and the method are the `pnpmStoreDir` and
  `pnpmImportMethod` settings, see
  [docs/myrmidon/bot-disk-cache.md](../../docs/myrmidon/bot-disk-cache.md);
- `RUSTUP_HOME`/`CARGO_HOME` stay sealed under `/opt` and `cargo` writes its target dir into
  the checked-out workspace;
- Go's build cache defaults under `$HOME` (`/data/hermes`), the durable volume.

**PATH never holds a writable volume.** The dev stage assembles `PATH` from `/opt` and
`/usr` only (`/opt/node24/bin`, `/opt/pnpm/bin`, `/opt/go/bin`, `/opt/cargo/bin`,
`/opt/docker-cli/bin`, the inherited venv and system paths). This is the same constraint the
Node.js variant documents above: the dockergate image check
(`tools/dockergate/internal/policy/image.go`) rejects an image whose `PATH` element is under
`/data`, `/workspace`, `/scratch` or `/tmp`, and also rejects one carrying an `ENV` or
`BASH_ENV` variable name — the dev variant introduces neither.

Checks: the last build step runs `node`, `pnpm`, `go`, `cargo`, `rustc`, `gh`, `jq`, `zstd`,
`git`, `docker` and `devbuild --help` as uid `10001` in the finished stage and asserts no `PATH`
element is under a writable root. On pull requests the workflow repeats the toolchain run on the
finished image with `--read-only`, `--user 10001:10001` and `tmpfs` in place of the volumes, checks
the contract label and the image user before that, and fails if `dockerd` is present — the image
carries the client only.

### `devbuild`: builds and tests on the build VPS (1.6.1 BUILD-OFFLOAD B)

The dev variant carries `/opt/paperclip/bin/devbuild` (root-owned, first on `PATH`; deliberately not `/usr/local/bin/devbuild`, whose presence is the gate that opens the local build wrappers; from
`docker/bot-runtime/devbuild/devbuild`): it rsyncs the `/workspace` repo copy (`.git` included,
`node_modules`/`dist`/`target`/caches excluded) to `$DEVBUILD_BASE/<bot>/<repo>/` on the shared
build VPS over ssh, then runs the given command there with the shared caches exported
(`npm_config_store_dir=/srv/devcache/pnpm`, `GOMODCACHE`, `GOCACHE`, `GRADLE_USER_HOME` — created
on first run, shared by all bots) and passes the exit code through. Heavy jobs
(`pnpm -r typecheck`, full test suites, `cargo test`) run there instead of inside the 1 CPU / 3 GB
bot container; editing, git and pushing stay local.

Connection settings come only from the bot profile env (`DEVBUILD_HOST`, `DEVBUILD_USER`,
`DEVBUILD_BASE` — never baked into the image or tests). Without them the script prints a pointer
to the `devbuild` skill and exits 1. The ssh key is read from `/opt/devbuild-ssh/id_ed25519`,
mounted by the runtime template (part C); key authorization and the remote resource limits are
the fleet operator's part (D). The image adds `rsync` to the apt set for the transport.

### Shared git objects and the clone report (1.6.2 BOT-DISK-C)

- `/opt/paperclip/bin/git` (`git-reference/git`, a Node script like the other wrappers) shadows
  `/usr/bin/git`. For `git clone https://github.com/<owner>/<repo>` it adds
  `--reference-if-able /cache/git/<owner>/<repo>.git` when that directory exists (the board's
  read-only mirror, mounted only when the instance lists mirrored repositories); everything else
  runs the real git unchanged, so `git-credential-paperclip` keeps working. Clones that pick the
  storage of their own objects (`--dissociate`, `--shared`, `--local`, `--mirror`, `--filter`) are
  left alone; a bounded clone (`--depth` and the shallow options), a clone that names
  `--reference`/`--reference-if-able`/`--no-local` and a non-GitHub clone take the mirror as one
  more alternate, and one that the store does not serve prints a `[myrmidon-git]` line and writes
  `$HERMES_HOME/.myrmidon/git-objects-last-error.json`.
- `/opt/paperclip/bin/bot-clone-hygiene` (`git-reference/bot-clone-hygiene`, Python standard
  library) is started by the entrypoint (every `MYRMIDON_CLONE_HYGIENE_INTERVAL_SEC`, default
  900) and writes `$HERMES_HOME/.myrmidon/clone-hygiene.json`: per repository under `/workspace`
  and `/scratch`, whether it is dirty, mid-operation, stashed, holds commits on no remote, or is
  the base of a linked worktree or an alternate. It only reads. The board's draft-directory
  lifecycle removes an idle clone only when this report says it is clean and fully pushed.
- Tests: `scripts/myrmidon/bot-runtime/git-reference.test.mjs` and `pnpm-hardlink.test.mjs`.

### Heavy builds are blocked at the image level (1.6.1 BUILD-OFFLOAD)

The dev variant deliberately does **not** let a bot run the repository's heavy build
operations locally. `pnpm install`, a monorepo `tsc --noEmit`, `vitest` suites, `gradle`
builds and `go build`/`go test` are compile- and network-heavy workloads that belong on the
build VPS, and running them inside a bot container starves the gateway (the container's CPU
and memory budget is sized for the gateway, not a compiler).

That is enforced by wrappers, not convention: `/opt/paperclip/bin` — the FIRST `PATH`
element — carries `pnpm`, `tsc`, `vitest`, `gradle` and `go` shims (Node scripts, the same
shape as the `gh`/`git-credential-paperclip` wrappers above) that intercept the bare names
before the real binaries in `/opt/pnpm/bin`, `/opt/node24/bin` and `/opt/go/bin`.

- **Blocked, exit 1, with the exact replacement on stderr**: `pnpm install`, `pnpm exec …`,
  `pnpm run/test`, `pnpm store prune`, `tsc …`, `vitest …`, `gradle …`, `go build/test …`
  and every other non-trivial invocation.
- **Allowed locally (no network, no build work)**: `pnpm --version`, `pnpm config …`,
  `pnpm store status`/`path`, and a bare `--version`/`--help` of the other wrapped tools.
- **Not wrapped at all**: `git`, `node`, `cargo`, `gh`, `docker`, `jq`, `rg`, … — the
  light/editing part of the cycle keeps running in the container.

**The gate and how to run a build.** The wrappers open only when an executable
`/usr/local/bin/devbuild` exists in the container. That file is never part of the image: it
is mounted by the BUILD-OFFLOAD part-B driver into the per-invocation build container, so
the ordinary bot container (this image plus its three volumes) always has the barrier
closed. To run a heavy command, use the `devbuild` CLI, which mounts this workspace into a
build container on the build VPS and runs the same command there:

```
devbuild pnpm install
devbuild pnpm exec tsc --noEmit
devbuild pnpm vitest run
devbuild go build ./...
```

Inside a devbuild-driven container the wrappers detect the gate and exec the real binaries,
so `devbuild pnpm install` literally runs `pnpm install` there.

Build-time verification: the final `RUN` in the `runtime-dev` stage asserts, as uid `10001`
in the finished image, that `pnpm install` fails with the refusal text (which names the
`devbuild` replacement) and a non-zero exit, that `tsc`, `vitest`, `gradle` and `go build`
refuse the same way, and that `pnpm --version` still answers through the wrapper. The image
also asserts `/usr/local/bin/devbuild` does NOT exist in the built image — the gateway is
mounted, never baked.


## Sealed image: lazy installs and the write-safe root

`/opt/hermes-src` (the venv, the hermes source tree and the bundled skills
under it) is root-owned and read-only for the `bot` user — not a pure
security win on its own, since hermes has its own runtime mechanisms that
assume a writable install by default:

- `tools/lazy_deps.py` installs an opt-in backend's SDK (the native
  `anthropic` provider, `bedrock`, `vertex`, `azure_identity`, the
  `exa`/`firecrawl`/`parallel` web-search backends, TTS/STT, OTLP export,
  …) the first time a bot profile actually uses it. Left unconfigured, it
  installs straight into the (read-only) venv and fails with a raw `uv pip
  install` permission error at that moment, instead of hermes' own clean
  "no writable install target configured" message.
- `agent/file_safety.py`'s write/patch guard (`HERMES_WRITE_SAFE_ROOT`) is
  inert when unset — hermes' built-in file-write tools would then have no
  application-level path scoping beyond raw container filesystem
  permissions (the separate `~/.ssh`/credential-file denylist in the same
  module stays active regardless).

hermes' own upstream `Dockerfile` seals its image the identical way and
sets three `ENV` vars for exactly these two reasons; this image sets the
same three, pointed at the durable `/data` volume instead of upstream's
`/opt/data`:

| Variable | Value | What |
|---|---|---|
| `HERMES_DISABLE_LAZY_INSTALLS` | `1` | Blocks a lazy install into the sealed venv; still allowed when a durable target is configured (below) — see `tools/lazy_deps.py::_allow_lazy_installs()`. |
| `HERMES_LAZY_INSTALL_TARGET` | `/data/hermes/lazy-packages` | Redirects a lazy install to this directory instead (created on first use, under the already-writable `HERMES_HOME`) and appends it to `sys.path` — appended, not prepended, so a lazy package can only add modules, never shadow or downgrade a core one. |
| `HERMES_WRITE_SAFE_ROOT` | `/data:/workspace` | Scopes hermes' own write/patch tools to the durable volume and the workspace, matching upstream's equivalent setting for the same sealed-image posture. |

## Why editable, not `pip install hermes-agent`

`hermes-agent`'s own `setup.py` explicitly refuses to build a wheel or
sdist outside a Nix build:

> pip/PyPI and Homebrew are no longer supported distribution methods for
> Hermes Agent [...] Hermes is distributed via the shell installer, Docker
> image, or Nix. [...] If you are developing, use an editable install
> instead: `uv sync` / `uv pip install -e .`.

So `pip install hermes-agent==0.21.5` from PyPI cannot be relied on for
this hermes release (whether or not PyPI currently happens to serve a
stale wheel from an older release is not something to depend on).
`docker/hermes-gateway-smoke/` in this repo does exactly that, pinned to
`0.17.0` by default — an older release, from before this restriction, and
not what this image should copy. This Dockerfile instead clones the
pinned tag and does what hermes' own upstream `Dockerfile` does for its
Python half: `uv sync --frozen`, which installs the project editable —
the officially supported path, and the one that reliably resolves bundled
skills through `__file__`, not PyPI package-data.

`uv` itself is copied (not `pip install`ed) from
`ghcr.io/astral-sh/uv:0.11.6-python3.13-trixie`, pinned to the exact
digest hermes' own upstream `Dockerfile` uses for the same
`pyproject.toml`/`uv.lock` pair — reusing a version we found already
vetted against this exact hermes release, not one guessed independently.
It is copied into both the builder stage and the final runtime image: at
runtime, hermes' own lazy-install mechanism (`tools/lazy_deps.py`, see
"Sealed image" below) tries `uv pip install --target <dir>` before falling
back to `pip`/`ensurepip` — a fallback that would try (and fail) to write
into the sealed, read-only `/opt/hermes-src/.venv` in this image. Without
`uv` on `PATH`, every lazy-installable opt-in backend (a model provider not
already baked in, a web-search backend, TTS/STT, OTLP export, ...) would
silently break in this image the first time a bot profile picked one.

The builder stage clones the tag into `/opt/hermes-src`, but the runtime
image does not ship that clone unmodified: after `uv sync`, the Dockerfile
removes `.git` (the shallow clone's history — never needed once `git
apply`/`uv sync` above are done, since hermes-agent's version is a static
`pyproject.toml` string, not derived from git at build time) and the
top-level dev/build-only directories and lockfiles that nothing in the
installed package imports at runtime (`tests/`, `tests-js/`, `evals/`,
`docs/`, `contributors/`, `nix/`, `mcp-research-data/`, `package-lock.json`,
`flake.lock`, `flake.nix`). `plugin-catalog/` is kept — it is read at
runtime by `hermes_cli/plugin_catalog.py`.

## Patches

`patches/*.patch` are applied (`git apply`) against the cloned tag before
`uv sync`. Three are carried at `v2026.9.24`: a session-snapshot secret
redaction (02), a bounded retry of state-database reads that find the database
locked (04), and the gateway's asyncio default-executor pool size (05). The two
hindsight patches this image used to carry (01, 03) are gone: 0.21.5 removed
the provider from the hermes tree, the catalog plugin already carries the
`retain_async` fix, and what it does not carry yet is tracked as its own delta
with an upstream offer — see `patches/README.md`,
`docs/myrmidon/hermes-deltas.md` and `scripts/myrmidon/hermes-upstream/`.

A reference checkout carries further local modifications. A plain tree diff of
it against the pinned tag (no repository history is needed) gives a closed
list, and `patches/README.md` decides every file on it: ported (above), or not
needed in this image with the reason — the `reasoning_content` storage
optimization in `agent/chat_completion_helpers.py` (storage only, not a fix),
the CLI query-label escape in `cli.py` (this image never runs that path), and
the browser tool's socket-directory files `tools/browser_tool.py` and
`tools/browser_tool_session.py` (the image ships no browser). As of that
comparison nothing is left as an open gap.

## Required environment

| Variable | Required | What |
|---|---|---|
| `API_SERVER_KEY` | yes, but never as container `Env` | Bearer token for the gateway's API server. hermes itself refuses to start the API server without one at least 16 chars and not a known placeholder (`gateway/platforms/api_server.py: _api_key_passes_startup_guard`); the entrypoint checks length up front so a misconfigured container fails in one line. Per the bot-runtime contract (below), the G3 driver never sets container `Env` — the entrypoint reads it from `${HERMES_HOME}/.env` (`API_SERVER_KEY="..."`, parsed as data, never sourced) when it is not already in the process environment. Generate with `openssl rand -hex 32`. |
| `MYRMIDON_BOT_YOLO` | no (default `1`) | `1`: sets `HERMES_YOLO_MODE=1` before exec — dangerous-command approvals bypassed, because this gateway has no attended operator to answer a prompt. `0`: leaves approvals to the profile's `config.yaml` (`approvals.mode`, default `smart`); on `api_server` (an "unattended platform" in hermes' own terms) an unanswered approval defaults to `deny`, not to a hang. See `docs/myrmidon/SETTINGS.md`. |

`API_SERVER_ENABLED`, `API_SERVER_HOST`, `API_SERVER_PORT`, `HERMES_HOME`,
`HERMES_DISABLE_LAZY_INSTALLS`, `HERMES_LAZY_INSTALL_TARGET`,
`HERMES_WRITE_SAFE_ROOT` already have working defaults baked into the
image (`true`, `0.0.0.0`, `8642`, `/data/hermes`, `1`,
`/data/hermes/lazy-packages`, `/data:/workspace:/scratch`) — override only
if the container topology needs something else.

The entrypoint sets `umask 077` before its first file write, so every file a
run creates — scratch dumps, cache, tmp helpers — is born `0600` (directories
`0700`). Every bot on a host shares uid `10001`, and the mode bits are the
only barrier between one run's scratch/cache and another bot's processes;
the umask is inherited by every child of the entrypoint (gateway → session →
terminal/tool), so no cooperation from the workload is needed. Files that
are legitimately shared between processes of the same container (the
`${HERMES_HOME}/.myrmidon/*.json` start report read by the container's own
reporter, ipc sockets, logs collected by the host's root-side janitor) keep
working: their readers are the same uid or root.

## Bot-runtime contract

The image declares `myrmidon.bot-runtime.contract="1"` (an OCI label,
`docker/bot-runtime/Dockerfile`'s runtime-stage `LABEL`). The G3 container
driver (`server/src/myrmidon/bot-containers/template.ts`,
`assertBotRuntimeContract`) refuses to create a bot container from an image
that does not declare a value it supports, before anything is created — an
image that exists but was built for a different contract would otherwise
only fail after the container starts, then crash-loop under its restart
policy. Contract "1" (see that file's docstring on
`BOT_RUNTIME_CONTRACT_LABEL` for the authoritative text) commits this image
to: uid:gid `10001:10001`, `HERMES_HOME=/data/hermes` and `/workspace` as
the working directory; every secret read from `${HERMES_HOME}/.env`, never
from the container's own environment; nothing written outside `/data/hermes`,
`/workspace`, `/scratch`, `/tmp` and any volume the image declares itself
(the driver runs the container with a read-only root filesystem); and a
POSIX shell with `find`, `mv -T`, `mkdir -p`, `rm`, `chmod`, `chown`,
`dirname`.

## Volumes

The container has ONE writable bind, the bot's whole tree, at `/bot` (with `hermes/`,
`workspace/` and `scratch/` inside it); link(2) cannot cross mounts, so the three paths below
are links the image makes into it (`/data/hermes` → `/bot/hermes`, `/workspace` →
`/data/workspace` → `/bot/workspace`, `/scratch` → `/data/scratch` → `/bot/scratch`), not
mounts. The ownership requirement applies to the three directories inside `/bot`.
The `/bot` root itself must also let uid `10001` enter it: the driver's prepare
helper normalizes the host directory's mode to `0711` (owner `root` kept,
non-recursive, the content untouched) at every apply, and when a bot still starts
on a root it cannot enter, `entrypoint.sh` fails with a line naming the traversal
problem and the fix (recreate the bot) instead of the misleading
`API_SERVER_KEY is required`.

A member of a **shared isolation scope** (BOT-DISK-F, label `myrmidon.bot-runtime.scope=1`) has no
`/bot`: its one mount is the scope instance's directory at `/bot-scope`, a tmpfs over `/data`
holds the three links, and the entrypoint points them into `/bot-scope/$MYRMIDON_BOT_SCOPE_SUBDIR/`
(the one non-secret variable the driver sets) before anything reads `HERMES_HOME`. The image's
`WORKDIR` is `/` for that reason (`/workspace` only resolves after the links); the entrypoint enters
`/workspace` itself. See [docs/myrmidon/bot-disk-cache.md](../../docs/myrmidon/bot-disk-cache.md).

- `/data` — `HERMES_HOME=/data/hermes`: config, `.env`, `sessions/`,
  `state.db`. Must be owned by uid `10001` before the container starts
  (this image does not chown it — that is the fleet manager's job, since
  it is the one process with the privilege to do it; see item C1 in
  `docs/myrmidon/ROADMAP.md` on why `docker.sock` and that privilege live
  there and not here — the fuller rationale is maintainer-side material,
  not part of this repository). `HOME` is also set to `/data/hermes`
  (not the default `/home/bot`): the driver runs this image with a
  read-only root filesystem, so anything a library would write under
  `$HOME` on first use needs to land on a mounted, writable path instead —
  mirrors hermes' own upstream Dockerfile, which points its user's home at
  its data volume for the identical reason.
- `/workspace` — the bot/project's working directory (`terminal.cwd`).
  Same ownership requirement.
- `/scratch` — scratch space for the coding-agent tools' own temp files,
  outside `/workspace` and `/data/hermes`. Same ownership requirement; part
  of `HERMES_WRITE_SAFE_ROOT` alongside the other two.

## Health check

`GET /health` (no auth — unlike `GET /v1/capabilities`, which is
Bearer-gated and would need the key threaded into the `HEALTHCHECK`
command for no real benefit at this stage). `/health` only confirms the
aiohttp server accepted the connection and hermes' process is alive; it
does not confirm a model provider is configured or that a run would
actually succeed — that needs a live-run check on a stand, not a
container health check.

## G4 adapter contract check

`g4-contract-check.sh` exercises the `hermes_gateway` adapter's wire
contract against a container booted from the CI-built image (the node:test
wrapper `scripts/myrmidon/bot-runtime/g4-contract.myrmidon.test.mjs` runs
the live part when `G4_CONTRACT_CHECK_IMAGE` names the image — e.g.
`ghcr.io/itkadr-git/myrmidon-hermes:main` or the tag being released;
locally: `bash docker/bot-runtime/g4-contract-check.sh <image> [port]`).
It checks, over the live gateway HTTP API:

1. `/health` is open, a wrong bearer is rejected (401), stopping an
   unknown run is a clean 404;
2. `Idempotency-Key`: same key + same body replays the same `run_id` with
   `replayed: true`; same key + different body is
   `idempotency_key_conflict` — the property the board's infra-interrupt
   relief for `hermes_gateway` (L1) relies on;
3. `/stop` on a live run: a run pinned to a loopback mock provider stays
   `running`, `POST .../stop` flips it to `stopping` and then `cancelled`,
   with `run.cancelled` as the terminal SSE event;
4. `POST .../approval` with nothing pending is a 409 (the endpoint the
   adapter's auto-deny posts to);
5. the `MYRMIDON_BOT_YOLO` switch: `1` exports `HERMES_YOLO_MODE=1` to
   the gateway process, `0` leaves it unset (approvals follow
   `config.yaml`).

The check needs no secrets: the API server key is generated per run and
used only in headers/env of that run; the mock provider never leaves
loopback and streams one chunk per second so the run is stoppable. The
script binds `/bot` from a throwaway directory whose `hermes/` carries the key through
`${HERMES_HOME}/.env`, per the bot-runtime contract, mirroring the container
driver's single-mount layout.

### Task workspaces: `myr-ws`, `git clone` interception, quota refusals (1.6.5 BOT-DISK-H, contract H0)

How a bot gets its task copy now, per the interface contract
(`docs/myrmidon/bot-disk-contract/README.md`):

- A run arrives with `workspace: {key, repo, baseRef?}`. The gateway opens the
  copy itself with `myr-ws open <key> <repo> [--base <baseRef>] --json` and
  starts the run with `MYRMIDON_TASK_WORKSPACE=/workspace/<key>` as cwd. If
  `open` fails with exit 3/4/5 (quota, base limit, network), the run still
  starts — in `/scratch`, with a warning event.
- The copy is a **worktree** of a per-bot bare base at
  `$HERMES_HOME/.myrmidon/git-base/<owner>/<repo>.git` on branch
  `bot/<KEY>`: no per-copy objects, no promisor packs, no token in
  `.git/config` (auth stays with `git-credential-paperclip`).
- `git clone https://github.com/<owner>/<repo>` inside the container is
  intercepted into `myr-ws open`: with `MYRMIDON_TASK_WORKSPACE` set it opens
  the task copy, otherwise it becomes a scratch copy at `/scratch/<name>`.
  `--filter`, `--depth`, `--mirror` and `--bare` are ignored with a message —
  the objects are already in the base. The real git lives at
  `/opt/paperclip/libexec/git` outside PATH.
- `myr-ws` commands: `open <KEY> [owner/repo] [--base <ref>] [--scratch]`,
  `list`, `close <KEY> [--force]`, `restore <KEY>`, `migrate`; global
  `--json`. Exit codes: `0` ok, `2` invalid arguments, `3` quota/disk
  refusal — the message starts with `BOT_DISK_QUOTA_EXCEEDED:` — `4`
  repository over the base limit (8), `5` network/fetch, `6` no such
  copy/archive, `7` unpushed work without `--force`.
- On `BOT_DISK_QUOTA_EXCEEDED:` the bot partition is over its quota or past
  the refuse-open fill level: stop cloning, commit and push what you have,
  report to the board, do not retry in a loop.
- The in-container agent `botd` follows the board's desired state
  (`GET /api/myrmidon/bots/me/workspaces`): a copy whose task went terminal,
  was reassigned or had its PR merged turns `closing`, survives a grace
  (`general.botDisk.graceClosingMinutes`, default 30 min), and is removed;
  unpushed work is archived first (`$HERMES_HOME/.myrmidon/archive/`, cap 2
  GiB / 30 days) and is restorable with `myr-ws restore <KEY>`. Scratch
  copies expire by idle TTL (`general.botDisk.scratchTtlHours`, default 24 h).
  When the board is unreachable botd deletes nothing. Botd reports disk state
  back with `POST /api/myrmidon/bots/me/disk-report`.

## What's not verified yet

This Dockerfile and entrypoint were written by reading a reference
`hermes-agent` checkout and hermes' own upstream `Dockerfile`/tests, not
by running a build — this session's host forbids installing dependencies
or running Docker builds locally (CONVENTIONS.md, "Сборка и тесты"). CI
builds and, on `main`/tags, should also be given a live boot check before
this image is used for the Этап 2 pilot: start a container with a
generated `API_SERVER_KEY` and no provider configured, confirm `/health`
comes up and `hermes gateway run` does not need a configured model
provider just to serve `api_server` (untested assumption — see the PR's
"Риски и что проверить на стенде").
