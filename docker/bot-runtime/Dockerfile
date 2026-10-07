# syntax=docker/dockerfile:1.20
#
# G1: bot runtime image — a long-running hermes gateway (`hermes gateway run`,
# OpenAI-compatible API server on :8642) that the board talks to through the
# hermes_gateway adapter. See docs/myrmidon/CONVENTIONS.md and
# docs/myrmidon/ROADMAP.md (items C1/H3, owner decision 2026-09-28, "variant
# B") for the surrounding architecture: this image is the long-lived
# per-bot/per-project process; the board and a separate fleet manager own
# its lifecycle. The fuller design write-up behind C1/H3 is maintainer-side
# material, not part of this repository (ROADMAP.md says the same under C1).
#
# hermes-agent is NOT published as an installable PyPI wheel from this
# version on (its own setup.py refuses `bdist_wheel`/`sdist` outside a Nix
# build — "Hermes is distributed via the shell installer, Docker image, or
# Nix"). Editable installs (`uv sync`, `pip install -e .`) are the supported
# path, so this Dockerfile clones the pinned upstream tag and installs it
# editable; the source tree stays in the image (read-only for the runtime
# user) because bundled skills and other packaged assets are resolved by
# hermes relative to the installed module's __file__, not from wheel
# package-data.

# HERMES_VERSION is the `version =` field in hermes' pyproject.toml (the
# number it reports itself); HERMES_GIT_REF is the git tag that ships that
# version. The two do NOT share a numbering scheme: hermes-agent tags
# releases by date (vYYYY.M.D) while pyproject.toml's version field is a
# separate, independently-bumped 0.x.y counter. v2026.9.24 is the tag we
# confirmed (via the GitHub API and `git ls-remote --tags`, against every
# recent release tag) carries `version = "0.21.5"` — do not assume a future
# HERMES_VERSION bump maps to `v<that number>`; look the date tag up the same
# way and update both.
ARG HERMES_VERSION=0.21.5
ARG HERMES_GIT_REF=v2026.9.24
# The exact commit `HERMES_GIT_REF` must resolve to (confirmed via the GitHub API
# against both the fork and upstream, and by `git ls-remote --tags` on the fork).
# A git tag is a mutable ref — upstream (or an MITM on the clone) moving it would otherwise
# silently ship a different tree under the same version/label check below. The builder stage
# fails loudly on a mismatch, before the shallow clone's `.git` is ever removed, so this
# check is only meaningful pinned here, not as a comment. Update both together when
# HERMES_GIT_REF moves to a new tag.
ARG HERMES_GIT_SHA=f97608f178d1ffeca59860195ab7da295f7c8e5f
# myrmidon(HERMES-UPSTREAM): clone the pinned tag from the author's repository.
# Our hermes changes live in this repository (docker/bot-runtime/patches/*.patch)
# and HERMES_GIT_SHA below pins the exact tree, so a moved or tampered upstream
# ref cannot ship anything different. No separate fork is kept.
ARG HERMES_REPO=https://github.com/NousResearch/hermes-agent.git
# gateway/platforms/api_server.py uses aiohttp.web, but aiohttp is not a core
# dependency of hermes-agent — it only ships inside optional extras, most of
# which also pull in Telegram/Discord/Slack client libraries we do not need
# for an API-server-only bot. "sms" is the smallest extra that resolves to
# exactly aiohttp + its own transitive deps and nothing else, so installing
# through it (`uv sync --frozen --extra sms --extra mcp`, see the
# builder stage below) gets aiohttp through the same hash-verified lockfile path as
# every other dependency in this image, instead of a separate unlocked `uv pip
# install`. See docker/bot-runtime/README.md.
ARG HERMES_AIOHTTP_VERSION=3.14.3

# Same uv build + digest hermes-agent's own upstream Dockerfile pins (its
# `uv_source` stage) — reusing a version we found already vetted against
# this exact pyproject.toml/uv.lock pair, rather than picking one blind.
FROM ghcr.io/astral-sh/uv:0.11.6-python3.13-trixie@sha256:b3c543b6c4f23a5f2df22866bd7857e5d304b67a564f4feab6ac22044dde719b AS uv_bin

FROM python:3.13-slim AS builder
ARG HERMES_VERSION
ARG HERMES_GIT_REF
ARG HERMES_GIT_SHA
ARG HERMES_REPO
ARG HERMES_AIOHTTP_VERSION

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

COPY --chmod=0755 --from=uv_bin /usr/local/bin/uv /usr/local/bin/uvx /usr/local/bin/

# build-essential/python3-dev: safety net for any core dependency without a
# manylinux wheel for cp313; discarded with this stage either way.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    git \
    python3-dev \
  && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch "${HERMES_GIT_REF}" "${HERMES_REPO}" /opt/hermes-src
WORKDIR /opt/hermes-src

# Fail the build loudly if the cloned tag does not resolve to the pinned commit
# (moved tag, upstream force-push, MITM on the clone) instead of silently building
# a different tree than the one HERMES_GIT_SHA records as reviewed. Must run before
# .git is removed below — it is the only place this ref's identity can be checked.
RUN set -eu; \
    actual="$(git rev-parse HEAD)"; \
    if [ "$actual" != "${HERMES_GIT_SHA}" ]; then \
      echo "HERMES_GIT_REF=${HERMES_GIT_REF} resolved to commit $actual, HERMES_GIT_SHA=${HERMES_GIT_SHA} disagrees" >&2; \
      exit 1; \
    fi

# Fail the build loudly if the pinned tag and the pinned version disagree
# (wrong build-arg, moved tag, upstream renumbering) instead of silently
# shipping a different hermes than the labels claim.
RUN set -eu; \
    pinned="$(sed -n 's/^version = "\(.*\)"$/\1/p' pyproject.toml)"; \
    if [ "$pinned" != "${HERMES_VERSION}" ]; then \
      echo "HERMES_GIT_REF=${HERMES_GIT_REF} has pyproject version '$pinned' != HERMES_VERSION=${HERMES_VERSION}" >&2; \
      exit 1; \
    fi

# myrmidon(G1): apply our hermes client patches (docker/bot-runtime/patches/*.patch) —
# see docker/bot-runtime/patches/README.md for what each one does and how a new one is
# added and reviewed. Copying the whole directory (not a *.patch glob) so the build
# does not fail if it ever holds only the README again.
COPY patches/ /tmp/patches/
RUN set -eu; \
    for p in /tmp/patches/*.patch; do \
      [ -e "$p" ] || continue; \
      echo "applying $p"; \
      git apply --whitespace=fix "$p"; \
    done

# Fail loudly if pyproject.toml's "sms" extra ever stops being exactly
# aiohttp pinned at HERMES_AIOHTTP_VERSION (a future hermes release could
# add a dependency to it, or repin aiohttp to a different version than the
# rest of the messaging extras) instead of silently installing whatever it
# resolves to.
RUN set -eu; \
    pinned_aiohttp="$(sed -n 's/^sms = \["aiohttp==\(.*\)"\]$/\1/p' pyproject.toml)"; \
    if [ "$pinned_aiohttp" != "${HERMES_AIOHTTP_VERSION}" ]; then \
      echo "pyproject.toml 'sms' extra pins aiohttp==$pinned_aiohttp, HERMES_AIOHTTP_VERSION=${HERMES_AIOHTTP_VERSION} disagrees" >&2; \
      exit 1; \
    fi

# myrmidon(G1): "mcp" is baked in (not left to hermes' own lazy install) because a
# G2-compiled bot profile always writes mcp_servers — without that extra hermes
# silently starts with MCP tools disabled (tools/mcp_tool.py checks
# importlib.util.find_spec('mcp') and logs at debug on failure) instead of a build-
# or start-time error. Hindsight memory is NOT an extra any more: v2026.9.24 moved
# plugins/memory/hindsight/ out of the hermes tree into its plugin catalog, so the
# provider is vendored from that catalog pin below. See README.md
# "Sealed image: lazy installs and the write-safe root" for why lazy-installing
# them at runtime instead is not a reliable fallback in this image.
#
# myrmidon(G1): the venv's `bin/python` is a symlink to whichever interpreter `uv sync`
# picked, and the runtime stage copies only /opt/hermes-src, so that interpreter must exist
# in the runtime stage too. hermes ships a `.python-version` (3.11, a dev-machine pin) that
# `uv sync` honours: when the stage's Python is not 3.11 it silently downloads a managed
# CPython into $HOME (/root/.local/share/uv/python/...) and links the venv to it — a path
# absent from the runtime stage and unreadable by the bot user, so the image died at start
# with "bad interpreter: Permission denied". pyproject.toml's `requires-python`
# (>=3.11,<3.14) admits this stage's Python 3.13, and hermes' own upstream Docker image
# runs Debian 13's system Python (3.13) the same way (its `uv sync` step sees only
# pyproject.toml + uv.lock, never `.python-version`), so the venv is pinned to the base
# image's interpreter. The builder and runtime stages MUST stay on the same
# `python:3.13-slim`, so that path is the same interpreter in both; the runtime-stage
# assertion below checks it. UV_PYTHON_DOWNLOADS=never turns any future mismatch into a
# build error instead of a dangling link.
ENV UV_PYTHON_DOWNLOADS=never
RUN uv sync --frozen --extra sms --extra mcp --python /usr/local/bin/python3 \
  && find /opt/hermes-src/.venv -name '__pycache__' -type d -prune -exec rm -rf {} +

# myrmidon(G1): the Hindsight memory provider now comes from hermes' plugin catalog
# (plugin-catalog/hindsight.yaml, kept in this image) instead of the two patches we used
# to carry against plugins/memory/hindsight/. The catalog entry names the repository, the
# subdirectory and an exact commit; this builder clones exactly that commit (never a
# branch or tag — the same reasoning as HERMES_GIT_SHA above: a movable ref would let a
# different tree ship under the label the catalog entry claims), copies the plugin into
# /opt/hermes-plugins/hindsight, and installs the dependencies the plugin declares through
# hermes' OWN plugin installer — that path resolves them against hermes' core constraints
# and is the same one `hermes plugins install` runs, so a hand-rolled `uv pip install` with
# no constraint check cannot drift from it. The plugin directory is sealed (root-owned)
# like the rest of /opt/hermes-src; the entrypoint links it into the bot's writable
# HERMES_HOME at container start, which is where hermes looks for user memory providers.
# The catalog pin is read from the catalog file (not repeated as a build arg) so there is
# exactly one place to bump it. See patches/README.md and docs/myrmidon/hermes-deltas.md.
RUN set -eu; \
    repo="$(sed -n 's/^repo:[[:space:]]*//p' plugin-catalog/hindsight.yaml)"; \
    subdir="$(sed -n 's/^subdir:[[:space:]]*//p' plugin-catalog/hindsight.yaml)"; \
    sha="$(sed -n 's/^sha:[[:space:]]*//p' plugin-catalog/hindsight.yaml)"; \
    if [ -z "$repo" ] || [ -z "$subdir" ] || [ -z "$sha" ]; then \
      echo "plugin-catalog/hindsight.yaml must name repo, subdir and sha" >&2; exit 1; \
    fi; \
    git init -q /tmp/hindsight-plugin; \
    git -C /tmp/hindsight-plugin remote add origin "$repo"; \
    git -C /tmp/hindsight-plugin sparse-checkout init --cone; \
    git -C /tmp/hindsight-plugin sparse-checkout set "$subdir"; \
    git -C /tmp/hindsight-plugin fetch --depth 1 --filter=blob:none origin "$sha"; \
    git -C /tmp/hindsight-plugin checkout -q --detach FETCH_HEAD; \
    actual="$(git -C /tmp/hindsight-plugin rev-parse HEAD)"; \
    if [ "$actual" != "$sha" ]; then \
      echo "$repo $sha resolved to commit $actual, catalog pin disagrees" >&2; exit 1; \
    fi; \
    mkdir -p /opt/hermes-plugins/hindsight; \
    cp -a "/tmp/hindsight-plugin/$subdir/." /opt/hermes-plugins/hindsight/; \
    rm -rf /tmp/hindsight-plugin

# Fail the build loudly if the plugin's own dependency declaration cannot be installed
# against hermes' core constraints (or silently installs nothing / the wrong thing) —
# the provider reports "not available" at runtime otherwise. install_for_plugin_dir never
# raises; it returns a status, so translate anything but installed/none into a build error.
RUN HERMES_HOME=/opt/hermes-plugin-deps /opt/hermes-src/.venv/bin/python -c \
    "from hermes_cli.plugin_python_deps import install_for_plugin_dir as install; \
o = install('/opt/hermes-plugins/hindsight'); \
print('hindsight plugin deps:', o.status, o.detail if hasattr(o, 'detail') else ''); \
raise SystemExit(0 if o.status in ('installed', 'none') else 1)"

# Fail the build loudly if any package this image relies on being preinstalled (never
# lazily) fails to import from the synced venv, instead of only discovering it the first
# time a bot profile tries to use MCP tools or hindsight memory at runtime.
RUN /opt/hermes-src/.venv/bin/python -c 'import aiohttp, mcp, hindsight_client'

# myrmidon(G1): import smoke for every module a patch in patches/ changes
# (hermes_state: 04, 06; tools.environments.base and base_session_env: 02; gateway.run: 05;
# gateway.platforms.api_server_runs, tools.environments.local and tools.github_broker_context: 09;
# tools.run_workspace (also api_server_runs/local): 10)
# plus the vendored memory provider (a relative-import package, so a broken plugin tree
# fails the build here, not at the first bot start). `git apply` only proves the hunks
# land; a patch that applies cleanly but breaks a module's imports or top-level code
# would otherwise surface only when a bot starts. No bytecode is written, so the sealed
# tree stays as the build left it.
RUN PYTHONDONTWRITEBYTECODE=1 /opt/hermes-src/.venv/bin/python -c 'import hermes_state, tools.environments.base, tools.environments.base_session_env, gateway.run, gateway.platforms.api_server_runs, tools.environments.local, tools.github_broker_context, tools.run_workspace'

# myrmidon(G1): behaviour check for patch 06 — the state-DB generation probe must not
# walk /proc/self/fd once per write while the gateway holds hundreds of descriptors
# (see patches/README.md and tests/state_db_fd_probe_budget.py). The import smoke above
# proves the patched module still imports; this one proves the patched behaviour still
# holds, against the same synced venv and the same patched tree. It runs in the builder
# stage only; the tests directory is not copied into the runtime image.
COPY tests/ /tmp/patch-tests/
RUN PYTHONDONTWRITEBYTECODE=1 /opt/hermes-src/.venv/bin/python /tmp/patch-tests/state_db_fd_probe_budget.py /opt/hermes-src
# myrmidon(G1): behaviour regression for 09-run-scoped-github-broker.patch
# (CONTAINER-GITHUB-WRITE): the github_broker body field must bind per-run
# (contextvars), bridge into terminal child envs, and never touch the process
# env shared by concurrent runs.
RUN PYTHONDONTWRITEBYTECODE=1 /opt/hermes-src/.venv/bin/python /tmp/patch-tests/github_broker_run_scope.py /opt/hermes-src
# myrmidon(BOT-DISK-H5b): behaviour regression for 10-run-workspace-open.patch
# (bot-disk contract C6): the workspace body field must run `myr-ws open`
# (fake CLI via MYRMIDON_WS_BIN) with the contract argv, bind the opened path as
# cwd + MYRMIDON_TASK_WORKSPACE per run, fall back to /scratch with a warning on
# exit codes 3/4/5, and be a no-op — never an inherited stale value — without
# the field.
RUN PYTHONDONTWRITEBYTECODE=1 /opt/hermes-src/.venv/bin/python /tmp/patch-tests/run_workspace_open.py /opt/hermes-src
# myrmidon(G1): names imported inside functions of the patched modules resolve too
# (the import smoke above runs only top-level imports; a missing lazily imported name
# broke every run of the 1.6.0 dev image while the build passed).
RUN PYTHONDONTWRITEBYTECODE=1 /opt/hermes-src/.venv/bin/python /tmp/patch-tests/lazy_imports_resolve.py /opt/hermes-src hermes_state tools.environments.base tools.environments.base_session_env gateway.run gateway.platforms.api_server_runs tools.environments.local tools.github_broker_context tools.run_workspace

# The provider itself, through hermes' OWN discovery path (the same one the gateway uses at
# start): a staging home gets the same symlink the entrypoint will make at run time, and
# find_provider_dir must resolve it. This catches a broken plugin tree, a missing
# __init__.py or a relative-import failure at build time instead of at the first bot start.
RUN set -eu; \
    mkdir -p /opt/hermes-plugin-deps/plugins; \
    ln -sfn /opt/hermes-plugins/hindsight /opt/hermes-plugin-deps/plugins/hindsight; \
    PYTHONDONTWRITEBYTECODE=1 HERMES_HOME=/opt/hermes-plugin-deps /opt/hermes-src/.venv/bin/python -c \
      "from plugins.memory import find_provider_dir; p = find_provider_dir('hindsight'); print('hindsight provider dir:', p); raise SystemExit(0 if p else 1)"

# myrmidon(G1): the runtime image only needs the installed package plus
# bundled skills (tools/skills_sync.py resolves skills/ relative to its own
# __file__, so that lookup is unaffected by anything removed below). Drop
# the shallow clone's git history (never needed after `git apply`/`uv sync`
# above — hermes-agent's version is a static pyproject.toml string, not
# derived from git at build time) and the top-level dev/build-only
# directories and lockfiles that are never imported at runtime, so the
# image does not ship the whole upstream checkout. `plugin-catalog/` is
# kept: hermes_cli/plugin_catalog.py reads it at runtime
# (get_bundled_catalog_dir()).
RUN rm -rf /opt/hermes-src/.git \
    /opt/hermes-src/tests \
    /opt/hermes-src/tests-js \
    /opt/hermes-src/evals \
    /opt/hermes-src/docs \
    /opt/hermes-src/contributors \
    /opt/hermes-src/nix \
    /opt/hermes-src/mcp-research-data \
    /opt/hermes-src/package-lock.json \
    /opt/hermes-src/flake.lock \
    /opt/hermes-src/flake.nix

FROM python:3.13-slim AS runtime
ARG HERMES_VERSION

# myrmidon.bot-runtime.contract: the G3 container driver
# (server/src/myrmidon/bot-containers/template.ts, BOT_RUNTIME_CONTRACT_LABEL)
# refuses to create a container from an image that does not declare a supported
# value here — see that file's docstring on BOT_RUNTIME_CONTRACT_LABEL for the
# full contract this image commits to (uid:gid, mounts, secrets via
# $HERMES_HOME/.env, read-only root, shell requirements).
LABEL org.opencontainers.image.title="myrmidon-hermes" \
      org.opencontainers.image.description="Bot runtime image: hermes gateway (API server) for a Myrmidon bot or project container" \
      org.opencontainers.image.source="https://github.com/itkadr-git/myrmidon" \
      org.opencontainers.image.licenses="MIT" \
      io.github.itkadr-git.myrmidon.base.hermes-version="${HERMES_VERSION}" \
      myrmidon.bot-runtime.contract="1" \
      myrmidon.bot-runtime.scope="1"

# ripgrep: hermes' file-search tool shells out to `rg`. git: workspace tools
# (status/diff/commit) for coding-agent bots. curl: HEALTHCHECK only. openssh-client:
# key-based ssh from a bot (-i <tmp key>, -o UserKnownHostsFile=<writable dir>).
# jq: bots pipe JSON API responses (board, shop, ads APIs) through it in shell
# steps; it is a small text tool, not a media tool.
# No media tools (ffmpeg, yt-dlp, ...): forbidden by docs/myrmidon/CONVENTIONS.md §8
# and out of scope — media handling is a separate service outside this image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    jq \
    openssh-client \
    ripgrep \
    tini \
  && rm -rf /var/lib/apt/lists/*

# myrmidon(G1): --home-dir /data/hermes (not /home/bot) — the G3 driver runs this
# image with ReadonlyRootfs: true (docker-driver.ts buildCreateContainerRequestBody),
# so anything under $HOME on the image's own filesystem (dotfiles a library writes on
# first use — pip/uv cache dirs, .gitconfig, …) would fail to write instead of no-op.
# /data/hermes is always present and writable (it is HERMES_HOME; since BOT-DISK-D a
# link into the bot's single /bot mount, made below, so no --create-home here);
# mirrors hermes' own upstream Dockerfile, which points its `hermes` user's home at
# its data volume for the identical reason (`useradd -m -d /opt/data`).
RUN groupadd --gid 10001 bot \
  && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /data/hermes --shell /usr/sbin/nologin bot

COPY --from=builder --chown=root:root /opt/hermes-src /opt/hermes-src
# myrmidon(G1): the catalog memory provider vendored in the builder stage, sealed like the
# rest of /opt (root-owned, not writable by `bot`). The entrypoint links it into the bot's
# writable HERMES_HOME at container start — hermes only looks for a memory provider under
# $HERMES_HOME/plugins (or the bundled tree), and the bot's HERMES_HOME is a mounted volume
# that does not exist at build time. HERMES_CATALOG_PLUGINS_DIR is the single place both the
# entrypoint and the docs take that path from.
COPY --from=builder --chown=root:root /opt/hermes-plugins /opt/hermes-plugins
# myrmidon(G1): uv is also needed at runtime, not just to build the image — hermes'
# own lazy-install mechanism (tools/lazy_deps.py, see the ENV block below) shells out
# to `uv pip install --target <dir>` first and only falls back to `pip`/`ensurepip`
# (which would try to write into the sealed, read-only /opt/hermes-src/.venv and
# fail) when uv is not on PATH. Without this, every lazy-installable opt-in backend
# (a non-baked-in model provider, a web-search backend, TTS/STT, OTLP export, ...)
# would be silently broken in this image the first time a bot profile picked one.
COPY --chmod=0755 --from=uv_bin /usr/local/bin/uv /usr/local/bin/uvx /usr/local/bin/
COPY --chmod=0755 entrypoint.sh /usr/local/bin/bot-runtime-entrypoint

# /opt/hermes-src is root-owned and not writable by `bot` — the venv, the
# hermes source and the bundled skills under it are effectively read-only
# for the runtime user without a separate read-only bind mount. Sealing it
# this way also seals hermes' own lazy-install mechanism
# (tools/lazy_deps.py — installs an opt-in backend's SDK, e.g. the native
# `anthropic` provider, `bedrock`, a web-search backend, on first use): with
# neither HERMES_LAZY_INSTALL_TARGET nor HERMES_DISABLE_LAZY_INSTALLS set,
# it defaults to installing straight into this read-only venv, which would
# fail with a raw `uv pip install` permission error the first time any bot
# profile picks such a feature, instead of hermes' own clean "no writable
# target configured" message. HERMES_WRITE_SAFE_ROOT scopes hermes' own
# write/patch tools (agent/file_safety.py) to the durable volume for the
# same "sealed, unattended container" reason. All three ENV vars below
# mirror hermes' own upstream Dockerfile, which seals its image the same
# way and redirects lazy installs and safe writes to its data volume for
# the identical reason.
#
# myrmidon(BOT-DISK-D): a bot container has ONE bind mount, its whole writable tree,
# at /bot (template.ts BOT_ROOT_MOUNT). hard links work only within one mount, which
# is what lets pnpm link node_modules into its store, so the three paths the
# bot-runtime contract names are not mounts but links into that one: /data/hermes ->
# /bot/hermes, /workspace -> /data/workspace -> /bot/workspace, /scratch ->
# /data/scratch -> /bot/scratch. The directories are created and chowned here so a
# manual `docker run` without a mount still gets a writable tree; the G3 driver's
# prepare-volumes helper re-chowns the three from the host side regardless.
RUN mkdir -p /bot/hermes /bot/workspace /bot/scratch /data \
  && ln -s /bot/hermes /data/hermes \
  && ln -s /bot/workspace /data/workspace \
  && ln -s /bot/scratch /data/scratch \
  && ln -s /data/workspace /workspace \
  && ln -s /data/scratch /scratch \
  && chown bot:bot /bot /bot/hermes /bot/workspace /bot/scratch /data \
  && chown -h bot:bot /data/hermes /data/workspace /data/scratch /workspace /scratch

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/hermes-src/.venv/bin:$PATH \
    HERMES_HOME=/data/hermes \
    HERMES_BUNDLED_SKILLS=/opt/hermes-src/skills \
    HERMES_CATALOG_PLUGINS_DIR=/opt/hermes-plugins \
    HERMES_WRITE_SAFE_ROOT=/data:/workspace:/scratch:/bot:/bot-scope \
    HERMES_DISABLE_LAZY_INSTALLS=1 \
    HERMES_LAZY_INSTALL_TARGET=/data/hermes/lazy-packages \
    NO_COLOR=1 \
    API_SERVER_ENABLED=true \
    API_SERVER_HOST=0.0.0.0 \
    API_SERVER_PORT=8642 \
    MYRMIDON_BOT_YOLO=1
# myrmidon(G1): HOME=$HERMES_HOME (/data/hermes), not /home/bot — see the useradd
# comment above; ENV cannot reference another ENV set earlier in the same
# instruction reliably across BuildKit versions, so the literal is repeated here.
ENV HOME=/data/hermes

USER 10001:10001
# myrmidon(BOT-DISK-F): "/" and not /workspace: for a member of a shared isolation scope /workspace
# is a link that only exists after the entrypoint makes it, and a container whose working
# directory does not resolve at start does not start. The entrypoint enters /workspace itself.
WORKDIR /
VOLUME ["/bot"]
EXPOSE 8642

# myrmidon(G1): build-time guard for the venv interpreter, run as the runtime user in the
# runtime stage (not in the builder, where /root is readable and the interpreter always
# exists): the venv's python must resolve outside /root and the hermes source must import
# through the editable install (cwd /workspace, so nothing is found via the working dir).
# A `bin/python` link into the builder's /root fails here, at build time, instead of when
# the first container starts.
RUN /opt/hermes-src/.venv/bin/python -c 'import os, sys; real = os.path.realpath(sys.executable); assert not real.startswith("/root/"), "venv python resolves into /root: " + real; import hermes_state'

# /health needs no auth (unlike /v1/capabilities, which is Bearer-gated) —
# see docker/bot-runtime/README.md and gateway/platforms/api_server.py.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${API_SERVER_PORT}/health" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/bot-runtime-entrypoint"]

# ---------------------------------------------------------------------------
# Variant `runtime-node`: the `runtime` image plus Node.js and a fixed set of
# preinstalled packages, for the few bots whose work is node scripts
# (presentations/documents, diagram and image rendering). INTERIM measure until
# a per-task sandbox exists; the plain `runtime` target stays the default image
# and this stage is only built explicitly (`--target runtime-node`, published as
# ghcr.io/itkadr-git/myrmidon-hermes-node). Nothing else differs: same uid,
# same read-only root, same contract label, same entrypoint. See README.md,
# "Variant with Node.js".
#
# NODE_VERSION is an exact release of the pinned LTS major; NODE_SHA256 is the
# digest of the linux-x64 .tar.xz from that release's SHASUMS256.txt. Bump both
# together. The build fails on a digest mismatch.
# ---------------------------------------------------------------------------
FROM python:3.13-slim AS node_dist
ARG NODE_VERSION=22.23.3
ARG NODE_SHA256=df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de

# Fonts: @napi-rs/canvas draws text with system fonts only, and the slim base
# has none, so Cyrillic labels in a rendered diagram would come out as boxes.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    fonts-dejavu-core \
    fonts-liberation \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    curl -fsSL -o /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"; \
    echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c -; \
    mkdir /opt/node; \
    tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1; \
    rm -rf /tmp/node.tar.xz /opt/node/include /opt/node/share /opt/node/CHANGELOG.md /opt/node/README.md; \
    /opt/node/bin/node --version | grep -x "v${NODE_VERSION}"

FROM node_dist AS node_tools
ENV PATH=/opt/node/bin:$PATH
WORKDIR /opt/node-tools
# package.json pins exact versions; package-lock.json pins every transitive
# package with an integrity hash, and `npm ci` refuses to run if they disagree.
# --ignore-scripts: the native packages (sharp, @napi-rs/canvas) ship prebuilt
# binaries as platform packages, no install script or compiler is involved.
COPY node-tools/package.json node-tools/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  && rm -rf /root/.npm

FROM runtime AS runtime-node
LABEL org.opencontainers.image.title="myrmidon-hermes-node" \
      org.opencontainers.image.description="Bot runtime image, Node.js variant: hermes gateway plus Node.js and preinstalled document/image packages" \
      io.github.itkadr-git.myrmidon.variant="node"

COPY --from=node_dist --chown=root:root /opt/node /opt/node
COPY --from=node_tools --chown=root:root /opt/node-tools /opt/node-tools
COPY --from=node_dist --chown=root:root /usr/share/fonts/truetype /usr/share/fonts/truetype
COPY --chown=root:root node-tools/smoke.cjs /opt/node-tools/smoke.cjs

# The root filesystem is read-only at run time, so every place node or npm write
# to must be a mounted volume: the npm cache and the global prefix live under
# /scratch (wiped with the scratch volume, which is fine for a cache), $HOME is
# already /data/hermes. /opt/node-tools is sealed (root-owned) and reached from
# any working directory through NODE_PATH — this covers CommonJS `require()`
# only; ES module `import` ignores NODE_PATH, so an .mjs script imports these
# packages by absolute path or through `createRequire` (README.md).
#
# PATH must not hold any writable volume (/data, /workspace, /scratch, /tmp): the
# dockergate image check rejects it, since a bot could plant a binary there. So the
# global prefix's bin directory is deliberately not on PATH; bots use the packages
# preinstalled in /opt/node-tools.
ENV PATH=/opt/node/bin:$PATH \
    NODE_TOOLS_DIR=/opt/node-tools \
    NODE_PATH=/opt/node-tools/node_modules:/scratch/npm-global/lib/node_modules \
    NPM_CONFIG_CACHE=/scratch/npm-cache \
    NPM_CONFIG_PREFIX=/scratch/npm-global \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

USER 10001:10001

# Build-time check, run as the runtime user in the finished stage (not in the
# builder where everything is readable): every preinstalled package loads and
# does a small real job (pptx written to a temp file, a Cyrillic text rendered
# and re-encoded, a PDF built, pdfjs imported). Only /tmp is written to.
RUN node /opt/node-tools/smoke.cjs && npm --version

# ---------------------------------------------------------------------------
# Variant `runtime-dev`: the `runtime` image plus the whole toolchain a member
# of the development team needs to run a repository pull-request cycle
# (install, typecheck, test, push) from inside a bot container. A bot container
# has no Docker of its own — dockergate refuses arbitrary containers on purpose
# — so the team cannot open a throwaway `node:24` container the way it does on
# a separate sandbox host. Published as
# ghcr.io/itkadr-git/myrmidon-hermes-dev by the same workflow and with the same
# gating as the other variants (push to `main` and `myr-v*` tags; a pull
# request builds and checks it, never pushes).
#
# Everything the shared `runtime` image guarantees still holds and is NOT
# redeclared here: uid/gid `10001:10001`, the read-only root filesystem, the
# three fixed volumes, the entrypoint, the health check and the inherited
# `myrmidon.bot-runtime.contract="1"` label. This stage only ADDS toolchains.
#
# The dockergate image check (tools/dockergate/internal/policy/image.go) reads
# this image too: no element of PATH may live under a writable root (/data,
# /workspace, /scratch, /tmp), because a bot could plant a binary there. Every
# toolchain below therefore lands under /opt or /usr, and no `ENV`/`BASH_ENV`
# variable name is set (a shell that reads a file at start is refused).
#
# Version pins and wrapper checks: see the COPY/RUN block below and
# "Heavy builds are blocked at the image level" in README.md.
# ---------------------------------------------------------------------------
# myrmidon(1.6.1 BUILD-OFFLOAD A): the dev variant also carries build
# wrappers (pnpm/tsc/vitest/gradle/go) in /opt/paperclip/bin that refuse
# heavy repository operations with a "use devbuild" error unless the
# devbuild gateway (/usr/local/bin/devbuild, mounted by part B) is present —
# installs, typechecks, test runs and compiler builds belong on the build VPS.
# ---------------------------------------------------------------------------
FROM python:3.13-slim AS node24_dist
ARG NODE24_VERSION=24.21.0
ARG NODE24_SHA256=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6

# The slim base carries neither curl nor xz, and the Node.js tarball is .tar.xz.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    curl -fsSL -o /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE24_VERSION}/node-v${NODE24_VERSION}-linux-x64.tar.xz"; \
    echo "${NODE24_SHA256}  /tmp/node.tar.xz" | sha256sum -c -; \
    mkdir /opt/node24; \
    tar -xJf /tmp/node.tar.xz -C /opt/node24 --strip-components=1; \
    rm -rf /tmp/node.tar.xz /opt/node24/include /opt/node24/share /opt/node24/CHANGELOG.md /opt/node24/README.md; \
    /opt/node24/bin/node --version | grep -x "v${NODE24_VERSION}"

# Go: the repository's dockergate and fleetd tools are Go modules (go 1.25,
# stdlib only), and CI runs gofmt/go vet/go test over them in their own lanes.
# The official tarball is pinned by exact version and sha256, like Node.js.
FROM python:3.13-slim AS go_dist
ARG GO_VERSION=1.25.14
ARG GO_SHA256=a21ae5633a269bcd7e90cf767e48225633795e99d831742cbf3397064fee7712

# The slim base carries no curl.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    curl -fsSL -o /tmp/go.tar.gz "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz"; \
    echo "${GO_SHA256}  /tmp/go.tar.gz" | sha256sum -c -; \
    mkdir -p /opt/go; \
    tar -xzf /tmp/go.tar.gz -C /opt/go --strip-components=1; \
    rm -f /tmp/go.tar.gz; \
    /opt/go/bin/go version | grep -q "go${GO_VERSION}"

# Docker CLI, client only. The bot container runs no engine (the container
# driver refuses arbitrary containers on purpose); the development team's
# engine is the sandbox VM, reached over mutual TLS. The static release
# tarball is pinned by exact version and sha256 like every other download
# here, and only the `docker` binary is copied out of it — the tarball also
# ships dockerd, containerd and runc, and none of those may enter this image.
FROM python:3.13-slim AS docker_cli_dist
ARG DOCKER_CLI_VERSION=29.7.2
ARG DOCKER_CLI_SHA256=803d433f226db4776e1768fd319fc6c6e4935a456acf84fcc0080818b854bc8f

# The slim base carries no curl.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
  && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    curl -fsSL -o /tmp/docker.tgz "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_CLI_VERSION}.tgz"; \
    echo "${DOCKER_CLI_SHA256}  /tmp/docker.tgz" | sha256sum -c -; \
    mkdir -p /tmp/docker-cli /opt/docker-cli/bin; \
    tar -xzf /tmp/docker.tgz -C /tmp/docker-cli; \
    cp /tmp/docker-cli/docker/docker /opt/docker-cli/bin/docker; \
    rm -rf /tmp/docker.tgz /tmp/docker-cli; \
    /opt/docker-cli/bin/docker --version | grep -q "${DOCKER_CLI_VERSION}"

FROM runtime AS runtime-dev
LABEL org.opencontainers.image.title="myrmidon-hermes-dev" \
      org.opencontainers.image.description="Bot runtime image, development variant: hermes gateway plus Node.js, pnpm, Go, Rust, git/gh/jq/zstd and a C toolchain for a repository pull-request cycle; heavy builds are routed to the build VPS via devbuild (1.6.1 BUILD-OFFLOAD)" \
      io.github.itkadr-git.myrmidon.variant="dev"

# The base stage is `USER 10001:10001`; installing needs root, and the stage
# ends by returning to the contract user (the G3 driver refuses any other user,
# and dockergate checks Config.User against 10001:10001 before any create).
USER root

# Build tools the repository needs to install and build its workspaces:
# gcc/g++/make/pkg-config for native addons and node-gyp, python3 (present in
# the base) for node-gyp itself, gh for the pull-request cycle, zstd and unzip
# for archives, xz-utils for the tarballs above. Same --no-install-recommends
# discipline as the other stages.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    g++ \
    gcc \
    gh \
    git \
    jq \
    libc6-dev \
    make \
    openssh-client \
    pkg-config \
    python3 \
    ripgrep \
    unzip \
    xz-utils \
    zstd \
  && rm -rf /var/lib/apt/lists/*

# Rust: packages/paperclip-runner carries a native crate and its own
# rust-toolchain.toml, which is the single owner of the compiler pin — the same
# version-pinned, checksum-verified rustup installer and the same
# "install the package-owned compiler before source enters the stage" step as
# the repository's own build Dockerfile. RUST_CHANNEL must stay equal to the
# channel in packages/paperclip-runner/rust-toolchain.toml; a guard test
# (scripts/myrmidon/bot-runtime/dockerfile.test.mjs) fails if the two drift.
ENV RUSTUP_HOME=/opt/rustup \
    CARGO_HOME=/opt/cargo
ARG RUST_CHANNEL=1.97.1
ARG RUSTUP_VERSION=1.29.0
ARG RUSTUP_SHA256_AMD64=4acc9acc76d5079515b46346a485974457b5a79893cfb01112423c89aeb5aa10
# `rustup` lands in $CARGO_HOME/bin, which is not on PATH until the final
# ENV below — put it on PATH for this RUN, or `rustup toolchain install`
# exits 127 with "rustup: not found".
RUN set -eux; \
    export PATH="/opt/cargo/bin:$PATH"; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) rustTarget="x86_64-unknown-linux-gnu"; sha256="$RUSTUP_SHA256_AMD64" ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/rustup-init "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${rustTarget}/rustup-init"; \
    echo "${sha256}  /tmp/rustup-init" | sha256sum -c -; \
    chmod +x /tmp/rustup-init; \
    /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain none; \
    rm /tmp/rustup-init; \
    rustup toolchain install "${RUST_CHANNEL}" --profile minimal --component rustfmt; \
    rustup default "${RUST_CHANNEL}"; \
    cargo --version; rustc --version; rustfmt --version

COPY --from=node24_dist --chown=root:root /opt/node24 /opt/node24
COPY --from=go_dist --chown=root:root /opt/go /opt/go
COPY --from=docker_cli_dist --chown=root:root /opt/docker-cli /opt/docker-cli

# pnpm: the repository pins `packageManager: pnpm@9.15.4`. It is installed with
# the pinned Node.js npm into a sealed /opt prefix — the same reason the Node.js
# variant keeps its global prefix off PATH: an element under a writable volume
# is refused by dockergate, so the package manager may not live in /scratch.
# corepack is deliberately not used (it fails on this base).
ARG PNPM_VERSION=10.18.1
RUN PATH=/opt/node24/bin:$PATH npm install --global --prefix /opt/pnpm "pnpm@${PNPM_VERSION}" \
  && PATH=/opt/node24/bin:$PATH /opt/pnpm/bin/pnpm --version | grep -x "${PNPM_VERSION}" \
  && rm -rf /root/.npm

# myrmidon(G1) CONTAINER-GITHUB-WRITE: the run-scoped GitHub broker wrappers
# for the dev variant. The hermes patch 09 exports the run's broker capability
# (PAPERCLIP_GITHUB_BROKER_URL/TOKEN) into exactly that run's terminal
# children; these wrappers consume it:
#   - /opt/paperclip/bin/git-credential-paperclip answers git's `get` for
#     github.com/https from the board's POST /runtime-tools/github/credentials;
#   - /opt/paperclip/bin/gh resolves the credential the same way and runs the
#     real gh with the returned env;
#   - /etc/gitconfig installs the helper URL-scoped (leading empty value
#     clears ambient helpers), so no GIT_CONFIG_* env vars are needed (the
#     terminal env scrub would drop those).
# Everything lands under /opt and /etc — PATH policy keeps only /opt and /usr
# elements, and the root filesystem is read-only at run time, so a bot cannot
# plant or rewrite a helper. The wrappers are Node scripts using the image's
# own /opt/node24 (no extra runtime), carry no secrets, and fail open: without
# a capability in the environment, git/gh behave exactly as before.
COPY --chown=root:root github-broker/git-credential-paperclip github-broker/gh /opt/paperclip/bin/
COPY --chown=root:root github-broker/gitconfig /etc/gitconfig
RUN chmod 0755 /opt/paperclip/bin/git-credential-paperclip /opt/paperclip/bin/gh \
  && /opt/node24/bin/node --check /opt/paperclip/bin/git-credential-paperclip \
  && /opt/node24/bin/node --check /opt/paperclip/bin/gh \
  && git config --system --list >/dev/null

# myrmidon(1.6.2 BOT-DISK-C): shared git objects. /opt/paperclip/bin/git shadows
# /usr/bin/git and adds `--reference-if-able /cache/git/<owner>/<repo>.git` to a
# `git clone` of a GitHub repository the board mirrors (the read-only /cache/git
# mount, absent unless the instance setting lists mirrored repositories); every
# other git invocation runs the real git unchanged, credential helper included.
# bot-clone-hygiene reports which clones hold unpushed work (the entrypoint
# runs it in the background); the board's draft-directory lifecycle reads that
# report before it removes an idle clone. Node/Python scripts under /opt only.
#
# myrmidon(1.6.5 BOT-DISK-G): the same wrapper also answers for a bare `git`
# when a bot terminal rebuilds PATH without /opt/paperclip/bin (the hermes
# adapter appends only its own directories and the sane /usr and /usr/local
# elements to the PATH the gateway captured). A /usr/local/bin symlink shadows
# /usr/bin/git through the *reordered* PATH, and the wrapper's shebang names
# /opt/node24/bin/node absolutely, so both facts hold in that terminal — which
# is exactly where the clones happen. The build-time check below asserts both:
# without the symlink a bare `git` is the real binary; with a broken shebang it
# dies with 127 in a PATH the wrapper cannot inject itself into.
COPY --chown=root:root git-reference/git git-reference/bot-clone-hygiene git-reference/clone-args.js /opt/paperclip/bin/
RUN chmod 0755 /opt/paperclip/bin/git /opt/paperclip/bin/bot-clone-hygiene \
  && ln -s /opt/paperclip/bin/git /usr/local/bin/git \
  && /opt/node24/bin/node --check /opt/paperclip/bin/git \
  && head -1 /opt/paperclip/bin/git | grep -qx "#!/opt/node24/bin/node" \
  && python3 -m py_compile /opt/paperclip/bin/bot-clone-hygiene \
  && rm -rf /opt/paperclip/bin/__pycache__

# myrmidon(1.6.5 BOT-DISK-H1c): the real git moves out of PATH. The Debian binary
# goes to /opt/paperclip/libexec/git (dpkg-divert keeps a later `apt` upgrade of
# the git package from putting it back), and /usr/bin/git becomes a symlink to the
# wrapper, so EVERY bare `git` — whatever PATH a bot terminal rebuilds — answers
# through the wrapper; there is no regular way to reach the real binary but its
# absolute libexec path (which the ownership and quota layers catch). The wrapper's
# default REAL_GIT is that libexec path (MYRMIDON_GIT_REAL still overrides it) —
# without that, the wrapper would exec itself. git finds its helpers
# (git-upload-pack, git-remote-https, ...) through the compiled-in
# /usr/lib/git-core, not through the binary's own path, so moving it is safe; the
# build asserts that with a real `git ls-remote` of a local repository (the
# git-upload-pack helper) through the wrapper.
#
# myr-ws (CLI, H2) and botd (lifecycle agent, H3) are installed whole, as
# directories (lib/*.js and package.json go with the entry point): myr-ws/ to
# /opt/paperclip/myr-ws, botd/ to /opt/paperclip/botd. /opt/paperclip/bin/myr-ws
# and /usr/local/bin/myr-ws (a terminal PATH without /opt/paperclip/bin) are
# symlinks to /opt/paperclip/myr-ws/myr-ws; /opt/paperclip/bin/botd links to the
# botd entry point /opt/paperclip/botd/botd. Until that entry point exists in the
# tree (H3 ships lib/ first) there is no botd link, the image still builds and the
# entrypoint falls back to bot-clone-hygiene (see entrypoint.sh). The two
# directories must be in the tree: this change merges after BOT-DISK-H2/H3a.
COPY --chown=root:root myr-ws/ /opt/paperclip/myr-ws/
COPY --chown=root:root botd/ /opt/paperclip/botd/
RUN set -eu; \
    mkdir -p /opt/paperclip/libexec; \
    dpkg-divert --local --rename --divert /opt/paperclip/libexec/git --add /usr/bin/git; \
    ln -s /opt/paperclip/bin/git /usr/bin/git; \
    chmod 0755 /opt/paperclip/libexec/git; \
    chmod 0755 /opt/paperclip/myr-ws/myr-ws; \
    ln -s /opt/paperclip/myr-ws/myr-ws /opt/paperclip/bin/myr-ws; \
    ln -s /opt/paperclip/myr-ws/myr-ws /usr/local/bin/myr-ws; \
    [ -x /usr/local/bin/myr-ws ] && [ -x /opt/paperclip/bin/myr-ws ] || { echo "myr-ws is not executable" >&2; exit 1; }; \
    if [ -f /opt/paperclip/botd/botd ]; then \
      chmod 0755 /opt/paperclip/botd/botd; \
      ln -s /opt/paperclip/botd/botd /opt/paperclip/bin/botd; \
      [ -x /opt/paperclip/bin/botd ] || { echo "botd is not executable" >&2; exit 1; }; \
    fi; \
    [ "$(readlink /usr/bin/git)" = "/opt/paperclip/bin/git" ] || { echo "/usr/bin/git must be the wrapper symlink" >&2; exit 1; }; \
    [ -x /opt/paperclip/libexec/git ] && [ ! -L /opt/paperclip/libexec/git ] || { echo "the real git must sit in libexec as a regular file" >&2; exit 1; }; \
    for el in $(echo "$PATH" | tr ':' ' '); do \
      [ "$el" = /opt/paperclip/libexec ] && { echo "libexec must not be on PATH" >&2; exit 1; }; \
      if [ -e "$el/git" ] && [ "$(readlink -f "$el/git")" != "$(readlink -f /opt/paperclip/bin/git)" ]; then \
        echo "$el/git is a real git outside libexec" >&2; exit 1; \
      fi; \
    done; \
    out="$(env -i PATH=/usr/bin:/bin git --version)"; \
    case "$out" in "git version "*) ;; *) echo "git --version through the wrapper failed: $out" >&2; exit 1 ;; esac; \
    d="$(mktemp -d)"; /opt/paperclip/libexec/git init -q "$d/r"; \
    env -i PATH=/usr/bin:/bin git ls-remote "$d/r" >/dev/null; \
    rm -rf "$d"

# myrmidon(1.6.1 BUILD-OFFLOAD A): the build-offload wrappers. Heavy
# repository operations (pnpm install, monorepo tsc, vitest, gradle,
# go build/test) must run on the build VPS through the `devbuild` CLI
# (task B mounts /usr/local/bin/devbuild into the per-invocation build
# container), not inside a bot container where they starve the gateway.
# These Node wrappers stand in /opt/paperclip/bin — FIRST on PATH, ahead
# of /opt/pnpm/bin, /opt/node24/bin and /opt/go/bin — so a bare `pnpm
# install` or `go build` hits the wrapper before the real binary:
# a physical barrier, not a convention. The gate condition is the
# executable /usr/local/bin/devbuild being present in THIS container
# (it never is in the ordinary bot container); without it every wrapped
# heavy invocation refuses on stderr with the exact devbuild replacement
# and exits 1. Light probes pass through locally: `pnpm --version`,
# `pnpm config`, `pnpm store status/path`, and bare `--version`/`--help`
# of the other tools. git is deliberately not wrapped. The wrappers are
# root-owned, read-only for `bot` at run time, carry no secrets and no
# hostnames (the build host's address arrives with devbuild's own
# environment in part B, never in this image). Same shape as the
# github-broker wrappers above: Node scripts, node --check at build
# time, /opt only.
COPY --chown=root:root build-wrappers/devbuild-gate.js build-wrappers/blocked-tool.js \
     build-wrappers/pnpm build-wrappers/tsc build-wrappers/vitest \
     build-wrappers/gradle build-wrappers/go /opt/paperclip/bin/
RUN chmod 0755 /opt/paperclip/bin/pnpm /opt/paperclip/bin/tsc /opt/paperclip/bin/vitest \
     /opt/paperclip/bin/gradle /opt/paperclip/bin/go \
  && chmod 0644 /opt/paperclip/bin/devbuild-gate.js /opt/paperclip/bin/blocked-tool.js \
  && for f in devbuild-gate.js blocked-tool.js pnpm tsc vitest gradle go; do \
       /opt/node24/bin/node --check /opt/paperclip/bin/$f; \
     done

# The root filesystem is read-only at run time and the bot's writable
# directories are exactly its single /bot mount, so every path pnpm or the
# toolchains write to must live under it:
#   - the pnpm store defaults to /workspace/.pnpm-store, INSIDE the /bot mount like
#     every clone root (/data/hermes, /workspace, /scratch), because pnpm imports
#     node_modules from its store with package-import-method=reflink (cp
#     --reflink, FICLONE) and reflinks cannot cross a superblock (EXDEV) — a
#     store on /cache would make pnpm copy every package into every clone
#     (see README.md). pnpm 10 itself still COPIES when the kernel refuses the
#     clone, so the guards are the build-time check below and the start-time
#     reflink self-check in entrypoint.sh (BOT-DISK-D, BOT-DISK-H8b);
#   - Rust's RUSTUP_HOME/CARGO_HOME stay sealed under /opt and cargo writes its
#     target dir into the checked-out workspace, never into the image;
#   - Go's build cache defaults under $HOME (/data/hermes) — the durable volume.
# PATH is assembled from /opt and /usr only — never a writable volume.
# myrmidon(G1) CONTAINER-GITHUB-WRITE: /opt/paperclip/bin is prepended so the
# gh wrapper (which resolves run-scoped credentials before exec'ing the real
# gh) is found first; git needs no PATH entry — it reaches the credential
# helper through /etc/gitconfig's absolute path.
# myrmidon 1.6.1 BUILD-OFFLOAD B: the `devbuild` entry point (rsync + ssh to
# the shared build VPS with the shared /srv/devcache caches). Root-owned,
# outside the writable volumes, so a bot cannot rewrite its own transport.
# It lives in /opt/paperclip/bin, NOT /usr/local/bin: the part-A wrappers open
# only when an executable /usr/local/bin/devbuild exists, and this transport
# must not open the local barrier — the heavy command runs on the build VPS;
# the key it reads is mounted separately by the runtime template (part C).
# rsync is part of the transport contract and lives in /usr/bin.
RUN apt-get update \
  && apt-get install -y --no-install-recommends rsync \
  && rm -rf /var/lib/apt/lists/*
COPY --chown=root:root devbuild/devbuild /opt/paperclip/bin/devbuild
RUN chmod 0755 /opt/paperclip/bin/devbuild
# myrmidon(1.6.1 BUILD-OFFLOAD A): the same first position is what makes the
# build wrappers (pnpm/tsc/vitest/gradle/go) shadow the real binaries in
# /opt/pnpm/bin, /opt/node24/bin and /opt/go/bin — see the COPY block above.
ENV PATH=/opt/paperclip/bin:/opt/node24/bin:/opt/pnpm/bin:/opt/go/bin:/opt/cargo/bin:/opt/docker-cli/bin:/opt/hermes-src/.venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    npm_config_store_dir=/workspace/.pnpm-store \
    npm_config_package_import_method=reflink \
    GOTOOLCHAIN=local \
    GOFLAGS=-mod=mod

USER 10001:10001

# Build-time check as the contract user, in the finished stage: every toolchain
# answers, and no PATH element is under a writable root the dockergate image
# policy rejects. Running it here (not in a builder stage) is what makes the
# check meaningful — it sees exactly what a bot container would.
# The devbuild entry point answers --help as uid 10001 (it must: bots invoke
# it; the image build fails if its mode or interpreter ever break).
# myrmidon(1.6.1 BUILD-OFFLOAD A): the check also proves the build-offload
# barrier behaves from the contract user's own eyes — with no
# /usr/local/bin/devbuild in this image, `pnpm install` MUST fail with the
# refusal text and a non-zero exit, while the light probes (`pnpm --version`)
# keep working through the wrapper. `pnpm --version` answering here is doubly
# meaningful: it goes through the wrapper (in /opt/paperclip/bin, first on
# PATH) and exercises the pass-through path, not the bare binary.
RUN set -eu; \
    node --version; \
    pnpm --version; \
    go version; \
    cargo --version; \
    rustc --version; \
    gh --version; \
    jq --version; \
    zstd --version; \
    git --version; \
    docker --version; \
    devbuild --help >/dev/null; \
    for el in $(echo "$PATH" | tr ':' ' '); do \
      case "$el" in \
        /bot|/bot/*|/data|/data/*|/workspace|/workspace/*|/scratch|/scratch/*|/tmp|/tmp/*) \
          echo "PATH element $el is under a writable root" >&2; exit 1 ;; \
      esac; \
    done; \
    if [ -e /usr/local/bin/devbuild ]; then \
      echo "devbuild gateway present in the built image — part B must mount it, never the image" >&2; exit 1; \
    fi; \
    out="$(pnpm install 2>&1)" && rc=0 || rc=$?; \
    if [ "$rc" -eq 0 ]; then \
      echo "pnpm install must refuse without the devbuild gateway" >&2; exit 1; \
    fi; \
    case "$out" in \
      *"devbuild pnpm install"*) ;; \
      *) echo "pnpm install refusal must name the devbuild replacement, got: $out" >&2; exit 1 ;; \
    esac; \
    case "$out" in \
      *"1.6.1 BUILD-OFFLOAD"*) ;; \
      *) echo "pnpm install refusal must say why (1.6.1 BUILD-OFFLOAD), got: $out" >&2; exit 1 ;; \
    esac; \
    out="$(go build ./... 2>&1)" && rc=0 || rc=$?; \
    if [ "$rc" -eq 0 ]; then \
      echo "go build must refuse without the devbuild gateway" >&2; exit 1; \
    fi; \
    case "$out" in *"devbuild go build"*) ;; \
      *) echo "go build refusal must name the devbuild replacement" >&2; exit 1 ;; \
    esac; \
    out="$(tsc --noEmit 2>&1)" && rc=0 || rc=$?; \
    if [ "$rc" -eq 0 ]; then \
      echo "tsc must refuse without the devbuild gateway (and no local tsc may pass)" >&2; exit 1; \
    fi; \
    case "$out" in *"devbuild tsc"*) ;; \
      *) echo "tsc refusal must name the devbuild replacement" >&2; exit 1 ;; \
    esac; \
    out="$(vitest run 2>&1)" && rc=0 || rc=$?; \
    if [ "$rc" -eq 0 ]; then \
      echo "vitest must refuse without the devbuild gateway" >&2; exit 1; \
    fi; \
    case "$out" in *"devbuild vitest"*) ;; \
      *) echo "vitest refusal must name the devbuild replacement" >&2; exit 1 ;; \
    esac; \
    out="$(gradle --version 2>&1)" && rc=0 || rc=$?; \
    if [ "$rc" -eq 0 ]; then \
      echo "gradle must refuse without the devbuild gateway" >&2; exit 1; \
    fi; \
    case "$out" in *"devbuild gradle"*) ;; \
      *) echo "gradle refusal must name the devbuild replacement" >&2; exit 1 ;; \
    esac; \
    echo "build-offload barrier verified: heavy tools refuse, light probes pass"

# myrmidon(BOT-DISK-D): the image's pnpm really hard-links into the store from EVERY
# clone root of the single /bot mount (same script the repository's bot-runtime test
# runs), and the git wrapper is the git on PATH. A copy, or a failed link, would mean
# every clone's node_modules duplicates the store, which is the problem this stage
# exists to prevent; the real pnpm binary is called directly, the devbuild gate only
# fronts the bare name.
COPY --chown=root:root --chmod=0755 pnpm-hardlink-check.sh /opt/paperclip/pnpm-hardlink-check.sh
COPY --chown=root:root --chmod=0755 pnpm-reflink-check.sh /opt/paperclip/pnpm-reflink-check.sh
# myrmidon(BOT-DISK-H8b): the image's pnpm really reflink-imports into the
# store from EVERY clone root of the single /bot mount — the import method the
# fleet now runs (template.ts DEFAULT_PNPM_IMPORT_METHOD). pnpm copies silently
# when FICLONE is refused (another superblock, a filesystem without reflinks),
# and a copy means every clone's node_modules duplicates the store, the problem
# this stage exists to prevent. shared=yes needs filefrag's extent comparison;
# on a build filesystem without reflink support this stage fails the build,
# which is the point of the CI gate.
RUN set -eu; \
    out="$(PNPM=/opt/pnpm/bin/pnpm ROOTS="/data/hermes /workspace /scratch" STORE_DIR=/workspace/.pnpm-store /opt/paperclip/pnpm-reflink-check.sh)"; \
    echo "pnpm reflink check: $out"; \
    [ "$(echo "$out" | wc -l)" -eq 3 ] || { echo "expected one result per clone root, got: $out" >&2; exit 1; }; \
    echo "$out" | while read -r line; do \
      case "$line" in \
        *"shared=yes"*) ;; \
        *) echo "pnpm must reflink into the store from every clone root, got: $line" >&2; exit 1 ;; \
      esac; \
    done; \
    rm -rf /workspace/.pnpm-store
RUN set -eu; \
    out="$(PNPM=/opt/pnpm/bin/pnpm ROOTS="/data/hermes /workspace /scratch" STORE_DIR=/workspace/.pnpm-store /opt/paperclip/pnpm-hardlink-check.sh)"; \
    echo "pnpm hardlink check: $out"; \
    [ "$(echo "$out" | wc -l)" -eq 3 ] || { echo "expected one result per clone root, got: $out" >&2; exit 1; }; \
    echo "$out" | while read -r line; do \
      case "$line" in \
        *"samefile=yes"*) ;; \
        *) echo "pnpm must hard-link into the store from every clone root, got: $line" >&2; exit 1 ;; \
      esac; \
      case "$line" in \
        *"nlink=1 "*) echo "pnpm copied instead of hard-linking: $line" >&2; exit 1 ;; \
      esac; \
    done; \
    rm -rf /workspace/.pnpm-store; \
    [ "$(command -v git)" = "/opt/paperclip/bin/git" ] || { echo "git on PATH must be the reference wrapper" >&2; exit 1; }; \
    git --version
