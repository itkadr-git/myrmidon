#!/usr/bin/env bash
# scripts/myrmidon/install/install.sh
#
# ONE-COMMAND-INSTALL (1.6.6, owner decision 06.10.2026): one command brings a
# fresh server to a working board.
#
#   curl -fsSL https://github.com/itkadr-git/myrmidon/releases/latest/download/install.sh | sudo bash
#
# This file is attached to every GitHub release as the asset `install.sh`
# (scripts/myrmidon/release/publish-github-release.sh), so the URL above always
# serves the installer of the latest release.
#
# What it does, in order:
#   1. checks the machine against the system requirements and names what is
#      missing in plain language (root, OS, arch, CPU, memory, disk, ports);
#   2. installs docker and the compose plugin when they are absent;
#   3. resolves the release: `releases/latest` (or --version myr-vX.Y.Z) and its
#      machine-readable manifest `release-components.json`, read over the public
#      download endpoints (no token, no API request budget) — the board,
#      dockergate and bot images are pinned BY DIGEST, never by a moving tag (the
#      same CI-only rule deploy.sh enforces);
#   4. generates every secret (database password, session secret, tool-action
#      signing secret), writes `deploy.env` (mode 0600) and `compose.yml`;
#   5. pulls the images and brings up the database, the board and dockergate;
#   6. waits for `/api/health` to answer `status: ok` and prints the address, the
#      first-administrator link and the paths of the files that were written.
#
# Database profile (1.6.5, SHARED-PG): a fresh install stands up ONE PostgreSQL
# 18 server with the pgvector extension. In the default (internal) mode the
# installer runs that server as a container and initialises it with one
# database and one owned login role per service — the board (paperclip),
# litellm, langfuse, hindsight — so a single cluster can serve them all. The
# memory parameters (shared_buffers and friends) are sized for that combined
# load and are overridable through the install environment (see deploy.env).
# With --database-url URL (or MYRMIDON_INSTALL_DATABASE_URL) the board instead
# connects to an EXTERNAL shared PostgreSQL server: the installer writes no db
# container at all and the operator owns the server.
#
# Re-running the script is the update path: it resolves the latest release,
# dumps the database first, switches the image, checks health and rolls back to
# the previous digest when the new board does not become healthy.
#
#   install.sh --uninstall          stop and remove the stack (data kept)
#   install.sh --uninstall --purge  also delete the database volume and the files
#
# By default it asks nothing (--interactive turns the questions on). Every
# message is printed in Russian or English according to the locale (--lang).
set -euo pipefail

MYR_DEFAULT_DIR=/opt/myrmidon
MYR_REPO="${MYRMIDON_INSTALL_REPO:-itkadr-git/myrmidon}"
# Release assets are read over the public download endpoints of GitHub
# (github.com/<repo>/releases/...): they need no token and carry no per-hour
# request budget, unlike the anonymous API (60 requests/hour per IP), which a
# shared NAT address exhausts quickly.
MYR_WEB="${MYRMIDON_INSTALL_WEB_URL:-https://github.com}"
MYR_PROJECT=myrmidon

DIR=""
PORT=""
PUBLIC_URL=""
RELEASE_TAG=""
LANG_CODE=""
INTERACTIVE=0
ASSUME_YES=0
MODE="install"
PURGE=0
# DATABASE_URL: when set (--database-url or MYRMIDON_INSTALL_DATABASE_URL), the
# board uses this EXTERNAL shared PostgreSQL server and the installer writes no
# db service into the compose project. Otherwise the default internal profile
# stands up one PostgreSQL 18 + pgvector container with the per-service DBs.
DATABASE_URL="${MYRMIDON_INSTALL_DATABASE_URL:-}"
# Decided by db_profile: internal (one shared container), external (operator's
# server) or keep (a database that predates the profile — left untouched).
DB_PROFILE=""

die() { printf '[myrmidon-install] ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[myrmidon-install] %s\n' "$*" >&2; }

# ---------------------------------------------------------------- language ----
# LANG_CODE: ru when the locale names Russian, en otherwise; --lang overrides.
detect_lang() {
  local l="${MYRMIDON_INSTALL_LANG:-${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}}"
  case "$l" in
    ru*|*_RU*) printf 'ru' ;;
    *) printf 'en' ;;
  esac
}
[[ -n "$LANG_CODE" ]] || LANG_CODE="$(detect_lang)"

# say <en text> <ru text>: prints in the selected language.
say() {
  if [[ "$LANG_CODE" == "ru" ]]; then printf '%s\n' "$2" >&2; else printf '%s\n' "$1" >&2; fi
}
say_out() {
  if [[ "$LANG_CODE" == "ru" ]]; then printf '%s\n' "$2"; else printf '%s\n' "$1"; fi
}

usage() {
  cat <<'USAGE'
scripts/myrmidon/install/install.sh — ONE-COMMAND-INSTALL

  curl -fsSL https://github.com/itkadr-git/myrmidon/releases/latest/download/install.sh | sudo bash

Options:
  --version myr-vX.Y.Z   install that release instead of releases/latest
  --dir PATH             where to install (default /opt/myrmidon)
  --port N               port the board listens on (default 3100)
  --url URL              public address of the board
  --lang ru|en           language of the messages (default: taken from the locale)
  --database-url URL     use an external shared PostgreSQL server (connection
                         string postgres://...): the installer creates no db
                         container and the board connects straight to this URL.
                         Same as MYRMIDON_INSTALL_DATABASE_URL.
  --interactive          ask the questions instead of answering them silently
  --yes, -y              answer yes to everything
  --uninstall            stop and remove the stack (your data is kept)
  --purge                with --uninstall: also delete the database volume
  -h, --help             print this help

Re-running the script without --uninstall is the update path: it takes the
latest release, dumps the database first and rolls back if the board does not
become healthy. Nothing is asked by default.
USAGE
  exit 0
}

# ------------------------------------------------------------------- args -----
# An option that takes a value must be given one. Under `set -u` the plain
# "$2" would kill the run with a bare bash error — and because the documented
# form pipes the script into bash, that error is all a novice would ever see.
value_for() {
  (($# >= 2)) || die "option $1 needs a value"
}

while (($#)); do
  case "$1" in
    --version) value_for "$@" ; RELEASE_TAG="$2"; shift 2 ;;
    --dir) value_for "$@" ; DIR="$2"; shift 2 ;;
    --port) value_for "$@" ; PORT="$2"; shift 2 ;;
    --url) value_for "$@" ; PUBLIC_URL="$2"; shift 2 ;;
    --lang) value_for "$@" ; LANG_CODE="$2"; shift 2 ;;
    --database-url) value_for "$@" ; DATABASE_URL="$2"; shift 2 ;;
    --interactive) INTERACTIVE=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --uninstall) MODE="uninstall"; shift ;;
    --purge) PURGE=1; shift ;;
    -h|--help) usage ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -z "$RELEASE_TAG" || "$RELEASE_TAG" =~ ^myr-v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]] \
  || die "--version must look like myr-vX.Y.Z or myr-vX.Y.Z-rc.N (got: $RELEASE_TAG)"
[[ "$LANG_CODE" == "ru" || "$LANG_CODE" == "en" ]] || die "--lang must be ru or en"

DIR="${DIR:-${MYRMIDON_INSTALL_DIR:-$MYR_DEFAULT_DIR}}"
[[ "$DIR" == /* ]] || die "--dir must be an absolute path"
PORT="${PORT:-${MYRMIDON_INSTALL_PORT:-3100}}"
[[ "$PORT" =~ ^[0-9]+$ ]] || die "--port must be a number"
[[ -z "$PUBLIC_URL" || "$PUBLIC_URL" == http://* || "$PUBLIC_URL" == https://* ]] \
  || die "--url must be an http:// or https:// address"

# --------------------------------------------------------------- helpers ------
have() { command -v "$1" >/dev/null 2>&1; }

require_root() {
  # Test hook: the harness of install.test.mjs runs the script unprivileged with
  # fake docker/curl on PATH and has nothing to chown.
  if [[ "${MYRMIDON_INSTALL_SKIP_ROOT_CHECK:-0}" == "1" ]]; then
    say "MYRMIDON_INSTALL_SKIP_ROOT_CHECK=1: the root check is skipped (tests only)." \
        "MYRMIDON_INSTALL_SKIP_ROOT_CHECK=1: проверка root пропущена (только для тестов)."
    return 0
  fi
  if [[ "$(id -u)" != "0" ]]; then
    say "This installer must run as root: pipe it to 'sudo bash', not 'bash'." \
        "Установщику нужны права root: передайте его 'sudo bash', а не 'bash'."
    exit 1
  fi
}

# fetch <url> [outfile]: prints to stdout, or writes outfile. The public download
# endpoints are mirrored by MYRMIDON_INSTALL_TOKEN_FILE for a private repository;
# the token is never printed.
fetch() {
  local url="$1" out="${2:-}"
  local -a auth=()
  if [[ -n "${MYRMIDON_INSTALL_TOKEN_FILE:-}" ]]; then
    [[ -r "$MYRMIDON_INSTALL_TOKEN_FILE" ]] || die "MYRMIDON_INSTALL_TOKEN_FILE is not readable"
    auth=(-H "Authorization: Bearer $(<"$MYRMIDON_INSTALL_TOKEN_FILE")")
  fi
  if [[ -n "$out" ]]; then
    curl -fsSL --retry 3 --retry-delay 2 "${auth[@]}" -o "$out" "$url"
  else
    curl -fsSL --retry 3 --retry-delay 2 "${auth[@]}" "$url"
  fi
}

require_tools() {
  local missing="" t
  for t in curl jq; do have "$t" || missing="$missing $t"; done
  if [[ -n "$missing" ]]; then
    log "installing:$missing"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq || die "apt-get update failed"
    # shellcheck disable=SC2086
    apt-get install -y -qq ca-certificates $missing || die "cannot install:$missing"
  fi
}

# The board image carries native code built for the x86-64-v2 baseline. On an
# older CPU the container dies minutes in with a raw module-load error, so the
# fact is read here, before anything on the machine is changed.
cpu_supports_x86_64_v2() {
  local cpuinfo="${MYRMIDON_INSTALL_CPUINFO:-/proc/cpuinfo}" flags
  [[ -r "$cpuinfo" ]] || return 0   # cannot tell: do not block a valid machine
  flags="$(awk -F: '/^flags/{print $2; exit}' "$cpuinfo")"
  [[ -n "$flags" ]] || return 0
  [[ "$flags" == *sse4_2* && "$flags" == *popcnt* && "$flags" == *cx16* ]]
}

# -------------------------------------------------------------- preflight -----
# Every requirement is a fact read from the machine, not an assumption: the
# script names what is missing instead of failing later inside docker.
preflight() {
  local os_id="" os_ver="" arch cpu mem_mb free_mb free_kb

  [[ -r /etc/os-release ]] || die "/etc/os-release is missing: unknown operating system"
  # shellcheck disable=SC1091
  os_id="$( . /etc/os-release && printf '%s' "${ID:-}" )"
  os_ver="$( . /etc/os-release && printf '%s' "${VERSION_ID:-}" )"
  case "$os_id" in
    ubuntu)
      if [[ "${os_ver%%.*}" -lt 24 ]]; then
        say "Ubuntu ${os_ver} is older than the supported 24.04 or newer." \
            "Ubuntu ${os_ver} старше поддерживаемой 24.04 или новее."
        ((ASSUME_YES)) || die "unsupported Ubuntu release"
      fi ;;
    debian)
      if [[ "${os_ver%%.*}" -lt 13 ]]; then
        say "Debian ${os_ver} is older than the supported 13." \
            "Debian ${os_ver} старше поддерживаемого 13."
        ((ASSUME_YES)) || die "unsupported Debian release"
      fi ;;
    *) say "Operating system '${os_id}' is not Ubuntu 24.04 or Debian 13: continuing, but this is untested." \
           "Система '${os_id}' — не Ubuntu 24.04 и не Debian 13: продолжаю, но это не проверено." ;;
  esac

  arch="$(uname -m)"
  case "$arch" in
    x86_64|aarch64) ;;
    *) die "architecture $arch is not supported (x86_64 or aarch64)" ;;
  esac

  if [[ "$arch" == x86_64 ]] && ! cpu_supports_x86_64_v2; then
    say "This CPU does not meet the x86-64-v2 baseline (SSE4.2, POPCNT, CMPXCHG16B): the board image cannot start on it." \
        "Процессор не дотягивает до базового уровня x86-64-v2 (SSE4.2, POPCNT, CMPXCHG16B): образ доски на нём не запустится."
    die "unsupported CPU (x86-64-v2 is required)"
  fi

  have systemctl || say "systemd was not found: the stack is not covered by the host reboot." \
                       "systemd не найден: после перезагрузки хост не поднимет стек сам."

  cpu="$(nproc)"
  if (( cpu < 2 )); then
    say "2 CPU cores are required, this machine has $cpu." \
        "Нужно 2 ядра CPU, на этой машине $cpu."
    die "not enough CPU"
  fi

  mem_mb="$(( $(awk '/MemTotal/{print $2}' /proc/meminfo) / 1024 ))"
  if (( mem_mb < 3800 )); then
    say "4 GB of memory is required, this machine has ${mem_mb} MB." \
        "Нужно 4 ГБ памяти, на этой машине ${mem_mb} МБ."
    die "not enough memory"
  fi

  mkdir -p "$DIR" || die "cannot create $DIR"
  free_kb="$(df -Pk "$DIR" | awk 'NR==2{print $4}')"
  free_mb="$(( free_kb / 1024 ))"
  if (( free_mb < 10240 )); then
    say "10 GB of free disk are required under $DIR, ${free_mb} MB are free." \
        "Под $DIR нужно 10 ГБ свободного места, свободно ${free_mb} МБ."
    die "not enough disk"
  fi

  # The port must be free unless our own stack already holds it (the update path).
  if ! compose_is_up 2>/dev/null; then
    if have ss && ss -ltn "( sport = :$PORT )" | grep -q ":$PORT"; then
      say "Port $PORT is already in use by another service; pass --port <number>." \
          "Порт $PORT занят другой службой; укажите --port <номер>."
      die "port $PORT is busy"
    fi
  fi

  say "System requirements: ok (${os_id} ${os_ver}, ${arch}, ${cpu} CPU, ${mem_mb} MB RAM, ${free_mb} MB free under $DIR)." \
      "Требования к системе: порядок (${os_id} ${os_ver}, ${arch}, ${cpu} CPU, ${mem_mb} МБ ОЗУ, ${free_mb} МБ свободно под $DIR)."
}

# ----------------------------------------------------------------- docker -----
install_docker() {
  if have docker && docker compose version >/dev/null 2>&1; then
    say "Docker and the compose plugin are already installed." \
        "Docker и плагин compose уже установлены."
    return 0
  fi
  say "Installing Docker and the compose plugin..." \
      "Ставлю Docker и плагин compose..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq || die "apt-get update failed"
  apt-get install -y -qq ca-certificates curl gnupg || die "cannot install the apt prerequisites"
  install -m 0755 -d /etc/apt/keyrings
  local os_id
  os_id="$( . /etc/os-release && printf '%s' "${ID:-}" )"
  if [[ ! -r /etc/apt/keyrings/docker.asc ]]; then
    curl -fsSL "https://download.docker.com/linux/${os_id}/gpg" -o /etc/apt/keyrings/docker.asc \
      || die "cannot download the Docker signing key"
    chmod a+r /etc/apt/keyrings/docker.asc
  fi
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${os_id} $(. /etc/os-release && echo "${VERSION_CODENAME}") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq || die "apt-get update failed after adding the Docker repository"
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
    || die "cannot install Docker"
  systemctl enable --now docker >/dev/null 2>&1 || true
  have docker || die "Docker was installed but the 'docker' command is still missing"
  docker compose version >/dev/null 2>&1 || die "the compose plugin is missing after the install"
  say "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null) is ready." \
      "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null) готов."
}

# ---------------------------------------------------------------- release -----
# The release is a tag plus the digests of its images. Only images published by
# CI from that tag reach a host: the installer pins them by digest, exactly as
# deploy.sh does, and there is no flag that skips the check.
resolve_release() {
  local tag="$1" manifest_url
  if [[ -n "$tag" ]]; then
    RELEASE_TAG="$tag"
    manifest_url="$MYR_WEB/$MYR_REPO/releases/download/$tag/release-components.json"
  else
    # releases/latest follows the newest STABLE release: a pre-release is served
    # only when it is asked for by tag (--version myr-vX.Y.Z-rc.N).
    RELEASE_TAG=""
    manifest_url="$MYR_WEB/$MYR_REPO/releases/latest/download/release-components.json"
  fi

  MANIFEST="$(mktemp)"
  fetch "$manifest_url" "$MANIFEST" \
    || die "cannot download the release manifest $manifest_url (check the network and the repository name)"

  # The published manifest names every component with its repository and digest:
  #   {"schema":1,"version":"1.6.5","tag":"myr-v1.6.5",
  #    "components":{"board":{"repository":"ghcr.io/...","digest":"sha256:..."},...}}
  MANIFEST_VERSION="$(jq -r '.version // ""' "$MANIFEST")"
  if [[ -z "$RELEASE_TAG" ]]; then
    RELEASE_TAG="$(jq -r '.tag // ""' "$MANIFEST")"
    if [[ -z "$RELEASE_TAG" && -n "$MANIFEST_VERSION" ]]; then RELEASE_TAG="myr-v$MANIFEST_VERSION"; fi
    if [[ -z "$RELEASE_TAG" ]]; then RELEASE_TAG="$(latest_tag)"; fi
    [[ -n "$RELEASE_TAG" ]] || RELEASE_TAG="latest"
  fi
  [[ -n "$MANIFEST_VERSION" ]] || MANIFEST_VERSION="${RELEASE_TAG#myr-v}"

  BOARD_REPOSITORY="$(jq -r '.components.board.repository // ""' "$MANIFEST")"
  DOCKERGATE_REPOSITORY="$(jq -r '.components.dockergate.repository // ""' "$MANIFEST")"
  BOT_REPOSITORY="$(jq -r '.components.hermes.repository // .components["hermes-dev"].repository // ""' "$MANIFEST")"
  BOARD_DIGEST="$(jq -r '.components.board.digest // ""' "$MANIFEST")"
  DOCKERGATE_DIGEST="$(jq -r '.components.dockergate.digest // ""' "$MANIFEST")"
  BOT_DIGEST="$(jq -r '.components.hermes.digest // .components["hermes-dev"].digest // ""' "$MANIFEST")"

  [[ -n "$BOARD_REPOSITORY" ]] || BOARD_REPOSITORY="ghcr.io/itkadr-git/myrmidon"
  [[ -n "$DOCKERGATE_REPOSITORY" ]] || DOCKERGATE_REPOSITORY="ghcr.io/itkadr-git/myrmidon-dockergate"
  [[ -n "$BOT_REPOSITORY" ]] || BOT_REPOSITORY="ghcr.io/itkadr-git/myrmidon-hermes"

  [[ "$BOARD_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || die "the manifest of $RELEASE_TAG names no board image digest"
  [[ "$DOCKERGATE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || die "the manifest of $RELEASE_TAG names no dockergate image digest"
  [[ "$BOT_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || die "the manifest of $RELEASE_TAG names no bot image digest (dockergate needs at least one allowed image)"
  say "Release: $RELEASE_TAG" "Выпуск: $RELEASE_TAG"
  say "Images: board ${BOARD_DIGEST:0:19}, dockergate ${DOCKERGATE_DIGEST:0:19}, bot ${BOT_DIGEST:0:19} (pinned by digest)." \
      "Образы: доска ${BOARD_DIGEST:0:19}, dockergate ${DOCKERGATE_DIGEST:0:19}, бот ${BOT_DIGEST:0:19} (закреплены дайджестом)."
}

# latest_tag: the tag `releases/latest` points at, read from the redirect of the
# public page. Used only when the manifest of the newest release names neither a
# tag nor a version (releases published before 1.6.5).
latest_tag() {
  curl -fsSIL --retry 3 --retry-delay 2 "$MYR_WEB/$MYR_REPO/releases/latest" 2>/dev/null \
    | sed -n 's|^[Ll]ocation: .*/tag/\([^[:space:]\r]*\).*|\1|p' | tail -1
}

rand_hex() { openssl rand -hex "$1"; }

# The internal profile hands the shared server an init script in
# /docker-entrypoint-initdb.d: a shell script the official postgres
# entrypoint runs on FIRST start only, while the cluster holds no data. It
# creates one login role and one owned database per extra service of the
# shared cluster (role name == database name), enables the vector extension in
# every database — the board's own database and superuser role are already
# made by the entrypoint from POSTGRES_USER/POSTGRES_DB — and re-applies the
# memory parameters with ALTER SYSTEM so the same numbers also cover a
# PostgreSQL that later runs somewhere else. Passwords and sizes arrive as
# container environment variables from deploy.env; nothing secret is written
# into this file.
write_db_init() {
  mkdir -p "$DIR/db-init"
  cat > "$DIR/db-init/01-shared-roles.sh" <<'INIT'
#!/bin/bash
# Generated by myrmidon install.sh — the SHARED-PG database profile.
# Runs inside the postgres container during initdb (superuser, local socket).
set -euo pipefail

services="${MYRMIDON_SHARED_SERVICES:-}"
board_db="${POSTGRES_DB:-paperclip}"
# During initdb the only superuser is POSTGRES_USER — there is no "postgres"
# role yet, so every psql call must name it.
admin_user="${POSTGRES_USER:-paperclip}"

enable_vector() {
  # The pgvector image ships the extension's files; the databases are created
  # without it, so every database that stores vectors gets it explicitly.
  psql -v ON_ERROR_STOP=1 -U "$admin_user" -d "$1" -c "CREATE EXTENSION IF NOT EXISTS vector;"
}

enable_vector "$board_db"

for svc in $services; do
  pw_var="MYRMIDON_${svc^^}_PASSWORD"
  pw="${!pw_var:?the ${svc} password must be passed from deploy.env}"
  psql -v ON_ERROR_STOP=1 -U "$admin_user" -d postgres <<-SQL
	CREATE ROLE ${svc} LOGIN PASSWORD '${pw}';
	CREATE DATABASE ${svc} OWNER ${svc};
	SQL
  # CREATE DATABASE ... OWNER already binds the database to its role, so the
  # service can create objects in it; the vector extension is what it needs on
  # top of that.
  enable_vector "$svc"
done

# Same sizing the container command line carries, persisted in the cluster.
psql -v ON_ERROR_STOP=1 -U "$admin_user" -d postgres <<-SQL
	ALTER SYSTEM SET shared_buffers = '${MYRMIDON_DB_SHARED_BUFFERS:?}';
	ALTER SYSTEM SET effective_cache_size = '${MYRMIDON_DB_EFFECTIVE_CACHE_SIZE:?}';
	ALTER SYSTEM SET maintenance_work_mem = '${MYRMIDON_DB_MAINTENANCE_WORK_MEM:?}';
	ALTER SYSTEM SET work_mem = '${MYRMIDON_DB_WORK_MEM:?}';
	SQL
INIT
  chmod 755 "$DIR/db-init/01-shared-roles.sh"
  chmod 0755 "$DIR/db-init"   # the postgres entrypoint reads this dir as uid 999
}

# --------------------------------------------------------- database profile ---
# SHARED-PG (1.6.5): a fresh internal install stands up ONE PostgreSQL 18 server
# with the pgvector extension and creates, per service, a separate database and
# login role: the board (paperclip), litellm, langfuse, hindsight. The board's
# role and database are the image entrypoint's own POSTGRES_USER/POSTGRES_DB;
# the generated init script adds the other three roles, their databases and the
# vector extension in every database.
#
# Memory sizing for the SHARED server (all values overridable through the
# installer environment and persisted in deploy.env):
#   MYRMIDON_DB_TOTAL_MEMORY_MB       the RAM the shared PostgreSQL server gets
#       from the whole machine (default: the machine's MemTotal, capped at
#       16384 MB);
#   MYRMIDON_DB_SHARED_BUFFERS        default: 25 % of the total — the standard
#       rule of thumb for a cluster that carries the whole machine's database
#       work; the shared server serves board + litellm + langfuse + hindsight
#       at once, so it keeps the full quarter and the applications stay under
#       the rest of the OS page cache;
#   MYRMIDON_DB_EFFECTIVE_CACHE_SIZE  default: 75 % of the total — the planner
#       assumption about how much of RAM the OS file cache can hold;
#   MYRMIDON_DB_MAINTENANCE_WORK_MEM  default: 1/64 of the total, floor 64 MB —
#       index builds and autovacuum on the shared cluster;
#   MYRMIDON_DB_WORK_MEM              default: 16 MB — a query may open several
#       sort nodes; the value stays deliberately modest on a shared server;
#   MYRMIDON_DB_SHM_SIZE              default: half the total, 128 MB floor,
#       1 GB ceiling (2 * shared_buffers) — the /dev/shm mount parallel workers
#       use.
# A 4 GB machine therefore lands on shared_buffers=1GB,
# effective_cache_size=3GB, maintenance_work_mem=64MB, shm_size=256m.
db_profile() {
  # An existing install declares its profile in deploy.env: "keep" marks a
  # database that predates the shared profile — an update must never swap its
  # image; "external" pins the external-server mode so a re-run of the
  # installer does not grow a db container back.
  if [[ "$DB_PROFILE" == "keep" ]]; then return 0; fi
  # A stack installed before this profile carries a literal `image: postgres:...`
  # line in its compose file and names no profile in deploy.env. Swapping that
  # image under an existing PG17 data volume is a migration the operator runs
  # deliberately — the installer keeps the file untouched instead.
  if [[ -z "$DATABASE_URL" && -z "${MYRMIDON_DB_PROFILE:-}" && -r "$DIR/compose.yml" ]] \
     && grep -q '^[[:space:]]*image: postgres' "$DIR/compose.yml"; then
    DB_PROFILE="keep"
    return 0
  fi
  case "${MYRMIDON_DB_PROFILE:-internal}" in
    keep) DB_PROFILE="keep"; return 0 ;;
    external) [[ -n "$DATABASE_URL" ]] || DATABASE_URL="${MYRMIDON_DATABASE_URL:-}" ;;
  esac
  if [[ -n "$DATABASE_URL" ]]; then
    [[ "$DATABASE_URL" == postgres://* || "$DATABASE_URL" == postgresql://* ]] \
      || die "--database-url / MYRMIDON_INSTALL_DATABASE_URL must be a postgres:// connection string"
    DB_PROFILE="external"
    say "Database profile: external shared PostgreSQL server; no db container will be created." \
        "Профиль базы: внешний общий сервер PostgreSQL; контейнер db не создаётся."
    return 0
  fi
  DB_PROFILE="internal"
  # MemTotal is the machine's RAM in MB; the cap keeps a 64 GB host from
  # getting a 16 GB shared_buffers by default — an operator who wants more sets
  # MYRMIDON_DB_TOTAL_MEMORY_MB explicitly.
  [[ -n "${MYRMIDON_DB_TOTAL_MEMORY_MB:-}" ]] \
    || MYRMIDON_DB_TOTAL_MEMORY_MB="$(( $(awk '/MemTotal/{print $2}' /proc/meminfo) / 1024 ))"
  (( MYRMIDON_DB_TOTAL_MEMORY_MB <= 16384 )) || MYRMIDON_DB_TOTAL_MEMORY_MB=16384
  [[ -n "${MYRMIDON_DB_SHARED_BUFFERS:-}" ]] \
    || MYRMIDON_DB_SHARED_BUFFERS="$(( MYRMIDON_DB_TOTAL_MEMORY_MB / 4 ))MB"
  [[ -n "${MYRMIDON_DB_EFFECTIVE_CACHE_SIZE:-}" ]] \
    || MYRMIDON_DB_EFFECTIVE_CACHE_SIZE="$(( MYRMIDON_DB_TOTAL_MEMORY_MB * 3 / 4 ))MB"
  local mwm=$(( MYRMIDON_DB_TOTAL_MEMORY_MB / 64 )); (( mwm >= 64 )) || mwm=64
  [[ -n "${MYRMIDON_DB_MAINTENANCE_WORK_MEM:-}" ]] || MYRMIDON_DB_MAINTENANCE_WORK_MEM="${mwm}MB"
  [[ -n "${MYRMIDON_DB_WORK_MEM:-}" ]] || MYRMIDON_DB_WORK_MEM="16MB"
  local shm=$(( MYRMIDON_DB_TOTAL_MEMORY_MB / 8 )); (( shm >= 128 )) || shm=128; (( shm <= 1024 )) || shm=1024
  [[ -n "${MYRMIDON_DB_SHM_SIZE:-}" ]] || MYRMIDON_DB_SHM_SIZE="${shm}m"
  # The image is overridable so an operator can pin an exact digest
  # (MYRMIDON_DB_IMAGE=repo@sha256:...); the default is the pgvector project's
  # own rolling build of PostgreSQL 18 + pgvector.
  [[ -n "${MYRMIDON_DB_IMAGE:-}" ]] || MYRMIDON_DB_IMAGE="docker.io/pgvector/pgvector:pg18"
  # The extra services that share the cluster (space-separated; role name ==
  # database name; each gets MYRMIDON_<NAME>_PASSWORD, see write_env).
  [[ -n "${MYRMIDON_SHARED_SERVICES:-}" ]] || MYRMIDON_SHARED_SERVICES="litellm langfuse hindsight"
  return 0
}

load_env() {
  # A fresh install has no deploy.env yet: the read must be an `if`, not an
  # `&&` list — as the last command of the function the failed test would make
  # it return 1 and `set -e` would kill the installer.
  if [[ -r "$DIR/deploy.env" ]]; then
    # shellcheck disable=SC1091
    . "$DIR/deploy.env"
  fi
}

# The install directory is ours: it must be empty or carry the stamp this
# installer writes. A foreign directory is a refusal, never an overwrite (the
# same rule deploy.sh applies to a boot unit).
check_foreign() {
  [[ -e "$DIR/.myrmidon-install" ]] && return 0
  [[ -z "$(ls -A "$DIR" 2>/dev/null)" ]] && return 0
  die "$DIR is not empty and carries no .myrmidon-install stamp: this installer will not touch a directory it did not create"
}

write_env() {
  [[ -n "${POSTGRES_PASSWORD:-}" ]] || POSTGRES_PASSWORD="$(rand_hex 24)"
  [[ -n "${BETTER_AUTH_SECRET:-}" ]] || BETTER_AUTH_SECRET="$(rand_hex 32)"
  [[ -n "${PAPERCLIP_TOOL_ACTION_SIGNING_SECRET:-}" ]] || PAPERCLIP_TOOL_ACTION_SIGNING_SECRET="$(rand_hex 32)"
  [[ -n "$PUBLIC_URL" ]] || PUBLIC_URL="http://$(hostname -f 2>/dev/null || hostname):$PORT"

  # SHARED-PG profile parameters, persisted into deploy.env so a re-run (the
  # update path) keeps exactly the shape the first install chose. "keep" marks
  # a database that predates the profile: nothing about it is rewritten.
  local db_profile_env="" svc pw_var
  case "${DB_PROFILE:-internal}" in
    internal)
      db_profile_env="MYRMIDON_DB_PROFILE=internal
MYRMIDON_DB_IMAGE=$MYRMIDON_DB_IMAGE
MYRMIDON_SHARED_SERVICES=\"$MYRMIDON_SHARED_SERVICES\"
MYRMIDON_DB_TOTAL_MEMORY_MB=$MYRMIDON_DB_TOTAL_MEMORY_MB
MYRMIDON_DB_SHARED_BUFFERS=$MYRMIDON_DB_SHARED_BUFFERS
MYRMIDON_DB_EFFECTIVE_CACHE_SIZE=$MYRMIDON_DB_EFFECTIVE_CACHE_SIZE
MYRMIDON_DB_MAINTENANCE_WORK_MEM=$MYRMIDON_DB_MAINTENANCE_WORK_MEM
MYRMIDON_DB_WORK_MEM=$MYRMIDON_DB_WORK_MEM
MYRMIDON_DB_SHM_SIZE=$MYRMIDON_DB_SHM_SIZE"
      # One login role per extra service of the shared cluster (role name ==
      # database name). Each password is generated once and then kept from
      # deploy.env — see the init script write_db_init renders from these.
      for svc in $MYRMIDON_SHARED_SERVICES; do
        [[ "$svc" =~ ^[a-z][a-z0-9_]*$ ]] || die "MYRMIDON_SHARED_SERVICES names an invalid role: $svc"
        pw_var="MYRMIDON_${svc^^}_PASSWORD"
        [[ -z "${!pw_var:-}" ]] || continue
        printf -v "$pw_var" '%s' "$(rand_hex 24)"
      done
      for svc in $MYRMIDON_SHARED_SERVICES; do
        pw_var="MYRMIDON_${svc^^}_PASSWORD"
        db_profile_env+=$'\n'"${pw_var}=${!pw_var}"
      done
      ;;
    external)
      db_profile_env="MYRMIDON_DB_PROFILE=external
MYRMIDON_DATABASE_URL=$(printf %q "$DATABASE_URL")"
      ;;
    keep)
      # The marker must survive the re-write of deploy.env: without it the
      # next run would mistake the legacy database for a fresh one.
      db_profile_env="MYRMIDON_DB_PROFILE=keep"
      ;;
  esac

  umask 077
  cat > "$DIR/deploy.env" <<ENV
# Generated by myrmidon install.sh — do not edit by hand; re-run the installer
# to change a value (every secret below is regenerated only when it is missing).
# Keep this file out of version control.
MYRMIDON_VERSION=$MANIFEST_VERSION
MYRMIDON_RELEASE_TAG=$RELEASE_TAG
MYRMIDON_INSTALL_DIR=$DIR
MYRMIDON_PORT=$PORT
MYRMIDON_PUBLIC_URL=$PUBLIC_URL
MYRMIDON_BOARD_DIGEST=$BOARD_DIGEST
MYRMIDON_DOCKERGATE_DIGEST=$DOCKERGATE_DIGEST
MYRMIDON_BOT_DIGEST=$BOT_DIGEST
MYRMIDON_BOARD_REPOSITORY=$BOARD_REPOSITORY
MYRMIDON_DOCKERGATE_REPOSITORY=$DOCKERGATE_REPOSITORY
MYRMIDON_BOT_REPOSITORY=$BOT_REPOSITORY
MYRMIDON_DOCKER_GID=$DOCKER_GID
POSTGRES_DB=paperclip
POSTGRES_USER=paperclip
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
BETTER_AUTH_SECRET=$BETTER_AUTH_SECRET
PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=$PAPERCLIP_TOOL_ACTION_SIGNING_SECRET
$db_profile_env
ENV
  chmod 600 "$DIR/deploy.env"
}

write_compose() {
  # A running install that predates the shared-database profile keeps its
  # compose file untouched: an update must never swap the database image from
  # underneath an existing data volume (migrating that database onto a shared
  # PostgreSQL 18 is an operator task, not a side effect of `--version`).
  if [[ "$DB_PROFILE" == "keep" ]]; then return 0; fi

  local db_service="" db_depends="" pgdata_volume="" board_database_url=""
  if [[ "$DB_PROFILE" == "external" ]]; then
    # The board talks straight to the operator's shared server; no db service,
    # no pgdata volume, nothing to start locally.
    board_database_url='      DATABASE_URL: "${MYRMIDON_DATABASE_URL:?the external database connection string must be set in deploy.env}"'
  else
    # One shared PostgreSQL 18 + pgvector instance. The memory parameters come
    # from deploy.env (db_profile sized them for the combined load of the
    # board, LiteLLM, Langfuse and Hindsight); shm_size is the /dev/shm mount
    # the parallel workers use.
    local db_init_env="" svc pw_var
    for svc in ${MYRMIDON_SHARED_SERVICES:-}; do
      pw_var="MYRMIDON_${svc^^}_PASSWORD"
      db_init_env+=$'\n'"      ${pw_var}: \${${pw_var}:?the ${svc} database password must be set in deploy.env}"
    done
    db_service='  db:
    image: ${MYRMIDON_DB_IMAGE:?the database image must be set in deploy.env}
    restart: unless-stopped
    shm_size: "${MYRMIDON_DB_SHM_SIZE:-256m}"
    command:
      - postgres
      - -c
      - shared_buffers=${MYRMIDON_DB_SHARED_BUFFERS:?the shared_buffers value must be set in deploy.env}
      - -c
      - effective_cache_size=${MYRMIDON_DB_EFFECTIVE_CACHE_SIZE:?the effective_cache_size value must be set in deploy.env}
      - -c
      - maintenance_work_mem=${MYRMIDON_DB_MAINTENANCE_WORK_MEM:?the maintenance_work_mem value must be set in deploy.env}
      - -c
      - work_mem=${MYRMIDON_DB_WORK_MEM:?the work_mem value must be set in deploy.env}
    environment:
      POSTGRES_DB: ${POSTGRES_DB:-paperclip}
      POSTGRES_USER: ${POSTGRES_USER:-paperclip}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set}
      MYRMIDON_SHARED_SERVICES: ${MYRMIDON_SHARED_SERVICES:-}'"$db_init_env"'
      # Passed to the init script as well: it re-applies the sizing with
      # ALTER SYSTEM so the numbers live in the cluster, not only in the
      # command line of this container.
      MYRMIDON_DB_SHARED_BUFFERS: ${MYRMIDON_DB_SHARED_BUFFERS:?}
      MYRMIDON_DB_EFFECTIVE_CACHE_SIZE: ${MYRMIDON_DB_EFFECTIVE_CACHE_SIZE:?}
      MYRMIDON_DB_MAINTENANCE_WORK_MEM: ${MYRMIDON_DB_MAINTENANCE_WORK_MEM:?}
      MYRMIDON_DB_WORK_MEM: ${MYRMIDON_DB_WORK_MEM:?}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-paperclip} -d ${POSTGRES_DB:-paperclip}"]
      interval: 2s
      timeout: 5s
      retries: 30
    volumes:
      # PG18 keeps the cluster at /var/lib/postgresql/18/docker: mount the
      # volume at the declared VOLUME path of the image, not the PG17 data path.
      - pgdata:/var/lib/postgresql
      - ./db-init:/docker-entrypoint-initdb.d:ro'
    db_depends='    depends_on:
      db:
        condition: service_healthy'
    pgdata_volume='  pgdata:'
    board_database_url='      DATABASE_URL: "postgres://${POSTGRES_USER:-paperclip}:${POSTGRES_PASSWORD:?the board database password must be set in deploy.env}@db:5432/${POSTGRES_DB:-paperclip}"'
  fi

  # The sentinels below are literal lines of the quoted heredoc; the shell
  # substitution that follows places the profile-dependent blocks. A quoted
  # heredoc is mandatory: the file must carry compose ${VAR:?} syntax
  # verbatim, not the installer's expansion of it.
  local content
  content="$(cat <<'COMPOSE'
# Generated by myrmidon install.sh — the stack of a fresh installation:
# database, board and dockergate. Update it by re-running the installer.
services:
%%DB_SERVICE%%
  server:
    image: ${MYRMIDON_BOARD_REPOSITORY:?the board repository must be set}@${MYRMIDON_BOARD_DIGEST:?the board digest must be set}
    restart: unless-stopped
    pids_limit: 2048
%%DB_DEPENDS%%
    ports:
      - "${MYRMIDON_PORT:-3100}:3100"
    environment:
      HOST: "0.0.0.0"
      PORT: "3100"
      SERVE_UI: "true"
      PAPERCLIP_HOME: "/paperclip"
      PAPERCLIP_DEPLOYMENT_MODE: "authenticated"
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "private"
      PAPERCLIP_PUBLIC_URL: "${MYRMIDON_PUBLIC_URL}"
      PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: "${PAPERCLIP_TOOL_ACTION_SIGNING_SECRET:?PAPERCLIP_TOOL_ACTION_SIGNING_SECRET must be set}"
      BETTER_AUTH_SECRET: "${BETTER_AUTH_SECRET:?BETTER_AUTH_SECRET must be set}"
%%BOARD_DATABASE_URL%%
      MYRMIDON_BOT_DOCKER_SOCKET: "/run/myrmidon-dockergate/engine.sock"
    volumes:
      - paperclip-data:/paperclip
      - ./run:/run/myrmidon-dockergate

  dockergate:
    # The caller is pinned to the board container's main process (see the
    # generated config.json): the uid/gid mode is refused for a production root.
    image: ${MYRMIDON_DOCKERGATE_REPOSITORY:?the dockergate repository must be set}@${MYRMIDON_DOCKERGATE_DIGEST:?the dockergate digest must be set}
    restart: unless-stopped
    # dockergate talks to the daemon over /var/run/docker.sock, which on a stock
    # host is root:docker 0660. The image runs as the nonroot user 65532, so the
    # socket's group must be granted explicitly — otherwise the container starts
    # and immediately dies on "the daemon does not answer: upstream_error".
    group_add:
      - "${MYRMIDON_DOCKER_GID:-0}"
    # dockergate decides who is calling by a walk over /proc: it pins the first
    # child of the *board container's* main process (docs/myrmidon/dockergate.md,
    # step 1). In its own pid namespace it sees only its own processes, so
    # /proc/<board pid> is missing: the container stays up, the self-check says
    # ok, and every hourly re-resolve logs "caller_resolve_failed:
    # board_not_running" — a stack that looks healthy and serves no call.
    pid: host
    # The rest mirrors the production service (deploy.sh): a unix-socket-only
    # proxy needs no network, no capabilities and no writable root.
    network_mode: none
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    mem_limit: 128m
    cpus: 1
    pids_limit: 128
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./dockergate/config.json:/etc/myrmidon-dockergate/config.json:ro
      - ./run:/run/myrmidon-dockergate
      - ./dockergate-state:/run/myrmidon-dockergate-state

volumes:
%%PGDATA_VOLUME%%
  paperclip-data:
COMPOSE
)"
  content="${content//%%DB_SERVICE%%/$db_service}"
  content="${content//%%DB_DEPENDS%%/$db_depends}"
  content="${content//%%BOARD_DATABASE_URL%%/$board_database_url}"
  content="${content//%%PGDATA_VOLUME%%/$pgdata_volume}"
  printf '%s\n' "$content" > "$DIR/compose.yml"

  [[ "$DB_PROFILE" == "external" ]] || write_db_init

  cat > "$DIR/dockergate/config.json" <<DG
{
  "listen": "/run/myrmidon-dockergate/engine.sock",
  "upstream": "/var/run/docker.sock",
  "apiVersion": "1.45",
  "caller": {
    "mode": "container-main-process",
    "uid": 1000,
    "gid": 1000,
    "container": "${MYR_PROJECT}-server-1",
    "containerLabels": {
      "com.docker.compose.project": "${MYR_PROJECT}",
      "com.docker.compose.service": "server"
    },
    "argv": ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]
  },
  "volumeRoot": "$DIR/bots",
  "network": "myrmidon-bots",
  "images": ["$BOT_REPOSITORY@$BOT_DIGEST"],
  "bots": [],
  "statsFile": "/run/myrmidon-dockergate-state/stats.json"
}
DG

  # dockergate opens this file as its nonroot user (65532), so root-only 0600 is
  # unreadable for it and the container dies with "config: open ...: permission
  # denied". Nothing secret is in here (listen, upstream, the caller shape, the
  # pinned bot digest), and this is the shape the production install uses.
  if [[ "$(id -u)" == "0" ]]; then
    chown 65532:65532 "$DIR/dockergate/config.json"
    chmod 0640 "$DIR/dockergate/config.json"
  fi
}

# ------------------------------------------------------------ the stack -------
compose() {
  docker compose --project-name "$MYR_PROJECT" --project-directory "$DIR" \
    --env-file "$DIR/deploy.env" -f "$DIR/compose.yml" "$@"
}

compose_is_up() {
  [[ -r "$DIR/compose.yml" ]] || return 1
  [[ -n "$(compose ps -q server 2>/dev/null)" ]]
}

prepare_dirs() {
  mkdir -p "$DIR/dockergate" "$DIR/bots" "$DIR/state" "$DIR/run" "$DIR/dockergate-state"
  # dockergate runs as the image's nonroot user (65532) and creates the socket
  # there; the mode is the one the production install uses (0711 + a 0666 socket).
  if [[ "$(id -u)" == "0" ]]; then
    chown 65532:65532 "$DIR/run" "$DIR/dockergate-state"
    chmod 0711 "$DIR/run"
    chmod 0755 "$DIR/dockergate-state"
  fi
  docker network inspect myrmidon-bots >/dev/null 2>&1 \
    || docker network create myrmidon-bots >/dev/null 2>&1 || true
  printf 'generated by myrmidon install.sh\n%s\nrelease %s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${MANIFEST_VERSION:-unknown}" > "$DIR/.myrmidon-install"
}

wait_health() {
  local deadline="${1:-${MYRMIDON_INSTALL_HEALTH_TIMEOUT:-300}}" url="http://127.0.0.1:$PORT/api/health" body status waited=0
  while (( waited < deadline )); do
    body="$(curl -fsS --max-time 5 "$url" 2>/dev/null || true)"
    status="$(printf '%s' "$body" | jq -r '.status // ""' 2>/dev/null || true)"
    if [[ "$status" == "ok" ]]; then
      printf '%s' "$body"
      return 0
    fi
    sleep 5
    waited=$((waited + 5))
    if (( waited % 30 == 0 )); then
      say "Waiting for the board to become healthy (${waited}s)..." \
          "Жду, пока доска станет здоровой (${waited} с)..."
    fi
  done
  return 1
}

diagnose() {
  say "The board did not become healthy. The last log lines:" \
      "Доска не стала здоровой. Последние строки журнала:"
  compose logs --tail 40 server >&2 || true
}

summary() {
  say_out "" ""
  say_out "Myrmidon $MANIFEST_VERSION is installed and answering." \
          "Myrmidon $MANIFEST_VERSION установлен и отвечает."
  say_out "" ""
  say_out "  Address:            $PUBLIC_URL" \
          "  Адрес:              $PUBLIC_URL"
  say_out "  First administrator: open $PUBLIC_URL , create an account — the first account becomes the administrator of this instance." \
          "  Первый администратор: откройте $PUBLIC_URL , создайте учётную запись — первый зарегистрировавшийся становится администратором этого сервера."
  say_out "  Files:              $DIR (deploy.env holds the secrets, mode 0600; the directory carries the .myrmidon-install stamp)" \
          "  Файлы:              $DIR (секреты в deploy.env, режим 0600; каталог помечен файлом .myrmidon-install)"
  say_out "  Update:             re-run the same command (or: install.sh --version myr-vX.Y.Z)" \
          "  Обновление:         тот же запуск (или: install.sh --version myr-vX.Y.Z)"
  say_out "  Stop / remove:      install.sh --uninstall        (--purge also deletes the data volume)" \
          "  Остановка / снос:   install.sh --uninstall        (--purge удаляет и том с данными)"
}

do_install() {
  require_tools
  preflight
  resolve_release "$RELEASE_TAG"
  # load_env first: an existing install declares its database profile in
  # deploy.env, and db_profile must see it before any file is (re)written.
  load_env
  db_profile
  check_foreign
  prepare_dirs

  if compose_is_up; then
    load_env
    say "An installation is already running in $DIR (release ${MYRMIDON_VERSION:-?}): updating." \
        "В $DIR уже работает установка (выпуск ${MYRMIDON_VERSION:-?}): обновляю."
    do_update
    return
  fi

  log "generating secrets and the compose project in $DIR"
  write_env
  write_compose

  log "pulling the images (this may take a few minutes)"
  ( cd "$DIR" && compose pull --quiet ) || die "cannot pull the images of $RELEASE_TAG"
  log "starting the board stack"
  ( cd "$DIR" && compose up -d ) || die "docker compose up failed"

  log "waiting for /api/health"
  wait_health >/dev/null || { diagnose; die "the board did not become healthy; see 'docker compose logs server' in $DIR"; }
  summary
}

# Re-running is the update path: the database is dumped BEFORE the image line
# changes, health is verified after, and a board that does not come up healthy
# is rolled back to the digest that ran before.
do_update() {
  need_window=0
  if [[ "$BOARD_DIGEST" != "${MYRMIDON_BOARD_DIGEST:-}" ]]; then need_window=1; fi
  if [[ "$DOCKERGATE_DIGEST" != "${MYRMIDON_DOCKERGATE_DIGEST:-}" ]]; then need_window=1; fi
  if [[ "$BOARD_REPOSITORY" != "${MYRMIDON_BOARD_REPOSITORY:-}" ]]; then need_window=1; fi
  if [[ "$DOCKERGATE_REPOSITORY" != "${MYRMIDON_DOCKERGATE_REPOSITORY:-}" ]]; then need_window=1; fi
  if (( need_window == 0 )); then
    say "The installation in $DIR already runs $RELEASE_TAG; nothing to change." \
        "Установка в $DIR уже работает на $RELEASE_TAG; менять нечего."
    return 0
  fi

  local previous_board="${MYRMIDON_BOARD_DIGEST:-}" previous_docker="${MYRMIDON_DOCKERGATE_DIGEST:-}" previous_bot="${MYRMIDON_BOT_DIGEST:-}"
  local previous_version="${MYRMIDON_VERSION:-}" previous_tag="${MYRMIDON_RELEASE_TAG:-}"
  local previous_board_repo="${MYRMIDON_BOARD_REPOSITORY:-}" previous_docker_repo="${MYRMIDON_DOCKERGATE_REPOSITORY:-}"
  local previous_bot_repo="${MYRMIDON_BOT_REPOSITORY:-}"
  local dump
  dump="$DIR/state/pre-update-$(date -u +%Y%m%dT%H%M%SZ).dump"

  log "dumping the database before the image changes"
  if compose ps -q db >/dev/null 2>&1 && [[ -n "$(compose ps -q db)" ]]; then
    compose exec -T db pg_dump -U "${POSTGRES_USER:-paperclip}" -Fc "${POSTGRES_DB:-paperclip}" > "$dump" \
      || { rm -f "$dump"; die "the pre-update database dump failed; nothing was changed"; }
    if [[ ! -s "$dump" ]]; then rm -f "$dump"; die "the pre-update database dump is empty; nothing was changed"; fi
    log "dump: $dump ($(du -h "$dump" | cut -f1))"
  else
    say "The database container is not running: the update continues without a dump." \
        "Контейнер базы не запущен: обновляюсь без дампа."
    dump=""
  fi

  write_env
  write_compose
  load_env

  log "switching to $RELEASE_TAG (board ${BOARD_DIGEST:0:19}, dockergate ${DOCKERGATE_DIGEST:0:19})"
  ( cd "$DIR" && compose pull --quiet ) || die "cannot pull the images of $RELEASE_TAG (nothing was changed)"
  ( cd "$DIR" && compose up -d ) || die "docker compose up failed"

  log "waiting for /api/health"
  if wait_health >/dev/null; then
    summary
    return 0
  fi

  log "the new board did not become healthy: rolling back to the previous digests"
  BOARD_DIGEST="$previous_board"; DOCKERGATE_DIGEST="$previous_docker"; BOT_DIGEST="$previous_bot"
  BOARD_REPOSITORY="$previous_board_repo"; DOCKERGATE_REPOSITORY="$previous_docker_repo"; BOT_REPOSITORY="$previous_bot_repo"
  MANIFEST_VERSION="$previous_version"; RELEASE_TAG="$previous_tag"
  write_env
  ( cd "$DIR" && compose up -d ) || true
  if wait_health >/dev/null; then
    say "The update failed and the previous release is running again." \
        "Обновление не удалось, снова работает предыдущий выпуск."
    diagnose
    exit 1
  fi
  diagnose
  die "the new board is unhealthy AND the rollback did not come up healthy; the dump is at $dump"
}

do_uninstall() {
  [[ -r "$DIR/compose.yml" ]] || die "no installation found in $DIR"
  compose_is_up && load_env
  log "stopping the stack in $DIR"
  ( cd "$DIR" && compose down ) || die "docker compose down failed"
  if (( PURGE )); then
    load_env
    docker volume rm "${MYR_PROJECT}_pgdata" "${MYR_PROJECT}_paperclip-data" >/dev/null 2>&1 || true
    rm -rf "$DIR"
    say "The stack, its data volume and $DIR were removed." \
        "Стек, том с данными и каталог $DIR удалены."
  else
    say "The stack is stopped. The data volume and $DIR were kept; --purge also deletes them." \
        "Стек остановлен. Том с данными и каталог $DIR сохранены; --purge удаляет и их."
  fi
}

# --interactive asks the three values a beginner may want to change. The
# questions read /dev/tty, because the script itself arrives on stdin
# (`curl ... | sudo bash`); with no terminal the defaults are used silently.
ask() {
  local prompt="$1" default="$2" answer=""
  if [[ -r /dev/tty ]]; then
    printf '%s [%s]: ' "$prompt" "$default" >&2
    IFS= read -r answer < /dev/tty || answer=""
  fi
  printf '%s' "${answer:-$default}"
}

interactive_questions() {
  (( INTERACTIVE )) || return 0
  say "Interactive mode: press Enter to keep the value in brackets." \
      "Интерактивный режим: Enter оставляет значение в скобках."
  DIR="$(ask "$( [[ "$LANG_CODE" == ru ]] && echo 'Каталог установки' || echo 'Install directory' )" "$DIR")"
  PORT="$(ask "$( [[ "$LANG_CODE" == ru ]] && echo 'Порт доски' || echo 'Board port' )" "$PORT")"
  PUBLIC_URL="$(ask "$( [[ "$LANG_CODE" == ru ]] && echo 'Адрес, по которому открывают доску' || echo 'Address the board is opened at' )" "${PUBLIC_URL:-http://$(hostname -f 2>/dev/null || hostname):$PORT}")"
  [[ "$DIR" == /* ]] || die "--dir must be an absolute path"
  [[ "$PORT" =~ ^[0-9]+$ ]] || die "--port must be a number"
}

# The daemon socket is root:docker 0660 on a stock host, while dockergate runs as
# the image's nonroot user: the container needs the socket's group. The value is
# read from the socket itself, so it is right whatever the docker group id is.
detect_docker_gid() {
  DOCKER_GID="$(stat -c '%g' /var/run/docker.sock 2>/dev/null || true)"
  [[ "$DOCKER_GID" =~ ^[0-9]+$ ]] || DOCKER_GID=0
  return 0
}

main() {
  require_root
  case "$MODE" in
    uninstall) do_uninstall ;;
    install)
      interactive_questions
      install_docker
      detect_docker_gid
      do_install ;;
  esac
}

main
