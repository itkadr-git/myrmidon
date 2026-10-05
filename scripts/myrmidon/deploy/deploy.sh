#!/usr/bin/env bash
# Deploys a Myrmidon image by digest. Only images built by CI are deployed.
#
#   deploy.sh --config deploy.env --digest sha256:<64 hex> [--dry-run]
#             [--expect-version V] [--expect-commit SHA] [--force]
#   deploy.sh --config deploy.env --release myr-vX.Y.Z [--dry-run] [--force]
#
# ONE-DEPLOY: --release reads the release's component digests (the board,
# dockergate, fleetd and the bot images) from the machine-readable manifest
# asset of the GitHub release (release-manifest.sh; the digest table of the
# release body for a release that predates the manifest) and updates every
# deployed component in ONE maintenance window: the board, dockergate (its
# config checked with `dockergate check-config` before the recreate, its running
# self-check version verified), fleetd where deployed, and the bot image list in
# dockergate images[] (SIGHUP when dockergate itself is unchanged). A component
# that already runs its release image is not restarted. The window is
# all-or-nothing: when a component fails, every component this deploy changed,
# the dockergate config and the board roll back together
# (MYRMIDON_COMPONENT_AUTO_ROLLBACK=0 keeps the old manual contract). After the
# window the bot cards that track the release image switch in batches of at
# most 5 (see bot-image-rollout.sh). --digest alone (the board-interface job)
# resolves the same release from the board image's version label.
#
# --digest takes sha256:<64 hex> or ghcr.io/itkadr-git/myrmidon@sha256:<64 hex>.
#
# Before anything else (before the pull, the dump and maintenance) the script
# refuses unless: the reference is exactly ghcr.io/itkadr-git/myrmidon@sha256:<64 hex>
# (no tag, no other repository); the image is in the registry; its
# org.opencontainers.image.revision label names a commit that is on origin/main
# or carries a myr-v* tag (git fetch in the clone that holds these scripts).
# There is no flag to skip this check, --force does not skip it either.
# It also refuses when the systemd boot unit (paperclip.service) does not
# start the server from exactly the compose files this deploy manages
# (one boot path: see lib.sh, verify_boot_unit).
#
# PREDEPLOY-DB-CHECK (the 05.10 incident): the board image is proven BEFORE the
# window. The predeploy dump is restored into a throwaway Postgres and the new
# board is started there, next to the NEW dockergate of the same release, on its
# own network (no bot container, no production dockergate). deploy.sh waits for
# `status ok` and walks the attention list and the main company APIs; when the
# image does not come up on the copy, the deploy stops before the maintenance
# window and production is never touched (predeploy-board-check.sh). The 05.10
# board started on CI's empty database and crashed on production data.
#
# Steps: pull the image by digest; remember the current digest as "previous";
# dump the database (DUMP_COMMAND, refuses an empty dump); check the image on a
# copy of that dump (PREDEPLOY-DB-CHECK) and read-only preflight every changed
# component; enter maintenance; wait until no runs are in progress. The window
# drains for the short grace
# (MAINTENANCE_DRAIN_GRACE_SEC, 300 s by default) and then interrupts whatever
# is still running; the interrupted runs are retried when the window closes
# (MAINTENANCE_ON_TIMEOUT=wait keeps the old "wait for the long timeout"
# behaviour). A drain timeout lifts maintenance again and aborts before the
# image changes; then the release COMPONENTS roll out first and the board
# follows: switch the image line in the compose override file and recreate only
# the server service; verify /api/health (status, version,
# commit); leave maintenance (myrmidon EXIT-ASYNC: the exit call returns as soon
# as the window is `leaving`, then the script waits for the window to retire,
# not for the HTTP call); run the post-deploy fleet check (no issue became
# blocked in the deploy window, the window retired).
#
# RELEASE-GATE (the 01.10 incident): the release's component images roll out
# together with the board, in this same run, and BEFORE the board is switched:
# the board is verified against the NEW dockergate, not the running one (the
# 05.10 board never became `ok` against the old dockergate, `route_not_allowed`,
# and dockergate rolled out after the board check — the order was part of the
# incident). After the board image check the matching dockergate and fleetd
# digests are resolved from the same release (same tag: the tag the board image
# was built from, or the short sha of its commit; see
# ../dockergate/check-release-support.sh). A release whose component digests are
# missing is refused BEFORE anything changes. Inside the window every component
# is pulled, switched and health-checked (rollout-component.sh) and only then is
# the board switched and verified; a failing component health is DEGRADED, not
# silent.
#
# myrmidon(BOT-IMAGE-ROLLOUT, 1.6.1): after the components, the BOT images of
# the same release roll out in this same run (bot-image-rollout.sh): the
# digests resolve from the same release, land in dockergate's allowed images
# and the fleet's bots[] enrollment, every bot card switches (canary first,
# one at a time, never interrupting a run), and the superseded bot images
# leave the list. Gated by MYRMIDON_BOT_IMAGE_ROLLOUT (default 1 when the
# board has bot containers configured; 0 restores the manual path).
# Last, a post-deploy smoke (bot-apply-smoke.sh) waits for at least one bot
# container to re-apply; failing that within its window the deploy reports
# DEGRADED and prints the rollback commands.
#
# On a failed health check the script stops with maintenance still on and
# prints the rollback command. --dry-run changes nothing and prints the plan
# (the image checks are read-only, so they run in a dry run too).
#
# PRE-CHECK (the 05.10 incident): every component this deploy is about to roll
# out is pre-checked — its CI image, the target host's compose project (the REAL
# error of `docker compose config` when the project cannot be read, never a
# misleading "not a service"), the service that project declares, the health
# URL — BEFORE the image pull and the database dump, and in a dry run as well.
# A dry run that passes now proves the window gets past its first component
# refusal; on 05.10 it passed and the refusal surfaced after the pull and the
# dump.
#
# TRACING-HEALTH: right after the health check the deploy verifies the LLM
# tracing configuration (tracing-check.sh, step 7b): the callback set is the
# OTLP-only one (a legacy `langfuse` callback against a v4 Langfuse server is
# refused), the gateway delivers OTEL events (an install without an event in
# `events_core`, or a delivery ratio below 50%, is refused), and the Langfuse
# and gateway images carry a full version tag or a digest. A refusal stops the
# deploy like a failed health check — maintenance stays on and the rollback
# command is printed — and there is no flag that skips it. Without a
# MYRMIDON_TRACING_* setting the step logs that it is skipped, so an
# installation without a tracing gateway still deploys.
set -euo pipefail
# shellcheck source=lib.sh source-path=SCRIPTDIR
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

config="" digest="" expect_version="" expect_commit="" force=0 release_tag=""
DRY_RUN=0
while (($#)); do
  case "$1" in
    --config) config="$2"; shift 2 ;;
    --digest) digest="$2"; shift 2 ;;
    --release) release_tag="$2"; shift 2 ;;
    --expect-version) expect_version="$2"; shift 2 ;;
    --expect-commit) expect_commit="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --force) force=1; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n "$digest" || -n "$release_tag" ]] || die "give --digest or --release"
load_config "$config"
require_cmd docker curl jq

# ONE-DEPLOY: the release manifest (components by digest). With --release the
# board digest comes from it and a disagreeing --digest is refused.
manifest_lines=""
MYR_MANIFEST_FILE="${MYRMIDON_RELEASE_MANIFEST_FILE:-}"
read_manifest() {
  if [[ -n "$MYR_MANIFEST_FILE" ]]; then
    "$MYR_SCRIPT_DIR/release-manifest.sh" --from-file "$MYR_MANIFEST_FILE"
  else
    "$MYR_SCRIPT_DIR/release-manifest.sh" --tag "$1"
  fi
}
manifest_digest() { sed -n "s/^$1=//p" <<<"$manifest_lines" | head -n1; }
if [[ -n "$release_tag" ]]; then
  [[ "$release_tag" =~ ^myr-v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "--release must look like myr-vX.Y.Z (got: $release_tag)"
  manifest_lines="$(read_manifest "$release_tag")" || die "cannot read the component digests of release $release_tag; nothing was changed"
  manifest_board="$(manifest_digest board)"
  [[ -n "$manifest_board" ]] || die "release $release_tag names no board image; nothing was changed"
  if [[ -n "$digest" && "${digest#*@}" != "$manifest_board" ]]; then
    die "--digest does not match the board image of release $release_tag ($manifest_board); nothing was changed"
  fi
  digest="$manifest_board"
fi
parse_digest_arg "$digest"

# RELEASE-GATE: which components roll with the board, and the smoke settings.
MYR_RELEASE_COMPONENTS="${MYRMIDON_RELEASE_COMPONENTS:-dockergate,fleetd}"
MYR_SMOKE_ENABLED="${MYRMIDON_DEPLOY_SMOKE:-1}"
MYR_SMOKE_TIMEOUT_SEC="${MYRMIDON_DEPLOY_SMOKE_TIMEOUT_SEC:-300}"
MYR_SMOKE_INTERVAL_SEC="${MYRMIDON_DEPLOY_SMOKE_INTERVAL_SEC:-10}"
MYR_SMOKE_COMPANY="${MYRMIDON_DEPLOY_SMOKE_COMPANY:-}"
MYR_SMOKE_AGENT="${MYRMIDON_DEPLOY_SMOKE_AGENT:-}"
# myrmidon(BOT-IMAGE-ROLLOUT): the bot images of the release roll out in this
# same run, after the components. On by default: the 03.10 incident was the
# board moving while the bots could not follow. 0 restores the manual path
# (and the deploy then warns, because the split is the incident).
MYR_BOT_ROLLOUT_ENABLED="${MYRMIDON_BOT_IMAGE_ROLLOUT:-1}"

# Only CI images reach production: this runs before any other action.
[[ "$MYRMIDON_IMAGE" == "$MYR_CI_IMAGE" ]] \
  || die "MYRMIDON_IMAGE is '$MYRMIDON_IMAGE': only $MYR_CI_IMAGE is deployed (images built by CI); nothing was changed"
ref="$MYRMIDON_IMAGE@$digest"
log "checking that $ref was built by CI"
if ! check_ci_image "$ref"; then
  log "Only images built by the CI workflow 'Myrmidon image' from main or a myr-v* tag are deployed. This check cannot be skipped."
  die "image refused, nothing was changed: $CI_CHECK_REASON"
fi
log "image ok: built by CI from commit ${CI_IMAGE_REVISION:0:12}, version ${CI_IMAGE_VERSION:-<none>}"

# RELEASE-GATE: resolve the component digests of the SAME release before
# anything changes. Order: the myr-vX.Y.Z tag when the board commit carries
# one (version label of a tag build), else the sha-<short> tag of the commit.
# A release whose component digests are missing is refused here: rolling the
# board alone is exactly what the 01.10 incident did to the fleet.
component_digests=""
component_resolution=""
component_source="registry"
bot_digest_args=()
bot_digests_known=0
version_tag=""
if [[ "${CI_IMAGE_VERSION:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  version_tag="$CI_IMAGE_VERSION"
fi
# The job flow (--digest only): the release of the board image is found by its
# version label; its manifest is used when it is published and names this board
# digest, otherwise the registry resolves the components as before.
if [[ -z "$manifest_lines" && -n "$version_tag" ]]; then
  candidate="$(read_manifest "myr-v$version_tag" 2>/dev/null)" || candidate=""
  if [[ -n "$candidate" && "$(sed -n 's/^board=//p' <<<"$candidate" | head -n1)" == "$digest" ]]; then
    manifest_lines="$candidate"
  fi
fi
if [[ -n "$manifest_lines" ]]; then
  component_source="manifest"
  [[ -n "$release_tag" ]] && version_tag="${release_tag#myr-v}"
  [[ -n "$version_tag" ]] && component_resolution="tag $version_tag"
  [[ -n "$component_resolution" ]] || component_resolution="sha ${CI_IMAGE_REVISION:0:7}"
  if [[ -n "$MYR_RELEASE_COMPONENTS" && "$MYR_RELEASE_COMPONENTS" != "none" ]]; then
    missing=""
    for name in $(tr ',' ' ' <<<"$MYR_RELEASE_COMPONENTS"); do
      cdigest="$(manifest_digest "$name")"
      if [[ -n "$cdigest" ]]; then
        component_digests+="$name=$cdigest"$'\n'
      else
        missing="$missing $name"
      fi
    done
    if [[ -n "$missing" ]]; then
      log "Release gate: the release manifest does not name:$missing"
      die "release incomplete: component digests missing ($MYR_RELEASE_COMPONENTS, manifest of $component_resolution)"
    fi
    component_digests="${component_digests%$'\n'}"
  fi
  for name in hermes hermes-dev hermes-node; do
    cdigest="$(manifest_digest "$name")"
    if [[ -n "$cdigest" ]]; then bot_digest_args+=(--digest "$name=$cdigest"); bot_digests_known=1; fi
  done
elif [[ -n "$MYR_RELEASE_COMPONENTS" && "$MYR_RELEASE_COMPONENTS" != "none" ]]; then
  # RELEASE-GATE: resolve the component digests of the SAME release before
  # anything changes. Order: the myr-vX.Y.Z tag when the board commit carries
  # one (version label of a tag build), else the sha-<short> tag of the commit.
  # A release whose component digests are missing is refused here: rolling the
  # board alone is exactly what the 01.10 incident did to the fleet.
  if [[ -n "$version_tag" ]]; then
    component_resolution="tag $version_tag"
    component_digests="$("$MYR_SCRIPT_DIR/../dockergate/check-release-support.sh" --from-tag "$version_tag" --components "$MYR_RELEASE_COMPONENTS" 2>/dev/null)" || component_digests=""
  fi
  if [[ -z "$component_digests" ]]; then
    component_resolution="sha ${CI_IMAGE_REVISION:0:7}"
    component_digests="$("$MYR_SCRIPT_DIR/../dockergate/check-release-support.sh" --from-sha "${CI_IMAGE_REVISION:0:7}" --components "$MYR_RELEASE_COMPONENTS" 2>/dev/null)" || component_digests=""
  fi
  if [[ -z "$component_digests" ]]; then
    log "Release gate: the component images ($MYR_RELEASE_COMPONENTS) of this release ($component_resolution) are not in the registry."
    log "A release must ship its components together with the board; this deploy is refused and nothing was changed."
    log "This cannot be skipped: build and publish the component images from the same commit (the component workflows run on every push to main and every myr-v* tag)."
    die "release incomplete: component digests missing ($MYR_RELEASE_COMPONENTS, resolved by $component_resolution)"
  fi
fi
if [[ -n "$component_digests" ]]; then
  log "release components ($component_resolution, from the $component_source):"
  while IFS= read -r line; do
    [[ -n "$line" ]] && log "  $line"
  done <<<"$component_digests"
fi

# myrmidon(BOT-IMAGE-ROLLOUT): the resolution deploy.sh used for the release,
# passed to bot-image-rollout.sh so it resolves the bot images of the SAME
# release (tag when the board was built from a myr-v* tag, else the short sha).
bot_rollout_resolution="$component_resolution"
bot_rollout_ref=""
if [[ "$bot_rollout_resolution" == "tag "* ]]; then
  bot_rollout_ref="${bot_rollout_resolution#tag }"
elif [[ "$bot_rollout_resolution" == "sha "* ]]; then
  bot_rollout_ref="${bot_rollout_resolution#sha }"
else
  # MYRMIDON_RELEASE_COMPONENTS=none: no resolution was made, but the bot
  # rollout still needs one.
  if [[ -n "$version_tag" ]]; then
    bot_rollout_resolution="tag $version_tag"
    bot_rollout_ref="$version_tag"
  else
    bot_rollout_resolution="sha ${CI_IMAGE_REVISION:0:7}"
    bot_rollout_ref="${CI_IMAGE_REVISION:0:7}"
  fi
fi

# ONE-DEPLOY: the bot image digests are known BEFORE anything changes: from the
# manifest, else from the registry. A release whose bot images are missing is
# refused here, not discovered inside the window.
if [[ "$MYR_BOT_ROLLOUT_ENABLED" == "1" && "$bot_digests_known" != "1" ]]; then
  bot_components="${MYRMIDON_BOT_IMAGE_ROLLOUT_COMPONENTS:-hermes,hermes-dev,hermes-node}"
  if [[ "${bot_rollout_resolution%% *}" == "tag" ]]; then
    bot_lines="$("$MYR_SCRIPT_DIR/../dockergate/check-release-support.sh" --from-tag "$bot_rollout_ref" --components "$bot_components" 2>/dev/null)" || bot_lines=""
  else
    bot_lines="$("$MYR_SCRIPT_DIR/../dockergate/check-release-support.sh" --from-sha "$bot_rollout_ref" --components "$bot_components" 2>/dev/null)" || bot_lines=""
  fi
  if [[ -z "$bot_lines" ]]; then
    log "the bot images of this release ($bot_components, resolved by $bot_rollout_resolution) are not in the registry"
    die "release incomplete: bot image digests missing ($bot_components, resolved by $bot_rollout_resolution); nothing was changed"
  fi
  while IFS= read -r line; do
    [[ -n "$line" ]] && bot_digest_args+=(--digest "$line")
  done <<<"$bot_lines"
  bot_digests_known=1
fi

# myrmidon(BOOT-PATH): one boot path. The boot unit must read exactly the
# compose files this deploy manages, or a reboot restarts the board from
# a different (e.g. vendor) compose file. Refused before anything changes;
# the check is read-only and runs in a dry run too.
if ! verify_boot_unit; then
  log "Only a boot unit pointing at the compose files of this deploy (COMPOSE_DIR, COMPOSE_FILES, the override) is accepted; this cannot be skipped."
  die "boot unit not verified, nothing was changed: $BOOT_UNIT_REASON"
fi
log "boot unit ok: $(boot_unit_path) starts $COMPOSE_SERVICE from COMPOSE_DIR ($COMPOSE_FILES + $COMPOSE_OVERRIDE_FILE)"

previous="$(current_digest)"
previous_image="$(current_image)"

# ONE-DEPLOY: what changes. The board, each release component whose running
# image differs from the release's, and the bot images (dockergate images[]).
board_changed=1
if [[ "$previous" == "$digest" && "$force" != "1" ]]; then
  board_changed=0
fi
# DOCKERGATE-FIRST: set when the board image line is actually written inside the
# window (step 6). The all-or-nothing rollback rolls the board back only then.
board_switched=0
declare -A COMP_REPO=(
  [dockergate]="ghcr.io/itkadr-git/myrmidon-dockergate"
  [fleetd]="ghcr.io/itkadr-git/myrmidon-fleetd"
)
declare -A COMP_REF=() COMP_PRE=()
component_names=()
changed_components=()
if [[ -n "$component_digests" ]]; then
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    name="${line%%=*}"
    cdigest="${line#*=}"
    [[ -n "${COMP_REPO[$name]:-}" ]] || continue
    component_names+=("$name")
    COMP_REF[$name]="${COMP_REPO[$name]}@$cdigest"
    COMP_PRE[$name]="$(component_current_ref "$name")"
    host_var="MYR_$(printf '%s' "$name" | tr '[:lower:]' '[:upper:]')_HOST"
    if [[ "${!host_var:-local}" == "skip" ]]; then
      continue
    fi
    if [[ "${COMP_PRE[$name]}" != "${COMP_REF[$name]}" ]]; then
      changed_components+=("$name")
    fi
  done <<<"$component_digests"
fi
is_changed_component() {
  local want="$1" c
  for c in "${changed_components[@]}"; do [[ "$c" == "$want" ]] && return 0; done
  return 1
}

# The bot images: dockergate's config names them (MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_CONFIG).
DG_CONFIG="${MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_CONFIG:-}"
bot_images_missing=0
if [[ "$MYR_BOT_ROLLOUT_ENABLED" == "1" && -n "$DG_CONFIG" && -f "$DG_CONFIG" && "$bot_digests_known" == "1" ]]; then
  for ((bi = 0; bi < ${#bot_digest_args[@]}; bi += 2)); do
    kv="${bot_digest_args[bi + 1]}"
    bname="${kv%%=*}"
    case "$bname" in
      hermes) brepo="ghcr.io/itkadr-git/myrmidon-hermes" ;;
      hermes-dev) brepo="ghcr.io/itkadr-git/myrmidon-hermes-dev" ;;
      hermes-node) brepo="ghcr.io/itkadr-git/myrmidon-hermes-node" ;;
    esac
    jq -e --arg r "$brepo@${kv#*=}" '(.images // []) | index($r) != null' "$DG_CONFIG" >/dev/null 2>&1 || bot_images_missing=1
  done
fi
need_window=0
if ((board_changed)) || ((${#changed_components[@]} > 0)) || ((bot_images_missing)); then
  need_window=1
fi

if [[ "$MYR_BOT_ROLLOUT_ENABLED" == "1" ]]; then
  [[ -n "$DG_CONFIG" ]] \
    || die "MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_CONFIG is required for the bot image rollout (or set MYRMIDON_BOT_IMAGE_ROLLOUT=0 to roll the bot images by hand); nothing was changed"
fi

if ((need_window == 0)); then
  log "board and every release component already run the release images; nothing to restart (use --force to redeploy the board)"
fi

# ONE-DEPLOY (the 05.10 incident): the read-only pre-check of every component
# this deploy is about to roll out — the CI image, the target host's compose
# project (and the REAL error of `docker compose config` when the project cannot
# be read, instead of a misleading "not a service"), the service it declares and
# the health URL. It runs BEFORE the image pull and the database dump, and it
# runs in a dry run too, so a rehearsal fails exactly where the real window
# would: on 05.10 the dry run passed and the fault surfaced only after the pull
# and the dump. rollout-component.sh --dry-run IS this pre-check.
preflight_components() {
  local name
  for name in "${changed_components[@]}"; do
    log "pre-checking component $name (before the pull and the dump)"
    if ! "$MYR_SCRIPT_DIR/rollout-component.sh" --config "$config" --component "$name" --digest "${COMP_REF[$name]#*@}" --dry-run; then
      die "the pre-check of component $name failed; nothing was pulled and nothing was changed"
    fi
  done
}
preflight_components

if [[ "$DRY_RUN" == "1" ]]; then
  log "dry run: nothing will be changed. Plan:"
  plan "0. image check passed (read-only): $ref is in the registry, commit ${CI_IMAGE_REVISION:0:12} is on origin/main or a myr-v* tag"
  plan "0.5 boot unit check passed (read-only): $(boot_unit_path) reads the compose files of this deploy"
  plan "0.6 release components (${component_resolution:-none}, from the $component_source): board, ${MYR_RELEASE_COMPONENTS//,/, }, bot images; one maintenance window, all-or-nothing"
  if ((board_changed)); then
    plan "board: ${previous_image:-<none>} -> $ref"
  else
    plan "board: unchanged ($ref already runs): not restarted"
  fi
  for name in "${component_names[@]}"; do
    host_var="MYR_$(printf '%s' "$name" | tr '[:lower:]' '[:upper:]')_HOST"
    if [[ "${!host_var:-local}" == "skip" ]]; then
      plan "$name: ${COMP_REF[$name]} (not managed by this deploy: MYR_${name^^}_HOST=skip)"
    elif is_changed_component "$name"; then
      plan "$name: ${COMP_PRE[$name]:-<none>} -> ${COMP_REF[$name]}"
    else
      plan "$name: unchanged (${COMP_REF[$name]}): not restarted"
    fi
  done
  if [[ "$MYR_BOT_ROLLOUT_ENABLED" == "1" ]]; then
    plan "bot images: add the release's hermes/hermes-dev/hermes-node digests to images[] of $DG_CONFIG (check-config, SIGHUP when dockergate itself is unchanged); then the bot cards that track the release switch in batches of at most 5, only while paused or idle"
  else
    plan "bot images: rollout disabled (MYRMIDON_BOT_IMAGE_ROLLOUT=0): the bot images of the release do NOT roll out with the board; move the bots by hand"
  fi
  if ((need_window)); then
    plan "1. docker pull $ref"
    plan "2. remember previous image: ${previous_image:-<none>} -> $PREVIOUS_IMAGE_FILE"
    plan "3. dump database with DUMP_COMMAND into $DUMP_DIR (refuse if smaller than $DUMP_MIN_BYTES bytes)"
    if ((board_changed)) && [[ "${MYRMIDON_PREDEPLOY_CHECK:-1}" == "1" ]]; then
      plan "3b. prove the image on a copy of the production database BEFORE the window (PREDEPLOY-DB-CHECK, predeploy-board-check.sh): own Postgres restored from the dump, own network, the NEW dockergate next to it; wait for status ok and walk the attention list and the main APIs; a failure stops the deploy here, production untouched"
    elif ((board_changed)); then
      plan "3b. PREDEPLOY-DB-CHECK disabled (MYRMIDON_PREDEPLOY_CHECK=0): the image is deployed WITHOUT being proven on a copy of the production database"
    else
      plan "3b. board unchanged: nothing to prove on the copy"
    fi
    plan "4. enter maintenance (MAINTENANCE_MODE=$MAINTENANCE_MODE, onTimeout=$MAINTENANCE_ON_TIMEOUT, grace ${MAINTENANCE_DRAIN_GRACE_SEC}s)"
    plan "5. wait for zero running runs (timeout ${RUNS_WAIT_TIMEOUT_SEC}s); onTimeout=$MAINTENANCE_ON_TIMEOUT drains for the grace and then interrupts what is still running (retried after the window closes); on a drain timeout maintenance is lifted and the deploy aborts before the image changes"
    plan "5b. inside the window, BEFORE the board is switched: dockergate config (bot images) + the changed components (${changed_components[*]:-none}); each verified; the board is then checked against the NEW dockergate; ANY failure rolls the changed components, the dockergate config and (only if switched) the board back together"
    plan "6. set image in $OVERRIDE_PATH to $ref; docker compose up -d --no-deps $COMPOSE_SERVICE"
    plan "7. verify $HEALTH_URL: status ok, version ${expect_version:-<from image label>}, commit ${expect_commit:-<from image label>}"
    plan "7b. verify the LLM tracing callbacks (OTLP only; refuses the legacy 'langfuse' callback against a v4 Langfuse server; logs a skip when no MYR_TRACING_* input is configured)"
    plan "8. leave maintenance (the exit POST returns when the window is marked leaving; the deploy waits for the state off, MAINTENANCE_EXIT_WAIT_SEC=${MAINTENANCE_EXIT_WAIT_SEC}s); then the post-deploy fleet check (no issue blocked in the deploy window, the window retired; needs BOARD_API_URL/BOARD_COMPANY_ID, otherwise skipped)"
  fi
  if [[ "$MYR_SMOKE_ENABLED" == "1" ]]; then
    plan "10. post-deploy smoke: wait for a bot container to re-apply (bot-apply-smoke.sh, timeout ${MYR_SMOKE_TIMEOUT_SEC}s); on failure the deploy reports DEGRADED and prints the rollback commands"
  fi
  exit 0
fi

# ---- helpers of the window ---------------------------------------------------
DG_CFG_BACKUP="$STATE_DIR/dockergate-config.pre-deploy"
dg_cfg_saved=0
rolled_components=()

# ONE-DEPLOY: all-or-nothing. Restores, in reverse order, everything this deploy
# changed inside the window: the dockergate config, every component it
# switched (to the image it ran before, from the pre-state recorded above) and
# the board. Maintenance is lifted by rollback.sh once the board is healthy
# again; on any failure here maintenance stays on.
rollback_everything() {
  local what="$1" ok=1 i name
  log "ROLLING BACK TOGETHER: $what failed; restoring the board and every component this deploy changed"
  if ((dg_cfg_saved)) && [[ -f "$DG_CFG_BACKUP" ]]; then
    if cp -p "$DG_CFG_BACKUP" "$DG_CONFIG"; then
      log "restored the dockergate config"
    else
      ok=0
      log "FAILED to restore the dockergate config from $DG_CFG_BACKUP"
    fi
  fi
  for ((i = ${#rolled_components[@]} - 1; i >= 0; i--)); do
    name="${rolled_components[i]}"
    rb_args=(--config "$config" --component "$name")
    [[ -n "${COMP_PRE[$name]}" ]] && rb_args+=(--to-image "${COMP_PRE[$name]}")
    if "$MYR_SCRIPT_DIR/rollback-component.sh" "${rb_args[@]}"; then
      log "rolled $name back"
    else
      ok=0
      log "FAILED to roll $name back"
    fi
  done
  # dockergate stayed on its image but its config changed: tell it to re-read.
  if ((dg_cfg_saved)) && ! is_changed_component dockergate && [[ -n "${MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_SIGNAL_COMMAND:-}" ]]; then
    bash -c "$MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_SIGNAL_COMMAND" || { ok=0; log "FAILED to signal dockergate after the config restore"; }
  fi
  # DOCKERGATE-FIRST: the components now roll out BEFORE the board is switched,
  # so a component failure can happen with the board never touched. Rolling a
  # board that was not switched back would restart it for nothing.
  if ((board_switched)); then
    "$MYR_SCRIPT_DIR/rollback.sh" --config "$config" || { ok=0; log "FAILED to roll the board back"; }
  else
    log "the board image was not switched: nothing to roll back, maintenance is lifted as is"
    maintenance_exit || { ok=0; log "could not lift maintenance"; }
  fi
  if ((ok)); then
    log "ROLLED BACK: the deploy of $ref failed at $what and everything returned to the previous state; maintenance is lifted"
  else
    log "ROLLBACK INCOMPLETE: see the FAILED lines above; maintenance may still be on. Dump: ${LAST_DUMP_FILE:-<none>}"
  fi
  exit 1
}

# 7c: the components and the dockergate config, inside the window.
roll_components_in_window() {
  local name post rc
  if [[ "$MYR_BOT_ROLLOUT_ENABLED" == "1" ]]; then
    mkdir -p "$STATE_DIR"
    cp -p "$DG_CONFIG" "$DG_CFG_BACKUP" || { log "cannot back up $DG_CONFIG"; return 1; }
    dg_cfg_saved=1
    local cfg_args=(--config "$config" --phase config --resolution "${bot_rollout_resolution%% *}" --ref "$bot_rollout_ref" "${bot_digest_args[@]}")
    if is_changed_component dockergate; then
      # the recreate that follows reads the file at start; check-config here
      # runs with the NEW dockergate image
      cfg_args+=(--no-reload --dockergate-image "${COMP_REF[dockergate]}")
    fi
    log "7c/8 dockergate config: bot images and enrollment"
    "$MYR_SCRIPT_DIR/bot-image-rollout.sh" "${cfg_args[@]}" || { log "FAILED: dockergate config / bot images"; return 1; }
  fi
  for name in "${component_names[@]}"; do
    is_changed_component "$name" || { log "component $name unchanged: not restarted"; continue; }
    log "rolling out $name at ${COMP_REF[$name]#*@}"
    rc=0
    "$MYR_SCRIPT_DIR/rollout-component.sh" --config "$config" --component "$name" --digest "${COMP_REF[$name]#*@}" || rc=$?
    post="$(component_current_ref "$name")"
    # a component whose override moved (even when its health then failed) must
    # roll back with the rest
    [[ "$post" != "${COMP_PRE[$name]}" ]] && rolled_components+=("$name")
    ((rc == 0)) || { log "FAILED: component $name"; return 1; }
  done
  return 0
}

fail_window() {
  local what="$1"
  if [[ "${MYRMIDON_COMPONENT_AUTO_ROLLBACK:-1}" == "1" ]]; then
    rollback_everything "$what"
  fi
  log "DEPLOY FAILED at $what; automatic rollback is off (MYRMIDON_COMPONENT_AUTO_ROLLBACK=0). Maintenance stays on."
  log "Roll back with: $MYR_SCRIPT_DIR/rollback.sh --config $config; components: $MYR_SCRIPT_DIR/rollback-component.sh --config $config --component <dockergate|fleetd>"
  exit 1
}

if ((need_window == 0)); then
  # Nothing to restart. The bot cards (and an images[] that needs no window)
  # are still reconciled below.
  deploy_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  LAST_DUMP_FILE=""
else
if ((board_changed)); then
log "1/8 pull $ref"
docker pull --quiet "$ref" >/dev/null || die "cannot pull $ref"
[[ -n "$expect_version" ]] || expect_version="$(image_label "$ref" org.opencontainers.image.version)"
[[ -n "$expect_commit" ]] || expect_commit="$(image_label "$ref" org.opencontainers.image.revision)"
[[ -n "$expect_version" || -n "$expect_commit" ]] || die "image has no version/revision labels; pass --expect-version and --expect-commit"

log "2/8 previous image: ${previous_image:-<none>}"
mkdir -p "$STATE_DIR"
# myrmidon(R4): a forced redeploy of the same image must not overwrite the real previous one.
if [[ -n "$previous" && "$previous" != "$digest" ]]; then
  printf '%s\n' "$previous" >"$PREVIOUS_FILE"
fi
# myrmidon(R4): the full reference, so rollback also works from a vendor image.
if [[ -n "$previous_image" && "$previous_image" != "$ref" ]]; then
  printf '%s\n' "$previous_image" >"$PREVIOUS_IMAGE_FILE"
fi

log "3/8 database dump"
take_dump "${digest#sha256:}"
LAST_DUMP_FILE="${LAST_DUMP_FILE:-}"
fi

# PREDEPLOY-DB-CHECK (the 05.10 incident): the new board image must come up on a
# COPY of the production database, next to the NEW dockergate of the same
# release, BEFORE the maintenance window opens. A failure here stops the deploy
# with nothing on production changed; the 1.6.3 board instead crashed inside the
# window on data only production has (an attention card whose key was not a
# uuid). The check is read-only against production: the dump was already taken.
if ((board_changed)); then
  dockergate_digest="$(sed -n 's/^dockergate=//p' <<<"$component_digests" | head -n1)"
  check_args=(--config "$config" --digest "$digest" --dump "$LAST_DUMP_FILE")
  [[ -n "$dockergate_digest" ]] && check_args+=(--dockergate-digest "$dockergate_digest")
  log "3b/8 prove the image on a copy of the production database (PREDEPLOY-DB-CHECK)"
  if ! "$MYR_SCRIPT_DIR/predeploy-board-check.sh" "${check_args[@]}"; then
    log "DEPLOY STOPPED BEFORE THE WINDOW: $ref was not proven on a copy of the production database."
    log "Nothing on production was changed: no maintenance window was entered, the running board and its data are untouched."
    log "Fix the image (or the throwaway copy's environment) and deploy again; the predeploy dump ${LAST_DUMP_FILE:-<none>} reproduces the data by hand."
    exit 1
  fi
fi

# myrmidon(POST-DEPLOY-CHECK): the deploy window starts when the first
# board-affecting step runs (the maintenance enter below). Issues blocked after
# this moment are the failure signature the post-deploy check looks for.
deploy_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

log "4/8 enter maintenance"
# ROLLBACK-WITHOUT-BOARD's counterpart: maintenance_enter now reports an enter
# that did not happen, so it is handled instead of swallowed (05.10: a silent
# failure reported "entered" and the deploy switched the board anyway). In api
# mode a board that does not answer cannot count running runs either, so the
# drain wait below aborts before the image changes — the message the operator
# needs is the drain one. In hook mode a broken MAINTENANCE_ENTER_COMMAND stops
# the deploy here: it must not switch the image into a fleet that is running.
if ! maintenance_enter "deploy $MYRMIDON_IMAGE@${digest:0:19}"; then
  if [[ "$MAINTENANCE_MODE" == "api" ]]; then
    log "WARNING: the maintenance window is not on (the board API did not answer); the drain wait below decides"
  else
    die "cannot enter maintenance (MAINTENANCE_MODE=$MAINTENANCE_MODE); nothing was changed"
  fi
fi

log "5/8 wait for running runs"
# myrmidon(DEPLOY-TIMEOUT-EXIT): the drain happens with maintenance already on,
# so a failed wait must not die inside wait_for_idle_runs and leave the board in
# maintenance until someone lifts it by hand. The wait returns 1 instead of
# dying; here we lift maintenance, then die, so the board serves traffic again
# and the image has not changed (nothing after this point ran). The state flag
# keeps the final message true when the lift itself fails (maintenance may
# already be off): then the reason stays "the drain did not finish", and the
# operator is told maintenance is still on, not that it was lifted.
if ! wait_for_idle_runs; then
  log "drain failed; lifting maintenance before aborting (image not changed)"
  lift_ok=1
  maintenance_exit || lift_ok=0
  if ((lift_ok == 0)); then
    log "WARNING: could not lift maintenance (it may already be off); check $MAINTENANCE_MODE manually"
    die "runs: deploy aborted before changing the image; maintenance lift failed (see WARNING above)"
  fi
  die "runs: deploy aborted before changing the image; maintenance was lifted"
fi

# DOCKERGATE-FIRST (the 05.10 incident): the components of the same release roll
# out in THIS window and BEFORE the board is switched, so the board is verified
# against the NEW dockergate: the 1.6.3 board never became `ok` against the old
# one (`route_not_allowed`) while dockergate rolled out after the board check.
# Any failure rolls the changed components, the dockergate config and (only if
# it was switched) the board back together (all-or-nothing).
if ! roll_components_in_window; then
  fail_window "the component rollout"
fi

if ((board_changed)); then
log "6/8 switch image and recreate $COMPOSE_SERVICE"
write_override "$digest"
if [[ "$force" == "1" ]]; then
  compose up -d --no-deps --force-recreate "$COMPOSE_SERVICE"
else
  compose up -d --no-deps "$COMPOSE_SERVICE"
fi
board_switched=1
record_history deploy "$digest"

log "7/8 verify health"
if ! "$MYR_SCRIPT_DIR/verify-health.sh" --url "$HEALTH_URL" --timeout "$HEALTH_TIMEOUT_SEC" \
  --expect-version "$expect_version" --expect-commit "$expect_commit" \
  ${HEALTH_TOKEN_FILE:+--token-file "$HEALTH_TOKEN_FILE"} --interval "$POLL_INTERVAL_SEC"; then
  log "DEPLOY FAILED: $ref is running but health does not match. Maintenance stays on."
  log "Roll back with: $MYR_SCRIPT_DIR/rollback.sh --config $config"
  log "Pre-deploy dump: $LAST_DUMP_FILE"
  exit 1
fi

# TRACING-HEALTH: the gateway must carry the OTLP-only callback set. A legacy
# `langfuse` callback against a v4 Langfuse server makes the gateway reject
# about 12k events per hour while everything looks healthy, so a refusal stops
# the deploy exactly like a failed health check (maintenance stays on, the
# rollback command is printed). The check is read-only: without a
# MYRMIDON_TRACING_* setting it logs a skip and the deploy continues.
log "7b/8 verify LLM tracing callbacks"
if ! "$MYR_SCRIPT_DIR/tracing-check.sh" \
  --langfuse-url "${MYRMIDON_TRACING_LANGFUSE_URL:-}" \
  --langfuse-version "${MYRMIDON_TRACING_LANGFUSE_VERSION:-}" \
  --gateway-config "${MYRMIDON_TRACING_GATEWAY_CONFIG:-}" \
  --callbacks-command "${MYRMIDON_TRACING_CALLBACKS_COMMAND:-}" \
  --intended-file "${MYRMIDON_TRACING_CALLBACKS_FILE:-$(tracing_callbacks_file_default)}" \
  --delivery-command "${MYRMIDON_TRACING_DELIVERY_COMMAND:-}" \
  --delivery-window "${MYRMIDON_TRACING_DELIVERY_WINDOW_SEC:-900}" \
  --langfuse-image "${MYRMIDON_TRACING_LANGFUSE_IMAGE:-}" \
  --gateway-image "${MYRMIDON_TRACING_GATEWAY_IMAGE:-}" \
  ${MYRMIDON_TRACING_TOKEN_FILE:+--token-file "$MYRMIDON_TRACING_TOKEN_FILE"}; then
  log "DEPLOY FAILED: $ref is running and healthy, but the LLM tracing checks are refused. Maintenance stays on."
  log "Fix the tracing configuration (OTLP only, 'langfuse_otel'; a delivering install; pinned images) and run the deploy again."
  log "Roll back with: $MYR_SCRIPT_DIR/rollback.sh --config $config"
  exit 1
fi
fi

log "8/8 leave maintenance"
# myrmidon(EXIT-ASYNC): the exit POST returns once the window is marked
# `leaving`; maintenance_exit then waits (bounded) for the window to retire, so
# the deploy waits on the STATE, not on the HTTP call.
maintenance_exit
fi

# myrmidon(POST-DEPLOY-CHECK): the board is live again — prove the deploy did
# not leave the fleet stalled. A degraded verdict does NOT fail the deploy (the
# image is switched and healthy); it is reported loudly so the operator reacts
# at once instead of finding a stalled team by hand.
if ((need_window)); then
  log "post-deploy fleet check"
  if ! post_deploy_fleet_check "$deploy_started_at"; then
    log "DEPLOY DEGRADED: $ref is running and healthy, but the post-deploy check reported problems above; inspect the board now"
  fi
  log "deployed $ref (previous: ${previous:-<none>}, dump: ${LAST_DUMP_FILE:-<none>})"
fi

# ONE-DEPLOY: the bot cards. With the window above the config phase already ran
# inside it; without a window the whole rollout runs here. A failure is
# DEGRADED (the board and the components are healthy); the rollback commands
# are printed. Batches of at most 5, only while paused or idle.
if [[ "$MYR_BOT_ROLLOUT_ENABLED" == "1" ]]; then
  bot_phase="all"; ((need_window)) && bot_phase="cards"
  log "9/10 bot cards ($bot_rollout_resolution, phase $bot_phase)"
  bot_rollout_args=(--config "$config" --phase "$bot_phase" --resolution "${bot_rollout_resolution%% *}" --ref "$bot_rollout_ref" "${bot_digest_args[@]}")
  [[ -n "${MYRMIDON_BOT_IMAGE_ROLLOUT_CANARY:-}" ]] && bot_rollout_args+=(--canary "$MYRMIDON_BOT_IMAGE_ROLLOUT_CANARY")
  if ! "$MYR_SCRIPT_DIR/bot-image-rollout.sh" "${bot_rollout_args[@]}"; then
    log "DEGRADED: the bot image rollout failed; the board and the components are healthy, see the bot rollout log above"
    log "Roll back the board with: $MYR_SCRIPT_DIR/rollback.sh --config $config"
    log "Roll back a component with: $MYR_SCRIPT_DIR/rollback-component.sh --config $config --component <dockergate|fleetd>"
    log "Roll the bot images by hand with: $MYR_SCRIPT_DIR/bot-image-rollout.sh --config $config --resolution ${bot_rollout_resolution%% *} --ref $bot_rollout_ref"
    exit 1
  fi
else
  log "WARNING: MYRMIDON_BOT_IMAGE_ROLLOUT=0: the bot images of this release did not roll out with the board; move the bots by hand (this split is the 03.10 incident)"
fi

# RELEASE-GATE: post-deploy smoke. Within MYR_SMOKE_TIMEOUT_SEC at least one
# bot container must re-apply; otherwise the deploy is DEGRADED with the
# rollback commands. Skipped only when explicitly disabled or unconfigured
# (no company): an unconfigured smoke on a bot fleet is itself reported.
if [[ "$MYR_SMOKE_ENABLED" == "1" ]]; then
  if [[ -z "$MYR_SMOKE_COMPANY" ]]; then
    log "WARNING: post-deploy bot smoke skipped: MYRMIDON_DEPLOY_SMOKE_COMPANY is not set; the deploy cannot prove a bot re-applied"
  else
    log "10/10 post-deploy smoke: waiting for a bot container to re-apply"
    smoke_args=(--board-url "${BOARD_API_URL:-$MAINTENANCE_API_URL}" --company "$MYR_SMOKE_COMPANY" --timeout "$MYR_SMOKE_TIMEOUT_SEC" --interval "$MYR_SMOKE_INTERVAL_SEC")
    [[ -n "$MYR_SMOKE_AGENT" ]] && smoke_args+=(--agent "$MYR_SMOKE_AGENT")
    [[ -n "$HEALTH_TOKEN_FILE" ]] && smoke_args+=(--token-file "$HEALTH_TOKEN_FILE")
    if ! "$MYR_SCRIPT_DIR/bot-apply-smoke.sh" "${smoke_args[@]}"; then
      log "DEGRADED: no bot container re-applied within ${MYR_SMOKE_TIMEOUT_SEC}s"
      log "Roll back the board with: $MYR_SCRIPT_DIR/rollback.sh --config $config"
      log "Roll back a component with: $MYR_SCRIPT_DIR/rollback-component.sh --config $config --component <dockergate|fleetd>"
      exit 1
    fi
  fi
fi

log "release gate passed: board and ${MYR_RELEASE_COMPONENTS:-no components} rolled out together, bots re-apply"
