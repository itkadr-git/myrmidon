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
#   4. Enroll the fleet in `bots[]`: the board's agents list is the source of
#      truth. A bot missing from `bots[]` is exactly the `bot_not_enrolled`
#      refusal Wiki Maintainer hit on 03.10. Limits come from the card
#      (container.memoryMb/cpus/pidsLimit).
#   5. Switch the bot cards to the release image, one bot at a time (canary
#      first when --canary names one): PATCH the card's
#      adapterConfig.container.image, then POST the card's "apply" so the
#      board's own reconciler drains that agent alone and recreates the
#      container. A bot with running work answers `deferred`: the rollout
#      retries it (MYRMIDON_BOT_IMAGE_ROLLOUT_BOT_TIMEOUT_SEC per bot) and a
#      run is never interrupted by this rollout. A deferred bot keeps its old
#      card image until a later retry or the periodic sweep.
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
# Cards: a card TRACKS the release when its image is a digest-pinned image of one
# of our bot repositories (hermes, hermes-dev, hermes-node) that is not the
# release's image of that repository; it moves to the release image of the SAME
# repository. Any other card image (another repository, a tag, none) is PINNED
# and left alone. Cards switch in batches of at most 5, and a bot is switched
# only while its agent is paused or idle; every batch and every failure is
# reported (log lines, the journal and $STATE_DIR/bot-image-rollout-summary.json).
#
# Exit codes: 0 = rolled out (or dry run); 1 = failure (see the log lines).
set -euo pipefail
# shellcheck source=lib.sh source-path=SCRIPTDIR
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

config="" resolution="" res_ref=""
DRY_RUN=0 canary="" phase="all" no_reload=0 dockergate_image=""
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
    -h|--help) sed -n '2,72p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n "$config" ]] || die "--config is required"
[[ "$phase" == "all" || "$phase" == "config" || "$phase" == "cards" ]] || die "--phase must be all, config or cards"
[[ "$resolution" == "tag" || "$resolution" == "sha" ]] \
  || die "--resolution must be tag or sha (what deploy.sh resolved the release by)"
[[ -n "$res_ref" ]] || die "--ref is required (the release tag, or the commit short sha)"
load_config "$config"
require_cmd docker curl jq

# --- settings (see deploy.env.example) ---------------------------------------
MYR_BOT_COMPONENTS="${MYRMIDON_BOT_IMAGE_ROLLOUT_COMPONENTS:-hermes,hermes-dev,hermes-node}"
MYR_BOT_TIMEOUT_SEC="${MYRMIDON_BOT_IMAGE_ROLLOUT_BOT_TIMEOUT_SEC:-900}"
MYR_BOT_DOCKERGATE_CONFIG="${MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_CONFIG:-}"
MYR_BOT_DOCKERGATE_CHECK="${MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_CHECK_CONFIG_COMMAND:-}"
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

board_post_json() {
  local path="$1" body="$2"
  local -a auth=()
  mapfile -t auth < <(auth_args)
  curl -fsS --max-time 180 -X POST -H 'Content-Type: application/json' "${auth[@]}" --data "$body" \
    "$BOARD_API_URL$path" 2>/dev/null || return 1
}

# The company's hermes_gateway agents with enabled container blocks, shaped as
# "id|memoryMb|cpus|pidsLimit" per line. Card limits are the enrollment limits.
list_bots() {
  local body
  body="$(board_get "/companies/$BOARD_COMPANY_ID/agents")" || return 1
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
  body="$(board_get "/companies/$BOARD_COMPANY_ID/agents")" || return 1
  jq -r --arg id "$id" 'first(.[]? | select(.id == $id) | .adapterConfig.container.image // "")' <<<"$body" 2>/dev/null
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
# Add refs to images[] (idempotent: already-listed refs are kept once).
dockergate_add_images() {
  local cfg_file="$1"; shift
  local -a add=("$@")
  [[ -f "$cfg_file" ]] || die "dockergate config not found: $cfg_file"
  jq '.images = ((.images // []) + $ARGS.positional) | .images |= (unique | sort)' \
    "$cfg_file" --args "${add[@]}" >"$cfg_file.new" 2>/dev/null \
    || { rm -f "$cfg_file.new"; die "cannot edit $cfg_file with jq (is it valid JSON?)"; }
  mv "$cfg_file.new" "$cfg_file"
}

# Remove refs from images[] (refs that are gone stay gone; pinned ones are
# filtered by the caller).
dockergate_remove_images() {
  local cfg_file="$1"; shift
  local -a gone=("$@")
  jq '.images = ((.images // []) | map(. as $r | select(($ARGS.positional | index($r)) == null)))' \
    "$cfg_file" --args "${gone[@]}" >"$cfg_file.new" 2>/dev/null \
    || { rm -f "$cfg_file.new"; die "cannot edit $cfg_file with jq (is it valid JSON?)"; }
  mv "$cfg_file.new" "$cfg_file"
}

# Enroll the fleet in bots[]: "id|mem|cpus|pids" per line; a bot already
# enrolled keeps its existing limits (an operator's enrollment wins).
dockergate_enroll_bots() {
  local cfg_file="$1" bots="$2"
  [[ -f "$cfg_file" ]] || die "dockergate config not found: $cfg_file"
  jq -Rn --rawfile cfg "$cfg_file" '
    $cfg | fromjson as $c
    | [inputs | split("|") | select(length == 4)
        | {botKey: .[0], maxMemoryMb: (.[1] | tonumber), maxCpus: (.[2] | tonumber), maxPids: (.[3] | tonumber)}] as $want
    | ($want | map(select(.botKey as $k | ($c.bots // [] | map(.botKey) | index($k)) == null))) as $add
    | $c + {bots: (($c.bots // []) + $add)}
  ' <<<"$bots" >"$cfg_file.new" 2>/dev/null \
    || { rm -f "$cfg_file.new"; die "cannot edit bots[] of $cfg_file with jq (is it valid JSON?)"; }
  mv "$cfg_file.new" "$cfg_file"
}

# dockergate check-config against the real binary (the caller names the
# command; e.g. "docker run --rm -v file:/c.json <image> check-config --config /c.json").
dockergate_check_config() {
  local cfg_file="$1"
  if [[ "$DRY_RUN" == "1" ]]; then
    bot_log "dry run: dockergate check-config of $cfg_file"
    return 0
  fi
  local rc=0
  dockergate_check_config_file "$cfg_file" "$dockergate_image" || rc=$?
  case "$rc" in
    0) ;;
    3) bot_log "WARNING: no check-config command (MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_CHECK_CONFIG_COMMAND) and no dockergate image; the edited config is not verified" ;;
    *) die "dockergate check-config refused the edited config ($cfg_file); the last edit was not applied further" ;;
  esac
}

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
  bot_log "dockergate reloaded (SIGHUP)"
}

# --- the plan (dry run) --------------------------------------------------------
if [[ "$DRY_RUN" == "1" ]]; then
  bot_log "dry run: nothing will be changed. Bot image rollout plan:"
  bot_log "  1. resolved (read-only): $bot_digests"
  bot_log "  2. pull each image on the local host${MYR_BOT_FLEET_HOSTS:+ and fleet hosts $MYR_BOT_FLEET_HOSTS}"
  bot_log "  3. add the new digests to images of $MYR_BOT_DOCKERGATE_CONFIG (old bot images stay until the fleet moved); check-config; SIGHUP"
  bot_log "  4. enroll every hermes_gateway bot of company $BOARD_COMPANY_ID in bots of the dockergate config"
  bot_log "  5. switch every bot card to the release image, one at a time${canary:+ (canary $canary first)}, through PATCH + apply; deferred bots retry up to ${MYR_BOT_TIMEOUT_SEC}s; no run is interrupted"
  bot_log "  6. remove the superseded bot images from images; SIGHUP"
  bot_log "  7. journal: $MYR_BOT_ROLLOUT_LOG"
  bots="$(list_bots || true)"
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
      if ssh "${fleet_ssh_opts[@]}" "$host" "test -f '$fleet_cfg'" 2>/dev/null; then
        scp -q "${fleet_ssh_opts[@]}" "$MYR_BOT_DOCKERGATE_CONFIG" "$host:/tmp/.myrmidon-bot-enroll.$$" 2>/dev/null || true
        ssh "${fleet_ssh_opts[@]}" "$host" \
          "jq -c '. + {bots: ((.bots // []) + (input | .bots // []) | unique_by(.botKey))}' '$fleet_cfg' /tmp/.myrmidon-bot-enroll.$$ >'$fleet_cfg.new' && mv '$fleet_cfg.new' '$fleet_cfg' && rm -f /tmp/.myrmidon-bot-enroll.$$" \
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
    *myrmidon-hermes-dev@sha256:*) printf '%s\n' "${BOT_IMAGE_BY_NAME[hermes-dev]:-}" ;;
    *myrmidon-hermes-node@sha256:*) printf '%s\n' "${BOT_IMAGE_BY_NAME[hermes-node]:-}" ;;
    *myrmidon-hermes@sha256:*) printf '%s\n' "${BOT_IMAGE_BY_NAME[hermes]:-}" ;;
    *) printf '\n' ;;
  esac
}

# The agent's status (idle, paused, running, ...), empty when unknown.
card_status() {
  local id="$1" body
  body="$(board_get "/companies/$BOARD_COMPANY_ID/agents")" || return 1
  jq -r --arg id "$id" 'first(.[]? | select(.id == $id) | .status // "")' <<<"$body" 2>/dev/null
}

# Returns 0 switched, 2 deferred (retry), 1 failed.
switch_one_bot() {
  local id="$1" current target body out kind status
  current="$(card_image "$id" || true)"
  [[ -n "$current" ]] || current="(none)"
  target="$(release_image_for "$current")"
  # Only while the agent is paused or idle: no run is ever interrupted by the
  # rollout (an unknown status is treated as busy: fail-closed).
  status="$(card_status "$id" || true)"
  case "$status" in
    idle | paused) ;;
    *)
      bot_log "bot $id deferred (agent status '${status:-unknown}': switched only while paused or idle)"
      return 2
      ;;
  esac
  if is_release_ref "$current"; then
    # The card already names the release image (a previous rollout switched
    # it or the apply stayed deferred): only re-apply, never re-PATCH.
    out="$(board_post_json "/myrmidon/agents/$id/bot-container/apply" '{}')" || {
      bot_log "apply of bot $id failed (card already on the release image); the periodic sweep retries"
      journal "agent $id apply failed (card already on $target; the sweep retries)"
      return 1
    }
  else
    # PATCH the card: only adapterConfig.container.image is sent; the route
    # merges the patch into the stored adapterConfig, every other field stays.
    body="$(jq -cn --arg img "$target" '{adapterConfig: {container: {image: $img}}}')"
    if ! board_patch_json "/agents/$id" "$body" >/dev/null; then
      bot_log "PATCH of bot $id's card failed; the card is untouched"
      return 1
    fi
    # Apply now: the board's own reconciler drains this agent alone and
    # recreates the container with the new image.
    out="$(board_post_json "/myrmidon/agents/$id/bot-container/apply" '{}')" || {
      bot_log "apply of bot $id failed after the card switch; the card points at the release image, the periodic sweep applies it"
      journal "agent $id card switched to $target (apply failed; the sweep retries)"
      return 1
    }
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
      return 2
      ;;
    *)
      bot_log "bot $id: unexpected apply outcome '$kind'"
      journal "agent $id apply outcome '$kind'"
      return 1
      ;;
  esac
}

# Classify the cards: tracking (to switch) and pinned (left alone).
TRACKING_BOTS=()
pinned=0
while IFS= read -r id_line; do
  [[ -n "$id_line" ]] || continue
  id="${id_line%%|*}"
  current="$(card_image "$id" || true)"
  target="$(release_image_for "$current")"
  if [[ -z "$target" ]]; then
    bot_log "bot $id is pinned (image '${current:-<none>}' is not a previous release image of a bot repository this release ships): left alone"
    journal "agent $id pinned (${current:-none}): left alone"
    pinned=$((pinned + 1))
  else
    TRACKING_BOTS+=("$id")
  fi
done <<<"$bots"
if [[ -n "$canary" ]]; then
  # the canary leads the first batch
  mapfile -t TRACKING_BOTS < <(
    for id in "${TRACKING_BOTS[@]}"; do [[ "$id" == "$canary" ]] && echo "$id"; done
    for id in "${TRACKING_BOTS[@]}"; do [[ "$id" != "$canary" ]] && echo "$id"; done
  )
fi

total=${#TRACKING_BOTS[@]}
batches=$(((total + MYR_BOT_BATCH - 1) / MYR_BOT_BATCH))
bot_log "cards: $total tracking the release, $pinned pinned (left alone); $batches batch(es) of at most $MYR_BOT_BATCH"
failed=0
switched=0
stayed_deferred=0
batch_no=0
for ((start = 0; start < total; start += MYR_BOT_BATCH)); do
  batch_no=$((batch_no + 1))
  batch=("${TRACKING_BOTS[@]:start:MYR_BOT_BATCH}")
  bot_log "batch $batch_no/$batches: ${#batch[@]} bot(s)"
  pending=("${batch[@]}")
  deadline=$((SECONDS + MYR_BOT_TIMEOUT_SEC))
  b_switched=0 b_failed=0
  while ((${#pending[@]} > 0)); do
    retry=()
    for id in "${pending[@]}"; do
      rc=0
      switch_one_bot "$id" || rc=$?
      case "$rc" in
        0) b_switched=$((b_switched + 1)) ;;
        2) retry+=("$id") ;;
        *) b_failed=$((b_failed + 1)); bot_log "FAILED: bot $id did not switch" ;;
      esac
    done
    pending=("${retry[@]}")
    ((${#pending[@]} > 0)) || break
    if ((SECONDS >= deadline)); then
      for id in "${pending[@]}"; do
        bot_log "bot $id stayed busy/deferred for ${MYR_BOT_TIMEOUT_SEC}s; its card keeps the OLD image and the periodic sweep applies it later"
        journal "agent $id still deferred after ${MYR_BOT_TIMEOUT_SEC}s (card unchanged)"
      done
      stayed_deferred=$((stayed_deferred + ${#pending[@]}))
      break
    fi
    sleep "$POLL_INTERVAL_SEC"
  done
  switched=$((switched + b_switched))
  failed=$((failed + b_failed))
  bot_log "batch $batch_no/$batches done: $b_switched switched, $b_failed failed, ${#pending[@]} deferred (progress $switched/$total)"
  journal "batch $batch_no/$batches: $b_switched switched, $b_failed failed, ${#pending[@]} deferred"
done

mkdir -p "$(dirname "$MYR_BOT_SUMMARY")" 2>/dev/null || true
jq -cn --arg release "$resolution $res_ref" --argjson tracking "$total" --argjson switched "$switched" \
  --argjson deferred "$stayed_deferred" --argjson failed "$failed" --argjson pinned "$pinned" --argjson batches "$batches" \
  '{release: $release, tracking: $tracking, switched: $switched, deferred: $deferred, failed: $failed, pinned: $pinned, batches: $batches}' \
  >"$MYR_BOT_SUMMARY" 2>/dev/null || true

if ((failed > 0)); then
  bot_log "DEGRADED: $failed bot(s) failed to switch to the release image; see the log above and $MYR_BOT_ROLLOUT_LOG"
  exit 1
fi

# --- 6. remove the superseded bot image refs (only when everyone moved) -------
if ((stayed_deferred == 0)); then
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
  bot_log "$stayed_deferred bot(s) stayed deferred: the old bot images stay in images until they move (the next rollout removes them)"
fi

bot_log "bot image rollout complete: $switched bot(s) on the release images, journal $MYR_BOT_ROLLOUT_LOG"
journal "rollout complete: $switched bot(s) on the release images ($resolution $res_ref)"
exit 0
