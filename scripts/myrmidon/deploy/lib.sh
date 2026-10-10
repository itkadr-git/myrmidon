#!/usr/bin/env bash
# Shared helpers for deploy.sh, rollback.sh and verify-health.sh.
# Sourced, not executed. Requires bash 4+, docker (with compose), curl, jq.
# shellcheck disable=SC2034  # variables are used by the sourcing scripts

MYR_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '[myrmidon-deploy] %s\n' "$*" >&2; }
die() { printf '[myrmidon-deploy] ERROR: %s\n' "$*" >&2; exit 1; }

# Runs a command, or prints it in dry-run mode.
run() {
  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    printf '[dry-run] %s\n' "$*" >&2
    return 0
  fi
  "$@"
}

plan() { printf '  %s\n' "$*" >&2; }

# --- config writes keep owner and mode ---------------------------------------
# A config file is replaced through a temp file and a rename. The temp file is
# born with the umask of the caller (0600 under a strict one) and the owner of
# the caller, so a plain rename silently changed who may read the file: a
# service running as another user (dockergate runs as uid 65532) then could not
# open its own config. Every such write goes through install_preserving, which
# copies owner and mode of the file it replaces onto the new content first and
# refuses to replace the file when it cannot.

# Gives <dest> the owner and mode of <ref>. Returns 1 when it cannot.
preserve_attrs() {
  local ref="$1" dest="$2"
  chmod --reference="$ref" "$dest" || return 1
  if ! chown --reference="$ref" "$dest" 2>/dev/null; then
    [[ "$(stat -c '%u:%g' "$ref")" == "$(stat -c '%u:%g' "$dest")" ]] || return 1
  fi
}

# Replaces <target> with the content of <new> (a temp file on the same
# filesystem), keeping the owner and mode of <target>; a target that does not
# exist yet gets 0644. On refusal <target> is untouched and <new> is left for
# the caller to remove.
install_preserving() {
  local new="$1" target="$2"
  if [[ -e "$target" ]]; then
    if ! preserve_attrs "$target" "$new"; then
      log "ERROR: cannot give the new content of $target its owner and mode (a write as root keeps them); $target was not changed"
      return 1
    fi
  else
    chmod 0644 "$new"
  fi
  mv -f "$new" "$target"
}

require_cmd() {
  local cmd
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 || die "required command not found: $cmd"
  done
}

valid_digest() { [[ "$1" =~ ^sha256:[0-9a-f]{64}$ ]]; }

# --- CI-only images ----------------------------------------------------------
# Only images built by the "Myrmidon image" workflow from main or from a myr-v*
# tag reach production. deploy.sh refuses anything else before it changes
# anything; rollback.sh only warns (it is the emergency path). There is
# deliberately no flag or setting that skips these checks.
MYR_CI_IMAGE="ghcr.io/itkadr-git/myrmidon"
MYR_CI_SOURCE="https://github.com/itkadr-git/myrmidon"
MYR_CI_ORIGIN_RE='(^|[/@])github\.com[:/]itkadr-git/myrmidon(\.git)?/?$'
MYR_NET_TIMEOUT_SEC=90
CI_CHECK_REASON=""
CI_IMAGE_REVISION=""
CI_IMAGE_VERSION=""

# Runs a network command with a time limit, so a dead registry or remote cannot hang the script.
with_timeout() {
  if command -v timeout >/dev/null 2>&1; then
    timeout "$MYR_NET_TIMEOUT_SEC" "$@"
  else
    "$@"
  fi
}

# Explains, in one line, why a reference is not exactly $MYR_CI_IMAGE@sha256:<64 hex>.
image_ref_problem() {
  local ref="$1" repo digest
  if [[ -z "$ref" ]]; then
    echo "no image given: pass the digest of an image built by CI as sha256:<64 hex>"
  elif [[ "$ref" == *@* ]]; then
    repo="${ref%@*}"
    digest="${ref#*@}"
    if [[ "$repo" != "$MYR_CI_IMAGE" ]]; then
      echo "image '$repo' is not $MYR_CI_IMAGE: only images built by CI in this repository are deployed"
    else
      echo "digest '$digest' must be sha256: followed by 64 lowercase hex characters"
    fi
  elif [[ "$ref" == sha256:* ]]; then
    echo "digest '$ref' must be sha256: followed by 64 lowercase hex characters"
  else
    echo "'$ref' has no digest (it is a tag or a name); tags can be moved. CI images are referenced as $MYR_CI_IMAGE@sha256:<64 hex>, the digest is in the CI run summary"
  fi
}

# Sets `digest` from a bare sha256:<64 hex> or from $MYR_CI_IMAGE@sha256:<64 hex>; dies on anything else.
parse_digest_arg() {
  local arg="$1"
  if valid_digest "$arg"; then
    digest="$arg"
  elif [[ "$arg" == "$MYR_CI_IMAGE@"* ]] && valid_digest "${arg#"$MYR_CI_IMAGE@"}"; then
    digest="${arg#"$MYR_CI_IMAGE@"}"
  else
    die "$(image_ref_problem "$arg")"
  fi
}

# Checks that a commit is on origin/main or carries a release tag
# myr-v<x>.<y>.<z> (RC-VERSIONS: or the candidate myr-v<x>.<y>.<z>-rc.<n>),
# using the git clone that holds these scripts. Sets CI_CHECK_REASON and
# returns 1 when it cannot say yes.
commit_is_reviewed() {
  local rev="$1" clone url tags sha name
  local tag_re='^refs/tags/myr-v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?(\^\{\})?$'
  if ! command -v git >/dev/null 2>&1; then
    CI_CHECK_REASON="git is not installed, so commit ${rev:0:12} cannot be checked against main; run the script from a git clone of itkadr-git/myrmidon"
    return 1
  fi
  if ! clone="$(git -C "$MYR_SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)" || [[ -z "$clone" ]]; then
    CI_CHECK_REASON="the deploy scripts are not inside a git clone, so commit ${rev:0:12} cannot be checked against main; run them from a clone of itkadr-git/myrmidon"
    return 1
  fi
  if ! url="$(git -C "$clone" remote get-url origin 2>/dev/null)" || [[ ! "$url" =~ $MYR_CI_ORIGIN_RE ]]; then
    CI_CHECK_REASON="remote 'origin' of the clone does not point to github.com/itkadr-git/myrmidon, so main cannot be trusted"
    return 1
  fi
  if ! GIT_TERMINAL_PROMPT=0 with_timeout git -C "$clone" fetch --quiet --no-tags origin '+refs/heads/main:refs/remotes/origin/main' >/dev/null 2>&1; then
    CI_CHECK_REASON="git fetch origin main failed (no network or no access?), so commit ${rev:0:12} cannot be checked against main"
    return 1
  fi
  if git -C "$clone" merge-base --is-ancestor "$rev" refs/remotes/origin/main >/dev/null 2>&1; then
    return 0
  fi
  if ! tags="$(GIT_TERMINAL_PROMPT=0 with_timeout git -C "$clone" ls-remote --tags origin 'refs/tags/myr-v*' 2>/dev/null)"; then
    CI_CHECK_REASON="commit ${rev:0:12} is not on origin/main and the release tags of origin could not be read"
    return 1
  fi
  # An annotated tag is listed twice; the line ending in ^{} carries the commit.
  while read -r sha name; do
    if [[ "$sha" == "$rev" && "$name" =~ $tag_re ]]; then
      return 0
    fi
  done <<<"$tags"
  CI_CHECK_REASON="commit ${rev:0:12} of the image is neither on origin/main nor tagged myr-v*: it was built from a branch or from code that never went through a PR"
  return 1
}

# The whole check for one image reference (registry, labels, commit). Returns 0 when
# the image is a CI image; otherwise sets CI_CHECK_REASON and returns 1.
check_ci_image() {
  # RELEASE-GATE: the reference-format half is board-specific (image_ref_problem
  # speaks about the board repository); the registry/labels/commit half is the
  # same for every component image, so it lives in check_ci_image_for_repo.
  local ref="$1"
  if [[ "$ref" != *@* || "${ref%@*}" != "$MYR_CI_IMAGE" ]] || ! valid_digest "${ref#*@}"; then
    CI_CHECK_REASON="$(image_ref_problem "$ref")"
    return 1
  fi
  check_ci_image_for_repo "$MYR_CI_IMAGE" "$ref"
}

# RELEASE-GATE (the 01.10 incident): the same CI-image proof for a component
# image (dockergate, fleetd) of the release: in the registry, revision and
# source labels set by the CI workflows, commit on origin/main or a myr-v* tag.
# Takes the expected repository plus a repo@sha256:<64 hex> reference.
check_ci_image_for_repo() {
  local expected_repo="$1" ref="$2" out err rc=0 labels revision image_source
  CI_CHECK_REASON="" CI_IMAGE_REVISION="" CI_IMAGE_VERSION=""

  if [[ "$ref" != *@* || "${ref%@*}" != "$expected_repo" ]] || ! valid_digest "${ref#*@}"; then
    CI_CHECK_REASON="$ref is not $expected_repo@sha256:<64 lowercase hex>"
    return 1
  fi

  # Reads the manifest and config from the registry without pulling the layers. A
  # locally built image is not there.
  err="$(mktemp)"
  out="$(with_timeout docker buildx imagetools inspect "$ref" --format '{{json .Image}}' 2>"$err")" || rc=$?
  if ((rc != 0)); then
    out="$(tail -n1 "$err")"
    out="${out#ERROR: }"
    CI_CHECK_REASON="$ref cannot be read from the registry (never pushed there, deleted, or the registry is unreachable): ${out#"$ref": }"
    rm -f "$err"
    return 1
  fi
  rm -f "$err"

  labels="$(jq -c '[.. | objects | select(has("Labels")) | .Labels | select(type == "object")] | first // {}' <<<"$out" 2>/dev/null)" || labels="{}"
  revision="$(jq -r '."org.opencontainers.image.revision" // ""' <<<"$labels" 2>/dev/null)" || revision=""
  image_source="$(jq -r '."org.opencontainers.image.source" // ""' <<<"$labels" 2>/dev/null)" || image_source=""
  CI_IMAGE_VERSION="$(jq -r '."org.opencontainers.image.version" // ""' <<<"$labels" 2>/dev/null)" || CI_IMAGE_VERSION=""

  if [[ ! "$revision" =~ ^[0-9a-f]{40}$ ]]; then
    CI_CHECK_REASON="$ref has no org.opencontainers.image.revision label with a full commit sha, so it was not built by the CI image workflow"
    return 1
  fi
  if [[ "$image_source" != "$MYR_CI_SOURCE" ]]; then
    CI_CHECK_REASON="$ref has org.opencontainers.image.source '${image_source:-<none>}', expected $MYR_CI_SOURCE: it was not built by the CI image workflow"
    return 1
  fi
  CI_IMAGE_REVISION="$revision"
  commit_is_reviewed "$revision"
}

# The boot unit (one boot path). The board container is started at boot by a
# systemd unit; the incident of 01.10 was exactly a unit that read a *different*
# compose file than the one deploy.sh maintains, so an old vendor image replaced
# the board for 7 minutes. verify_boot_unit() refuses a deploy unless the unit
# points at the same compose files (COMPOSE_DIR + COMPOSE_FILES + the override)
# this deploy manages, and can install the canonical unit from the template.
# Settings (all optional, see deploy.env.example; read by load_config):
#   SYSTEMD_UNIT_NAME     default paperclip.service
#   SYSTEMD_UNIT_DIR      default /etc/systemd/system (sandboxable for stands)
#   SYSTEMD_UNIT_INSTALL  1 = install the canonical unit from the template when
#                         none exists yet (needs root); unset = verify only.
#                         A unit that exists but does not match is ALWAYS a
#                         refusal, even with SYSTEMD_UNIT_INSTALL=1: repairing a
#                         foreign unit silently is how the incident happened.

# Fills the paperclip.service template: __COMPOSE_DIR__, __COMPOSE_FILE_ARGS__
# (the colon-separated COMPOSE_FILES expanded into -f arguments, the board
# image override and the override files of the local release components) and
# __COMPOSE_SERVICE__. One source of truth per image: the unit reads the same
# generated override the deploy and the rollback write, so a boot starts the
# image that was running, not whatever an older file says. With the argument
# "legacy" it renders the unit of releases before the component overrides
# joined the boot path (the only unit a SYSTEMD_UNIT_INSTALL=1 deploy replaces).
render_boot_unit() {
  local mode="${1:-}"
  local -a files=()
  local f
  IFS=':' read -r -a _boot_files <<<"$COMPOSE_FILES"
  for f in "${_boot_files[@]}"; do files+=("$COMPOSE_DIR/$f"); done
  files+=("$OVERRIDE_PATH")
  if [[ "$mode" != "legacy" ]]; then
    local -a _boot_component_files=()
    mapfile -t _boot_component_files < <(component_override_paths)
    for f in "${_boot_component_files[@]}"; do [[ -n "$f" ]] && files+=("$f"); done
  fi
  local file_args=""
  for f in "${files[@]}"; do file_args+="${file_args:+ }-f $f"; done
  sed -e "s|__COMPOSE_DIR__|$COMPOSE_DIR|g" \
    -e "s|__COMPOSE_FILE_ARGS__|$file_args|g" \
    -e "s|__COMPOSE_SERVICE__|$COMPOSE_SERVICE|g" \
    "$MYR_SCRIPT_DIR/paperclip.service.template"
}

# The install path of the unit (absolute).
boot_unit_path() { printf '%s/%s\n' "${SYSTEMD_UNIT_DIR%/}" "$SYSTEMD_UNIT_NAME"; }

# Checks the installed unit against the compose set this deploy manages.
# Returns 0 and sets BOOT_UNIT_OK=1 when the unit is the canonical one (its
# ExecStart names exactly COMPOSE_DIR, every COMPOSE_FILES entry and the
# override, in any order, with no other compose file); returns 1 with
# BOOT_UNIT_REASON set otherwise. Missing unit, uninstalled systemd or a
# foreign unit are all "not verified": the deploy refuses.
verify_boot_unit() {
  BOOT_UNIT_OK=0 BOOT_UNIT_REASON="" BOOT_UNIT_NOTE=""
  local unit expected current
  unit="$(boot_unit_path)"
  if ! command -v systemctl >/dev/null 2>&1; then
    BOOT_UNIT_REASON="systemctl is not available: the boot unit $SYSTEMD_UNIT_NAME cannot be verified; install it from scripts/myrmidon/deploy/paperclip.service.template or set SYSTEMD_UNIT_INSTALL=1 on a host with systemd"
    return 1
  fi
  if [[ ! -f "$unit" ]]; then
    if [[ "$SYSTEMD_UNIT_INSTALL" == "1" ]]; then
      # A dry run proves the same thing the real run would do and changes nothing.
      if [[ "$DRY_RUN" == "1" ]]; then
        BOOT_UNIT_NOTE="the boot unit $unit does not exist; this deploy installs it (SYSTEMD_UNIT_INSTALL=1)"
      else
        install_boot_unit || return 1
      fi
    else
      BOOT_UNIT_REASON="the boot unit $unit does not exist; install it (SYSTEMD_UNIT_INSTALL=1 or copy scripts/myrmidon/deploy/paperclip.service.template) so the board starts from the compose files this deploy manages"
      return 1
    fi
  else
    expected="$(render_boot_unit)"
    current="$(cat "$unit")"
    if [[ "$current" != "$expected" ]]; then
      # The unit of the releases before the component overrides joined the boot
      # path is a known predecessor, not a foreign unit: with SYSTEMD_UNIT_INSTALL=1
      # it is replaced by the canonical one (and only it).
      if [[ "$SYSTEMD_UNIT_INSTALL" == "1" && "$current" == "$(render_boot_unit legacy)" ]]; then
        if [[ "$DRY_RUN" == "1" ]]; then
          BOOT_UNIT_NOTE="the boot unit $unit is the previous canonical unit (no component override files); this deploy updates it (SYSTEMD_UNIT_INSTALL=1)"
        else
          upgrade_boot_unit "$unit" || return 1
        fi
      else
        BOOT_UNIT_REASON="the boot unit $unit does not match the canonical unit for COMPOSE_DIR=$COMPOSE_DIR (COMPOSE_FILES=$COMPOSE_FILES + $COMPOSE_OVERRIDE_FILE + the override files of the local release components): it may start the board from other compose files, as on 01.10. Fix: SYSTEMD_UNIT_INSTALL=1 on the unit host (replaces only the previous canonical unit), or make the unit match scripts/myrmidon/deploy/paperclip.service.template. The deploy is refused while the unit differs (nothing was changed)"
        return 1
      fi
    fi
  fi
  BOOT_UNIT_OK=1
  return 0
}

# Replaces the previous canonical unit by the current one, keeping owner and
# mode of the file, and reloads systemd.
upgrade_boot_unit() {
  local unit="$1" tmp
  tmp="$(mktemp "$(dirname "$unit")/.paperclip.XXXXXX")" || { BOOT_UNIT_REASON="cannot write to $(dirname "$unit")"; return 1; }
  render_boot_unit >"$tmp"
  if ! install_preserving "$tmp" "$unit"; then
    rm -f "$tmp"
    BOOT_UNIT_REASON="cannot replace the unit at $unit (need root to update the boot unit $SYSTEMD_UNIT_NAME)"
    return 1
  fi
  if command -v systemctl >/dev/null 2>&1; then
    run systemctl daemon-reload || log "WARNING: systemctl daemon-reload failed; run it by hand"
  fi
  log "boot unit updated: $unit (the override files of the local release components joined the compose file list)"
  return 0
}

# Installs the canonical unit (needs write access to SYSTEMD_UNIT_DIR, i.e.
# root on a real host) and reloads systemd. Existing foreign unit: refusal.
install_boot_unit() {
  local unit
  unit="$(boot_unit_path)"
  if [[ -f "$unit" ]]; then
    BOOT_UNIT_REASON="refusing to overwrite the existing unit $unit with the canonical one automatically: a foreign unit is exactly the 01.10 incident; remove or fix it by hand, then deploy"
    return 1
  fi
  if ! mkdir -p "$SYSTEMD_UNIT_DIR" 2>/dev/null; then
    BOOT_UNIT_REASON="cannot create $SYSTEMD_UNIT_DIR (need root to install the boot unit $SYSTEMD_UNIT_NAME); install it by hand from scripts/myrmidon/deploy/paperclip.service.template"
    return 1
  fi
  local tmp
  tmp="$(mktemp "$SYSTEMD_UNIT_DIR/.paperclip.XXXXXX")" || { BOOT_UNIT_REASON="cannot write to $SYSTEMD_UNIT_DIR"; return 1; }
  render_boot_unit >"$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$unit" || { rm -f "$tmp"; BOOT_UNIT_REASON="cannot install the unit at $unit"; return 1; }
  if command -v systemctl >/dev/null 2>&1; then
    run systemctl daemon-reload || log "WARNING: systemctl daemon-reload failed; run it by hand"
    run systemctl enable "$SYSTEMD_UNIT_NAME" >/dev/null 2>&1 || log "WARNING: could not enable $SYSTEMD_UNIT_NAME; run: systemctl enable $SYSTEMD_UNIT_NAME"
  fi
  log "boot unit installed: $unit (from paperclip.service.template; After=docker.service, reads the compose files of this deploy)"
  return 0
}

# Loads the settings file (see deploy.env.example) and applies defaults.
load_config() {
  local file="$1"
  [[ -n "$file" ]] || die "--config <file> is required (see scripts/myrmidon/deploy/deploy.env.example)"
  [[ -f "$file" ]] || die "config file not found: $file"
  # shellcheck disable=SC1090
  source "$file"
  : "${MYRMIDON_IMAGE:=ghcr.io/itkadr-git/myrmidon}"
  : "${COMPOSE_DIR:?COMPOSE_DIR is required}"
  : "${COMPOSE_SERVICE:?COMPOSE_SERVICE is required}"
  : "${COMPOSE_FILES:=docker-compose.yml}"
  : "${COMPOSE_OVERRIDE_FILE:=docker-compose.myrmidon-image.yml}"
  # myrmidon(COMPOSE-SET-ANCHOR): the declared compose set of the board is
  # kept in a machine-readable anchor block (one fragment per line between
  # board-mount-set:begin/end markers); a watchdog compares it with the live
  # container label. Empty settings disable the sync step below.
  : "${MYRMIDON_COMPOSE_SET_ANCHOR_FILE:=}"
  : "${MYRMIDON_COMPOSE_SET_ANCHOR_GIT:=}"
  : "${MYRMIDON_COMPOSE_SET_LABEL_SOURCE:=}"
  : "${HEALTH_URL:?HEALTH_URL is required}"
  : "${HEALTH_TIMEOUT_SEC:=300}"
  : "${HEALTH_TOKEN_FILE:=}"
  : "${STATE_DIR:=$COMPOSE_DIR/.myrmidon-deploy}"
  : "${DUMP_DIR:=$STATE_DIR/dumps}"
  : "${DUMP_COMMAND:=}"
  : "${DUMP_MIN_BYTES:=1}"
  : "${RESTORE_COMMAND:=}"
  : "${MAINTENANCE_MODE:=pause}"
  : "${MAINTENANCE_API_URL:=}"
  : "${MAINTENANCE_TOKEN_FILE:=$HEALTH_TOKEN_FILE}"
  # myrmidon(DRAIN-INTERRUPT): a planned deploy must not wait for long runs. In
  # `interrupt_and_retry` (the default) the window drains for the short grace
  # below and then interrupts whatever is still running; the interrupted runs
  # are retried when the window closes. `wait` keeps the old behaviour: admission
  # stays closed and the drain waits for the long timeout instead.
  : "${MAINTENANCE_ON_TIMEOUT:=interrupt_and_retry}"
  : "${MAINTENANCE_DRAIN_GRACE_SEC:=300}"
  : "${MAINTENANCE_DRAIN_TIMEOUT_SEC:=1800}"
  : "${MAINTENANCE_ENTER_COMMAND:=}"
  : "${MAINTENANCE_EXIT_COMMAND:=}"
  : "${MAINTENANCE_PAUSE_SEC:=0}"
  : "${MAINTENANCE_EXIT_WAIT_SEC:=120}"
  : "${RUNNING_RUNS_COMMAND:=}"
  : "${RUNS_WAIT_TIMEOUT_SEC:=1800}"
  : "${ALLOW_UNKNOWN_RUNS:=0}"
  : "${POLL_INTERVAL_SEC:=5}"
  # PREDEPLOY-DB-CHECK (the 05.10 incident): before the maintenance window the
  # new board image must come up on a COPY of the production database (the
  # predeploy dump) with the new dockergate, on its own network, and answer the
  # attention list and the main APIs. deploy.sh calls
  # predeploy-board-check.sh; the settings below are its inputs. The check
  # refuses (nothing changed) when it is enabled and its inputs are missing:
  # silently deploying an image nothing proved is the incident.
  : "${MYRMIDON_PREDEPLOY_CHECK:=1}"
  : "${MYRMIDON_PREDEPLOY_POSTGRES_IMAGE:=}"
  : "${MYRMIDON_PREDEPLOY_DB_NAME:=myrmidon}"
  : "${MYRMIDON_PREDEPLOY_DB_USER:=myrmidon}"
  : "${MYRMIDON_PREDEPLOY_DB_READY_COMMAND:=}"
  : "${MYRMIDON_PREDEPLOY_RESTORE_COMMAND:=}"
  : "${MYRMIDON_PREDEPLOY_BOARD_ENV_FILE:=}"
  : "${MYRMIDON_PREDEPLOY_DOCKERGATE_ENV_FILE:=}"
  : "${MYRMIDON_PREDEPLOY_BOARD_ARGS:=}"
  : "${MYRMIDON_PREDEPLOY_DOCKERGATE_ARGS:=}"
  : "${MYRMIDON_PREDEPLOY_BOARD_PORT:=13110}"
  : "${MYRMIDON_PREDEPLOY_NETWORK:=}"
  : "${MYRMIDON_PREDEPLOY_HEALTH_TIMEOUT_SEC:=$HEALTH_TIMEOUT_SEC}"
  : "${MYRMIDON_PREDEPLOY_API_PATHS:=}"
  : "${MYRMIDON_PREDEPLOY_TOKEN_FILE:=}"
  : "${MYRMIDON_PREDEPLOY_KEEP:=0}"
  # DEPLOY-HYGIENE (OPE-5107): the deploy must not fill the disk it deploys
  # from. Before the first pull the free space of the filesystem that holds
  # /var/lib/docker is checked (deploy_disk_precheck); after a successful
  # deploy the component images older than MYRMIDON_DEPLOY_IMAGE_KEEP previous
  # releases are removed (deploy_image_retention; the running and the
  # just-deployed images are always kept).
  : "${MYRMIDON_DEPLOY_MIN_FREE_GB:=15}"
  : "${MYRMIDON_DEPLOY_IMAGE_KEEP:=1}"
  : "${MYRMIDON_DEPLOY_IMAGE_REPOS:=$MYRMIDON_IMAGE,ghcr.io/itkadr-git/myrmidon-dockergate,ghcr.io/itkadr-git/myrmidon-fleetd,ghcr.io/itkadr-git/myrmidon-hermes,ghcr.io/itkadr-git/myrmidon-hermes-dev,ghcr.io/itkadr-git/myrmidon-hermes-node}"
  # DB-TUNING (OPE-5009): the PostgreSQL settings from the database audit
  # (OPE-4270) are applied DECLARATIVELY by the deploy — the values live in
  # scripts/myrmidon/deploy/db-tuning.sql, the reset in db-tuning-rollback.sql,
  # and deploy.sh/rollback.sh are the only things that run them (never a
  # manual ALTER SYSTEM on the server). All four settings are optional: an
  # empty one skips its step. Read by deploy.sh/rollback.sh, not by the server.
  : "${DB_TUNE_COMMAND:=}"
  : "${DB_TUNE_SHOW_COMMAND:=}"
  : "${DB_TUNE_EXPECTED:=}"
  : "${DB_TUNE_ROLLBACK_COMMAND:=}"
  : "${SYSTEMD_UNIT_NAME:=paperclip.service}"
  : "${SYSTEMD_UNIT_DIR:=/etc/systemd/system}"
  : "${SYSTEMD_UNIT_INSTALL:=}"
  case "$MAINTENANCE_MODE" in
    api|hook|pause) ;;
    *) die "MAINTENANCE_MODE must be api, hook or pause (got $MAINTENANCE_MODE)" ;;
  esac
  # myrmidon(DRAIN-INTERRUPT): reject a typo instead of silently keeping the
  # default interrupt mode (or silently switching a wait operator to interrupt).
  case "$MAINTENANCE_ON_TIMEOUT" in
    wait|interrupt_and_retry) ;;
    *) die "MAINTENANCE_ON_TIMEOUT must be wait or interrupt_and_retry (got $MAINTENANCE_ON_TIMEOUT)" ;;
  esac
  if [[ "$MAINTENANCE_MODE" == "api" && -z "$MAINTENANCE_API_URL" ]]; then
    die "MAINTENANCE_MODE=api needs MAINTENANCE_API_URL"
  fi
  OVERRIDE_PATH="$COMPOSE_DIR/$COMPOSE_OVERRIDE_FILE"
  PREVIOUS_FILE="$STATE_DIR/previous-digest"
  PREVIOUS_IMAGE_FILE="$STATE_DIR/previous-image"
  HISTORY_FILE="$STATE_DIR/history.log"
}

compose() {
  local args=(compose --project-directory "$COMPOSE_DIR")
  local f
  IFS=':' read -r -a _files <<<"$COMPOSE_FILES"
  for f in "${_files[@]}"; do args+=(-f "$COMPOSE_DIR/$f"); done
  args+=(-f "$OVERRIDE_PATH")
  # RELEASE-GATE: the component override files (dockergate, fleetd) ride along
  # when they exist, so one `docker compose` call sees the whole release stack.
  local -a _component_files=()
  mapfile -t _component_files < <(component_override_paths)
  for f in "${_component_files[@]}"; do
    [[ -n "$f" && -f "$f" ]] && args+=(-f "$f")
  done
  docker "${args[@]}" "$@"
}

# The override files of the release components that live on this host
# (MYRMIDON_RELEASE_COMPONENTS, default dockergate,fleetd; a component with
# MYR_<COMPONENT>_HOST other than local is not part of this host's compose
# stack). One per line, in the order the boot unit lists them.
component_override_paths() {
  local c up ov_var host_var
  for c in $(tr ',' ' ' <<<"${MYRMIDON_RELEASE_COMPONENTS:-dockergate,fleetd}"); do
    [[ -n "$c" && "$c" != "none" ]] || continue
    up="$(printf '%s' "$c" | tr '[:lower:]' '[:upper:]')"
    ov_var="MYR_${up}_OVERRIDE_FILE"
    host_var="MYR_${up}_HOST"
    [[ "${!host_var:-local}" == "local" ]] || continue
    printf '%s\n' "$COMPOSE_DIR/${!ov_var:-docker-compose.myrmidon-$c.yml}"
  done
}

# Digest currently pinned in the override file, or empty.
current_digest() {
  [[ -f "$OVERRIDE_PATH" ]] || return 0
  grep -Eo '@sha256:[0-9a-f]{64}' "$OVERRIDE_PATH" | head -n1 | cut -c2- || true
}

# Full image reference currently in the override file (any repository, tag or
# digest), or empty. myrmidon(R4): lets the first deploy remember a vendor image.
current_image() {
  [[ -f "$OVERRIDE_PATH" ]] || return 0
  sed -nE 's/^[[:space:]]*image:[[:space:]]*([^[:space:]#]+).*/\1/p' "$OVERRIDE_PATH" | head -n1
}

# Image of the board container that exists now (running, restarting or exited),
# as it was created: `docker inspect`, found by the labels compose puts on it
# (works even when the compose files do not validate). Empty when there is none.
board_running_image() {
  local id
  id="$(docker ps -a -q \
    --filter "label=com.docker.compose.service=$COMPOSE_SERVICE" \
    --filter "label=com.docker.compose.project.working_dir=$COMPOSE_DIR" 2>/dev/null | head -n1)" || id=""
  [[ -n "$id" ]] || return 0
  docker inspect --format '{{.Config.Image}}' "$id" 2>/dev/null | head -n1 || true
}

# The board image to go back to: the running container's image, the override
# file only when no container exists (same rule as for the components).
previous_board_image() {
  local running file
  running="$(board_running_image)"
  file="$(current_image)"
  if [[ -n "$running" ]]; then
    if [[ -n "$file" && "$file" != "$running" ]]; then
      log "WARNING: the override file ($OVERRIDE_PATH) names $file but the board container runs $running; the running image is the previous image"
    fi
    printf '%s\n' "$running"
  else
    printf '%s\n' "$file"
  fi
}

# Digest part (sha256:<64 hex>) of an image reference, or empty.
ref_digest() { grep -Eo '@sha256:[0-9a-f]{64}' <<<"$1" | head -n1 | cut -c2- || true; }

# Writes the override file: the only line that changes between deploys is `image:`.
write_override_ref() {
  local ref="$1" tmp
  tmp="$(mktemp "$OVERRIDE_PATH.XXXXXX")"
  {
    echo "# Managed by scripts/myrmidon/deploy. Only the image line changes."
    echo "services:"
    echo "  $COMPOSE_SERVICE:"
    echo "    image: $ref"
  } >"$tmp"
  install_preserving "$tmp" "$OVERRIDE_PATH" || { rm -f "$tmp"; die "cannot write $OVERRIDE_PATH"; }
}

write_override() { write_override_ref "$MYRMIDON_IMAGE@$1"; }

auth_header_args() {
  local file="$1"
  if [[ -n "$file" ]]; then
    [[ -r "$file" ]] || die "token file not readable: $file"
    printf '%s\n' "-H" "Authorization: Bearer $(tr -d '\r\n' <"$file")"
  fi
}

http_get() {
  local url="$1" token_file="${2:-}"
  local -a auth=()
  mapfile -t auth < <(auth_header_args "$token_file")
  curl -fsS --max-time 10 "${auth[@]}" "$url"
}

http_post_json() {
  local url="$1" body="$2" token_file="${3:-}"
  local -a auth=()
  mapfile -t auth < <(auth_header_args "$token_file")
  curl -fsS --max-time 30 -X POST -H 'Content-Type: application/json' "${auth[@]}" --data "$body" "$url"
}

# Version and commit the server reports are stored as image labels by the
# image workflow (org.opencontainers.image.version / .revision).
image_label() {
  local ref="$1" label="$2"
  docker image inspect --format "{{ index .Config.Labels \"$label\" }}" "$ref"
}

# --- local images (ROLLBACK-LOCAL) -------------------------------------------
# myrmidon(ROLLBACK-LOCAL): rollback support for images that only exist on the
# deploy host (pre-1.1.0 builds are not in the registry). Nothing here pulls:
# the checks read the local docker daemon only.

# Is the reference present on the local docker daemon? Prints nothing; rc 0/1.
local_image_exists() {
  docker image inspect "$1" >/dev/null 2>&1
}

# Local tags of one repository (e.g. ghcr.io/itkadr-git/myrmidon), newest
# first, without duplicates. May print nothing when there are none.
local_image_tags() {
  local repo="$1"
  docker image ls "$repo" --format '{{.Tag}}' 2>/dev/null | grep -v '^<none>$' || true
}

# Dies with a readable message listing what is actually on the host, so a typo
# in a tag does not turn into a bare "No such image". Succeeds (rc 0) when the
# reference is on the daemon.
require_local_image() {
  local ref="$1" repo tags
  if [[ "$ref" == *@sha256:* ]]; then
    repo="${ref%@*}"
  else
    repo="${ref%%:*}"
  fi
  if ! local_image_exists "$ref"; then
    if [[ "$ref" == *@sha256:* ]]; then
      die "image is not on the local docker daemon: $ref
Available local digests of $repo:
$(docker image ls "$repo" --format '{{.ID}}' 2>/dev/null | grep . | sort -u || true)
Rollback to an image that is on the host (docker image ls $repo), or drop --local to pull from the registry"
    fi
    tags="$(local_image_tags "$repo" | paste -sd, -)"
    die "image is not on the local docker daemon: $ref
Available local tags of $repo: ${tags:-<none>}
Rollback to a tag that is on the host (docker image ls $repo), or drop --local to pull from the registry"
  fi
}

# Enters the maintenance window. Returns 1 when the window was NOT entered (api:
# the enter POST did not answer; hook: MAINTENANCE_ENTER_COMMAND failed) so the
# caller can report it — a rollback continues without a window (a board that is
# down has no admission gate to close), a deploy decides for itself.
maintenance_enter() {
  local reason="$1"
  case "$MAINTENANCE_MODE" in
    api)
      # myrmidon(DRAIN-INTERRUPT): in interrupt mode the drain timeout is the
      # short grace after which the window interrupts what is still running; in
      # wait mode it stays the long timeout the window simply waits out.
      local drain_timeout="$MAINTENANCE_DRAIN_TIMEOUT_SEC"
      if [[ "$MAINTENANCE_ON_TIMEOUT" == "interrupt_and_retry" ]]; then
        drain_timeout="$MAINTENANCE_DRAIN_GRACE_SEC"
      fi
      local body
      body="$(jq -cn --arg reason "$reason" --argjson t "$drain_timeout" --arg o "$MAINTENANCE_ON_TIMEOUT" \
        '{action: "enter", scope: {type: "instance"}, reason: $reason, drainTimeoutSec: $t, onTimeout: $o}')"
      run http_post_json "$MAINTENANCE_API_URL" "$body" "$MAINTENANCE_TOKEN_FILE" >/dev/null \
        || { log "maintenance: the board API did not answer the enter POST ($MAINTENANCE_API_URL)"; return 1; }
      log "maintenance: entered (onTimeout=$MAINTENANCE_ON_TIMEOUT, drainTimeoutSec=$drain_timeout)"
      ;;
    hook)
      [[ -n "$MAINTENANCE_ENTER_COMMAND" ]] || die "MAINTENANCE_MODE=hook needs MAINTENANCE_ENTER_COMMAND"
      run env MYRMIDON_DEPLOY_REASON="$reason" bash -c "$MAINTENANCE_ENTER_COMMAND"
      ;;
    pause)
      log "maintenance: no maintenance API configured; pausing ${MAINTENANCE_PAUSE_SEC}s (MAINTENANCE_MODE=pause)"
      run sleep "$MAINTENANCE_PAUSE_SEC"
      ;;
  esac
}

maintenance_exit() {
  # myrmidon(EXIT-ASYNC): the exit POST returns as soon as the server marks the
  # window `leaving` (the server finishes the leave asynchronously on its
  # maintenance tick; admission already reopens in `leaving`). The deploy
  # therefore waits on the STATE, not on the HTTP call: poll GET /maintenance
  # until the instance window is gone (state `off`), bounded by
  # MAINTENANCE_EXIT_WAIT_SEC. Without this wait the script reported success
  # while the window was still `leaving`, and the next enter raced the previous
  # exit (409 "still leaving"). A wait timeout does not fail an already
  # switched and healthy deploy: the window is `leaving` (admission open) and
  # the tick retires it, so the timeout is logged loudly and the deploy moves
  # on. A failed POST still aborts (unchanged): the window would stay `on`.
  case "$MAINTENANCE_MODE" in
    api)
      run http_post_json "$MAINTENANCE_API_URL" '{"action":"exit","scope":{"type":"instance"}}' "$MAINTENANCE_TOKEN_FILE" >/dev/null || return 1
      wait_for_maintenance_off \
        || log "WARNING: the exit request was accepted, but the instance window did not retire within ${MAINTENANCE_EXIT_WAIT_SEC}s (MAINTENANCE_EXIT_WAIT_SEC); it stays 'leaving' (admission is open) and the maintenance tick retires it"
      ;;
    hook)
      [[ -n "$MAINTENANCE_EXIT_COMMAND" ]] || die "MAINTENANCE_MODE=hook needs MAINTENANCE_EXIT_COMMAND"
      run bash -c "$MAINTENANCE_EXIT_COMMAND"
      ;;
    pause) log "maintenance: nothing to exit (MAINTENANCE_MODE=pause)" ;;
  esac
}

# myrmidon(EXIT-ASYNC): poll the maintenance status until the instance window
# is retired (state `off`, or no instance window at all), or give up after
# MAINTENANCE_EXIT_WAIT_SEC (default 120). A missing state field means the
# board is not in maintenance — that is success, not something to wait for.
# Returns 1 on timeout so the caller can report it.
wait_for_maintenance_off() {
  local deadline=$((SECONDS + MAINTENANCE_EXIT_WAIT_SEC)) body state
  while :; do
    body="$(http_get "$MAINTENANCE_API_URL" "$MAINTENANCE_TOKEN_FILE" 2>/dev/null)" || body=""
    state="$(jq -r '.instance.state // "off"' <<<"$body" 2>/dev/null || echo off)"
    [[ "$state" == "off" ]] && return 0
    ((SECONDS < deadline)) || { log "maintenance: instance window still '$state' after ${MAINTENANCE_EXIT_WAIT_SEC}s (MAINTENANCE_EXIT_WAIT_SEC)"; return 1; }
    sleep "$POLL_INTERVAL_SEC"
  done
}

# myrmidon(POST-DEPLOY-CHECK): after the image switch, the health check and the
# maintenance exit, prove the deploy did not leave the fleet stalled.
# Read-only against the board API the deploy already talks to. Two facts:
#   1. No issue is `blocked` with an update inside the deploy window
#      (GET /companies/<id>/issues?status=blocked&updatedSince=<deploy start>).
#      A planned restart must not turn in-flight work into blocked; any hit is
#      the failure signature this step exists for.
#   2. The maintenance window retired (`off`): the admission gate that closed
#      during the drain is gone, so the vendor periodic resumeQueuedRuns
#      re-admits what queued up.
# BOARD_API_URL and BOARD_COMPANY_ID are optional: when unset, the check is
# skipped with a log line, so a standalone install without board credentials
# stays deployable. A configured but unreadable board is a degraded deploy, not
# a pass. Returns 1 (and logs "degraded:") when the deploy must be reported
# degraded; 0 on a clean check.
post_deploy_fleet_check() {
  local started_at="$1" rc=0
  if [[ -z "${BOARD_API_URL:-}" || -z "${BOARD_COMPANY_ID:-}" ]]; then
    log "post-deploy check: BOARD_API_URL/BOARD_COMPANY_ID not set; skipping the fleet check (set them in the deploy env to enable)"
    return 0
  fi
  local -a auth=()
  mapfile -t auth < <(auth_header_args "$MAINTENANCE_TOKEN_FILE")
  local body blocked
  body="$(curl -fsS --max-time 30 "${auth[@]}" \
    "$BOARD_API_URL/companies/$BOARD_COMPANY_ID/issues?status=blocked&updatedSince=$started_at&limit=100" 2>/dev/null)" || body=""
  if [[ -z "$body" ]]; then
    log "post-deploy check: board issue list unreadable (BOARD_API_URL=$BOARD_API_URL)"
    log "degraded: board issue list unreadable after deploy"
    return 1
  fi
  blocked="$(jq -r 'if type == "array" then length elif type == "object" and (.issues | type == "array") then (.issues | length) else "?" end' <<<"$body" 2>/dev/null || echo "?")"
  if [[ "$blocked" == "?" || -z "$blocked" ]]; then
    log "post-deploy check: unexpected board answer shape for blocked issues"
    log "degraded: board issue list unreadable after deploy"
    return 1
  fi
  if ((blocked > 0)); then
    log "post-deploy check: $blocked blocked issue(s) updated since the deploy started ($started_at) — inspect them before waking agents by hand"
    log "degraded: $blocked blocked issue(s) in the deploy window"
    rc=1
  fi
  local mstate mbody
  mbody="$(http_get "$MAINTENANCE_API_URL" "$MAINTENANCE_TOKEN_FILE" 2>/dev/null)" || mbody=""
  mstate="$(jq -r '.instance.state // "off"' <<<"$mbody" 2>/dev/null || echo off)"
  if [[ "$mstate" != "off" ]]; then
    log "post-deploy check: maintenance window still '$mstate' after exit"
    log "degraded: maintenance window did not retire after exit"
    rc=1
  fi
  if ((rc == 0)); then
    log "post-deploy check: no blocked issues in the deploy window, maintenance retired"
  fi
  return "$rc"
}

# Prints the number of running agent runs, or nothing when unknown.
running_runs() {
  if [[ -n "$RUNNING_RUNS_COMMAND" ]]; then
    bash -c "$RUNNING_RUNS_COMMAND"
  elif [[ "$MAINTENANCE_MODE" == "api" ]]; then
    http_get "$MAINTENANCE_API_URL" "$MAINTENANCE_TOKEN_FILE" | jq -r '.instance.runningRuns // empty'
  fi
}

wait_for_idle_runs() {
  # myrmidon(DEPLOY-TIMEOUT-EXIT): returns 1 instead of dying, so the caller
  # (deploy.sh) can lift maintenance before it aborts. Dying here would strand
  # the board in maintenance mode, because maintenance_enter already ran.
  local deadline=$((SECONDS + RUNS_WAIT_TIMEOUT_SEC)) count rc
  while :; do
    # myrmidon(R4): a broken counter must not let the image switch cut live runs.
    rc=0
    count="$(running_runs)" || rc=$?
    count="$(tr -d '[:space:]' <<<"$count")"
    if ((rc != 0)) || [[ -z "$count" ]]; then
      if [[ "$ALLOW_UNKNOWN_RUNS" == "1" ]]; then
        log "runs: cannot count running runs (exit $rc); ALLOW_UNKNOWN_RUNS=1, not waiting"
        return 0
      fi
      log "ERROR: runs: cannot count running runs (exit $rc, output '${count}'); fix RUNNING_RUNS_COMMAND / MAINTENANCE_MODE=api or set ALLOW_UNKNOWN_RUNS=1; image not changed"
      return 1
    fi
    [[ "$count" =~ ^[0-9]+$ ]] || { log "ERROR: running runs count is not a number: $count"; return 1; }
    if ((count == 0)); then
      log "runs: no runs in progress"
      return 0
    fi
    ((SECONDS < deadline)) || { log "ERROR: runs: $count run(s) still in progress after ${RUNS_WAIT_TIMEOUT_SEC}s; deploy aborted before changing the image"; return 1; }
    log "runs: waiting for $count run(s) to finish"
    sleep "$POLL_INTERVAL_SEC"
  done
}

# Takes the pre-deploy dump and refuses to continue when it is missing or empty.
take_dump() {
  local label="$1"
  [[ -n "$DUMP_COMMAND" ]] || die "DUMP_COMMAND is not set; refusing to deploy without a database dump"
  mkdir -p "$DUMP_DIR"
  local file
  file="$DUMP_DIR/myrmidon-$(date -u +%Y%m%dT%H%M%SZ)-$label.dump"
  log "dump: $file"
  DUMP_FILE="$file" bash -c "$DUMP_COMMAND" || die "dump command failed; image not changed"
  [[ -f "$file" ]] || die "dump command did not create $file; image not changed"
  local size
  size="$(wc -c <"$file" | tr -d ' ')"
  if ((size < DUMP_MIN_BYTES)); then
    die "dump $file is empty or too small ($size bytes < $DUMP_MIN_BYTES); image not changed"
  fi
  log "dump: ok ($size bytes)"
  LAST_DUMP_FILE="$file"
}

record_history() {
  mkdir -p "$STATE_DIR"
  printf '%s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" >>"$HISTORY_FILE"
}

# --- COMPOSE-SET-ANCHOR (the 07.10 drift) -------------------------------------
# myrmidon(COMPOSE-SET-ANCHOR): a release deploy can itself change the set of
# compose files the board runs from (COMPOSE_FILES, the board image override
# and the component override files written by this deploy). Installations keep
# the declared set in a machine-readable anchor block — a file that lists one
# compose fragment per line between `board-mount-set:begin`/`board-mount-set:end`
# markers — and a watchdog compares that list against the live container's
# com.docker.compose.project.config_files label. When the deploy changes the
# set and the anchor is not updated in the same deploy, the watchdog drifts on
# the next run and an operator has to register the change by hand after the
# fact (the 07.10 incident).
#
# sync_compose_set_anchor() closes that gap: after the board container was
# (re)created it reads the LIVE label of the container this deploy manages,
# compares it (by basename, the way the watchdog compares) with the fragment
# list in the anchor block, and when they differ rewrites the block and commits
# the anchor file with one commit whose message names the deploy reference.
#
# Settings (all optional, see deploy.env.example; empty = the step is skipped
# with a log line, so an installation without an anchor still deploys):
#   MYRMIDON_COMPOSE_SET_ANCHOR_FILE  the file carrying the begin/end block
#   MYRMIDON_COMPOSE_SET_ANCHOR_GIT   the git repository of that file
#                                     (the commit lands there; may equal
#                                     ANCHOR_FILE's parent repo)
#   MYRMIDON_COMPOSE_SET_LABEL_SOURCE an optional shell command that prints
#                                     the live config_files label (overrides
#                                     the docker inspect of the local daemon,
#                                     so the step is testable on a stand)
#
# The function never fails the deploy: a healthy board outranks a drifted
# anchor, and the watchdog still catches the residue on its next run (the
# anchor block's format and the watchdog itself are not touched here).
# Returns 0 always; the outcome is logged and, when something was rewritten,
# ANCHOR_SYNC_COMMIT holds the commit sha.
sync_compose_set_anchor() {
  ANCHOR_SYNC_COMMIT=""
  ANCHOR_SYNC_ACTION="skipped"
  if [[ -z "$MYRMIDON_COMPOSE_SET_ANCHOR_FILE" ]]; then
    log "COMPOSE-SET-ANCHOR: skipped (MYRMIDON_COMPOSE_SET_ANCHOR_FILE is empty; the declared compose set is not managed by this deploy)"
    return 0
  fi
  local anchor_file="$MYRMIDON_COMPOSE_SET_ANCHOR_FILE"
  if [[ ! -f "$anchor_file" ]]; then
    log "WARNING: COMPOSE-SET-ANCHOR: the anchor file does not exist: $anchor_file (nothing was rewritten; check the setting)"
    return 0
  fi
  local label_raw
  if [[ -n "$MYRMIDON_COMPOSE_SET_LABEL_SOURCE" ]]; then
    label_raw="$(bash -c "$MYRMIDON_COMPOSE_SET_LABEL_SOURCE" 2>/dev/null || true)"
  else
    # The board container this deploy manages, by the labels compose puts on it
    # (the same lookup board_running_image() uses; works even when the compose
    # files do not validate).
    local board_id
    board_id="$(docker ps -a -q \
      --filter "label=com.docker.compose.service=$COMPOSE_SERVICE" \
      --filter "label=com.docker.compose.project.working_dir=$COMPOSE_DIR" 2>/dev/null | head -n1)" || board_id=""
    if [[ -z "$board_id" ]]; then
      log "WARNING: COMPOSE-SET-ANCHOR: no container of service $COMPOSE_SERVICE in project $COMPOSE_DIR (the container may not exist yet); the anchor was not re-checked"
      return 0
    fi
    label_raw="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$board_id" 2>/dev/null || true)"
  fi
  if [[ -z "$label_raw" ]]; then
    log "WARNING: COMPOSE-SET-ANCHOR: no live config_files label on the board container; the anchor was not re-checked"
    return 0
  fi
  # Compare by basename, the way the watchdog does: the anchor names fragments
  # relative to a project directory, the label carries absolute paths.
  local label_basenames anchor_basenames
  label_basenames="$(printf '%s\n' "$label_raw" | tr ',' '\n' | sed 's#.*/##; s/^[[:space:]]*//; s/[[:space:]]*$//' | sed '/^$/d' | sort -u)"
  anchor_basenames="$(sed -n '/board-mount-set:begin/,/board-mount-set:end/p' "$anchor_file" | grep -oE '^[[:space:]]*[A-Za-z0-9._/-]+\.ya?ml[[:space:]]*$' | sed 's#^.*/##; s/^[[:space:]]*//; s/[[:space:]]*$//' | sort -u)"
  if [[ -z "$anchor_basenames" ]]; then
    log "WARNING: COMPOSE-SET-ANCHOR: no readable board-mount-set block in $anchor_file (the block format is the watchdog's contract and is not created here); the anchor was not re-checked"
    return 0
  fi
  if [[ "$anchor_basenames" == "$label_basenames" ]]; then
    ANCHOR_SYNC_ACTION="match"
    log "COMPOSE-SET-ANCHOR: the anchor matches the live set ($(printf '%s' "$label_basenames" | grep -c . || true) fragments)"
    return 0
  fi
  # Diverged: rewrite the block from the live label, keeping one fragment per
  # line between the markers exactly as the format expects. The live label
  # carries absolute paths; the block keeps them verbatim (the watchdog's
  # parser accepts paths, and the project directory is the label's own).
  local tmp printed=0 anchor_dir in_block=0
  anchor_dir="$(dirname "$anchor_file")"
  tmp="$(mktemp "$anchor_file.XXXXXX")"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == *board-mount-set:begin* ]]; then
      printf '%s\n' "$line" >>"$tmp"
      # Write fragments relative to the anchor file's own directory when they
      # live under it (the anchor's own style, and the watchdog resolves
      # relative names against its project dir); absolute otherwise. The
      # watchdog's parser accepts both shapes.
      printf '%s\n' "$label_raw" | tr ',' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | sed '/^$/d' \
        | while IFS= read -r frag; do
            case "$frag" in
              "$anchor_dir"/*) printf '%s\n' "${frag#"$anchor_dir"/}" ;;
              *) printf '%s\n' "$frag" ;;
            esac
          done >>"$tmp"
      printed=1
      in_block=1
      continue
    fi
    if [[ "$in_block" == "1" ]]; then
      # the old fragment lines of the block are dropped; the end marker closes it
      if [[ "$line" == *board-mount-set:end* ]]; then
        printf '%s\n' "$line" >>"$tmp"
        in_block=0
      fi
      continue
    fi
    printf '%s\n' "$line" >>"$tmp"
  done <"$anchor_file"
  if [[ "$printed" != "1" ]]; then
    rm -f "$tmp"
    log "WARNING: COMPOSE-SET-ANCHOR: no board-mount-set:begin marker in $anchor_file; nothing was rewritten"
    return 0
  fi
  # Replace atomically, keep owner and mode (a config write rule).
  local mode owner
  mode="$(stat -c '%a' "$anchor_file" 2>/dev/null || printf '644')"
  owner="$(stat -c '%u:%g' "$anchor_file" 2>/dev/null || printf '')"
  mv -f "$tmp" "$anchor_file"
  chmod "$mode" "$anchor_file"
  [[ -n "$owner" ]] && chown "$owner" "$anchor_file" 2>/dev/null || true
  ANCHOR_SYNC_ACTION="rewritten"
  log "COMPOSE-SET-ANCHOR: the live set differs from the anchor; the block was rewritten from the live label:"
  log "  anchor had: $(printf '%s' "$anchor_basenames" | tr '\n' ' ')"
  log "  live label: $(printf '%s' "$label_basenames" | tr '\n' ' ')"
  # One commit naming the deploy, when the anchor lives in a git repository.
  if command -v git >/dev/null 2>&1 && [[ -n "$MYRMIDON_COMPOSE_SET_ANCHOR_GIT" && -d "$MYRMIDON_COMPOSE_SET_ANCHOR_GIT/.git" ]]; then
    local rel msg
    rel="$(realpath --relative-to="$MYRMIDON_COMPOSE_SET_ANCHOR_GIT" "$anchor_file" 2>/dev/null || printf '%s' "$anchor_file")"
    msg="chore(deploy): sync board-mount-set anchor to the live compose set (deploy $MYRMIDON_IMAGE@${digest:-<unknown>})"
    if git -C "$MYRMIDON_COMPOSE_SET_ANCHOR_GIT" add -- "$rel" >/dev/null 2>&1 \
      && ANCHOR_SYNC_COMMIT="$(git -C "$MYRMIDON_COMPOSE_SET_ANCHOR_GIT" commit -m "$msg" -- "$rel" 2>/dev/null \
        && git -C "$MYRMIDON_COMPOSE_SET_ANCHOR_GIT" rev-parse --short HEAD 2>/dev/null)"; then
      log "COMPOSE-SET-ANCHOR: committed $rel as $ANCHOR_SYNC_COMMIT in $MYRMIDON_COMPOSE_SET_ANCHOR_GIT"
    else
      ANCHOR_SYNC_COMMIT=""
      log "WARNING: COMPOSE-SET-ANCHOR: the git commit of $rel failed (the file is rewritten; commit it by hand)"
    fi
  else
    log "WARNING: COMPOSE-SET-ANCHOR: MYRMIDON_COMPOSE_SET_ANCHOR_GIT is not a git repository; the file is rewritten, commit it by hand"
  fi
  return 0
}

# --- DB-TUNING (OPE-5009): the PostgreSQL settings of the audit, declaratively
# The settings from the database audit (OPE-4270: jit, work_mem, wal_compression,
# autovacuum scale factors) are applied by the DEPLOY from a source that lives in
# this repository (scripts/myrmidon/deploy/db-tuning.sql, reset:
# db-tuning-rollback.sql) — never by a manual ALTER SYSTEM on the server. Four
# optional settings (see deploy.env.example; empty skips its step):
#   DB_TUNE_COMMAND          shell command applying the settings (runs the SQL)
#   DB_TUNE_SHOW_COMMAND     shell command that must print the SHOW value of
#                            the parameter named in DB_TUNE_PARAM (exported)
#   DB_TUNE_EXPECTED         `name=value` pairs, one per line; deploy compares
#                            each SHOW against the expected value; rollback
#                            compares them against PREVIOUS values it recorded
#   DB_TUNE_ROLLBACK_COMMAND shell command returning to the previous settings
# db_tune_apply: runs DB_TUNE_COMMAND (the apply step); an empty command logs
# the skip and returns 0 — an installation that does not manage its settings
# still deploys.
# db_tune_rollback: runs DB_TUNE_ROLLBACK_COMMAND (returns to the previous
# settings); an empty command logs a WARNING and skips.
# db_tune_verify <label>: checks every DB_TUNE_EXPECTED pair through
# DB_TUNE_SHOW_COMMAND; 1 on the first mismatch (the caller decides what a
# failure costs). With DB_TUNE_EXPECTED or DB_TUNE_SHOW_COMMAND empty the
# verification is skipped with a log line, like every other empty setting.
# The two declarative SQL files are exported to the commands as
# DB_TUNING_SQL / DB_TUNING_ROLLBACK_SQL (paths inside this repository), so a
# config never has to hard-code where the scripts live.
# db_tune_record_previous: captures the current SHOW of every DB_TUNE_EXPECTED
# parameter into $STATE_DIR/db-tuning-previous BEFORE the settings are applied,
# so a later rollback.sh checks against what the server actually had. It runs
# once per parameter: a value already recorded (the first managed deploy) is
# the true pre-tuning value and re-reading it later would record the tuned one.
db_tune_apply() {
  if [[ -z "$DB_TUNE_COMMAND" ]]; then
    log "DB-TUNING: apply skipped (DB_TUNE_COMMAND is empty; the PostgreSQL settings of the audit are not managed by this deploy)"
    return 0
  fi
  log "DB-TUNING: applying the settings from $MYR_SCRIPT_DIR/db-tuning.sql"
  DB_TUNING_SQL="$MYR_SCRIPT_DIR/db-tuning.sql" DB_TUNING_ROLLBACK_SQL="$MYR_SCRIPT_DIR/db-tuning-rollback.sql" \
    bash -c "$DB_TUNE_COMMAND"
}

db_tune_rollback() {
  if [[ -z "$DB_TUNE_ROLLBACK_COMMAND" ]]; then
    log "WARNING: DB-TUNING: rollback skipped (DB_TUNE_ROLLBACK_COMMAND is empty): the database keeps the settings the deploy applied"
    return 0
  fi
  log "DB-TUNING: rolling the settings back from $MYR_SCRIPT_DIR/db-tuning-rollback.sql"
  DB_TUNING_SQL="$MYR_SCRIPT_DIR/db-tuning.sql" DB_TUNING_ROLLBACK_SQL="$MYR_SCRIPT_DIR/db-tuning-rollback.sql" \
    bash -c "$DB_TUNE_ROLLBACK_COMMAND"
}

# The rollback SHOW expectations: DB_TUNE_EXPECTED pairs rewritten against the
# previous values recorded before the last apply ($STATE_DIR/db-tuning-previous),
# for every parameter recorded there; a parameter with no recorded previous
# value keeps its new expectation (nothing was known to reset it).
db_tune_previous_expected() {
  local file="$STATE_DIR/db-tuning-previous"
  [[ -f "$file" ]] || { printf '%s\n' "$DB_TUNE_EXPECTED"; return; }
  local line name prev
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    name="${line%%=*}"
    prev="$(sed -n "s/^$name=//p" "$file" | tail -n1)"
    if [[ -n "$prev" ]]; then
      printf '%s=%s\n' "$name" "$prev"
    else
      printf '%s\n' "$line"
    fi
  done <<<"$DB_TUNE_EXPECTED"
}

db_tune_record_previous() {
  [[ -n "$DB_TUNE_COMMAND" && -n "$DB_TUNE_SHOW_COMMAND" && -n "$DB_TUNE_EXPECTED" ]] || return 0
  local line name prev prev_file content_changed=0
  prev_file="$STATE_DIR/db-tuning-previous"
  mkdir -p "$STATE_DIR"
  [[ -f "$prev_file" ]] || : >"$prev_file"
  while IFS= read -r line; do
    [[ "$line" == *=* ]] || continue
    name="${line%%=*}"
    # A value already recorded (first managed deploy) stays: it is the true
    # pre-tuning value; reading SHOW again after a tuned deploy would record
    # the tuned one as "previous".
    grep -q "^$name=" "$prev_file" && continue
    prev="$(DB_TUNE_PARAM="$name" bash -c "$DB_TUNE_SHOW_COMMAND" 2>/dev/null | tr -d '\r' | tail -n1 || true)"
    if [[ -n "$prev" ]]; then
      printf '%s=%s\n' "$name" "$prev" >>"$prev_file"
      content_changed=1
    fi
  done <<<"$DB_TUNE_EXPECTED"
  if ((content_changed)); then
    log "DB-TUNING: previous values recorded to $prev_file"
  fi
}

db_tune_verify() {
  local label="$1"
  local expected="${2-$DB_TUNE_EXPECTED}"
  if [[ -z "$expected" ]]; then
    log "DB-TUNING: SHOW verification skipped (no expectations given)"
    return 0
  fi
  if [[ -z "$DB_TUNE_SHOW_COMMAND" ]]; then
    log "DB-TUNING: SHOW verification skipped (DB_TUNE_SHOW_COMMAND is empty): the settings were applied but not verified"
    return 0
  fi
  local line name want got rc=0
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    [[ "$line" == *=* ]] || { log "DB-TUNING: bad expected-settings line '$line' (expected name=value)"; return 1; }
    name="${line%%=*}"
    want="${line#*=}"
    got="$(DB_TUNE_PARAM="$name" bash -c "$DB_TUNE_SHOW_COMMAND" 2>/dev/null | tr -d '\r' | tail -n1 || true)"
    if [[ "$got" == "$want" ]]; then
      log "DB-TUNING: $label $name = $got (as expected)"
    else
      log "DB-TUNING: $label $name = '${got:-<empty>}', expected '$want' — MISMATCH"
      rc=1
    fi
  done <<<"$expected"
  return $rc
}

# --- TRACING-HEALTH: one source of truth for the tracing callbacks -----------
# Langfuse v4 in the default `events_only` write mode rejects legacy trace and
# observation events on `/api/public/ingestion`. LiteLLM keeps sending them for
# as long as the legacy `langfuse` callback is enabled: the 02.10 incident was
# about 12k "Bad request" responses per hour, burned gateway CPU, and nobody
# noticed because nothing checked tracing. Tracing therefore runs over OTLP
# only, and the callback list has ONE source of truth: the function below.
# The generated file, the gateway config the bundle renders and the check all
# read that function, so a hand-written second list cannot drift away from it.
#
# Deploy settings (all optional; without them the check logs that it is
# skipped, so an installation without a tracing gateway still deploys):
#   MYRMIDON_TRACING_LANGFUSE_URL       base URL of the Langfuse server
#   MYRMIDON_TRACING_LANGFUSE_VERSION   version pinned in the bundle; the
#                                       fallback when the probe cannot answer
#   MYRMIDON_TRACING_GATEWAY_CONFIG     deployed LiteLLM config file
#   MYRMIDON_TRACING_CALLBACKS_COMMAND  command printing the effective callbacks
#   MYRMIDON_TRACING_CALLBACKS_FILE     generated file with the intended list
#   MYRMIDON_TRACING_TOKEN_FILE         token file for a guarded health route

# The only callback list the bundle installs. OpenTelemetry reaches Langfuse
# through the OTLP endpoint on v3 and v4; the legacy `langfuse` callback posts
# to `/api/public/ingestion`, which v4 rejects. One place, nothing else writes
# a second list.
tracing_intended_callbacks() {
  printf '%s\n' "langfuse_otel"
}

# Default location of the generated intended list (a file, so the check reads
# the same bytes the installer wrote).
tracing_callbacks_file_default() {
  printf '%s\n' "${STATE_DIR:-.}/tracing-callbacks.txt"
}

# Generates the intended callback list from the function above (one callback
# per line). The installer renders the gateway config and the start check from
# this file, so the bundle never carries two hand-written lists.
tracing_write_callbacks_file() {
  local file="$1" dir
  [[ -n "$file" ]] || die "tracing_write_callbacks_file needs a target file"
  dir="$(dirname "$file")"
  [[ -d "$dir" ]] || mkdir -p "$dir"
  tracing_intended_callbacks >"$file"
}

# Prints the callback names of a generated/readable list file, one per line,
# skipping blanks and comments.
tracing_read_callbacks_file() {
  local file="$1"
  [[ -r "$file" ]] || return 0
  grep -v '^[[:space:]]*$' "$file" | grep -v '^[[:space:]]*#' || true
}

# Normalizes a callback list (spaces, commas or newlines) to one name per line.
tracing_normalize_callbacks() {
  tr ',' '\n' | tr -s '[:space:]' '\n' | grep -v '^[[:space:]]*$' || true
}

# Major version of a version string ("4.2.0", "v4.2.0"), or empty.
tracing_major_of_version() {
  local version="${1#v}"
  if [[ "$version" =~ ^([0-9]+) ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
  else
    printf '%s\n' ""
  fi
  return 0
}

# Major version of the Langfuse server, or empty when it cannot be read. The
# first probe works without credentials: Langfuse serves `GET /api/public/health`
# (public route) with `{"status":...,"version":"4.x.y"}`, and the version is the
# documented v4 marker (on v4 the legacy ingestion endpoint rejects events with
# "events_only"). The documented fallback is the version the release bundle
# pins (MYRMIDON_TRACING_LANGFUSE_VERSION), used when the route is unreachable,
# guarded or answers without a version.
tracing_langfuse_major() {
  local url="$1" token_file="${2:-}" body version
  if [[ -z "$url" ]]; then
    printf '%s\n' ""
    return 0
  fi
  body="$(http_get "${url%/}/api/public/health" "$token_file" 2>/dev/null)" || body=""
  version="$(jq -r '.version // empty' <<<"$body" 2>/dev/null)" || version=""
  tracing_major_of_version "$version"
}

# Prints the callbacks of a LiteLLM gateway config file, one per line. Reads
# the `callbacks:` key of the `litellm_settings:` block and understands both
# the inline form (`callbacks: ["langfuse_otel"]`) and the block form
# (`callbacks:` plus `- langfuse_otel` lines). An unknown shape prints nothing
# rather than a guess.
tracing_callbacks_from_config() {
  local file="$1"
  [[ -n "$file" && -r "$file" ]] || return 0
  awk '
    function clean(s) {
      gsub(/"/, "", s)
      gsub("\047", "", s)
      sub(/^[ \t]+/, "", s)
      sub(/[ \t]+$/, "", s)
      sub(/,$/, "", s)
      return s
    }
    /^[ \t]*#/ { next }
    /^[ \t]*$/ { next }
    /^[^ \t]/ {
      in_litellm = ($0 ~ /^litellm_settings[ \t]*:/)
      block = 0
      next
    }
    !in_litellm { next }
    /^[ \t]+callbacks[ \t]*:/ {
      rest = $0
      sub(/^[ \t]*callbacks[ \t]*:[ \t]*/, "", rest)
      if (rest ~ /^\[/) {
        sub(/^\[/, "", rest)
        sub(/\][ \t]*$/, "", rest)
        n = split(rest, parts, ",")
        for (i = 1; i <= n; i++) { v = clean(parts[i]); if (v != "") print v }
        block = 0
      } else if (rest != "") {
        v = clean(rest); if (v != "") print v
        block = 0
      } else {
        block = 1
      }
      next
    }
    block && /^[ \t]*-[ \t]*/ {
      v = $0
      sub(/^[ \t]*-[ \t]*/, "", v)
      v = clean(v)
      if (v != "") print v
      next
    }
    block { block = 0 }
  ' "$file"
}

# Effective LiteLLM callbacks, one per line. Two sources are read and the union
# is taken, because the gateway config file and the gateway database disagree
# and the database only ADDS callbacks (a legacy one can stay in memory while
# the file looks clean):
#   * MYRMIDON_TRACING_CALLBACKS_COMMAND — the live gateway (or its database),
#     whatever the deployment trusts to read it;
#   * MYRMIDON_TRACING_GATEWAY_CONFIG — the deployed config file.
tracing_effective_callbacks() {
  local command="${1:-}" config="${2:-}" out=""
  if [[ -n "$command" ]]; then
    out="$(bash -c "$command" 2>/dev/null)" || out=""
    tracing_normalize_callbacks <<<"$out"
  fi
  if [[ -n "$config" ]]; then
    tracing_callbacks_from_config "$config"
  fi
}

# True when the stream on stdin contains the legacy `langfuse` callback (as
# opposed to `langfuse_otel` or any other name).
tracing_has_legacy_callback() {
  local token
  while IFS= read -r token; do
    token="$(printf '%s' "$token" | tr -d '[:space:]')"
    [[ "$token" == "langfuse" ]] && return 0
  done
  return 1
}

# The guard. Returns 0 when the bundle's OTLP-only list is what the gateway
# uses; returns 1 after a log line naming the reason when a legacy `langfuse`
# callback is installed against a v4 (or unproven) Langfuse server. There is
# deliberately no flag or setting that skips the refusal: callers die on 1.
# Arguments: langfuse_url, pinned_version, intended_file, gateway_config,
# callbacks_command, token_file.
tracing_check() {
  local url="${1:-}" pinned="${2:-}" intended_file="${3:-}" config="${4:-}" command="${5:-}" token_file="${6:-}"
  local major intended effective reason=""

  if [[ -z "$url$pinned$config$command" ]]; then
    log "tracing: no MYRMIDON_TRACING_* input configured; the callback check is skipped"
    return 0
  fi

  if [[ -z "$config" && -z "$command" ]]; then
    log "tracing: ERROR: tracing is configured but the effective callback set cannot be read; set MYRMIDON_TRACING_GATEWAY_CONFIG (the deployed gateway config) or MYRMIDON_TRACING_CALLBACKS_COMMAND (the live gateway). The check refuses rather than assuming the list is clean."
    return 1
  fi

  major="$(tracing_langfuse_major "$url" "$token_file")"
  if [[ -z "$major" && -n "$pinned" ]]; then
    major="$(tracing_major_of_version "$pinned")"
    [[ -n "$major" ]] && log "tracing: the Langfuse version pinned in the bundle is $pinned; the server probe gave no version"
  fi

  intended="$(tracing_read_callbacks_file "$intended_file")"
  [[ -n "$intended" ]] || intended="$(tracing_intended_callbacks)"
  effective="$(tracing_effective_callbacks "$command" "$config")"

  log "tracing: intended callbacks: $(tr '\n' ' ' <<<"$intended" | sed 's/ *$//')"
  log "tracing: effective callbacks: $(tr '\n' ' ' <<<"$effective" | sed 's/ *$//')"

  if tracing_has_legacy_callback <<<"$intended"; then
    if [[ "$major" == "4" || -z "$major" ]]; then
      reason="the callback list the bundle itself installs"
    else
      log "tracing: the bundle list carries the legacy 'langfuse' callback; Langfuse $major accepts it (the v4 refusal is what this check exists for)"
    fi
  fi

  if [[ -z "$reason" ]] && tracing_has_legacy_callback <<<"$effective"; then
    if [[ "$major" == "4" ]]; then
      reason="the effective gateway callbacks"
    elif [[ -z "$major" ]]; then
      reason="the effective gateway callbacks, and the Langfuse version cannot be proven (pin MYRMIDON_TRACING_LANGFUSE_VERSION or expose GET /api/public/health)"
    else
      log "tracing: the gateway carries the legacy 'langfuse' callback; Langfuse $major accepts it (the v4 refusal is what this check exists for)"
    fi
  fi

  if [[ -n "$reason" ]]; then
    log "tracing: REFUSED: the legacy 'langfuse' callback is in $reason while the Langfuse server is v4 (or its version cannot be proven). Langfuse v4 in events_only mode rejects /api/public/ingestion with 'Bad request' per event and burns gateway CPU; install the OTLP callback 'langfuse_otel' only. This check cannot be skipped."
    return 1
  fi

  log "tracing: callbacks ok (OTLP only)"
  return 0
}

# --- TRACING-HEALTH: delivery and image pins ---------------------------------
# The installer sends a test request through the gateway and waits for an OTEL
# event in `events_core`. Without that event the install is NOT complete, and a
# silent success is exactly what the incident was about. The same window
# carries the delivery ratio: OTEL events against LiteLLM SpendLogs requests,
# refused below 50 %. Parts 1 and 2 of the deploy-side tracing guard.
#
#   MYRMIDON_TRACING_DELIVERY_COMMAND     prints two integers for the window:
#                                         "<otel events> <spend requests>"
#   MYRMIDON_TRACING_DELIVERY_WINDOW_SEC  the window the command reads; 900
#                                         (15 min) by default, exported to it
#   MYRMIDON_TRACING_LANGFUSE_IMAGE       Langfuse image reference of the bundle
#   MYRMIDON_TRACING_GATEWAY_IMAGE        gateway (LiteLLM) image reference
# The two image settings must carry a full X.Y.Z tag or a digest: a major or
# minor tag moves under the deployment and is not a pin.

# Prints a non-negative integer from a piece of text, or nothing.
tracing_integer_of() {
  local value="$1"
  value="${value//[[:space:]]/}"
  if [[ "$value" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$value"
  else
    printf '%s\n' ""
  fi
  return 0
}

# Reads the two counts of the delivery command ("<events> <requests>") with the
# window exported to it. Prints "<events> <requests>", or nothing when the
# command is unreadable or does not print two integers.
tracing_delivery_counts() {
  local command="$1" window="$2" out events requests
  [[ -n "$command" ]] || return 0
  out="$(MYRMIDON_TRACING_DELIVERY_WINDOW_SEC="$window" bash -c "$command" 2>/dev/null)" || out=""
  events=""
  requests=""
  read -r events requests <<<"$out" || true
  events="$(tracing_integer_of "${events:-}")"
  requests="$(tracing_integer_of "${requests:-}")"
  if [[ -z "$events" || -z "$requests" ]]; then
    printf '%s\n' ""
    return 0
  fi
  printf '%s %s\n' "$events" "$requests"
}

# The delivery check. Returns 1 (after a log line) when the install must be
# treated as failed: unreadable counts, no OTEL event while the gateway served
# requests, or a ratio below 50 %. Returns 0 when the install is proven, and
# also 0 with a log line when the window holds no gateway request at all
# (nothing to measure yet).
tracing_delivery_check() {
  local command="${1:-}" window="${2:-900}" counts events requests percent
  if [[ -z "$command" ]]; then
    log "tracing: no MYRMIDON_TRACING_DELIVERY_COMMAND configured; the delivery check is skipped"
    return 0
  fi
  counts="$(tracing_delivery_counts "$command" "$window")"
  if [[ -z "$counts" ]]; then
    log "tracing: REFUSED: the delivery command did not print the two integers of the ${window}s window (OTEL events, SpendLogs requests); the tracing install cannot be proven complete"
    return 1
  fi
  read -r events requests <<<"$counts"
  if ((requests == 0)); then
    log "tracing: no gateway request in the last ${window}s; the delivery ratio is not measurable yet"
    return 0
  fi
  if ((events == 0)); then
    log "tracing: REFUSED: no OTEL event arrived in the last ${window}s while the gateway served $requests request(s); the tracing install is not complete (events_core is empty for the window)"
    return 1
  fi
  percent=$((events * 100 / requests))
  if ((events * 2 < requests)); then
    log "tracing: REFUSED: the delivery ratio is ${percent}% (${events} OTEL events against ${requests} gateway requests in ${window}s), below the 50% floor"
    return 1
  fi
  log "tracing: delivery ok: ${percent}% (${events} OTEL events against ${requests} gateway requests in ${window}s)"
  return 0
}

# Explains why an image reference is not pinned, or prints nothing when it is
# (a full X.Y.Z tag, or a digest). A major or minor tag, `latest`, or no tag at
# all moves under the deployment and is not a pin.
tracing_image_pin_problem() {
  local ref="$1" tag
  [[ -n "$ref" ]] || return 0
  if [[ "$ref" == *@sha256:* ]]; then
    valid_digest "sha256:${ref#*@sha256:}" && return 0
    printf '%s\n' "$ref carries @sha256: without 64 lowercase hex characters"
    return 0
  fi
  if [[ "$ref" != *:* ]]; then
    printf '%s\n' "$ref has no tag: an untagged reference resolves to latest, which is not a pin"
    return 0
  fi
  tag="${ref##*:}"
  if [[ "$tag" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9._-]+)?$ ]]; then
    return 0
  fi
  printf '%s\n' "$ref is pinned by '$tag', which is not a full X.Y.Z version: a major or minor tag moves; pin it by X.Y.Z or by digest"
}

# The image-pin check: both images must be pinned when they are configured.
# Returns 1 with a log line on the first unpinned reference, 0 otherwise.
tracing_check_image_pins() {
  local langfuse_image="${1:-}" gateway_image="${2:-}" problem
  problem="$(tracing_image_pin_problem "$langfuse_image")"
  if [[ -n "$problem" ]]; then
    log "tracing: REFUSED: the Langfuse image is not pinned: $problem"
    return 1
  fi
  problem="$(tracing_image_pin_problem "$gateway_image")"
  if [[ -n "$problem" ]]; then
    log "tracing: REFUSED: the gateway image is not pinned: $problem"
    return 1
  fi
  if [[ -n "$langfuse_image$gateway_image" ]]; then
    log "tracing: image pins ok (langfuse='${langfuse_image:-<unset>}', gateway='${gateway_image:-<unset>}')"
  fi
  return 0
}

# HOST-TARGETING (the 02.10 two-host follow-up): shared component-host helpers.
# rollout-component.sh and rollback-component.sh both source lib.sh and both
# must act on the SAME host: a rollback that ignores MYR_<COMPONENT>_HOST would
# recreate the component on the deploy host — the exact 1.4.0 fleetd incident.
# The caller sets COMPONENT_REMOTE (empty = local) and COMPONENT_SERVICE first.
component_host_ssh_opts=(-o BatchMode=yes -o ConnectTimeout=10)
component_host_docker() {
  if [[ -n "$COMPONENT_REMOTE" ]]; then
    # shellcheck disable=SC2029
    ssh "${component_host_ssh_opts[@]}" "$COMPONENT_REMOTE" docker "$@"
  else
    docker "$@"
  fi
}
# Sets the settings of one component from the deploy settings (the names are
# the same for every script that touches a component):
#   MYR_<COMPONENT>_COMPOSE_SERVICE   default: the component name
#   MYR_<COMPONENT>_OVERRIDE_FILE     default: docker-compose.myrmidon-<component>.yml
#   MYR_<COMPONENT>_HEALTH_URL        a curl target (fleetd; dockergate is checked by its log)
#   MYR_<COMPONENT>_HOST              local (default), skip or remote:<user>@<host>
component_env() {
  local component="$1" up
  up="$(printf '%s' "$component" | tr '[:lower:]' '[:upper:]')"
  local svc_var="MYR_${up}_COMPOSE_SERVICE" ov_var="MYR_${up}_OVERRIDE_FILE" url_var="MYR_${up}_HEALTH_URL" host_var="MYR_${up}_HOST"
  COMPONENT_SERVICE="${!svc_var:-$component}"
  COMPONENT_OVERRIDE_NAME="${!ov_var:-docker-compose.myrmidon-$component.yml}"
  COMPONENT_OVERRIDE_PATH="$COMPOSE_DIR/$COMPONENT_OVERRIDE_NAME"
  COMPONENT_HEALTH_URL="${!url_var:-}"
  COMPONENT_HOST="${!host_var:-local}"
  COMPONENT_PREVIOUS_FILE="$STATE_DIR/previous-$component-image"
}

# True when a file exists on the component host (this host or over ssh).
component_host_file_exists() {
  if [[ -n "$COMPONENT_REMOTE" ]]; then
    # shellcheck disable=SC2029
    ssh "${component_host_ssh_opts[@]}" "$COMPONENT_REMOTE" test -f "$1" 2>/dev/null
  else
    [[ -f "$1" ]]
  fi
}

# The compose command of the component host. The file set is the project the
# board runs from: COMPOSE_FILES, the board image override (COMPOSE_OVERRIDE_FILE:
# without it a project whose server service has no image of its own does not
# validate, and every check built on `docker compose config` fails with a
# misleading answer) and the override of THIS component. A file that does not
# exist on the host (a remote host has no board override) is left out.
component_host_compose() {
  local args=(compose --project-directory "$COMPOSE_DIR")
  local f
  IFS=':' read -r -a _ch_files <<<"$COMPOSE_FILES"
  for f in "${_ch_files[@]}"; do args+=(-f "$COMPOSE_DIR/$f"); done
  if [[ -z "$COMPONENT_REMOTE" ]] || component_host_file_exists "$OVERRIDE_PATH"; then
    args+=(-f "$OVERRIDE_PATH")
  fi
  if component_host_file_exists "$COMPONENT_OVERRIDE_PATH"; then
    args+=(-f "$COMPONENT_OVERRIDE_PATH")
  fi
  component_host_docker "${args[@]}" "$@"
}
component_host_cat_override() {
  if [[ -n "$COMPONENT_REMOTE" ]]; then
    # shellcheck disable=SC2029
    ssh "${component_host_ssh_opts[@]}" "$COMPONENT_REMOTE" cat "$COMPONENT_OVERRIDE_PATH" 2>/dev/null || true
  else
    cat "$COMPONENT_OVERRIDE_PATH" 2>/dev/null || true
  fi
}
# The image the component's override file names (empty when there is none).
component_host_override_ref() {
  component_host_cat_override | sed -nE 's/^[[:space:]]*image:[[:space:]]*([^[:space:]#]+).*/\1/p' | head -n1
}
# The image of the container that exists for the component's service on the
# target host (running, restarting or exited), as the container was created:
# `docker inspect`, not a file. The container is found by the labels compose
# puts on it, so this works even when the compose files do not validate.
# Empty when there is no container.
component_host_running_ref() {
  local id
  id="$(component_host_docker ps -a -q \
    --filter "label=com.docker.compose.service=$COMPONENT_SERVICE" \
    --filter "label=com.docker.compose.project.working_dir=$COMPOSE_DIR" 2>/dev/null | head -n1)" || id=""
  [[ -n "$id" ]] || return 0
  component_host_docker inspect --format '{{.Config.Image}}' "$id" 2>/dev/null | head -n1 || true
}
# The reference to go back to: the running container's image; the override
# file only when no container exists. Logs a warning when the file disagrees
# with what runs (a stale override is how a rollback once restored the wrong
# image).
component_host_previous_ref() {
  local running file
  running="$(component_host_running_ref)"
  file="$(component_host_override_ref)"
  if [[ -n "$running" ]]; then
    if [[ -n "$file" && "$file" != "$running" ]]; then
      log "WARNING: ${COMPONENT_SERVICE}: the override file ($COMPONENT_OVERRIDE_PATH) names $file but the container runs $running; the running image is the previous image"
    fi
    printf '%s\n' "$running"
  else
    printf '%s\n' "$file"
  fi
}
# Is $COMPONENT_SERVICE defined by the compose files of the target host
# (docker compose config --services)? The fail-closed pre-check: a component
# with no trace on the target host is a misconfiguration (the 1.4.0 fleetd
# incident), not something to create from nothing.
#
# Return codes — the caller MUST tell the two faults apart:
#   0  the project is readable and declares the service;
#   1  the compose project itself cannot be read. COMPONENT_COMPOSE_ERROR holds
#      the real output of `docker compose config`;
#   2  the project is valid but does not declare the service.
#
# myrmidon(DEPLOY-PRECHECK, the 05.10 incident): `docker compose config
# --services` prints its error on stderr and nothing on stdout, exactly like a
# project that simply does not declare the service. A caller that looked only at
# the list reported the wrong fault — "dockergate is not a service of the
# compose project" — and hid the real one: the project was invalid (COMPOSE_FILES
# without the file that carries the image, so `server` had neither an image nor a
# build context). The error is therefore captured here and handed to the caller
# in COMPONENT_COMPOSE_ERROR instead of being dropped into /dev/null.
component_host_service_exists() {
  local services rc=0 err
  err="$(mktemp)"
  # the list is captured first: `grep -q` closing the pipe early would make the
  # producer die of SIGPIPE and, under pipefail, report a service as missing
  services="$(component_host_compose config --services 2>"$err")" || rc=$?
  COMPONENT_COMPOSE_ERROR="$(cat "$err" 2>/dev/null || true)"
  rm -f "$err"
  if ((rc != 0)); then
    # an empty stderr would leave the caller with nothing to report
    [[ -n "$COMPONENT_COMPOSE_ERROR" ]] \
      || COMPONENT_COMPOSE_ERROR="docker compose config exited $rc without printing an error"
    return 1
  fi
  grep -qx "$COMPONENT_SERVICE" <<<"$services" || return 2
  return 0
}
component_host_write_override() {
  local target_ref="$1"
  if [[ -n "$COMPONENT_REMOTE" ]]; then
    # shellcheck disable=SC2029
    ssh "${component_host_ssh_opts[@]}" "$COMPONENT_REMOTE" \
      "mkdir -p '$COMPOSE_DIR' && printf '%s\n' '# Managed by scripts/myrmidon/deploy. Only the image line changes.' 'services:' '  $COMPONENT_SERVICE:' '    image: $target_ref' > '$COMPONENT_OVERRIDE_PATH'"
  else
    local tmp
    tmp="$(mktemp "$COMPONENT_OVERRIDE_PATH.XXXXXX")" || die "cannot write next to $COMPONENT_OVERRIDE_PATH"
    {
      echo "# Managed by scripts/myrmidon/deploy. Only the image line changes."
      echo "services:"
      echo "  $COMPONENT_SERVICE:"
      echo "    image: $target_ref"
    } >"$tmp"
    install_preserving "$tmp" "$COMPONENT_OVERRIDE_PATH" || { rm -f "$tmp"; die "cannot write $COMPONENT_OVERRIDE_PATH"; }
  fi
}
# Parses MYR_<COMPONENT>_HOST into COMPONENT_REMOTE/COMPONENT_SKIP, die() on a
# malformed value. Usage: component_host_parse <component> <host-value>.
component_host_parse() {
  local component="$1" value="${2:-local}"
  COMPONENT_REMOTE="" COMPONENT_SKIP=0
  case "$value" in
    local) ;;
    skip) COMPONENT_SKIP=1 ;;
    remote:*)
      COMPONENT_REMOTE="${value#remote:}"
      [[ "$COMPONENT_REMOTE" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$ ]] \
        || die "MYR_${component^^}_HOST must be local, skip or remote:<user>@<host>, got '$value'"
      ;;
    *) die "MYR_${component^^}_HOST must be local, skip or remote:<user>@<host>, got '$value'" ;;
  esac
}

# ONE-DEPLOY: shared helpers of the all-components deploy.

# The image a component runs now (the container's image; the override file only
# when no container exists). One source of truth: what runs, not what a file
# says. Reads the same host the rollout targets (MYR_<COMPONENT>_HOST); runs in
# a subshell so the COMPONENT_* globals of the caller are not touched. Empty for
# a component the deploy does not manage (host skip).
component_current_ref() (
  component_env "$1"
  component_host_parse "$1" "$COMPONENT_HOST"
  [[ "$COMPONENT_SKIP" == "1" ]] && exit 0
  component_host_previous_ref
)

# The image the component's override file names (the generated file, which is
# also what the boot unit reads). Same host targeting as component_current_ref.
component_override_ref() (
  component_env "$1"
  component_host_parse "$1" "$COMPONENT_HOST"
  [[ "$COMPONENT_SKIP" == "1" ]] && exit 0
  component_host_override_ref
)

# Makes the generated override of a local component name the image that runs
# (the boot unit reads the override, so a stale file would start a different
# image at the next boot). Writes only when the file is missing or differs from
# the running container; nothing when no container exists. Prints one log line
# per change. Local components only (a remote host is left alone).
component_sync_override() (
  component_env "$1"
  component_host_parse "$1" "$COMPONENT_HOST"
  [[ "$COMPONENT_SKIP" == "1" || -n "$COMPONENT_REMOTE" ]] && exit 0
  running="$(component_host_running_ref)"
  file="$(component_host_override_ref)"
  if [[ -z "$running" ]]; then
    [[ -n "$file" ]] || log "WARNING: $1: no container and no override file ($COMPONENT_OVERRIDE_PATH); the boot unit lists that file, the rollout writes it"
    exit 0
  fi
  [[ "$running" == "$file" ]] && exit 0
  log "override $COMPONENT_OVERRIDE_PATH: ${file:-<missing>} -> $running (the image that runs; the boot unit reads this file)"
  component_host_write_override "$running"
)

# --- dockergate: config check, log state -------------------------------------

# dockergate check-config of a config file, run with the image that is about to
# be deployed (the config must be valid for THAT binary, before it is
# recreated). The operator's command wins when set (it may check through a
# running container); $MYR_BOT_CFG_FILE names the file. Without a command the
# image is run with the file mounted read-only and no network, as the user the
# image runs as - so a config the service could not open is refused here.
# The output of the check (stdout and stderr) is kept in DG_CHECK_OUTPUT and,
# on a refusal, logged line by line: the reason is in that text.
#   dockergate_check_config_file <config-file> <image-ref>
# rc 0 = valid, 1 = refused, 3 = no way to check (no command and no image).
dockergate_check_config_file() {
  local cfg="$1" image="${2:-}" rc=0 line
  local cmd="${MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_CHECK_CONFIG_COMMAND:-}"
  DG_CHECK_OUTPUT=""
  if [[ -n "$cmd" ]]; then
    DG_CHECK_OUTPUT="$(MYR_BOT_CFG_FILE="$cfg" bash -c "$cmd" 2>&1)" || rc=$?
    # 3 is this function's own "no way to check"; a command that exits 3 refused the file
    ((rc == 3)) && rc=1
  else
    [[ -n "$image" ]] || return 3
    DG_CHECK_OUTPUT="$(docker run --rm --network none --read-only \
      -v "$cfg:/etc/myrmidon-dockergate/config.json:ro" "$image" \
      check-config --config /etc/myrmidon-dockergate/config.json 2>&1)" || rc=$?
  fi
  if ((rc != 0)); then
    log "dockergate check-config refused $cfg (exit $rc); its output:"
    while IFS= read -r line; do log "  | $line"; done <<<"${DG_CHECK_OUTPUT:-<no output>}"
  fi
  return "$rc"
}

# The configuration hash dockergate reports (first 12 hex digits of the sha256
# of the file's bytes: the same value `check-config` prints and the start and
# reload log lines carry).
dockergate_config_hash() {
  local file="$1" sum
  if command -v sha256sum >/dev/null 2>&1; then
    sum="$(sha256sum "$file")"
  else
    sum="$(shasum -a 256 "$file")"
  fi
  printf '%s\n' "${sum:0:12}"
}

# The dockergate log (a bounded tail). DOCKERGATE_LOGS_COMMAND wins (the same
# setting the post-boot check reads); otherwise the compose logs of the service
# on its host. Runs in a subshell: the COMPONENT_* globals of the caller stay.
dockergate_logs() (
  if [[ -n "${DOCKERGATE_LOGS_COMMAND:-}" ]]; then
    bash -c "$DOCKERGATE_LOGS_COMMAND"
    exit
  fi
  component_env dockergate
  component_host_parse dockergate "$COMPONENT_HOST"
  component_host_compose logs --no-log-prefix --tail 400 "$COMPONENT_SERVICE"
)

# "<version> <configHash>" tab separated, from the newest "self-check ok" or
# "config_reloaded" line of a dockergate log on stdin (both lines carry the
# running version and the hash of the config the process loaded, in `configHash`;
# `hash` is read too); nothing when
# there is no such line. A failed reload (config_reload_failed) is not a state
# line: after it the newest line still names the config the process runs.
dockergate_state_from_log() {
  jq -Rrn '[inputs | fromjson? | select(type == "object" and (.event == "self-check ok" or .event == "config_reloaded"))]
    | if length == 0 then empty
      else "\((map(.version // empty) | last) // "")\t\((last.configHash // last.hash // ""))" end' 2>/dev/null
}

# The state of the dockergate container on its host: prints "running" when it
# runs and is not restarting, otherwise what it is ("restarting", "exited",
# "absent", ...).
dockergate_container_state() (
  component_env dockergate
  component_host_parse dockergate "$COMPONENT_HOST"
  id="$(component_host_docker ps -a -q \
    --filter "label=com.docker.compose.service=$COMPONENT_SERVICE" \
    --filter "label=com.docker.compose.project.working_dir=$COMPOSE_DIR" 2>/dev/null | head -n1)" || id=""
  if [[ -z "$id" ]]; then echo absent; exit 0; fi
  st="$(component_host_docker inspect --format '{{.State.Status}} {{.State.Restarting}}' "$id" 2>/dev/null)" || st=""
  case "$st" in
    "running false") echo running ;;
    "") echo unknown ;;
    *) echo "${st%% *}" ;;
  esac
)

# The dockergate health probe. The engine socket answers only the board's main
# process (the host gets 403 caller_not_board_main), so a ping from the host can
# never pass. What the host can prove: the container runs, and its newest
# "self-check ok" / "config_reloaded" line reports the expected version and the
# hash of the expected config. Polls until both hold or the time is up.
#   dockergate_verify_state <version|""> <config-hash|""> <timeout-sec> [lenient-hash]
# An empty expectation is not checked. lenient-hash (rollback to an older
# dockergate, which may not log a hash) accepts a log line without a hash.
# Sets DG_SEEN_VERSION and DG_SEEN_HASH; returns 0 when proven, 1 otherwise
# (the reason is logged).
dockergate_verify_state() {
  local want_version="$1" want_hash="$2" timeout="${3:-60}" lenient="${4:-}"
  local deadline=$((SECONDS + timeout)) state seen log_text container reason=""
  DG_SEEN_VERSION="" DG_SEEN_HASH=""
  while :; do
    container="$(dockergate_container_state)"
    # A dockergate that is not a compose service of this host (its log comes from
    # DOCKERGATE_LOGS_COMMAND) cannot be looked up by label: the log is the proof.
    [[ "$container" == "absent" && -n "${DOCKERGATE_LOGS_COMMAND:-}" ]] && container="running"
    log_text="$(dockergate_logs 2>/dev/null || true)"
    state="$(dockergate_state_from_log <<<"$log_text")"
    DG_SEEN_VERSION="${state%%$'\t'*}"
    DG_SEEN_HASH=""
    [[ "$state" == *$'\t'* ]] && DG_SEEN_HASH="${state#*$'\t'}"
    reason=""
    if [[ "$container" != "running" ]]; then
      reason="the container is '$container', not running"
    elif [[ -z "$state" ]]; then
      reason="no 'self-check ok' line in the dockergate log yet"
    elif [[ -n "$want_version" && "$DG_SEEN_VERSION" != "$want_version" ]]; then
      reason="the log reports version '${DG_SEEN_VERSION:-<none>}', expected '$want_version'"
    elif [[ -n "$want_hash" && -z "$DG_SEEN_HASH" && -n "$lenient" ]]; then
      log "WARNING: this dockergate does not log its config hash; the loaded config is not proven"
    elif [[ -n "$want_hash" && "$DG_SEEN_HASH" != "$want_hash" ]]; then
      reason="the log reports config hash '${DG_SEEN_HASH:-<none>}', expected '$want_hash' (the process did not load the new config)"
    fi
    [[ -z "$reason" ]] && return 0
    ((SECONDS < deadline)) || break
    sleep "$POLL_INTERVAL_SEC"
  done
  log "dockergate is not proven healthy: $reason"
  return 1
}

# --- DEPLOY-HYGIENE (OPE-5107): disk precheck and image retention ------------
# The 06.10 disk incident: one deploy of rc.3 moved the root filesystem of the
# deploy host from 86 % to 92 % in an hour. Three leaks: the anonymous volume
# of the predeploy database copy survived the check (handled in
# predeploy-board-check.sh), the component images of past releases were never
# removed (deploy_image_retention), and the deploy started pulling images
# without checking the disk could hold them (deploy_disk_precheck).

# Free gibibytes (integer) of the filesystem that holds /var/lib/docker.
# Prints nothing when the number cannot be read.
docker_free_gb() {
  local kb
  kb="$(df -Pk /var/lib/docker 2>/dev/null | awk 'NR==2 {print $4}')" || kb=""
  [[ "$kb" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' $((kb / 1024 / 1024))
}

# Refuses the deploy BEFORE the first image pull and the dump when the
# filesystem of /var/lib/docker has less than MYRMIDON_DEPLOY_MIN_FREE_GB
# gibibytes free (default 15; the board image alone is about 7 GB, the bot
# images several more). The refusal names the requirement, the current value
# and the candidates for cleanup, and runs before anything was changed.
# A threshold of 0 switches the check off. In a dry run the check is reported
# with the current value and the plan continues.
deploy_disk_precheck() {
  local where="$1" min_gb="${MYRMIDON_DEPLOY_MIN_FREE_GB:-15}" free
  [[ "$min_gb" =~ ^[0-9]+$ ]] || die "MYRMIDON_DEPLOY_MIN_FREE_GB must be a non-negative integer (got '$min_gb')"
  free="$(docker_free_gb)" || free=""
  if ((min_gb == 0)); then
    log "disk precheck ($where): MYRMIDON_DEPLOY_MIN_FREE_GB=0, the check is off (free: ${free:-unknown} GiB)"
    return 0
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    log "disk precheck ($where): dry run, nothing refused; the real run needs ${min_gb} GiB free on the filesystem of /var/lib/docker (now: ${free:-unknown} GiB)"
    return 0
  fi
  [[ -n "$free" ]] || { log "disk precheck ($where): cannot read the free space of /var/lib/docker; continuing (df gave no answer)"; return 0; }
  if ((free < min_gb)); then
    log "disk precheck ($where): ${free} GiB free on the filesystem of /var/lib/docker, less than the required ${min_gb} GiB (MYRMIDON_DEPLOY_MIN_FREE_GB)"
    log "disk precheck: the deploy is NOT started: no image was pulled, no dump was taken, nothing was changed"
    log "disk precheck: candidates for cleanup (docker system df): the component images of past releases (docker image ls ghcr.io/itkadr-git/myrmidon), orphaned volumes of past predeploy checks (docker volume ls -f name=myr-predeploy-dbvol-), build cache"
    docker system df 2>/dev/null >&2 || true
    die "not enough free disk space for the deploy: ${free} GiB < ${min_gb} GiB; free space (see the candidates above) or lower MYRMIDON_DEPLOY_MIN_FREE_GB"
  fi
  log "disk precheck ($where): ${free} GiB free on the filesystem of /var/lib/docker (>= ${min_gb} GiB required)"
}

# Removes the local images of the deploy's component repositories that are
# older than MYRMIDON_DEPLOY_IMAGE_KEEP previous releases (default 1: the
# current release plus the one before it, kept for a rollback). Order is the
# image creation date (docker image ls). An image used by ANY container
# (running or stopped) is never removed: it is skipped with a log line.
# <none> tags left by a removed image are taken with it. A keep of 0 switches
# the cleanup off. A failure here must never fail a finished deploy: the
# caller warns and moves on.
deploy_image_retention() {
  local keep="${MYRMIDON_DEPLOY_IMAGE_KEEP:-1}" repos="${MYRMIDON_DEPLOY_IMAGE_REPOS:-}"
  local repo entry id created tag kept entries
  [[ "$keep" =~ ^[0-9]+$ ]] || { log "image retention: MYRMIDON_DEPLOY_IMAGE_KEEP must be a non-negative integer (got '$keep'); the cleanup is skipped"; return 1; }
  if ((keep == 0)); then
    log "image retention: MYRMIDON_DEPLOY_IMAGE_KEEP=0, the cleanup is off"
    return 0
  fi
  # Image ids any container uses right now. Never removed, whatever their age.
  local used_ids
  used_ids="$(docker ps -a -q 2>/dev/null | while IFS= read -r cid; do
    [[ -n "$cid" ]] && docker inspect --format '{{.Image}}' "$cid" 2>/dev/null
done | sed 's/^sha256://' | sort -u)" || used_ids=""
  local removed=0 skipped=0
  for repo in $(tr ',' ' ' <<<"$repos"); do
    [[ -n "$repo" ]] || continue
    # Newest first: one image per line as "created<TAB>id<TAB>tag" (a tab
    # survives the raw echo of the fakes the tests drive and never appears in
    # a docker tag or id; the timestamp is cut at the first two fields).
    entries="$(docker image ls "$repo" --no-trunc --format '{{.CreatedAt}}{{"\t"}}{{.ID}}{{"\t"}}{{.Tag}}' 2>/dev/null \
      | sort -t"$(printf '\t')" -k1,1r)" || entries=""
    [[ -n "$entries" ]] || continue
    # The keep window counts only images the cleanup may touch: an image a
    # container uses is never removed, so it must not eat the budget of
    # releases the operator still needs for a rollback.
    kept=0
    while IFS= read -r entry; do
      [[ -n "$entry" ]] || continue
      created="$(printf '%s' "$entry" | cut -f1)"
      id="$(printf '%s' "$entry" | cut -f2)"
      tag="$(printf '%s' "$entry" | cut -f3-)"
      [[ -n "$id" ]] || continue
      if grep -qx "${id#sha256:}" <<<"$used_ids"; then
        log "image retention: $repo image ${id#sha256:} (created $created) is used by a container: skipped"
        skipped=$((skipped + 1))
        continue
      fi
      if ((kept < keep + 1)); then
        kept=$((kept + 1))
        continue
      fi
      if [[ -n "$tag" && "$tag" != "<none>" ]]; then
        docker image rm "$repo:$tag" >/dev/null 2>&1 || docker image rm "$id" >/dev/null 2>&1 || true
      else
        docker image rm "$id" >/dev/null 2>&1 || true
      fi
      log "image retention: removed $repo image ${id#sha256:} (created $created; older than $keep previous release(s))"
      removed=$((removed + 1))
    done <<<"$entries"
  done
  log "image retention: $removed image(s) removed, $skipped in use and kept (keep $keep previous release(s) per repository)"
}
