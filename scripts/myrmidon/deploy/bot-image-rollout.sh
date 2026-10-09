#!/usr/bin/env bash
# scripts/myrmidon/deploy/bot-image-rollout.sh
#
# myrmidon(BOT-IMAGE-ROLLOUT, 1.6.1): rolls the bot runtime images of the SAME
# release out together with the board, without manual steps. The 03.10
# incident: the board became 1.6.0 while the dev bots stayed on the old
# hermes-dev image, the new image was not even in dockergate's `images` list,
# and the operator moved the bots by hand. This script is the automatic path.
# deploy.sh calls it after the component rollout; it can also run alone.
#
#   bot-image-rollout.sh --config deploy.env --resolution tag|sha --ref <ref>
#                        [--dry-run] [--canary <agentId>]
#                        [--retry-deferred [--wait-sec N]]
#
# --resolution/--ref are what deploy.sh resolved the release by: "tag
# myr-vX.Y.Z" or "sha <7 hex>". The bot images resolve from the same release
# the same way dockergate and fleetd do (../dockergate/check-release-support.sh):
# the bot image workflow tags sha-<short> and myr-vX.Y.Z like every component.
#
# Steps (fail-closed; nothing changes before the checks pass):
#
#   1. Resolve the bot image digests of the release (hermes, hermes-dev,
#      hermes-node). A release whose bot images are missing from the registry
#      is refused before anything changes — rolling the board while the bots
#      cannot follow is exactly the 03.10 split.
#   2. Pull every resolved image on the local host and on every configured
#      fleet host (the container driver never pulls).
#   3. Add the new digests to dockergate's allowed `images` (a structural jq
#      edit of MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_CONFIG, verified with
#      `dockergate check-config` when a command is configured), then SIGHUP.
#      The OLD bot images stay allowed until the last bot moved: a
#      mid-rollout failure must not strand the un-moved bots.
#   4. Enroll the fleet in `bots[]`: the board's agent cards are the source of
#      truth. A bot missing from `bots[]` is exactly the `bot_not_enrolled`
#      refusal Wiki Maintainer hit on 03.10. Limits come from the card
#      (container.memoryMb/cpus/pidsLimit), read together with the rest of the
#      card config from GET /companies/:id/agent-configurations (the company
#      agents list carries no adapterConfig — PERF-DIET-G).
#   5. Switch the bot cards to the release image, one bot at a time (canary
#      first when --canary names one): PATCH the card's
#      adapterConfig.container.image, then POST the card's "apply" so the
#      board's own reconciler drains that agent alone and recreates the
#      container. A busy bot (agent status not paused/idle, or an apply that
#      answers `deferred`) does NOT hold its batch: it moves to a tail list
#      (deferred_tail) and the batch ends as soon as its other bots are done,
#      so the next batch starts at once (the rc.3/rc.5 lesson: one busy bot
#      made every batch wait MYRMIDON_BOT_IMAGE_ROLLOUT_BOT_TIMEOUT_SEC).
#      After the last batch the tail pass retries the deferred bots until the
#      same deadline, and past it the optional force stage
#      (MYRMIDON_BOT_IMAGE_ROLLOUT_FORCE_DEFERRED_SEC, default 0 = OFF; set
#      it to a number of seconds to opt in) applies them without the status
#      gate. The reconciler then opens a maintenance window and drains for
#      300 s; a longer run is interrupted by the maintenance, so the stage is
#      an explicit operator choice, never the default.
#      A failed apply never leaves a card switched while the container stays
#      on the old image: the card goes back to its previous container block.
#   5b. F-04 verification (1.6.5): after the batches, compare FACT for every
#      tracking bot — the card's image (adapterConfig.container.image from
#      the board API) against the running container's image
#      (bot-container/status, the same board call the async apply confirm
#      already reads; the board answers it from docker inspect on the deploy
#      host, so no new docker transport is introduced here). Print a
#      per-bot table and the summary switched / deferred(running) / mismatch
#      / failed. DEGRADED (exit 1) only when mismatch > 0 or failed > 0; a
#      deferred bot is not a failure — it prints a WARNING with the
#      --retry-deferred command to re-run when the bot goes quiet.
#   5c. --retry-deferred [--wait-sec N] (default N=30): the standard re-run
#      pass. It reads the previous run's summary (the deferredBots list in
#      $STATE_DIR/bot-image-rollout-summary.json), re-switches ONLY those
#      bots — waiting N seconds per bot before each attempt, never
#      interrupting a running agent — then repeats the 5b verification and
#      applies the same exit rules.
#   6. After every bot runs a release image, remove the superseded bot image
#      refs from `images` (only refs of our three bot repositories, never a
#      pinned one) and SIGHUP again. Deferred bots keep the old refs listed.
#   7. Journal: every switch is appended to
#      $STATE_DIR/bot-image-rollout.log (UTC timestamp, agent id, old image ->
#      new image, outcome), and to the deploy history (record_history).
#
# The board API (BOARD_API_URL, BOARD_TOKEN_FILE) and the agents list of
# BOARD_COMPANY_ID are required: the bot cards are the board's data. Missing
# configuration refuses before anything changes.
#
# ONE-DEPLOY additions:
#   --phase config   steps 1-4 only (resolve, pull, images[], bots[]): deploy.sh
#                    runs it inside the maintenance window, together with the
#                    dockergate swap, so a failure rolls back with the rest.
#   --phase cards    steps 5-6 only (the bot cards, the superseded images):
#                    deploy.sh runs it after the window closes.
#   --phase all      (default) everything, for a standalone run.
#   --no-reload      edit the dockergate config but do not SIGHUP (dockergate is
#                    recreated right after and reads the file at start).
#   --dockergate-image <ref>  the dockergate image check-config runs with when no
#                    check command is configured.
#   --digest name=sha256:<64 hex>  (repeatable) a digest the release manifest
#                    already named; without it the digests resolve from the
#                    registry by tag or sha.
# Every container bot is reported in exactly one category (never silently
# skipped; the same categories as the board's bot-container status API):
#   tracks_release  an enabled, complete card on a digest of one of our bot
#                   repositories: moved to the release image of that repository;
#   pinned          an enabled, complete card on any other image: left alone,
#                   listed with its image;
#   not_applicable  a card with a container block the board does not manage
#                   (not enabled, incomplete limits, a shared group): listed with
#                   the reason.
# The summary carries the count of each and the list of the pinned and the
# not applicable bots; the PATCH of a card sends the WHOLE container block with
# the new image (the board merges adapterConfig one level deep, so an
# image-only patch would drop enabled and the limits).
# Cards: a card TRACKS the release when its image is a digest-pinned image of one
# of our bot repositories (hermes, hermes-dev, hermes-node) that is not the
# release's image of that repository; it moves to the release image of the SAME
# repository. Any other card image (another repository, a tag, none) is PINNED
# and left alone. Cards switch in batches of at most 5, and a bot is switched
# only while its agent is paused or idle; every batch and every failure is
# reported (log lines, the journal and $STATE_DIR/bot-image-rollout-summary.json).
#
# Exit codes: 0 = rolled out (or dry run; deferred bots alone exit 0 with the
# WARNING and the --retry-deferred command above); 1 = DEGRADED failure —
# failed > 0 or a card/container mismatch (see the verification table above).
set -euo pipefail
# shellcheck source=lib.sh source-path=SCRIPTDIR
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

config="" resolution="" res_ref=""
DRY_RUN=0 canary="" phase="all" no_reload=0 dockergate_image=""
RETRY_DEFERRED=0 wait_sec=""
declare -A GIVEN_DIGESTS=()
while (($#)); do
  case "$1" in
    --phase) phase="$2"; shift 2 ;;
    --no-reload) no_reload=1; shift ;;
    --dockergate-image) dockergate_image="$2"; shift 2 ;;
    --digest)
      [[ "$2" =~ ^(hermes|hermes-dev|hermes-node)=sha256:[0-9a-f]{64}$ ]] || die "--digest takes name=sha256:<64 hex> for hermes, hermes-dev or hermes-node (got '$2')"
      GIVEN_DIGESTS["${2%%=*}"]="${2#*=}"; shift 2 ;;
    --config) config="$2"; shift 2 ;;
    --resolution) resolution="$2"; shift 2 ;;
    --ref) res_ref="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --canary) canary="$2"; shift 2 ;;
    --retry-deferred) RETRY_DEFERRED=1; shift ;;
    --wait-sec)
      [[ "${2:-}" =~ ^[0-9]+$ ]] || die "--wait-sec takes a non-negative whole number of seconds (got '${2:-}')"
      wait_sec="$2"; shift 2 ;;
    -h|--help) sed -n '2,111p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n "$config" ]] || die "--config is required"
[[ "$phase" == "all" || "$phase" == "config" || "$phase" == "cards" ]] || die "--phase must be all, config or cards"
[[ "$RETRY_DEFERRED" != "1" || "$phase" != "config" ]] || die "--retry-deferred re-switches bot cards; it cannot run with --phase config"
[[ "$resolution" == "tag" || "$resolution" == "sha" ]] \
  || die "--resolution must be tag or sha (what deploy.sh resolved the release by)"
[[ -n "$res_ref" ]] || die "--ref is required (the release tag, or the commit short sha)"
load_config "$config"
require_cmd docker curl jq

# --- settings (see deploy.env.example) ---------------------------------------
MYR_BOT_COMPONENTS="${MYRMIDON_BOT_IMAGE_ROLLOUT_COMPONENTS:-hermes,hermes-dev,hermes-node}"
MYR_BOT_TIMEOUT_SEC="${MYRMIDON_BOT_IMAGE_ROLLOUT_BOT_TIMEOUT_SEC:-900}"
# BOT-ROLLOUT-SKIP-BUSY: how long after the tail-pass deadline the
# still-deferred bots are applied WITHOUT the status gate. The reconciler
# drains only 300 s, then the maintenance interrupts a longer run, so the
# stage is OFF by default (0) and runs only when an operator sets a number of
# seconds explicitly.
MYR_BOT_FORCE_DEFERRED_SEC="${MYRMIDON_BOT_IMAGE_ROLLOUT_FORCE_DEFERRED_SEC:-0}"
[[ "$MYR_BOT_FORCE_DEFERRED_SEC" =~ ^[0-9]+$ ]] \
  || die "MYRMIDON_BOT_IMAGE_ROLLOUT_FORCE_DEFERRED_SEC must be a non-negative integer (got '$MYR_BOT_FORCE_DEFERRED_SEC')"
# 1.6.5 async "Apply now": how long to wait for ONE apply job (202 + applyId)
# to reach succeeded|failed, and how often the job is read.
MYR_BOT_APPLY_WAIT_SEC="${MYRMIDON_BOT_IMAGE_ROLLOUT_APPLY_WAIT_SEC:-300}"
MYR_BOT_APPLY_POLL_SEC="${MYRMIDON_BOT_IMAGE_ROLLOUT_APPLY_POLL_SEC:-4}"
[[ "$MYR_BOT_APPLY_WAIT_SEC" =~ ^[0-9]+$ ]] || die "MYRMIDON_BOT_IMAGE_ROLLOUT_APPLY_WAIT_SEC must be a non-negative integer (got '$MYR_BOT_APPLY_WAIT_SEC')"
[[ "$MYR_BOT_APPLY_POLL_SEC" =~ ^[1-9][0-9]*$ ]] || die "MYRMIDON_BOT_IMAGE_ROLLOUT_APPLY_POLL_SEC must be a positive integer (got '$MYR_BOT_APPLY_POLL_SEC')"
# F-04 (1.6.5): --retry-deferred waits this many seconds per deferred bot
# before re-applying (the --wait-sec flag overrides; decision 06.10 item 3).
MYR_BOT_RETRY_WAIT_SEC="${MYRMIDON_BOT_IMAGE_ROLLOUT_RETRY_WAIT_SEC:-30}"
[[ "$MYR_BOT_RETRY_WAIT_SEC" =~ ^[0-9]+$ ]] || die "MYRMIDON_BOT_IMAGE_ROLLOUT_RETRY_WAIT_SEC must be a non-negative integer (got '$MYR_BOT_RETRY_WAIT_SEC')"
[[ -z "$wait_sec" ]] || MYR_BOT_RETRY_WAIT_SEC="$wait_sec"
MYR_BOT_DOCKERGATE_CONFIG="${MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_CONFIG:-}"
MYR_BOT_DOCKERGATE_SIGNAL="${MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_SIGNAL_COMMAND:-}"
MYR_BOT_FLEET_HOSTS="${MYRMIDON_BOT_IMAGE_ROLLOUT_FLEET_HOSTS:-}"
MYR_BOT_ROLLOUT_LOG="${MYRMIDON_BOT_IMAGE_ROLLOUT_LOG:-$STATE_DIR/bot-image-rollout.log}"
MYR_BOT_SUMMARY="${MYRMIDON_BOT_IMAGE_ROLLOUT_SUMMARY:-$STATE_DIR/bot-image-rollout-summary.json}"
# Hard cap 5: never more than five containers are recreated at once.
MYR_BOT_BATCH="${MYRMIDON_BOT_IMAGE_ROLLOUT_BATCH_SIZE:-5}"
[[ "$MYR_BOT_BATCH" =~ ^[1-9][0-9]*$ ]] || die "MYRMIDON_BOT_IMAGE_ROLLOUT_BATCH_SIZE must be a positive integer (got '$MYR_BOT_BATCH')"
((MYR_BOT_BATCH <= 5)) || { log "MYRMIDON_BOT_IMAGE_ROLLOUT_BATCH_SIZE=$MYR_BOT_BATCH is above the cap; using 5"; MYR_BOT_BATCH=5; }

[[ -n "$BOARD_API_URL" ]] || die "BOARD_API_URL is required for the bot image rollout (the bot cards are the board's data)"
[[ -n "$BOARD_COMPANY_ID" ]] || die "BOARD_COMPANY_ID is required for the bot image rollout"
BOARD_TOKEN_FILE="${BOARD_TOKEN_FILE:-$HEALTH_TOKEN_FILE}"
if [[ -n "$BOARD_TOKEN_FILE" ]]; then
  [[ -r "$BOARD_TOKEN_FILE" ]] || die "token file not readable: $BOARD_TOKEN_FILE"
fi
[[ -n "$MYR_BOT_DOCKERGATE_CONFIG" ]] \
  || die "MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_CONFIG is required (the dockergate config.json this rollout enrolls bots and images in)"

# --- helpers -------------------------------------------------------------------
bot_log() { printf '[myrmidon-bot-rollout] %s\n' "$*" >&2; }
journal() {
  mkdir -p "$(dirname "$MYR_BOT_ROLLOUT_LOG")" 2>/dev/null || true
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$MYR_BOT_ROLLOUT_LOG" 2>/dev/null || true
}

# Bearer token of the board API, from the token file (never logged) —
# lib.sh's auth_header_args prints "-H" and "Authorization: Bearer <token>".
auth_args() {
  auth_header_args "$BOARD_TOKEN_FILE"
}

board_get() {
  local path="$1" body
  local -a auth=()
  mapfile -t auth < <(auth_args)
  body="$(curl -fsS --max-time 30 "${auth[@]}" "$BOARD_API_URL$path" 2>/dev/null)" || return 1
  printf '%s' "$body"
}

board_patch_json() {
  local path="$1" body="$2"
  local -a auth=()
  mapfile -t auth < <(auth_args)
  curl -fsS --max-time 30 -X PATCH -H 'Content-Type: application/json' "${auth[@]}" --data "$body" \
    "$BOARD_API_URL$path" 2>/dev/null || return 1
}

# POSTs JSON with curl and prints "<http-status>\n<body>"; always returns 0 so
# the caller can classify a refusal (409 = the bot cannot apply right now).
board_post_json_status() {
  local path="$1" body="$2" out
  local -a auth=()
  mapfile -t auth < <(auth_args)
  out="$(curl -sS --max-time 180 -X POST -H 'Content-Type: application/json' "${auth[@]}" --data "$body" \
    -w $'\n%{http_code}' "$BOARD_API_URL$path" 2>/dev/null)" || return 1
  printf '%s\n%s' "${out##*$'\n'}" "${out%$'\n'*}"
}

# The company's agent configurations: the card config (adapterConfig, the
# container block included) of every agent of the company.
# myrmidon(PERF-DIET-G): the company agents list (GET /companies/:id/agents)
# no longer carries adapterConfig, so every container read below asks for the
# configurations endpoint instead. It answers the same rows with the same
# access rules; the agent list keeps only the narrow projection (id,
# adapterType, status, adapterModel).
board_configs() {
  board_get "/companies/$BOARD_COMPANY_ID/agent-configurations"
}

# The company's hermes_gateway agents with enabled container blocks, shaped as
# "id|memoryMb|cpus|pidsLimit" per line. Card limits are the enrollment limits.
list_bots() {
  local body
  body="$(board_configs)" || return 1
  jq -r '[.[]? | select(.adapterType == "hermes_gateway")
      | select((.adapterConfig.container // {}) | (.enabled == true))
      | [.id,
         ((.adapterConfig.container.memoryMb // 2048) | tostring),
         ((.adapterConfig.container.cpus // 1) | tostring),
         ((.adapterConfig.container.pidsLimit // 512) | tostring)] | join("|")] | join("\n")' <<<"$body" 2>/dev/null
}

# The image a bot card pins right now ("" when the card names none).
card_image() {
  local id="$1" body
  body="$(board_configs)" || return 1
  jq -r --arg id "$id" 'first(.[]? | select(.id == $id) | .adapterConfig.container.image // "")' <<<"$body" 2>/dev/null
}

# The whole container block of a card as compact JSON ("{}" when none).
card_container() {
  local id="$1" body
  body="$(board_configs)" || return 1
  jq -c --arg id "$id" 'first(.[]? | select(.id == $id) | .adapterConfig.container // {})' <<<"$body" 2>/dev/null
}

# Every hermes_gateway agent with a container block, one TSV line each:
# id, category (tracks_release | pinned | not_applicable), image, reason.
# Mirrors classifyBotImageTracking (server/src/myrmidon/bot-containers/agent-config.ts).
bot_categories() {
  local body
  body="$(board_configs)" || return 1
  jq -r '.[]? | select(.adapterType == "hermes_gateway")
      | select((.adapterConfig.container | type) == "object")
      | .adapterConfig.container as $c
      | (if $c.enabled != true then "adapterConfig.container.enabled is not true"
         elif ($c.group != null) then "container.group (a container shared by several agents) is not supported yet"
         elif (($c.image | type) != "string" or ($c.image | gsub("\\s"; "") | length) == 0) then "container.image must be a non-empty string"
         elif (($c.memoryMb | type) != "number" or $c.memoryMb <= 0) then "container.memoryMb must be a positive number"
         elif (($c.cpus | type) != "number" or $c.cpus <= 0) then "container.cpus must be a positive number"
         elif (($c.pidsLimit | type) != "number" or $c.pidsLimit <= 0 or ($c.pidsLimit | floor) != $c.pidsLimit) then "container.pidsLimit must be a positive integer"
         else null end) as $reason
      | [.id,
         (if $reason != null then "not_applicable"
          elif ($c.image | gsub("^\\s+|\\s+$"; "") | test("myrmidon-hermes(-dev|-node)?@sha256:[0-9a-f]{64}$")) then "tracks_release"
          else "pinned" end),
         (if ($c.image | type) == "string" then ($c.image | gsub("^\\s+|\\s+$"; "")) else "" end),
         ($reason // "")] | @tsv' <<<"$body" 2>/dev/null
}

# Fleet hosts the bots live on: "user@host" per line (empty = none). Entries
# use the MYR_<COMPONENT>_HOST shape (remote:<user>@<host>), comma-separated.
fleet_hosts() {
  [[ -n "$MYR_BOT_FLEET_HOSTS" ]] || return 0
  local entry host
  tr ',' '\n' <<<"$MYR_BOT_FLEET_HOSTS" | while IFS= read -r entry; do
    entry="${entry#"${entry%%[![:space:]]*}"}"
    entry="${entry%"${entry##*[![:space:]]}"}"
    [[ -n "$entry" ]] || continue
    host="${entry#remote:}"
    [[ "$host" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$ ]] \
      || die "MYRMIDON_BOT_IMAGE_ROLLOUT_FLEET_HOSTS entry '$entry' must be remote:<user>@<host>"
    printf '%s\n' "$host"
  done
}

fleet_ssh_opts=(-o BatchMode=yes -o ConnectTimeout=10)

# --- 1. resolve the release's bot images -------------------------------------
bot_digests=""
for name in hermes hermes-dev hermes-node; do
  [[ -n "${GIVEN_DIGESTS[$name]:-}" ]] && bot_digests+="$name=${GIVEN_DIGESTS[$name]}"$'\n'
done
bot_digests="${bot_digests%$'\n'}"
if [[ -n "$bot_digests" ]]; then
  : # the release manifest named the digests
elif [[ "$resolution" == "tag" ]]; then
  bot_digests="$("$MYR_SCRIPT_DIR/../dockergate/check-release-support.sh" --from-tag "$res_ref" --components "$MYR_BOT_COMPONENTS" 2>/dev/null)" || bot_digests=""
else
  bot_digests="$("$MYR_SCRIPT_DIR/../dockergate/check-release-support.sh" --from-sha "$res_ref" --components "$MYR_BOT_COMPONENTS" 2>/dev/null)" || bot_digests=""
fi
if [[ -z "$bot_digests" ]]; then
  bot_log "the bot images of this release ($MYR_BOT_COMPONENTS, resolved by $resolution $res_ref) are not in the registry"
  bot_log "a release must ship its bot images together with the board (the bot image workflow runs on every push to main and every myr-v* tag)"
  die "release incomplete: bot image digests missing ($MYR_BOT_COMPONENTS, resolved by $resolution $res_ref)"
fi
bot_log "bot images of the release ($resolution $res_ref):"
declare -A BOT_IMAGE_REPOSITORIES=(
  [hermes]="ghcr.io/itkadr-git/myrmidon-hermes"
  [hermes-dev]="ghcr.io/itkadr-git/myrmidon-hermes-dev"
  [hermes-node]="ghcr.io/itkadr-git/myrmidon-hermes-node"
)
declare -A BOT_IMAGE_BY_NAME=()
while IFS= read -r line; do
  [[ -n "$line" ]] || continue
  name="${line%%=*}"
  cdigest="${line#*=}"
  BOT_IMAGE_BY_NAME["$name"]="${BOT_IMAGE_REPOSITORIES[$name]}@$cdigest"
  bot_log "  $name -> ${BOT_IMAGE_BY_NAME[$name]}"
done <<<"$bot_digests"
is_release_ref() {
  local want
  for want in "${BOT_IMAGE_BY_NAME[@]}"; do
    [[ "$1" == "$want" ]] && return 0
  done
  return 1
}

# --- 2. pull the images everywhere the bots run ------------------------------
# DEPLOY-HYGIENE (OPE-5107): refuse BEFORE the first pull when the filesystem
# of /var/lib/docker cannot hold the bot images (in a dry run the check is
# reported with the current value instead). Standalone runs only: when
# deploy.sh drives the rollout, deploy.sh already checked the same disk.
if [[ "$phase" != "cards" && -z "${MYRMIDON_DEPLOY_DISK_PRECHECK_DONE:-}" ]]; then
  deploy_disk_precheck bot-image-rollout
fi
mapfile -t FLEET_HOSTS_LIST < <(fleet_hosts)
for name in $(tr ',' ' ' <<<"$MYR_BOT_COMPONENTS"); do
  ref="${BOT_IMAGE_BY_NAME[$name]:-}"
  [[ -n "$ref" ]] || { bot_log "the release has no $name image; cards on that variant stay as they are"; continue; }
  [[ "$phase" == "cards" ]] && continue
  if [[ "$DRY_RUN" == "1" ]]; then
    bot_log "dry run: docker pull $ref"
    for host in "${FLEET_HOSTS_LIST[@]}"; do
      [[ -n "$host" ]] && bot_log "dry run: ssh $host docker pull $ref"
    done
    continue
  fi
  docker pull --quiet "$ref" >/dev/null || die "cannot pull $ref on the local host"
  for host in "${FLEET_HOSTS_LIST[@]}"; do
    [[ -n "$host" ]] || continue
    ssh "${fleet_ssh_opts[@]}" "$host" docker pull --quiet "$ref" >/dev/null \
      || die "cannot pull $ref on fleet host $host"
  done
done

# --- 3./4. dockergate config edits --------------------------------------------
# Every edit goes through a temp file next to the config and install_preserving:
# the new content keeps the owner and mode of the config it replaces (dockergate
# runs as another user than root; a file that became 0600 root made the SIGHUP
# reload fail silently and the next restart crash-loop on "permission denied").

# Replaces the config with the content of <tmp>, keeping its owner and mode.
dockergate_config_install() {
  local tmp="$1" cfg_file="$2"
  install_preserving "$tmp" "$cfg_file" || { rm -f "$tmp"; die "cannot write $cfg_file with its original owner and mode; it was not changed"; }
}

# Add refs to images[] (idempotent: already-listed refs are kept once).
dockergate_add_images() {
  local cfg_file="$1"; shift
  local -a add=("$@")
  [[ -f "$cfg_file" ]] || die "dockergate config not found: $cfg_file"
  local tmp
  tmp="$(mktemp "$cfg_file.XXXXXX")" || die "cannot write next to $cfg_file"
  jq '.images = ((.images // []) + $ARGS.positional) | .images |= (unique | sort)' \
    "$cfg_file" --args "${add[@]}" >"$tmp" 2>/dev/null \
    || { rm -f "$tmp"; die "cannot edit $cfg_file with jq (is it valid JSON?)"; }
  dockergate_config_install "$tmp" "$cfg_file"
}

# Remove refs from images[] (refs that are gone stay gone; pinned ones are
# filtered by the caller).
dockergate_remove_images() {
  local cfg_file="$1"; shift
  local -a gone=("$@")
  local tmp
  tmp="$(mktemp "$cfg_file.XXXXXX")" || die "cannot write next to $cfg_file"
  jq '.images = ((.images // []) | map(. as $r | select(($ARGS.positional | index($r)) == null)))' \
    "$cfg_file" --args "${gone[@]}" >"$tmp" 2>/dev/null \
    || { rm -f "$tmp"; die "cannot edit $cfg_file with jq (is it valid JSON?)"; }
  dockergate_config_install "$tmp" "$cfg_file"
}

# Enroll the fleet in bots[]: "id|mem|cpus|pids" per line; a bot already
# enrolled keeps its existing limits (an operator's enrollment wins).
dockergate_enroll_bots() {
  local cfg_file="$1" bots="$2"
  [[ -f "$cfg_file" ]] || die "dockergate config not found: $cfg_file"
  local tmp
  tmp="$(mktemp "$cfg_file.XXXXXX")" || die "cannot write next to $cfg_file"
  jq -Rn --rawfile cfg "$cfg_file" '
    $cfg | fromjson as $c
    | [inputs | split("|") | select(length == 4)
        | {botKey: .[0], maxMemoryMb: (.[1] | tonumber), maxCpus: (.[2] | tonumber), maxPids: (.[3] | tonumber)}] as $want
    | ($want | map(select(.botKey as $k | ($c.bots // [] | map(.botKey) | index($k)) == null))) as $add
    | $c + {bots: (($c.bots // []) + $add)}
  ' <<<"$bots" >"$tmp" 2>/dev/null \
    || { rm -f "$tmp"; die "cannot edit bots[] of $cfg_file with jq (is it valid JSON?)"; }
  dockergate_config_install "$tmp" "$cfg_file"
}

# dockergate check-config against the real binary (the caller names the
# command; e.g. "docker run --rm -v file:/c.json <image> check-config --config /c.json").
# The output of a refusal is logged by dockergate_check_config_file.
dockergate_check_config_now() {
  local cfg_file="$1" rc=0
  dockergate_check_config_file "$cfg_file" "$dockergate_image" || rc=$?
  case "$rc" in
    0) ;;
    3) bot_log "WARNING: no check-config command (MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_CHECK_CONFIG_COMMAND) and no dockergate image; the edited config is not verified" ;;
    *) die "dockergate check-config refused the edited config ($cfg_file); the last edit was not applied further" ;;
  esac
}

dockergate_check_config() {
  local cfg_file="$1"
  if [[ "$DRY_RUN" == "1" ]]; then
    bot_log "dry run: dockergate check-config of $cfg_file"
    return 0
  fi
  dockergate_check_config_now "$cfg_file"
}

# SIGHUP, then proof that the process loaded the new file: dockergate logs the
# hash of the config it loads at start and on every reload, and a reload that
# fails (a file it cannot open, an invalid one) logs no new hash and leaves the
# old configuration in memory - the signal "worked" and nothing changed. The
# hash of the file on disk must show up in the log within the timeout, else
# this dies loudly.
dockergate_reload() {
  if ((no_reload)); then
    bot_log "dockergate is recreated next; no SIGHUP"
    return 0
  fi
  [[ -n "$MYR_BOT_DOCKERGATE_SIGNAL" ]] || {
    bot_log "WARNING: no SIGHUP command (MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_SIGNAL_COMMAND); the config file changed but dockergate keeps the old one until reloaded"
    return 0
  }
  if [[ "$DRY_RUN" == "1" ]]; then
    bot_log "dry run: $MYR_BOT_DOCKERGATE_SIGNAL"
    return 0
  fi
  # shellcheck disable=SC2086
  bash -c "$MYR_BOT_DOCKERGATE_SIGNAL" || die "failed to signal dockergate: $MYR_BOT_DOCKERGATE_SIGNAL"
  local want_hash
  want_hash="$(dockergate_config_hash "$MYR_BOT_DOCKERGATE_CONFIG")"
  if ! dockergate_verify_state "" "$want_hash" "${MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_RELOAD_TIMEOUT_SEC:-30}"; then
    die "dockergate did not load the new config after SIGHUP: expected config hash $want_hash, the log says '${DG_SEEN_HASH:-<none>}'. The old image allowlist is still in memory. Look at the file's owner and mode ($(stat -c '%U:%G %a' "$MYR_BOT_DOCKERGATE_CONFIG" 2>/dev/null || echo unknown); dockergate runs as another user than root) and at the dockergate log for config_reload_failed"
  fi
  bot_log "dockergate reloaded (SIGHUP): it runs config hash $want_hash"
}

# The check a dry run makes of what the config phase would write: the edits are
# made on a copy that keeps the owner and mode of the config (the real run's
# check-config sees the same file), and the real binary checks the copy.
dockergate_preflight_edited_config() {
  local copy rc=0
  copy="$(mktemp "$MYR_BOT_DOCKERGATE_CONFIG.preflight.XXXXXX" 2>/dev/null)" || copy=""
  if [[ -z "$copy" ]]; then
    bot_log "dry run: cannot write next to $MYR_BOT_DOCKERGATE_CONFIG; checking the config as it is"
    dockergate_check_config_now "$MYR_BOT_DOCKERGATE_CONFIG"
    return
  fi
  cp -p "$MYR_BOT_DOCKERGATE_CONFIG" "$copy" || { rm -f "$copy"; die "cannot copy $MYR_BOT_DOCKERGATE_CONFIG for the preflight check"; }
  (
    trap 'rm -f "$copy"' EXIT
    dockergate_add_images "$copy" "${NEW_REFS[@]}"
    if [[ -n "${bots:-}" ]]; then dockergate_enroll_bots "$copy" "$bots"; fi
    dockergate_check_config_now "$copy"
  ) || rc=$?
  rm -f "$copy"
  return "$rc"
}

# The standard re-run command for the deferred bots (F-04 p.3).
retry_command() {
  printf 'bash %s --config %s --resolution %s --ref %s --phase cards --retry-deferred --wait-sec %s\n' \
    "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bot-image-rollout.sh" \
    "$(printf '%q' "$config")" "$resolution" "$res_ref" "$MYR_BOT_RETRY_WAIT_SEC"
}

# --retry-deferred input: the deferred bots of the previous run as recorded
# by this script in its summary (id, pre-rollout card image, target image).
read_deferred_bots() {
  [[ -f "$MYR_BOT_SUMMARY" ]] \
    || die "--retry-deferred needs the summary of the previous rollout ($MYR_BOT_SUMMARY): run the rollout first"
  # Fail closed on anything that is not a summary this script wrote: a broken
  # file, an old format without deferredBots/verification, another release, or
  # an empty list (nothing to retry is not a success of the retry).
  local rel_in_summary deferred_tsv
  jq -e '(.deferredBots | type == "array") and (.verification | type == "object")' "$MYR_BOT_SUMMARY" >/dev/null 2>&1 \
    || die "--retry-deferred: $MYR_BOT_SUMMARY is not a readable summary with deferredBots and verification (broken or old format): run the rollout again"
  rel_in_summary="$(jq -r '.release // ""' "$MYR_BOT_SUMMARY")"
  [[ "$rel_in_summary" == "$resolution $res_ref" ]] \
    || die "--retry-deferred: the summary belongs to release '$rel_in_summary', not '$resolution $res_ref'"
  deferred_tsv="$(jq -r '.deferredBots[] | [.id, (.image // ""), (.target // "")] | @tsv' "$MYR_BOT_SUMMARY")" \
    || die "--retry-deferred: cannot read deferredBots from $MYR_BOT_SUMMARY"
  [[ -n "$deferred_tsv" ]] \
    || die "--retry-deferred: the summary $MYR_BOT_SUMMARY lists no deferred bots: nothing to retry (never a silent empty retry)"
  printf '%s\n' "$deferred_tsv"
}

# --- the plan (dry run) --------------------------------------------------------
if [[ "$DRY_RUN" == "1" ]]; then
  if ((RETRY_DEFERRED)); then
    # The standard re-run pass: only the deferred bots of the previous rollout.
    # A missing summary fails the pass here (die): never a silent empty retry.
    deferred_list="$(read_deferred_bots)"
    bot_log "dry run: --retry-deferred would re-switch exactly the deferred bots listed in $MYR_BOT_SUMMARY (${MYR_BOT_RETRY_WAIT_SEC}s wait per bot), then verify card vs container again:"
    while IFS=$'\t' read -r id orig tgt; do
      [[ -n "$id" ]] && bot_log "    $id (pre-rollout image ${orig:--}, target ${tgt:--})"
    done <<<"$deferred_list"
    exit 0
  fi
  bot_log "dry run: nothing will be changed. Bot image rollout plan:"
  bot_log "  1. resolved (read-only): $bot_digests"
  bot_log "  2. pull each image on the local host${MYR_BOT_FLEET_HOSTS:+ and fleet hosts $MYR_BOT_FLEET_HOSTS}"
  bot_log "  3. add the new digests to images of $MYR_BOT_DOCKERGATE_CONFIG (old bot images stay until the fleet moved); check-config; SIGHUP"
  bot_log "  4. enroll every hermes_gateway bot of company $BOARD_COMPANY_ID in bots of the dockergate config"
  bot_log "  5. switch every bot card to the release image, one at a time${canary:+ (canary $canary first)}, through PATCH + apply; deferred bots retry up to ${MYR_BOT_TIMEOUT_SEC}s; no run is interrupted"
  bot_log "  6. remove the superseded bot images from images; SIGHUP"
  bot_log "  6b. DEPLOY-HYGIENE: remove the local bot/component images older than MYRMIDON_DEPLOY_IMAGE_KEEP=${MYRMIDON_DEPLOY_IMAGE_KEEP:-1} previous release(s) (images used by a container are kept)"
  bot_log "  7. journal: $MYR_BOT_ROLLOUT_LOG"
  categories="$(bot_categories || true)"
  if [[ -n "$categories" ]]; then
    bot_log "  container bots by category (read-only):"
    while IFS=$'\t' read -r id category image reason; do
      [[ -n "$id" ]] || continue
      bot_log "    $id: $category${image:+ ($image)}${reason:+ ($reason)}"
    done <<<"$categories"
  fi
  bots="$(list_bots || true)"
  if [[ "$phase" != "cards" && -f "$MYR_BOT_DOCKERGATE_CONFIG" ]]; then
    mapfile -t NEW_REFS < <(for name in $(tr ',' ' ' <<<"$MYR_BOT_COMPONENTS"); do [[ -n "${BOT_IMAGE_BY_NAME[$name]:-}" ]] && printf '%s\n' "${BOT_IMAGE_BY_NAME[$name]}"; done)
    bot_log "  dockergate config: the edited config is checked now (read-only, on a copy with the owner and mode of the real file)"
    dockergate_preflight_edited_config
  elif [[ "$phase" != "cards" ]]; then
    die "dockergate config not found: $MYR_BOT_DOCKERGATE_CONFIG"
  fi
  if [[ -n "$bots" ]]; then
    bot_log "  bots to roll:"
    while IFS= read -r line; do
      [[ -n "$line" ]] && bot_log "    ${line%%|*}"
    done <<<"$bots"
  else
    bot_log "  no eligible bots (the agents list answered no hermes_gateway containers); steps 5-6 are no-ops"
  fi
  exit 0
fi

bots="$(list_bots)" \
  || die "cannot read the agents list from $BOARD_API_URL (company $BOARD_COMPANY_ID): the bot cards are the board's data"

if [[ "$phase" != "cards" ]]; then
# --- 3. images[] + check-config + SIGHUP (old bot images stay) -----------------
mapfile -t NEW_REFS < <(for name in $(tr ',' ' ' <<<"$MYR_BOT_COMPONENTS"); do [[ -n "${BOT_IMAGE_BY_NAME[$name]:-}" ]] && printf '%s\n' "${BOT_IMAGE_BY_NAME[$name]}"; done)
dockergate_add_images "$MYR_BOT_DOCKERGATE_CONFIG" "${NEW_REFS[@]}"
dockergate_check_config "$MYR_BOT_DOCKERGATE_CONFIG"
dockergate_reload
bot_log "release bot images allowed in $MYR_BOT_DOCKERGATE_CONFIG (old bot images stay until the fleet moved)"

# --- 4. bots[] enrollment ------------------------------------------------------
bot_count=0
if [[ -n "$bots" ]]; then
  bot_count="$(grep -c . <<<"$bots" || true)"
  dockergate_enroll_bots "$MYR_BOT_DOCKERGATE_CONFIG" "$bots"
  dockergate_check_config "$MYR_BOT_DOCKERGATE_CONFIG"
  dockergate_reload
  journal "enrolled $bot_count bot(s) in bots[] of $MYR_BOT_DOCKERGATE_CONFIG"
  bot_log "enrolled $bot_count bot(s) in bots[] of $MYR_BOT_DOCKERGATE_CONFIG (already-enrolled bots keep their limits)"
  # Fleet hosts run fleetd with their own config.json; its bots[] must carry
  # the same fleet. Only a notice here: the config path is host-specific
  # (MYRMIDON_BOT_IMAGE_ROLLOUT_FLEET_CONFIG names it, default
  # /etc/myrmidon-fleetd/config.json), and an installation may share one file.
  if ((${#FLEET_HOSTS_LIST[@]} && ${#FLEET_HOSTS_LIST[@]} > 0)) && [[ -n "${FLEET_HOSTS_LIST[0]}" ]]; then
    for host in "${FLEET_HOSTS_LIST[@]}"; do
      [[ -n "$host" ]] || continue
      fleet_cfg="${MYRMIDON_BOT_IMAGE_ROLLOUT_FLEET_CONFIG:-/etc/myrmidon-fleetd/config.json}"
      # shellcheck disable=SC2029  # the path is meant to expand on the client side
      if ssh "${fleet_ssh_opts[@]}" "$host" "test -f '$fleet_cfg'" 2>/dev/null; then
        scp -q "${fleet_ssh_opts[@]}" "$MYR_BOT_DOCKERGATE_CONFIG" "$host:/tmp/.myrmidon-bot-enroll.$$" 2>/dev/null || true
        # shellcheck disable=SC2029  # the path is meant to expand on the client side
        ssh "${fleet_ssh_opts[@]}" "$host" \
          "jq -c '. + {bots: ((.bots // []) + (input | .bots // []) | unique_by(.botKey))}' '$fleet_cfg' /tmp/.myrmidon-bot-enroll.$$ >'$fleet_cfg.new' && chmod --reference='$fleet_cfg' '$fleet_cfg.new' && chown --reference='$fleet_cfg' '$fleet_cfg.new' && mv '$fleet_cfg.new' '$fleet_cfg'; rc=\$?; rm -f '$fleet_cfg.new' /tmp/.myrmidon-bot-enroll.$$; exit \$rc" \
          || bot_log "WARNING: could not enroll bots[] in the fleetd config of $host ($fleet_cfg); enroll it by hand or fix MYRMIDON_BOT_IMAGE_ROLLOUT_FLEET_CONFIG"
      else
        bot_log "NOTE: fleet host $host has no $fleet_cfg (fleetd reads its config from the host); nothing enrolled there"
      fi
    done
  fi
else
  bot_log "no eligible bots on the board (company $BOARD_COMPANY_ID): nothing to enroll, nothing to switch"
fi
fi # phase != cards

if [[ "$phase" == "config" ]]; then
  bot_log "config phase complete: bot images allowed and bots enrolled in $MYR_BOT_DOCKERGATE_CONFIG"
  exit 0
fi

# --- 5. switch the tracking cards, in batches of at most 5 -------------------
# A card TRACKS the release when it names a digest-pinned image of one of our
# bot repositories that is not the release's image of that repository; it moves
# to the release image of the SAME repository. Every other card (another
# repository, a tag, no image) is PINNED: left alone and reported.
release_image_for() {
  case "$1" in
    *myrmidon-hermes-dev@sha256:????????????????????????????????????????????????????????????????) printf '%s\n' "${BOT_IMAGE_BY_NAME[hermes-dev]:-}" ;;
    *myrmidon-hermes-node@sha256:????????????????????????????????????????????????????????????????) printf '%s\n' "${BOT_IMAGE_BY_NAME[hermes-node]:-}" ;;
    *myrmidon-hermes@sha256:????????????????????????????????????????????????????????????????) printf '%s\n' "${BOT_IMAGE_BY_NAME[hermes]:-}" ;;
    *) printf '\n' ;;
  esac
}

# The agent's status (idle, paused, running, ...), empty when unknown.
card_status() {
  local id="$1" body
  body="$(board_get "/companies/$BOARD_COMPANY_ID/agents")" || return 1
  jq -r --arg id "$id" 'first(.[]? | select(.id == $id) | .status // "")' <<<"$body" 2>/dev/null
}

# Waits for one async apply job. Prints the final status line on stdout:
# "succeeded", "failed|<error>", "deferred|<reason>" or "timeout"; always returns 0.
#
# Contract: server/src/myrmidon/bot-containers/routes.ts
#   POST /api/myrmidon/agents/:id/bot-container/apply
#     -> 202 {"applyId","status":"queued"}            (queued or a live job re-used)
#     -> 409 {"code":"bot_container_not_applicable","error":...}
#   GET  /api/myrmidon/agents/:id/bot-container/apply/:applyId
#     -> {"status":"queued"|"running"|"succeeded"|"failed","error":string|null,
#         "startedAt":string|null,"finishedAt":string|null}
# The background pass (runApplyJob) writes the job row; a deferred pass
# (kind="deferred" of ApplyBotContainerOutcome) is recorded as "succeeded"
# (no dedicated "deferred" job status), so a succeeded job still has to be
# confirmed by GET bot-container/status (container_on_image).
wait_apply_job() {
  local id="$1" apply_id="$2" end job st err
  end=$((SECONDS + MYR_BOT_APPLY_WAIT_SEC))
  while :; do
    if job="$(board_get "/myrmidon/agents/$id/bot-container/apply/$apply_id")"; then
      st="$(jq -r '.status // ""' <<<"$job" 2>/dev/null || true)"
      case "$st" in
        succeeded) printf 'succeeded\n'; return 0 ;;
        failed)
          err="$(jq -r '.error // "error unknown"' <<<"$job" 2>/dev/null || true)"
          printf 'failed|%s\n' "$err"
          return 0
          ;;
      esac
    fi
    if ((SECONDS >= end)); then printf 'timeout\n'; return 0; fi
    sleep "$MYR_BOT_APPLY_POLL_SEC"
  done
}

# "succeeded" of an apply job does not prove the switch (a busy bot's deferred
# pass is recorded as succeeded): the running container must be on the target.
container_on_image() {
  local id="$1" want="$2" body
  body="$(board_get "/myrmidon/agents/$id/bot-container/status")" || return 1
  jq -e --arg want "$want" '.container.state == "running" and .container.image == $want' <<<"$body" >/dev/null 2>&1
}

# Puts the card's container block back after a failed apply, so the card
# names the image it had before. Only the card's container block is restored:
# agent keys the apply pass may have re-issued are not rolled back. Skipped
# when the container is already on the target (the apply did work). A failed
# revert is logged loudly; the bot stays failed either way.
revert_card() {
  local id="$1" block="$2" target="$3" body
  [[ -n "$block" ]] || return 0
  if container_on_image "$id" "$target"; then
    bot_log "bot $id: apply reported a failure but the container runs the release image; the card stays"
    return 0
  fi
  body="$(jq -cn --argjson c "$block" '{adapterConfig: {container: $c}}')"
  if board_patch_json "/agents/$id" "$body" >/dev/null; then
    bot_log "bot $id: apply failed; the card is back on its previous image (reverted)"
    journal "agent $id apply failed: card reverted to its previous container block"
  else
    bot_log "bot $id: apply failed AND the card revert failed; the card points at the release image, the container is on the old one: fix by hand"
    journal "agent $id apply failed and card revert failed (card on $target, container on the old image)"
  fi
}

# Returns 0 switched, 2 deferred (retry), 1 failed.
# $2 == "force" drops the paused/idle status gate: the apply below goes to the
# reconciler as-is, and its pause-and-apply path opens the maintenance window
# and drains the in-flight run to its end (a run is never interrupted). The
# gate is dropped only by the force stage of the tail pass.
switch_one_bot() {
  local id="$1" force="${2:-}" current target body out kind status apply_id waited
  local prev_block=""
  current="$(card_image "$id" || true)"
  [[ -n "$current" ]] || current="(none)"
  target="$(release_image_for "$current")"
  # F-04 (1.6.5): the verification phase reads these — the pre-rollout card
  # image (first sight), the target image, and how this pass ended.
  BOT_ORIG["$id"]="${BOT_ORIG[$id]:-$current}"
  [[ -n "$target" ]] && BOT_TARGET["$id"]="$target"
  # Only while the agent is paused or idle: no run is ever interrupted by the
  # rollout (an unknown status is treated as busy: fail-closed).
  if [[ "$force" != "force" ]]; then
    status="$(card_status "$id" || true)"
    case "$status" in
      idle | paused) ;;
      *)
        bot_log "bot $id deferred (agent status '${status:-unknown}': switched only while paused or idle)"
        DEFERRED_REASON="agent status '${status:-unknown}': switched only while paused or idle"
        return 2
        ;;
    esac
  fi
  if is_release_ref "$current"; then
    # The card already names the release image (a previous rollout switched
    # it or the apply stayed deferred): only re-apply, never re-PATCH.
    out="$(board_post_json_status "/myrmidon/agents/$id/bot-container/apply" '{}')" || {
      bot_log "apply of bot $id failed (card already on the release image); the periodic sweep retries"
      journal "agent $id apply failed (card already on $target; the sweep retries)"
      return 1
    }
  else
    # PATCH the card: the route merges adapterConfig ONE level deep, so the
    # whole container block goes back with the new image (an image-only block
    # would replace it and drop enabled and the limits).
    local block
    block="$(card_container "$id" || true)"
    prev_block="$block"
    [[ -n "$block" && "$block" != "{}" ]] || { bot_log "bot $id: cannot read the card's container block; the card is untouched"; return 1; }
    body="$(jq -cn --argjson c "$block" --arg img "$target" '{adapterConfig: {container: ($c + {image: $img})}}')"
    if ! board_patch_json "/agents/$id" "$body" >/dev/null; then
      bot_log "PATCH of bot $id's card failed; the card is untouched"
      return 1
    fi
    # Apply now: the board's own reconciler drains this agent alone and
    # recreates the container with the new image.
    out="$(board_post_json_status "/myrmidon/agents/$id/bot-container/apply" '{}')" || {
      bot_log "apply of bot $id failed after the card switch"
      journal "agent $id card switched to $target, apply failed"
      revert_card "$id" "$prev_block" "$target"
      return 1
    }
  fi
  # 1.6.5 async apply: the first line is the HTTP status, the rest the body.
  # 202 queues the job; 409 says the bot cannot apply right now (not applicable,
  # disabled, runtime unavailable) — that is a deferral, not a failure.
  local http_status
  http_status="${out%%$'\n'*}"
  out="${out#*$'\n'}"
  case "$http_status" in
    202) ;;
    409)
      local conflict_code
      conflict_code="$(jq -r '.code // "bot_container_not_applicable"' <<<"$out" 2>/dev/null || true)"
      bot_log "bot $id deferred (apply refused: $conflict_code)"
      journal "agent $id apply refused (409 $conflict_code; card unchanged)"
      return 2
      ;;
    *)
      bot_log "apply of bot $id answered HTTP $http_status; the periodic sweep retries"
      journal "agent $id apply answered HTTP $http_status"
      revert_card "$id" "$prev_block" "$target"
      return 1
      ;;
  esac
  apply_id="$(jq -r '.applyId // ""' <<<"$out" 2>/dev/null || true)"
  if [[ -n "$apply_id" ]]; then
    # 1.6.5 async apply: 202 + applyId; the outcome is read from the job.
    waited="$(wait_apply_job "$id" "$apply_id")"
    case "$waited" in
      succeeded)
        if container_on_image "$id" "$target"; then
          bot_log "bot $id: $current -> $target (apply $apply_id succeeded, container on the release image)"
          journal "agent $id $current -> $target (async apply $apply_id)"
          record_history "bot-image" "$id $target"
          return 0
        fi
        # The job row says "succeeded" even when the reconciler deferred the
        # pass (a busy agent, a drain that lost the window). The container
        # staying off the release image is what proves it; the card already
        # points at the release image and the periodic sweep retries.
        bot_log "bot $id deferred (apply $apply_id succeeded but the container is not on the release image; the sweep retries)"
        DEFERRED_REASON="apply $apply_id succeeded but the container is not running the release image yet"
        journal "agent $id apply $apply_id deferred (container not on $target)"
        return 2
        ;;
      failed\|*)
        bot_log "bot $id: apply $apply_id failed: ${waited#failed|}"
        journal "agent $id apply $apply_id failed: ${waited#failed|}"
        revert_card "$id" "$prev_block" "$target"
        return 1
        ;;
      *)
        bot_log "bot $id deferred (apply $apply_id still not finished after ${MYR_BOT_APPLY_WAIT_SEC}s)"
        DEFERRED_REASON="apply $apply_id still not finished after ${MYR_BOT_APPLY_WAIT_SEC}s"
        journal "agent $id apply $apply_id still not finished after ${MYR_BOT_APPLY_WAIT_SEC}s"
        return 2
        ;;
    esac
  fi
  kind="$(jq -r '.outcome.kind // ""' <<<"$out" 2>/dev/null || true)"
  case "$kind" in
    created | applied_files | applied_restart | unchanged)
      bot_log "bot $id: $current -> $target ($kind)"
      journal "agent $id $current -> $target ($kind)"
      record_history "bot-image" "$id $target"
      return 0
      ;;
    deferred)
      local reason
      reason="$(jq -r '.outcome.reason // "reason unknown"' <<<"$out" 2>/dev/null || true)"
      bot_log "bot $id deferred ($reason)"
      DEFERRED_REASON="$reason"
      return 2
      ;;
    *)
      bot_log "bot $id: unexpected apply outcome '$kind'"
      journal "agent $id apply outcome '$kind'"
      revert_card "$id" "$prev_block" "$target"
      return 1
      ;;
  esac
}

# Records how this pass ended for the bot, then passes the switch_one_bot
# return code through (0 switched, 2 deferred, 1 failed) — the verification
# table and the summary classify the bot by this state plus the container fact.
switch_bot_recorded() {
  local id="$1" force="${2:-}" rc=0
  switch_one_bot "$id" $force || rc=$?
  case "$rc" in
    0) BOT_STATE["$id"]="switched" ;;
    2) BOT_STATE["$id"]="deferred" ;;
    *) BOT_STATE["$id"]="failed" ;;
  esac
  return "$rc"
}

# --- 5b. F-04 (1.6.5): verification against the fact -------------------------
# The batch loop reports what the script asked for; GET bot-container/status
# reports what actually runs (the board answers it from a docker inspect on
# the deploy host — the same channel switch_one_bot already uses for the
# async confirm; no second docker transport is introduced). Every bot of
# this pass is classified by the FACT of card image vs container image:
#   switched             the card names the release image and the running
#                        container reports the same image (fact confirms);
#   deferred(running)    a bot the batches left deferred: its container is
#                        not up or still runs the pre-rollout image, nothing
#                        disagrees — the periodic sweep finishes it; NOT a
#                        failure;
#   failed               the main cycle failed this bot (PATCH/apply error);
#   mismatch             anything else: card and container disagree, an
#                        image neither the old one nor the release's, or a
#                        "switched" the container does not confirm — exactly
#                        the lying rollout outcome F-04 was raised for.
# Exit rule (F-04 p.2): DEGRADED and exit 1 only when mismatch > 0 or
# failed > 0. deferred > 0 alone exits 0 with a WARNING naming the standard
# --retry-deferred re-run pass (F-04 p.3, decision 06.10 item 3).
declare -A BOT_STATE=() BOT_ORIG=() BOT_TARGET=() deferred_reasons=()

# The running container's fact as TSV "state<TAB>image"; non-zero when the
# board has no status to report (no container, or the read failed).
container_fact() {
  local id="$1" body
  body="$(board_get "/myrmidon/agents/$id/bot-container/status")" || return 1
  jq -r '[(.container.state // ""), (.container.image // "")] | @tsv' <<<"$body" 2>/dev/null || return 1
}

VERIFY_ROWS=()
DEFERRED_ROWS=()
v_switched=0
v_deferred=0
v_mismatch=0
v_failed=0
verify_fleet() {
  local id card fact="" cstate="" cimage="" target orig state verdict
  VERIFY_ROWS=("id|card image|container image|state|verdict")
  DEFERRED_ROWS=()
  v_switched=0 v_deferred=0 v_mismatch=0 v_failed=0
  for id in "$@"; do
    [[ -n "$id" ]] || continue
    card="$(card_image "$id" || true)"
    if fact="$(container_fact "$id")"; then
      cstate="${fact%%$'\t'*}"; cimage="${fact#*$'\t'}"
    else
      cstate=""; cimage=""
    fi
    target="${BOT_TARGET[$id]:-}" orig="${BOT_ORIG[$id]:-}" state="${BOT_STATE[$id]:-deferred}"
    if [[ "$state" == "failed" ]]; then
      # The main cycle failed on this bot (PATCH/apply error): the run stays
      # DEGRADED even if the cards happen to agree — the operator must see it.
      verdict="failed"
    elif [[ -n "$target" && "$card" == "$target" && "$cimage" == "$target" && "$cstate" == "running" ]]; then
      # The fact confirms the switch — even for a bot the main cycle only
      # deferred (the sweep or a late apply finished it).
      verdict="switched"
    elif [[ "$state" == "deferred" ]]; then
      # Nothing disagrees yet as long as the card carries one of the two
      # images this rollout knows (pre-rollout or release): the container
      # simply has not moved and the periodic sweep finishes it.
      # The container must be on one of those two images too (or report none):
      # an image that is neither is a real disagreement, not "not moved yet".
      if [[ "$card" == "$target" || "$card" == "$orig" ]] \
        && [[ -z "$cimage" || "$cimage" == "$target" || "$cimage" == "$orig" ]]; then
        verdict="deferred"
      else
        verdict="mismatch"
      fi
    else
      # The main cycle claimed switched but the container says otherwise, or
      # the card moved to something that is not the release image: a real
      # disagreement — exactly the lying rollout outcome F-04 was raised for.
      verdict="mismatch"
    fi
    [[ -n "$card" ]] || card="(unreadable)"
    [[ -n "$cimage" ]] || cimage="(none)"
    [[ -n "$cstate" ]] || cstate="-"
    VERIFY_ROWS+=("$id|$card|$cimage|$cstate|$verdict")
    case "$verdict" in
      switched) v_switched=$((v_switched + 1)) ;;
      deferred)
        v_deferred=$((v_deferred + 1))
        dreason="${deferred_reasons[$id]:-}"
        dreason="${dreason//[|$'\t\n']/ }"
        DEFERRED_ROWS+=("$id|${orig//|/}|${target//|/}|$dreason")
        ;;
      mismatch) v_mismatch=$((v_mismatch + 1)) ;;
      *) v_failed=$((v_failed + 1)) ;;
    esac
    BOT_STATE["$id"]="$verdict"
    journal "verify $id $verdict (card $card, container $cimage state $cstate)"
  done
  # The per-bot table on stderr, columns aligned to their content.
  printf '%s\n' "${VERIFY_ROWS[@]}" | awk -F'|' -v p='[myrmidon-bot-rollout]   ' '
    { n = NR; for (i = 1; i <= NF; i++) { cell[n "," i] = $i; if (length($i) > w[i]) w[i] = length($i) } }
    END {
      for (r = 1; r <= n; r++) {
        line = p
        for (i = 1; i <= 5; i++) line = line sprintf("%-*s  ", w[i], cell[r "," i])
        sub(/ +$/, "", line)
        print line
      }
    }' >&2
  bot_log "verification summary: $v_switched switched, $v_deferred deferred(running), $v_mismatch mismatch, $v_failed failed"
}

# The verification block written to the summary, and the deferred-bot records
# a later --retry-deferred reads back.
DEFERRED_JSON='[]'
VERIF_JSON='{}'
collect_verdict() {
  DEFERRED_JSON="$(printf '%s\n' "${DEFERRED_ROWS[@]}" | jq -Rn \
    '[inputs | select(length > 0) | split("|") | {id: .[0], image: .[1], target: .[2], reason: (.[3:] | join("|"))}]')"
  VERIF_JSON="$(jq -cn --argjson s "$v_switched" --argjson d "$v_deferred" --argjson m "$v_mismatch" --argjson f "$v_failed" \
    '{switched: $s, deferred: $d, mismatch: $m, failed: $f}')"
}

# Classify every container bot: tracking (to switch), pinned (left alone, listed
# with its image) and not applicable (left alone, listed with the reason).
TRACKING_BOTS=()
PINNED_LIST=()
NA_LIST=()
pinned=0
not_applicable=0
categories="$(bot_categories)" \
  || die "cannot read the agents list from $BOARD_API_URL (company $BOARD_COMPANY_ID): the bot cards are the board's data"
while IFS=$'\t' read -r id category image reason; do
  [[ -n "$id" ]] || continue
  case "$category" in
    tracks_release) TRACKING_BOTS+=("$id") ;;
    pinned)
      bot_log "bot $id is pinned (image '${image:-<none>}' is not a previous release image of a bot repository this release ships): left alone"
      journal "agent $id pinned (${image:-none}): left alone"
      PINNED_LIST+=("$id|$image")
      pinned=$((pinned + 1))
      ;;
    *)
      bot_log "bot $id: not applicable ($reason): left alone"
      journal "agent $id not applicable ($reason): left alone"
      NA_LIST+=("$id|$reason")
      not_applicable=$((not_applicable + 1))
      ;;
  esac
done <<<"$categories"
if [[ -n "$canary" ]]; then
  # the canary leads the first batch
  mapfile -t TRACKING_BOTS < <(
    for id in "${TRACKING_BOTS[@]}"; do [[ "$id" == "$canary" ]] && echo "$id"; done
    for id in "${TRACKING_BOTS[@]}"; do [[ "$id" != "$canary" ]] && echo "$id"; done
  )
fi

if ((RETRY_DEFERRED)); then
  # The standard re-run pass (F-04 p.3, decision 06.10 item 3): only the
  # deferred bots of the previous rollout, as recorded in its summary.
  # read_deferred_bots dies on a missing summary; the standalone assignment
  # propagates that exit under set -e (a substitution inside the loop's
  # redirection would not): no silent empty retry pass, ever.
  TRACKING_BOTS=()
  deferred_list="$(read_deferred_bots)"
  while IFS=$'\t' read -r r_id r_orig r_tgt; do
    [[ -n "$r_id" ]] || continue
    [[ -n "$r_orig" ]] && BOT_ORIG["$r_id"]="$r_orig"
    [[ -n "$r_tgt" ]] && BOT_TARGET["$r_id"]="$r_tgt"
    TRACKING_BOTS+=("$r_id")
  done <<<"$deferred_list"
  bot_log "retry-deferred pass: ${#TRACKING_BOTS[@]} deferred bot(s) of the previous run, ${MYR_BOT_RETRY_WAIT_SEC}s wait per bot; no run is ever interrupted"
fi

total=${#TRACKING_BOTS[@]}
batches=$(((total + MYR_BOT_BATCH - 1) / MYR_BOT_BATCH))
bot_log "cards: $total tracking the release, $pinned pinned (left alone, listed above), $not_applicable not applicable (left alone, listed above); $batches batch(es) of at most $MYR_BOT_BATCH"
failed=0
switched=0
stayed_deferred=0
deferred_tail=()
batch_no=0
if ((RETRY_DEFERRED)); then
  # One deliberate pass over the deferred bots: wait per bot, re-apply, never
  # interrupt a run; the verdict belongs to the verification below.
  for id in "${TRACKING_BOTS[@]}"; do
    ((MYR_BOT_RETRY_WAIT_SEC > 0)) && sleep "$MYR_BOT_RETRY_WAIT_SEC"
    rc=0
    switch_bot_recorded "$id" || rc=$?
    case "$rc" in
      0) switched=$((switched + 1)) ;;
      2) stayed_deferred=$((stayed_deferred + 1)) ;;
      *) failed=$((failed + 1)); bot_log "FAILED: the retry of bot $id did not switch" ;;
    esac
  done
else
for ((start = 0; start < total; start += MYR_BOT_BATCH)); do
  batch_no=$((batch_no + 1))
  batch=("${TRACKING_BOTS[@]:start:MYR_BOT_BATCH}")
  bot_log "batch $batch_no/$batches: ${#batch[@]} bot(s)"
  b_switched=0 b_failed=0 b_deferred=0
  for id in "${batch[@]}"; do
    rc=0
    DEFERRED_REASON=""
    switch_bot_recorded "$id" || rc=$?
    case "$rc" in
      0) b_switched=$((b_switched + 1)) ;;
      2)
        deferred_tail+=("$id")
        deferred_reasons["$id"]="${DEFERRED_REASON:-deferred}"
        b_deferred=$((b_deferred + 1))
        ;;
      *) b_failed=$((b_failed + 1)); bot_log "FAILED: bot $id did not switch" ;;
    esac
  done
  switched=$((switched + b_switched))
  failed=$((failed + b_failed))
  bot_log "batch $batch_no/$batches done: $b_switched switched, $b_failed failed, $b_deferred deferred (progress $switched/$total)"
  journal "batch $batch_no/$batches: $b_switched switched, $b_failed failed, $b_deferred deferred"
done
fi

# --- tail pass: retry the deferred bots until the deadline -------------------
tail_start=$SECONDS
tail_deadline=$((tail_start + MYR_BOT_TIMEOUT_SEC))
if ((${#deferred_tail[@]} > 0)); then
  bot_log "tail pass: ${#deferred_tail[@]} deferred bot(s), deadline ${MYR_BOT_TIMEOUT_SEC}s"
  pending=("${deferred_tail[@]}")
  while ((${#pending[@]} > 0)); do
    retry=()
    for id in "${pending[@]}"; do
      rc=0
      DEFERRED_REASON=""
      switch_bot_recorded "$id" || rc=$?
      case "$rc" in
        0) switched=$((switched + 1)) ;;
        2)
          retry+=("$id")
          deferred_reasons["$id"]="${DEFERRED_REASON:-deferred}"
          ;;
        *) failed=$((failed + 1)); bot_log "FAILED: bot $id did not switch" ;;
      esac
    done
    pending=("${retry[@]}")
    ((${#pending[@]} > 0)) || break
    if ((SECONDS >= tail_deadline)); then
      break
    fi
    sleep "$POLL_INTERVAL_SEC"
  done
  deferred_tail=("${pending[@]}")
  if ((${#deferred_tail[@]} > 0)); then
    bot_log "tail pass done: ${#deferred_tail[@]} bot(s) still deferred"
  else
    bot_log "tail pass done: all deferred bots switched"
  fi
fi

# --- force stage: apply still-deferred bots without the status gate ----------
if ((${#deferred_tail[@]} > 0)) && ((MYR_BOT_FORCE_DEFERRED_SEC > 0)); then
  force_deadline=$((SECONDS + MYR_BOT_FORCE_DEFERRED_SEC))
  bot_log "force stage: ${#deferred_tail[@]} deferred bot(s), applying without status gate for ${MYR_BOT_FORCE_DEFERRED_SEC}s"
  pending=("${deferred_tail[@]}")
  while ((${#pending[@]} > 0)); do
    retry=()
    for id in "${pending[@]}"; do
      rc=0
      DEFERRED_REASON=""
      switch_bot_recorded "$id" force || rc=$?
      case "$rc" in
        0) switched=$((switched + 1)) ;;
        2)
          retry+=("$id")
          deferred_reasons["$id"]="${DEFERRED_REASON:-deferred}"
          ;;
        *) failed=$((failed + 1)); bot_log "FAILED: bot $id did not switch" ;;
      esac
    done
    pending=("${retry[@]}")
    ((${#pending[@]} > 0)) || break
    if ((SECONDS >= force_deadline)); then
      break
    fi
    sleep "$POLL_INTERVAL_SEC"
  done
  deferred_tail=("${pending[@]}")
  if ((${#deferred_tail[@]} > 0)); then
    bot_log "force stage done: ${#deferred_tail[@]} bot(s) still deferred"
  else
    bot_log "force stage done: all deferred bots switched"
  fi
fi

stayed_deferred=$((stayed_deferred + ${#deferred_tail[@]}))
if ((${#deferred_tail[@]} > 0)); then
  bot_log "final: ${#deferred_tail[@]} bot(s) not on the release image:"
  for id in "${deferred_tail[@]}"; do
    bot_log "  $id: ${deferred_reasons[$id]:-unknown reason}"
  done
fi


# F-04 (1.6.5): the exit rule is decided by the FACT, not by the ask: verify
# every bot of this pass (card vs running container), write the summary from
# the verified counts, then DEGRADED only when mismatch > 0 or failed > 0.
finalize_rollout() {
  local -a pass=("$@")
  local ref
  verify_fleet "${pass[@]}"
  collect_verdict
  pinned_json="$(printf '%s\n' "${PINNED_LIST[@]}" | jq -Rn '[inputs | select(length > 0) | split("|") | {id: .[0], image: (.[1:] | join("|"))}]')"
  na_json="$(printf '%s\n' "${NA_LIST[@]}" | jq -Rn '[inputs | select(length > 0) | split("|") | {id: .[0], reason: (.[1:] | join("|"))}]')"
  jq -cn --arg release "$resolution $res_ref" --argjson tracking "${#pass[@]}" \
    --argjson switched "$v_switched" --argjson deferred "$v_deferred" --argjson mismatch "$v_mismatch" \
    --argjson failed "$v_failed" --argjson verification "$VERIF_JSON" --argjson deferredBots "$DEFERRED_JSON" \
    --argjson pinned "$pinned" --argjson batches "$batches" \
    --argjson notApplicable "$not_applicable" --argjson pinnedBots "$pinned_json" --argjson notApplicableBots "$na_json" \
    '{release: $release, tracking: $tracking, switched: $switched, deferred: $deferred, mismatch: $mismatch,
      failed: $failed, verification: $verification, deferredBots: $deferredBots, pinned: $pinned,
      notApplicable: $notApplicable, pinnedBots: $pinnedBots, notApplicableBots: $notApplicableBots, batches: $batches}' \
    >"$MYR_BOT_SUMMARY" 2>/dev/null || true

  if ((v_mismatch > 0 || v_failed > 0)); then
    bot_log "DEGRADED: $v_failed bot(s) failed to switch to the release image, $v_mismatch card/container mismatch(es); see the log above and $MYR_BOT_ROLLOUT_LOG"
    exit 1
  fi

  # --- 6. remove the superseded bot image refs (only when everyone moved) -----
  if ((RETRY_DEFERRED)); then
    # The retry pass sees only the deferred bots of the previous run, not the
    # fleet: it cannot know that nobody still runs the old images. images[] is
    # left alone; the next full rollout removes the superseded refs.
    bot_log "retry-deferred pass: images in $MYR_BOT_DOCKERGATE_CONFIG left untouched (the old bot images are removed by the next full rollout)"
  elif ((v_deferred == 0)); then
    mapfile -t GONE_REFS < <(
      jq -r '.images[]?' "$MYR_BOT_DOCKERGATE_CONFIG" 2>/dev/null \
        | while IFS= read -r ref; do
            [[ -n "$ref" ]] || continue
            case "$ref" in
              *myrmidon-hermes@* | *myrmidon-hermes-dev@* | *myrmidon-hermes-node@*)
                is_release_ref "$ref" || printf '%s\n' "$ref"
                ;;
            esac
          done
    )
    if ((${#GONE_REFS[@]} && ${#GONE_REFS[@]} > 0)) && [[ -n "${GONE_REFS[0]}" ]]; then
      dockergate_remove_images "$MYR_BOT_DOCKERGATE_CONFIG" "${GONE_REFS[@]}"
      dockergate_check_config "$MYR_BOT_DOCKERGATE_CONFIG"
      dockergate_reload
      bot_log "removed ${#GONE_REFS[@]} superseded bot image ref(s) from images"
      for ref in "${GONE_REFS[@]}"; do
        [[ -n "$ref" ]] && journal "images removed $ref"
      done
    else
      bot_log "no superseded bot image refs to remove from images"
    fi
  else
    # deferred is not a failure (F-04 p.2): exit 0 with a WARNING and the
    # standard re-run command (decision 06.10 item 3); the old bot images stay
    # allowed until the deferred bots actually move.
    bot_log "WARNING: $v_deferred bot(s) deferred (the running container is not on the release image yet; no run interrupted): the periodic sweep applies them. Standard re-run pass once they go quiet:"
    bot_log "  $(retry_command)"

    bot_log "$v_deferred bot(s) stayed deferred: the old bot images stay in images until they move (the next rollout removes them)"
  fi

  bot_log "bot image rollout complete: $v_switched bot(s) on the release images, journal $MYR_BOT_ROLLOUT_LOG"
  journal "rollout complete: $v_switched bot(s) on the release images ($resolution $res_ref)"

  # DEPLOY-HYGIENE (OPE-5107): the bots moved to the release images — free the
  # disk of the superseded ones (older than MYRMIDON_DEPLOY_IMAGE_KEEP previous
  # releases; an image used by any container is never removed). Standalone runs
  # only: when deploy.sh drives the rollout, deploy.sh runs the same cleanup
  # once after its post-deploy steps. A failure here never fails the rollout.
  if [[ -z "${MYRMIDON_DEPLOY_DISK_PRECHECK_DONE:-}" ]]; then
    if deploy_image_retention; then :; else
      bot_log "WARNING: the old image cleanup failed; the rollout itself is complete (remove old images by hand: docker image ls)"
    fi
  fi

  exit 0
}

# rel/1.6.5-rc.7 (#985) states the deferred bots from the pass counters; the fact-based
# verdict below (F-04 part B) decides the exit code. Keep both: the statement is not a verdict.
if ((stayed_deferred > 0)); then
  bot_log "WARNING: $stayed_deferred bot(s) stayed deferred (a busy agent or a 409 refusal); the cards already name the release image and the periodic sweep completes them"
fi

finalize_rollout "${TRACKING_BOTS[@]}"
