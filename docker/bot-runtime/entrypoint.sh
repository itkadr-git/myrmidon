#!/usr/bin/env bash
# G1 bot runtime entrypoint: validate the environment a hermes API-server
# gateway needs to start safely, then exec it as PID 1's child (tini is the
# actual PID 1 — see the Dockerfile ENTRYPOINT).
#
# This script intentionally duplicates a small part of hermes' own startup
# guard (gateway/platforms/api_server.py: _api_key_passes_startup_guard) so a
# misconfigured container fails in one line before Python even starts,
# instead of a stack trace after the interpreter boots. Hermes still runs
# its own (stricter) check — this is a fast first gate, not a replacement.
set -euo pipefail

log() {
  echo "[bot-runtime] $*" >&2
}

fail() {
  log "FATAL: $*"
  exit 1
}

# --- required environment ---------------------------------------------

: "${HERMES_HOME:?HERMES_HOME is required (set by the image; do not unset it — it must point at the /data volume)}"

# --- bot tree layout --------------------------------------------------------
# myrmidon(BOT-DISK-D): a bot container has ONE bind mount, its whole writable tree
# at ${MYRMIDON_BOT_ROOT:-/bot} (hermes/, workspace/, scratch/ inside it). Hard
# links work only within one mount, which is what lets pnpm link node_modules into
# its store, so /data/hermes, /workspace and /scratch must be paths INSIDE that
# mount, not separate binds. The image already ships them as links; this makes the
# same links when they are missing (a manual `docker run -v dir:/bot`, a tmpfs
# over /data). An existing entry (a link, or a real directory from the old
# three-bind layout) is left alone. MYRMIDON_DATA_DIR only exists for tests.
bot_root="${MYRMIDON_BOT_ROOT:-/bot}"
data_dir="${MYRMIDON_DATA_DIR:-/data}"
# myrmidon(BOT-DISK-F): a member of a SHARED isolation-scope instance has no /bot. Its
# one mount is the instance directory at ${MYRMIDON_BOT_SCOPE_DIR:-/bot-scope} (one pnpm
# store plus a subdirectory per member bot), and MYRMIDON_BOT_SCOPE_SUBDIR names this
# bot's subdirectory (its bot key; not a secret). /data is a small tmpfs the driver
# mounts for exactly this, so the three links are made here, into this bot's own
# subdirectory: hard links then work within the bot and across the bots of the instance
# (one mount), and no other instance's directory is mounted at all.
scope_dir="${MYRMIDON_BOT_SCOPE_DIR:-/bot-scope}"

# myrmidon(BOT-ROOT-TRAVERSE): the isolated layout's whole tree lives BEHIND bot_root
# (the one bind mounted at /bot). If the host directory's mode does not let this
# process traverse it (a root-owned 0710/0700 left by an external operation — the rc.1
# incident), every path under it resolves to EACCES: the links below silently do
# nothing, ${HERMES_HOME}/.env stays unreadable and the real cause would surface as a
# misleading "API_SERVER_KEY is required" ten steps later. Say it here, in one line,
# naming the container-side path only (no host paths are known or leaked). The driver
# normalizes this at every apply (the prepare helper chmods the root 0711), so the fix
# is to recreate the bot.
if [ -z "${MYRMIDON_BOT_SCOPE_SUBDIR:-}" ] && [ -e "${bot_root}" ] && [ ! -x "${bot_root}" ]; then
  fail "no traversal into ${bot_root}: the bot root directory is not executable by $(id -u):$(id -g) (mode/owner of the host directory mounted at ${bot_root}); the driver fixes this at apply — recreate the bot"
fi
if [ -n "${MYRMIDON_BOT_SCOPE_SUBDIR:-}" ]; then
  case "${MYRMIDON_BOT_SCOPE_SUBDIR}" in
    */* | . | .. | -*) fail "MYRMIDON_BOT_SCOPE_SUBDIR is not a plain directory name" ;;
  esac
  bot_root="${scope_dir}/${MYRMIDON_BOT_SCOPE_SUBDIR}"
  [ -d "${bot_root}" ] || fail "shared scope: ${bot_root} does not exist (the scope instance directory is not mounted at ${scope_dir}, or this bot has no subdirectory in it)"
  [ -w "${data_dir}" ] || fail "shared scope: ${data_dir} is not writable (it must be a tmpfs owned by the bot's uid)"
  for name in hermes workspace scratch; do
    mkdir -p "${bot_root}/${name}" || fail "shared scope: cannot create ${bot_root}/${name}"
    ln -sfn "${bot_root}/${name}" "${data_dir}/${name}" || fail "shared scope: cannot link ${data_dir}/${name}"
  done
  log "shared scope member: ${data_dir}/{hermes,workspace,scratch} -> ${bot_root}/"
elif [ -d "${bot_root}" ] && [ -d "${data_dir}" ] && [ -w "${data_dir}" ]; then
  for name in hermes workspace scratch; do
    if [ ! -e "${data_dir}/${name}" ] && [ ! -L "${data_dir}/${name}" ]; then
      mkdir -p "${bot_root}/${name}" 2>/dev/null || true
      ln -s "${bot_root}/${name}" "${data_dir}/${name}" 2>/dev/null \
        || log "WARNING: cannot link ${data_dir}/${name} to ${bot_root}/${name}"
    fi
  done
fi


# myrmidon(G1): API_SERVER_KEY is read from ${HERMES_HOME}/.env when the container's
# own environment does not already have it — never required in the container's Env.
# Bot-runtime contract "1" (server/src/myrmidon/bot-containers/template.ts,
# BOT_RUNTIME_CONTRACT_LABEL): the G3 driver's create body never sets a secret in Env (anything
# there is visible via `docker inspect`; the one variable it may set is the non-secret
# MYRMIDON_BOT_SCOPE_SUBDIR of a shared-scope member), so every secret the gateway needs travels
# only in the profile's ${HERMES_HOME}/.env. hermes itself loads that same file with
# override=True before reading API_SERVER_KEY (gateway/run.py, env_loader.py), so
# this is only a fast first gate — the file is parsed here as data (grep/sed), never
# sourced, since it is not a trusted script. A key already in the process
# environment (e.g. `docker run -e API_SERVER_KEY=...` for local/manual testing,
# outside the fleet driver) is honored as-is and the file is not touched.
if [ -z "${API_SERVER_KEY:-}" ]; then
  env_file="${HERMES_HOME}/.env"
  if [ -r "${env_file}" ]; then
    line="$(grep -m1 -E '^API_SERVER_KEY=' "${env_file}" || true)"
    if [ -n "${line}" ]; then
      value="${line#API_SERVER_KEY=}"
      # Strip one layer of matching quotes (dotenv KEY="value" / KEY='value').
      case "${value}" in
        \"*\") value="${value#\"}"; value="${value%\"}" ;;
        \'*\') value="${value#\'}"; value="${value%\'}" ;;
      esac
      API_SERVER_KEY="${value}"
    fi
  fi
fi
# gateway/platforms/api_server.py refuses to start the API server without a
# key at least 16 chars and not a known placeholder value. We only check
# length here; hermes itself checks the placeholder list.
: "${API_SERVER_KEY:?API_SERVER_KEY is required — set it in \${HERMES_HOME}/.env as API_SERVER_KEY=\"...\" (bot-runtime contract: never in the container's own environment) — generate one with: openssl rand -hex 32}"
if [ "${#API_SERVER_KEY}" -lt 16 ]; then
  fail "API_SERVER_KEY is ${#API_SERVER_KEY} chars, hermes requires at least 16 (openssl rand -hex 32 gives 64)"
fi
export API_SERVER_KEY

# --- defaults (only fill in what the image's own ENV did not already) --

export API_SERVER_ENABLED="${API_SERVER_ENABLED:-true}"
export API_SERVER_HOST="${API_SERVER_HOST:-0.0.0.0}"
export API_SERVER_PORT="${API_SERVER_PORT:-8642}"
export NO_COLOR="${NO_COLOR:-1}"

if [ "${API_SERVER_ENABLED}" != "true" ]; then
  log "API_SERVER_ENABLED=${API_SERVER_ENABLED} overridden to true — this image has no other job than serving the gateway API"
  export API_SERVER_ENABLED=true
fi

# MYRMIDON_BOT_YOLO=1 (default): no human is attached to this gateway to
# answer an approval prompt, so dangerous-command approvals are bypassed —
# equivalent to hermes' own --yolo flag. hermes reads HERMES_YOLO_MODE at
# import time (tools/approval.py: _YOLO_MODE_FROZEN), so it must be set
# before `exec hermes` below, not passed as a CLI flag after `gateway run`
# (--yolo is a pre-subcommand flag there — see hermes_cli/_parser.py).
# Set MYRMIDON_BOT_YOLO=0 to fall back to the profile's approvals.mode in
# config.yaml (manual/smart by default) — mainly useful on a stand.
MYRMIDON_BOT_YOLO="${MYRMIDON_BOT_YOLO:-1}"
case "${MYRMIDON_BOT_YOLO,,}" in
  1 | true | yes | on)
    export HERMES_YOLO_MODE=1
    log "MYRMIDON_BOT_YOLO=1: dangerous-command approvals bypassed (no attended operator on this gateway)"
    ;;
  *)
    log "MYRMIDON_BOT_YOLO=${MYRMIDON_BOT_YOLO}: approvals follow config.yaml (approvals.mode), unattended platforms default to deny"
    ;;
esac

# myrmidon(BOT-DISK-F): the image's WORKDIR is "/" (a member's /workspace link does not
# exist until the links above are made), so enter the workspace here, now it resolves.
workspace_dir="${MYRMIDON_WORKSPACE_DIR:-/workspace}"
if [ -e "${workspace_dir}" ]; then
  cd "${workspace_dir}" || fail "cannot enter the workspace ${workspace_dir} (is the bot tree mounted?)"
fi

# --- writable state -------------------------------------------------------

mkdir -p "${HERMES_HOME}" || fail "cannot create HERMES_HOME=${HERMES_HOME} — is /data mounted and owned by uid 10001?"
if [ ! -w "${HERMES_HOME}" ]; then
  fail "HERMES_HOME=${HERMES_HOME} is not writable by $(id -u):$(id -g) — the /data volume must be owned by uid 10001 (fleetd's job, not this image's)"
fi

if [ ! -w "$(pwd)" ]; then
  fail "workspace $(pwd) is not writable by $(id -u):$(id -g) — the /workspace volume must be owned by uid 10001"
fi

log "HERMES_HOME=${HERMES_HOME}"
log "workspace=$(pwd)"
log "API_SERVER_HOST=${API_SERVER_HOST} API_SERVER_PORT=${API_SERVER_PORT}"
# Set by the image (see the Dockerfile's runtime ENV block) so a lazy
# install (tools/lazy_deps.py) and hermes' own write guard
# (agent/file_safety.py) target the durable volume instead of the sealed,
# read-only /opt/hermes-src venv. Logged, not enforced here — an operator
# who overrides them away sees why in this line, not a silent behavior
# change.
log "HERMES_LAZY_INSTALL_TARGET=${HERMES_LAZY_INSTALL_TARGET:-<unset>} HERMES_WRITE_SAFE_ROOT=${HERMES_WRITE_SAFE_ROOT:-<unset>}"

# --- catalog memory provider ---------------------------------------------
# hermes resolves a memory provider from the bundled tree or ${HERMES_HOME}/plugins; the
# image ships the vendored catalog plugin read-only under $HERMES_CATALOG_PLUGINS_DIR, and
# the bot's HERMES_HOME is a mounted volume, so the plugin has to be linked into it here.
# Idempotent: an existing entry (an operator's own install, or the link from a previous
# start of the same volume) is left untouched. A missing catalog directory is a warning,
# not a hard failure — the gateway is useful without memory, and taking the bot down over
# it would be worse; the line names exactly what is missing.
catalog_dir="${HERMES_CATALOG_PLUGINS_DIR:-/opt/hermes-plugins}"
if [ -d "${catalog_dir}/hindsight" ]; then
  mkdir -p "${HERMES_HOME}/plugins"
  if [ -e "${HERMES_HOME}/plugins/hindsight" ] || [ -L "${HERMES_HOME}/plugins/hindsight" ]; then
    log "memory provider hindsight already present at ${HERMES_HOME}/plugins/hindsight — left as is"
  else
    ln -s "${catalog_dir}/hindsight" "${HERMES_HOME}/plugins/hindsight" \
      || fail "cannot link the catalog memory provider into ${HERMES_HOME}/plugins"
    log "memory provider hindsight linked from ${catalog_dir}/hindsight"
  fi
else
  log "WARNING: no catalog memory provider at ${catalog_dir}/hindsight — a profile with memory.provider=hindsight starts without memory"
fi

# --- hard-link self-check (dev variant) -------------------------------------
# myrmidon(BOT-DISK-D): pnpm falls back to copying when it cannot hard-link, which
# silently turns every clone's node_modules into a full copy (the disk grew ~5 GB/h
# before the bot tree became one mount). So at every start: make a file in the pnpm
# store directory and try to hard-link it into each clone root. A failure is logged
# as an error and written to ${HERMES_HOME}/.myrmidon/hardlink-check.json, which the
# clone-hygiene reporter passes to the board (the bot-disk status). It never stops
# the gateway: a bot with a broken store still works, just wastefully.
# The store is the one the bot's tools will use: the environment's
# npm_config_store_dir, overridden by the profile's .env, defaulting to the image's.
dotenv_value() {
  local file="${HERMES_HOME}/.env" line value
  [ -r "${file}" ] || return 0
  line="$(grep -m1 -E "^$1=" "${file}" || true)"
  [ -n "${line}" ] || return 0
  value="${line#"$1"=}"
  case "${value}" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s' "${value}"
}

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\n\r\t'
}

hardlink_self_check() {
  local store method roots root probe src dst err ok_all=true entries="" sep="" ok
  store="$(dotenv_value npm_config_store_dir)"
  store="${store:-${npm_config_store_dir:-/workspace/.pnpm-store}}"
  method="$(dotenv_value npm_config_package_import_method)"
  method="${method:-${npm_config_package_import_method:-hardlink}}"
  roots="${MYRMIDON_HARDLINK_ROOTS:-/data/hermes /workspace /scratch}"
  probe=".myrmidon-hardlink-probe.$$"
  src="${store}/${probe}"
  err=""
  if ! err="$(mkdir -p "${store}" 2>&1 && : > "${src}" 2>&1)"; then
    err="cannot create a file in the pnpm store ${store}: ${err}"
    log "ERROR: hard-link self-check: ${err}"
    for root in ${roots}; do
      entries="${entries}${sep}{\"root\":\"$(json_escape "${root}")\",\"ok\":false,\"error\":\"$(json_escape "${err}")\"}"
      sep=","
    done
    ok_all=false
  else
    for root in ${roots}; do
      dst="${root}/${probe}"
      ok=true
      if ! err="$(ln "${src}" "${dst}" 2>&1)"; then
        ok=false
        ok_all=false
        log "ERROR: hard-link self-check: cannot hard-link from the pnpm store ${store} into ${root}: ${err} — pnpm would copy every package into every clone there"
      else
        err=""
      fi
      rm -f "${dst}" 2>/dev/null || true
      entries="${entries}${sep}{\"root\":\"$(json_escape "${root}")\",\"ok\":${ok},\"error\":$( [ "${ok}" = true ] && printf 'null' || printf '"%s"' "$(json_escape "${err}")" )}"
      sep=","
    done
    rm -f "${src}" 2>/dev/null || true
  fi
  if [ "${ok_all}" = true ]; then
    log "hard-link self-check ok: store=${store} roots=${roots} importMethod=${method}"
  fi
  local out_dir="${HERMES_HOME}/.myrmidon" now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if mkdir -p "${out_dir}" 2>/dev/null; then
    printf '{"version":1,"checkedAt":"%s","store":"%s","importMethod":"%s","ok":%s,"roots":[%s]}\n' \
      "${now}" "$(json_escape "${store}")" "$(json_escape "${method}")" "${ok_all}" "${entries}" \
      > "${out_dir}/hardlink-check.json.tmp" 2>/dev/null \
      && mv -f "${out_dir}/hardlink-check.json.tmp" "${out_dir}/hardlink-check.json" 2>/dev/null \
      || log "WARNING: cannot write ${out_dir}/hardlink-check.json"
  fi
}
if [ "${MYRMIDON_HARDLINK_CHECK:-1}" != "0" ]; then
  hardlink_self_check || log "WARNING: the hard-link self-check itself failed to run"
fi

# --- shared-git-objects self-check (dev variant) ---------------------------
# myrmidon(1.6.5 BOT-DISK-G): task clones share one object store through
# --reference-if-able (the git wrapper, the board's mirror or the bot's own
# store). A broken chain costs 0.4 GB and a slow clone per task, silently —
# so at every start, in one pass:
#   1. the wrapper answers for a bare `git` through BOTH PATH positions:
#      /opt/paperclip/bin/git first on the image's PATH, and the
#      /usr/local/bin/git symlink, which is what makes a terminal whose PATH
#      the adapter rebuilt (without /opt/paperclip/bin) still get the wrapper;
#   2. the object store directory is writable;
#   3. a real reference-clone round trip offline: make a small origin,
#      bare-mirror it, clone --reference-if-able from the mirror and check the
#      clone's objects/info/alternates points at it. This is the mechanism the
#      wrapper relies on; if it fails here, clones copy objects again.
# A failure is logged as an error and written to
# ${HERMES_HOME}/.myrmidon/git-objects-check.json, which the clone-hygiene
# reporter passes to the board. It never stops the gateway: a bot with a
# broken store still works, just wastefully (the same contract as the
# hard-link check). Skipped entirely on the base image, which has no wrapper.
git_objects_self_check() {
  local store checks="" ok_all=true err sep=""
  local wrapper="${MYRMIDON_GIT_WRAPPER:-/opt/paperclip/bin/git}"
  local shadow="${MYRMIDON_GIT_SHADOW:-/usr/local/bin/git}"
  local real_git="${MYRMIDON_GIT_REAL:-/usr/bin/git}"
  if [ -n "${MYRMIDON_GIT_LOCAL_MIRROR+x}" ]; then
    store="${MYRMIDON_GIT_LOCAL_MIRROR}"
  else
    store="$(dotenv_value MYRMIDON_GIT_LOCAL_MIRROR)"
    [ -n "${store}" ] || store="${HERMES_HOME}/.myrmidon/git-objects"
  fi
  # (If MYRMIDON_GIT_LOCAL_MIRROR is explicitly empty, the store is off; the
  # wrapper reads the same value. Record that as a passing "off" state.)
  add_check() {
    local cname="$1" cok="$2" cerr="$3"
    checks="${checks}${sep}{\"check\":\"$(json_escape "${cname}")\",\"ok\":${cok},\"error\":$( [ "${cok}" = true ] && printf 'null' || printf '"%s"' "$(json_escape "${cerr}")" )}"
    sep=","
    [ "${cok}" = true ] || ok_all=false
  }

  if [ ! -x "${wrapper}" ]; then
    log "shared-objects self-check: no git wrapper at ${wrapper} (base image) — skipped"
    return 0
  fi
  # 1. wrapper resolution: image PATH and the /usr/local/bin symlink.
  local resolved
  if ! resolved="$(PATH="$(dirname "${shadow}"):/usr/bin:/bin" command -v git)" || [ "${resolved}" != "${shadow}" ]; then
    add_check "usr-local-shadow" false "${shadow} does not shadow git for a rebuilt terminal PATH (found: ${resolved:-none}) — a bare git there runs without shared objects"
  elif ! err="$("${shadow}" --version 2>&1 >/dev/null)"; then
    add_check "usr-local-shadow" false "${shadow} --version failed: ${err}"
  else
    add_check "usr-local-shadow" true ""
  fi
  if ! err="$("${wrapper}" --version 2>&1 >/dev/null)"; then
    add_check "wrapper-runs" false "the wrapper cannot run its interpreter: ${err}"
  else
    add_check "wrapper-runs" true ""
  fi
  # 2. the store is writable.
  if [ -z "${store}" ]; then
    add_check "store-writable" true "" # the store is explicitly off; nothing to write
  elif ! err="$(mkdir -p "${store}" 2>&1 && : > "${store}/.selfcheck-probe" 2>&1)"; then
    add_check "store-writable" false "cannot create a file in the git objects store ${store}: ${err}"
  else
    rm -f "${store}/.selfcheck-probe" 2>/dev/null || true
    add_check "store-writable" true ""
  fi
  # 3. offline reference-clone round trip in a scratch under HERMES_HOME.
  local work rc=0
  mkdir -p "${HERMES_HOME}/.myrmidon" 2>/dev/null || true
  work="$(mktemp -d "${HERMES_HOME}/.myrmidon/git-selfcheck.XXXXXX" 2>/dev/null)" || rc=1
  if [ "${rc}" -eq 0 ]; then
    err="$(
      {
        set -e
        export GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
        origin="${work}/origin"; mirror="${work}/mirror.git"; dest="${work}/clone"
        mkdir -p "${origin}"
        "${real_git}" init -q -b main "${origin}"
        echo one > "${origin}/a.txt"
        "${real_git}" -C "${origin}" add a.txt
        "${real_git}" -C "${origin}" commit -q -m one
        "${real_git}" clone -q --bare "${origin}" "${mirror}"
        # The round trip runs against the REAL git on purpose: it proves the
        # mechanism (--reference-if-able borrows objects), while the checks
        # above proved the wrapper answers and runs. The wrapper would pass the
        # local-path URL through unchanged anyway.
        "${real_git}" clone -q --reference-if-able "${mirror}" "${origin}" "${dest}"
        target="$(sed -n '1p' "${dest}/.git/objects/info/alternates")"
        # git records the realpath; HERMES_HOME itself may be a link into the bot's mount.
        want="$(cd "${mirror}/objects" 2>/dev/null && pwd -P)"
        [ -n "${target}" ] && [ "${target%/}" = "${want}" ]
      } 2>&1
    )"; rc=$?
    rm -rf "${work}" 2>/dev/null || true
    if [ "${rc}" -ne 0 ]; then
      add_check "reference-clone" false "a test clone with --reference-if-able did not borrow the mirror's objects: ${err}"
    else
      add_check "reference-clone" true ""
    fi
  else
    add_check "reference-clone" false "cannot create a scratch under ${HERMES_HOME}"
  fi
  if [ "${ok_all}" = true ]; then
    log "shared-objects self-check ok: store=${store:-off}"
  else
    log "ERROR: shared-objects self-check failed — task clones on this bot copy git history per clone again (see git-objects-check.json)"
  fi
  local out_dir="${HERMES_HOME}/.myrmidon" now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if mkdir -p "${out_dir}" 2>/dev/null; then
    printf '{"version":1,"checkedAt":"%s","store":"%s","ok":%s,"checks":[%s]}\n' \
      "${now}" "$(json_escape "${store}")" "${ok_all}" "${checks}" \
      > "${out_dir}/git-objects-check.json.tmp" 2>/dev/null \
      && mv -f "${out_dir}/git-objects-check.json.tmp" "${out_dir}/git-objects-check.json" 2>/dev/null \
      || log "WARNING: cannot write ${out_dir}/git-objects-check.json"
  fi
}
if [ "${MYRMIDON_GIT_OBJECTS_CHECK:-1}" != "0" ]; then
  git_objects_self_check || log "WARNING: the shared-objects self-check itself failed to run"
fi

# --- clone hygiene report (dev variant) -----------------------------------
# myrmidon(1.6.2 BOT-DISK-C): the board's draft-directory lifecycle removes an
# idle git clone only when this container says it holds nothing unpushed. The
# reporter only reads the clones and writes ${HERMES_HOME}/.myrmidon/clone-hygiene.json;
# it exists in the dev variant only, so the base image skips this.
if command -v bot-clone-hygiene >/dev/null 2>&1; then
  bot-clone-hygiene --interval "${MYRMIDON_CLONE_HYGIENE_INTERVAL_SEC:-900}" >/dev/null &
  log "clone hygiene reporter started (pid $!)"
fi

# --replace: a previous instance's lock (from a hard container restart) does
# not block this one — the fleet manager, not hermes, decides whether two
# instances should ever coexist. --accept-hooks: no TTY to answer a shell
# hook consent prompt (equivalent to hooks_auto_accept: true).
exec hermes gateway run --replace --accept-hooks "$@"
