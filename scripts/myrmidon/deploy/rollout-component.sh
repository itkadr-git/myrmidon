#!/usr/bin/env bash
# scripts/myrmidon/deploy/rollout-component.sh
#
# RELEASE-GATE (the 01.10 incident): deploy.sh rolls the matching dockergate
# (and fleetd) images together with the board image, in the same run. This is
# the shared half for one component: pull by digest, remember the previous
# reference, write the image line into the component override file, recreate
# the service, and check its health endpoint. deploy.sh calls it once per
# component after the board itself is healthy.
#
#   rollout-component.sh --config deploy.env --component dockergate \
#                        --digest sha256:<64 hex> [--dry-run] [--force]
#
# PRE-CHECK (the 05.10 incident): before anything is pulled or written the
# script makes every read-only refusal a rollout can make — the component's CI
# image, the target host's compose project (and the REAL error of `docker
# compose config` when the project cannot be read), the service the project
# declares, the health URL, the dockergate config file. --dry-run therefore
# fails exactly where a real rollout would, and deploy.sh pre-checks the whole
# release this way BEFORE its image pull and its database dump.
#
# ONE-DEPLOY: a component that already runs the requested image is left alone
# (exit 0, nothing pulled or restarted) unless --force. A dockergate rollout
# checks its config with `dockergate check-config`, run with the NEW image,
# BEFORE the service is recreated (MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_CONFIG
# names the file; without it the check is skipped with a warning), and after
# the recreate verifies the running dockergate's self-check version against the
# binary of the image.
#
# The component registry repositories are fixed (they are CI-built exactly like
# the board image; see scripts/myrmidon/dockergate/check-release-support.sh):
#   dockergate -> ghcr.io/itkadr-git/myrmidon-dockergate
#   fleetd     -> ghcr.io/itkadr-git/myrmidon-fleetd
#
# The image is verified the same way the board image is (registry presence,
# revision and source labels, commit on origin/main or a myr-v* tag) — there
# is no flag that skips it, for the same reason as the board check.
#
# Health check: fleetd needs MYR_FLEETD_HEALTH_URL (a curl -fsS target), and the
# rollout refuses before it pulls anything when it is missing. dockergate has no
# probe a host can pass (its socket answers only the board's main process; the
# host gets 403 caller_not_board_main), so it is proven by its own log: the
# container runs and its newest "self-check ok" / "config_reloaded" line reports
# the version of the new binary and the hash of the config it was started with.
# MYR_DOCKERGATE_HEALTH_URL is not used. verify-health.sh stays board-specific
# (version/commit of /api/health).
#
# One source of truth: the generated override file docker-compose.myrmidon-<component>.yml
# is what the deploy, the rollback and the boot unit read; the "previous" image
# is the image of the container that runs now (docker inspect), never a file.
#
# --dry-run runs every check the real run runs before it changes anything
# (CI image, the compose project of the target host with compose's own error
# text, the service, the health setting, the dockergate config check) and fails
# exactly when the real run would.
#
# HOST-TARGETING (the 02.10 two-host follow-up): a component does not have to
# live on the deploy host. fleetd of the 1.4.0 production install runs on a
# second host (vm-exec), while deploy.sh runs on the board host (vm-core): the
# first 1.4.0 rollout created paperclip-fleetd-1 on the board host, it exited
# at once (no /etc/myrmidon-fleetd/config.json there) and the operator removed
# it by hand. A component that does not live on this host must not be "rolled
# out" here. Two supported arrangements, fail-closed by default:
#
#   MYR_<COMPONENT>_HOST=local (default)   the service runs in this host's
#     compose project (COMPOSE_DIR). A rollout that finds no trace of the
#     service locally (no override file AND no service in `docker compose
#     config --services`) fails: silently skipping a required component is
#     exactly the 01.10 split again.
#   MYR_<COMPONENT>_HOST=remote:<user>@<host>   the service runs on another
#     host. The rollout then runs docker over ssh (ssh must be set up with a
#     key, no password prompt), writes the override file there under the same
#     relative name (COMPOSE_DIR must exist on the remote host too), recreates
#     the service there and probes MYR_<COMPONENT>_HEALTH_URL from THIS host
#     (the URL the deploy host can reach, not localhost of the remote host).
#   MYR_<COMPONENT>_HOST=skip   the component is not managed by this deploy at
#     all (rolled out by its own procedure elsewhere). The rollout logs a loud
#     SKIP line and exits 0 — the release still ships together, the operator
#     owns the other half explicitly.
set -euo pipefail
# shellcheck source=lib.sh source-path=SCRIPTDIR
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

config="" component="" digest="" force=0
DRY_RUN=0
while (($#)); do
  case "$1" in
    --config) config="$2"; shift 2 ;;
    --component) component="$2"; shift 2 ;;
    --digest) digest="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --force) force=1; shift ;;
    -h|--help) sed -n '2,78p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n "$component" ]] || die "--component is required (dockergate or fleetd)"
valid_digest "$digest" || die "component digest must be sha256:<64 hex>, got '$digest'"
load_config "$config"
require_cmd docker curl

declare -A MYR_COMPONENT_REPOSITORIES=(
  [dockergate]="ghcr.io/itkadr-git/myrmidon-dockergate"
  [fleetd]="ghcr.io/itkadr-git/myrmidon-fleetd"
)
repo="${MYR_COMPONENT_REPOSITORIES[$component]:-}"
[[ -n "$repo" ]] || die "unknown component: $component (known: dockergate, fleetd)"
ref="$repo@$digest"

# Service and override naming follow the component name (see component_env in
# lib.sh): MYR_<COMPONENT>_COMPOSE_SERVICE (default: the component name),
# MYR_<COMPONENT>_OVERRIDE_FILE (default: docker-compose.myrmidon-<component>.yml).
component_env "$component"

# HOST-TARGETING: where this component actually runs. skip is decided AFTER
# the CI-image check below: even a component this deploy does not manage must
# name a real, CI-built image of this release — the release ships together.
# The parser and the docker/compose/cat/write helpers live in lib.sh
# (component_host_*) so the rollback (rollback-component.sh) targets the SAME
# host as the rollout — a rollback ignoring MYR_<COMPONENT>_HOST would recreate
# the component on the deploy host, the exact 1.4.0 fleetd incident.
if [[ "$COMPONENT_HOST" == "skip" ]]; then
  log "SKIP: $component is not managed by this deploy (MYR_${component^^}_HOST=skip); its image rolls out by its own procedure"
  log "      make sure the $component image of THIS release ($ref) is rolled out there too — the release must ship together"
fi
component_host_parse "$component" "$COMPONENT_HOST"
component_docker() { component_host_docker "$@"; }
component_compose() { component_host_compose "$@"; }
component_cat_override() { component_host_cat_override; }
component_service_exists() { component_host_service_exists; }
component_write_override() { component_host_write_override "$@"; }

DG_CONFIG="${MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_CONFIG:-}"

# --- the read-only pre-check of this component --------------------------------
# myrmidon(DEPLOY-PRECHECK, the 05.10 incident): every refusal a rollout makes
# without pulling or writing anything lives in this one function, and it runs
# before the pull, before the override is written and before the --dry-run plan.
# So --dry-run fails exactly where the real rollout would, and deploy.sh's
# pre-flight (which calls this script with --dry-run for each component it is
# about to roll out) refuses before the image pull and the database dump. The
# 05.10 deploy had the opposite: the dry run ran none of these checks, the real
# run made them only after the pull and the dump, and an unreadable compose
# project was reported as "dockergate is not a service".
component_precheck() {
  # Same CI-image gate as the board: registry, labels, commit on main or a tag.
  log "checking that $ref was built by CI"
  if ! check_ci_image_for_repo "$repo" "$ref"; then
    log "Only component images built by the CI workflows from main or a myr-v* tag are rolled out."
    die "component image refused, nothing was changed: $CI_CHECK_REASON"
  fi

  # HOST-TARGETING: skip ends here — after the CI check, which a component this
  # deploy does not manage still has to pass (the release names a real image).
  if [[ "$COMPONENT_SKIP" == "1" ]]; then
    log "SKIP: $component rollout ends here; nothing was pulled, switched or recreated on this host"
    exit 0
  fi

  # HOST-TARGETING (fail-closed local pre-check): before anything is pulled or
  # written, prove the service is part of the target host's compose project. A
  # component with no trace there (the 1.4.0 fleetd-on-the-board-host incident)
  # must fail HERE, not at step 4 with an image pulled and an override written
  # on a host the service never ran on. A compose project that cannot be read at
  # all is reported as ITSELF, with the real compose error, and never as a
  # missing service (the 05.10 incident).
  local_desc="this host"
  [[ -n "$COMPONENT_REMOTE" ]] && local_desc="$COMPONENT_REMOTE (remote)"
  local srv_rc=0
  component_service_exists || srv_rc=$?
  if ((srv_rc == 1)); then
    log "docker compose config on $local_desc did not run; its output:"
    while IFS= read -r line; do
      [[ -n "$line" ]] && log "  $line"
    done <<<"$COMPONENT_COMPOSE_ERROR"
    die "the compose project itself cannot be read on $local_desc (COMPOSE_DIR=$COMPOSE_DIR, COMPOSE_FILES=$COMPOSE_FILES), so its services are unknown — this is NOT a missing service: fix the compose project and run again (COMPOSE_FILES must name every file of the project; a service with neither an image nor a build context is the usual cause)"
  fi
  if ((srv_rc == 2)); then
    die "$component is not a service of the compose project on $local_desc ($COMPONENT_SERVICE missing from \$COMPOSE_FILES; a rollout would create the service from nothing, as in the 1.4.0 fleetd incident): fix MYR_${component^^}_COMPOSE_SERVICE/COMPOSE_FILES or set MYR_${component^^}_HOST to remote:/skip"
  fi

  # The health URL is REQUIRED: the release deploy must prove the component
  # answers, so a component without one is refused here — before the pull, not
  # after its service was already recreated.
  # dockergate is proven by its self-check log line and needs no URL: the host
  # cannot ping it (its socket answers only the board's main process).
  [[ "$component" == "dockergate" || -n "$COMPONENT_HEALTH_URL" ]] \
    || die "$component has no MYR_${component^^}_HEALTH_URL configured: the release deploy must prove the component answers; refusing before anything is pulled"

  # dockergate: the config the NEW binary must accept is read on THIS host, so a
  # remote dockergate with a config check is refused here too.
  if [[ "$component" == "dockergate" && -n "$DG_CONFIG" ]]; then
    [[ -z "$COMPONENT_REMOTE" ]] || die "dockergate on a remote host: the config check runs on this host; set MYR_DOCKERGATE_HOST=local or drop MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_CONFIG"
    [[ -f "$DG_CONFIG" ]] || die "dockergate config not found: $DG_CONFIG"
  fi
  log "pre-check ok: $ref is a CI image and $COMPONENT_SERVICE is a service of the compose project on $local_desc"
}

component_precheck

# The health setting is checked before anything is pulled (it used to be found
# missing only after the service was recreated). dockergate is proven by its
# log and needs no URL.
if [[ "$component" == "dockergate" && -n "$COMPONENT_HEALTH_URL" ]]; then
  log "NOTE: MYR_DOCKERGATE_HEALTH_URL is ignored: the host cannot ping dockergate (the socket answers only the board's main process); dockergate is proven by its self-check log line"
fi

# One source of truth: the previous image is the running container's image.
current_ref="$(component_host_previous_ref)"
override_ref="$(component_host_override_ref)"

# ONE-DEPLOY: an unchanged component is not restarted. It must run the image AND
# its generated override (the boot unit's source) must name it; a stale file next
# to a correct container is repaired without a restart.
if [[ "$current_ref" == "$ref" && "$force" != "1" ]]; then
  if [[ "$override_ref" == "$ref" ]]; then
    log "UNCHANGED: $component already runs $ref; nothing pulled, nothing restarted (use --force to recreate)"
  elif [[ "$DRY_RUN" == "1" ]]; then
    log "UNCHANGED: $component already runs $ref; the override file would be corrected (${override_ref:-<missing>} -> $ref), nothing restarted"
  else
    log "UNCHANGED: $component already runs $ref; correcting the override file (${override_ref:-<missing>} -> $ref), nothing restarted"
    component_write_override "$ref"
  fi
  exit 0
fi

DG_CONFIG="${MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_CONFIG:-}"

# ONE-DEPLOY: the dockergate config is checked with the NEW binary before the
# service is recreated: a config the new dockergate refuses must stop the
# rollout here, not after the proxy of every bot container is down. The same
# check runs in a dry run (the new image is fetched by docker run when it is not
# on the host yet): the plan must fail where the real run fails. The output of
# the check is logged on a refusal (dockergate_check_config_file).
dockergate_config_preflight() {
  if [[ -n "$DG_CONFIG" ]]; then
    # the local-host rule and the config file were checked by component_precheck
    log "dockergate check-config ($DG_CONFIG) with $ref"
    local rc=0
    dockergate_check_config_file "$DG_CONFIG" "$ref" || rc=$?
    ((rc == 0)) || die "dockergate check-config refused $DG_CONFIG with $ref (rc $rc); nothing was recreated"
  else
    log "WARNING: MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_CONFIG is not set; the dockergate config is NOT checked before the recreate"
  fi
}

if [[ "$DRY_RUN" == "1" ]]; then
  [[ "$component" != "dockergate" ]] || dockergate_config_preflight
  log "dry run: nothing will be changed. Component plan (${COMPONENT_HOST%%:*} target):"
  plan "1. component image check passed (read-only): $ref built by CI from commit ${CI_IMAGE_REVISION:0:12}"
  plan "1b. the compose project of the target host validates and defines $COMPONENT_SERVICE (read-only)"
  plan "2. docker pull $ref"
  if [[ "$component" == "dockergate" ]]; then
    plan "2b. dockergate check-config of ${DG_CONFIG:-<no config configured: skipped with a warning>} with the new image passed (read-only), repeated before the recreate"
  fi
  plan "3. remember previous component image (the running container's): ${current_ref:-<none>} -> $COMPONENT_PREVIOUS_FILE"
  plan "4. set image in $COMPONENT_OVERRIDE_PATH; docker compose up -d --no-deps $COMPONENT_SERVICE${COMPONENT_REMOTE:+ (through ssh $COMPONENT_REMOTE)}"
  if [[ "$component" == "dockergate" ]]; then
    plan "5. health: the container runs; its self-check log line reports the new version and the hash of ${DG_CONFIG:-the config}"
  else
    plan "5. health: $COMPONENT_HEALTH_URL"
  fi
  exit 0
fi

log "1/5 pull $ref"
component_docker pull --quiet "$ref" >/dev/null || die "cannot pull $ref"

[[ "$component" != "dockergate" ]] || dockergate_config_preflight

log "2/5 remember previous component image"
mkdir -p "$STATE_DIR"
if [[ -n "$current_ref" && "$current_ref" != "$ref" ]]; then
  printf '%s\n' "$current_ref" >"$COMPONENT_PREVIOUS_FILE"
fi

log "3/5 switch image in $COMPONENT_OVERRIDE_PATH"
component_write_override "$ref"

log "4/5 recreate $COMPONENT_SERVICE"
component_compose up -d --no-deps "$COMPONENT_SERVICE" || die "compose up failed for $COMPONENT_SERVICE"
record_history "deploy-$component" "$ref"

log "5/5 health"
if [[ "$component" == "dockergate" ]]; then
  # The host cannot ping dockergate: its socket answers only the board's main
  # process (403 caller_not_board_main). The container runs, and its newest
  # self-check line has the version of the new binary and the hash of the
  # config it was started with.
  expected_version="$(component_docker run --rm --network none "$ref" version 2>/dev/null | head -n1 || true)"
  [[ -n "$expected_version" ]] || die "cannot read the version of $ref (docker run ... version)"
  expected_hash=""
  [[ -n "$DG_CONFIG" && -f "$DG_CONFIG" ]] && expected_hash="$(dockergate_config_hash "$DG_CONFIG")"
  if ! dockergate_verify_state "$expected_version" "$expected_hash" "$HEALTH_TIMEOUT_SEC"; then
    log "DEGRADED: dockergate did not prove healthy after the recreate (version '${DG_SEEN_VERSION:-<none>}', config hash '${DG_SEEN_HASH:-<none>}'; expected '$expected_version', '${expected_hash:-<not checked>}')"
    log "Roll back the board with: $MYR_SCRIPT_DIR/rollback.sh --config $config"
    log "Roll back this component with: $MYR_SCRIPT_DIR/rollback-component.sh --config $config --component $component"
    exit 1
  fi
  log "dockergate runs: version $DG_SEEN_VERSION, config hash ${DG_SEEN_HASH:-<not logged>}"
else
  # The value is the URL plus any curl arguments it needs (a unix socket, an
  # auth header): word-splitting is intended here.
  health_ok=0
  for _ in $(seq 1 "$((HEALTH_TIMEOUT_SEC / POLL_INTERVAL_SEC + 1))"); do
    # shellcheck disable=SC2086
    if curl -fsS --max-time 10 $COMPONENT_HEALTH_URL >/dev/null 2>&1; then
      health_ok=1
      break
    fi
    sleep "$POLL_INTERVAL_SEC"
  done
  if [[ "$health_ok" != "1" ]]; then
    log "DEGRADED: $component did not answer at $COMPONENT_HEALTH_URL within ${HEALTH_TIMEOUT_SEC}s"
    log "Roll back the board with: $MYR_SCRIPT_DIR/rollback.sh --config $config"
    log "Roll back this component with: $MYR_SCRIPT_DIR/rollback-component.sh --config $config --component $component"
    exit 1
  fi
fi
log "component $component rolled out ($ref, previous: ${current_ref:-<none>})"
