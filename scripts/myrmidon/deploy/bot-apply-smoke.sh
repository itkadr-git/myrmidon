#!/usr/bin/env bash
# scripts/myrmidon/deploy/bot-apply-smoke.sh
#
# RELEASE-GATE (the 01.10 incident & 03.11 OPE-10756 incident): post-deploy smoke
# of the bot fleet. The 01.10 incident showed a deploy can be "healthy" (board
# answers /api/health) while every bot apply is denied by a mismatched dockergate
# and the whole fleet sits in `created`. The 03.11 incident showed a deploy can
# exit rc=0 while gateway run_startup crashes (NameError SessionStore) and 0 bots
# are healthy.
#
# This script watches the fleet until at least N% of switched bots (default 50%)
# have Docker health = healthy and gateway /health responding — within a bounded
# window. On failure, it reports DEPLOYED-DEGRADED, prints trailing gateway logs,
# and exits != 0 so deploy.sh reports DEPLOYED-DEGRADED and prints rollback commands.
#
#   bot-apply-smoke.sh --board-url <http://host:3100/api> --token-file <file>
#                      --company <companyId> [--timeout 300] [--interval 10]
#                      [--agent <id>] [--summary <file>]
#                      [--min-healthy-percent <0-100>] [--dry-run]
#
# Exit codes: 0 = required percentage of bot gateways healthy; 1 = not within
# timeout (prints DEPLOYED-DEGRADED and gateway logs); 2 = usage/transport error.
set -euo pipefail

log() { printf '[myrmidon-smoke] %s\n' "$*" >&2; }
die() { printf '[myrmidon-smoke] ERROR: %s\n' "$*" >&2; exit 2; }

board_url=""
token_file=""
company=""
timeout_sec="${MYRMIDON_DEPLOY_SMOKE_TIMEOUT_SEC:-300}"
interval="${MYRMIDON_DEPLOY_SMOKE_INTERVAL_SEC:-10}"
agent="${MYRMIDON_DEPLOY_SMOKE_AGENT:-}"
summary_file="${MYRMIDON_BOT_IMAGE_ROLLOUT_SUMMARY:-}"
min_healthy_percent="${MYRMIDON_DEPLOY_SMOKE_MIN_HEALTHY_PERCENT:-${MYRMIDON_DEPLOY_SMOKE_HEALTHY_PERCENT:-50}}"
dry_run=0

while (($#)); do
  case "$1" in
    --board-url) board_url="$2"; shift 2 ;;
    --token-file) token_file="$2"; shift 2 ;;
    --company) company="$2"; shift 2 ;;
    --timeout) timeout_sec="$2"; shift 2 ;;
    --interval) interval="$2"; shift 2 ;;
    --agent) agent="$2"; shift 2 ;;
    --summary) summary_file="$2"; shift 2 ;;
    --min-healthy-percent) min_healthy_percent="$2"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -n "$board_url" ]] || die "--board-url is required (the board API root, e.g. http://127.0.0.1:3100/api)"
[[ -n "$company" ]] || die "--company is required (the company whose agents to watch; the agents list is company-scoped)"
[[ "$timeout_sec" =~ ^[0-9]+$ ]] || die "--timeout must be a number of seconds"
[[ "$interval" =~ ^[1-9][0-9]*$ ]] || die "--interval must be a positive number of seconds"
[[ "$min_healthy_percent" =~ ^[0-9]+$ ]] || die "--min-healthy-percent must be an integer (0-100)"
(( min_healthy_percent >= 0 && min_healthy_percent <= 100 )) || die "--min-healthy-percent must be between 0 and 100"

auth_args=()
if [[ -n "$token_file" ]]; then
  [[ -r "$token_file" ]] || die "token file not readable: $token_file"
  auth_args=(-H "Authorization: Bearer $(cat "$token_file")")
fi

# The company's agents: one read-only call; each row has id and adapterType.
list_agent_ids() {
  local body
  body="$(curl -fsS --max-time 10 "${auth_args[@]}" "$board_url/companies/$company/agents" 2>/dev/null)" || return 1
  jq -r '[.[]? | select(.adapterType == "hermes_gateway") | .id] | join(" ")' <<<"$body" 2>/dev/null
}

# Status of one agent's bot container (routes.ts bot-container status).
container_state() {
  local id="$1" body
  body="$(curl -fsS --max-time 10 "${auth_args[@]}" "$board_url/myrmidon/agents/$id/bot-container/status" 2>/dev/null)" || return 1
  jq -r '.container.state // "missing"' <<<"$body" 2>/dev/null
}

container_error() {
  local id="$1" body
  body="$(curl -fsS --max-time 10 "${auth_args[@]}" "$board_url/myrmidon/agents/$id/bot-container/status" 2>/dev/null)" || return 1
  jq -r '.containerError // ""' <<<"$body" 2>/dev/null
}

find_container() {
  local id="$1"
  if command -v docker >/dev/null 2>&1; then
    if docker inspect "myrmidon-bot-$id" >/dev/null 2>&1; then
      echo "myrmidon-bot-$id"
      return 0
    fi
    local match
    match="$(docker ps -a --filter "name=$id" --format '{{.Names}}' 2>/dev/null | head -n1 || true)"
    if [[ -n "$match" ]]; then
      echo "$match"
      return 0
    fi
  fi
  echo "myrmidon-bot-$id"
}

check_bot_healthy() {
  local id="$1"
  local cname="$2"
  local bstate
  bstate="$(container_state "$id" || echo "missing")"

  if [[ "$bstate" != "running" && "$bstate" != "healthy" ]]; then
    echo "board:$bstate"
    return 1
  fi

  if command -v docker >/dev/null 2>&1; then
    local hstatus
    hstatus="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cname" 2>/dev/null || echo "missing")"
    if [[ "$hstatus" == "unhealthy" || "$hstatus" == "starting" || "$hstatus" == "missing" ]]; then
      echo "docker:$hstatus"
      return 1
    fi

    # Docker healthcheck is healthy. Verify /health probe if possible:
    if docker exec "$cname" curl -fsS --max-time 3 "http://127.0.0.1:8642/health" >/dev/null 2>&1; then
      echo "healthy"
      return 0
    fi

    if [[ "$hstatus" == "healthy" ]]; then
      echo "healthy"
      return 0
    fi

    echo "docker:$hstatus"
    return 1
  fi

  if [[ "$bstate" == "running" ]]; then
    echo "healthy"
    return 0
  fi
  echo "board:$bstate"
  return 1
}

if [[ "$dry_run" == "1" ]]; then
  log "dry run: would poll bot gateway health (threshold >=${min_healthy_percent}%, timeout ${timeout_sec}s, interval ${interval}s${agent:+, agent $agent})"
  exit 0
fi

get_target_bot_ids() {
  if [[ -n "$agent" ]]; then
    echo "$agent"
    return 0
  fi
  if [[ -n "$summary_file" && -f "$summary_file" ]]; then
    local from_sum
    from_sum="$(jq -r '.switchedBots[]? // empty' "$summary_file" 2>/dev/null || true)"
    if [[ -n "$from_sum" ]]; then
      echo "$from_sum"
      return 0
    fi
  fi
  list_agent_ids || true
}

log "waiting for bot gateways to be healthy (timeout ${timeout_sec}s, threshold ${min_healthy_percent}%)"
deadline=$((SECONDS + timeout_sec))

while ((SECONDS < deadline)); do
  target_raw="$(get_target_bot_ids || true)"
  target_ids=()
  for id in $target_raw; do
    [[ -n "$id" ]] && target_ids+=("$id")
  done

  total="${#target_ids[@]}"
  if (( total == 0 )); then
    log "no hermes_gateway agents listed (board not ready yet, or none in company $company)"
  else
    needed=$(( (total * min_healthy_percent + 99) / 100 ))
    if (( min_healthy_percent == 0 )); then
      needed=0
    elif (( needed < 1 )); then
      needed=1
    fi

    healthy_count=0
    healthy_ids=()
    unhealthy_ids=()
    status_details=()
    last_healthy_id=""

    for id in "${target_ids[@]}"; do
      cname="$(find_container "$id")"
      h_out="$(check_bot_healthy "$id" "$cname" || true)"
      if [[ "$h_out" == "healthy" ]]; then
        healthy_count=$((healthy_count + 1))
        healthy_ids+=("$id")
        last_healthy_id="$id"
        status_details+=("${id##*-}:healthy")
      else
        unhealthy_ids+=("$id")
        status_details+=("${id##*-}:$h_out")
      fi
    done

    if (( healthy_count >= needed )); then
      log "OK: bot container of agent ${last_healthy_id:-${target_ids[0]}} is running and healthy (re-applied after the deploy; $healthy_count/$total bot gateways healthy, threshold: ${min_healthy_percent}%)"
      exit 0
    fi

    log "waiting for bot gateways: $healthy_count/$total healthy (required: $needed, ${min_healthy_percent}%; statuses: ${status_details[*]:-none})"
  fi
  sleep "$interval"
done

target_raw="$(get_target_bot_ids || true)"
target_ids=()
for id in $target_raw; do
  [[ -n "$id" ]] && target_ids+=("$id")
done
total="${#target_ids[@]}"
needed=$(( (total * min_healthy_percent + 99) / 100 ))
if (( min_healthy_percent == 0 )); then
  needed=0
elif (( needed < 1 && total > 0 )); then
  needed=1
fi

log "SMOKE FAILED: DEPLOYED-DEGRADED: only ${healthy_count:-0}/$total bot gateways are healthy within ${timeout_sec}s (required: $needed, ${min_healthy_percent}%)"
log "Diagnosis: trailing gateway logs for unhealthy bot containers:"
for id in "${unhealthy_ids[@]:-${target_ids[@]}}"; do
  cname="$(find_container "$id")"
  log "--- Last gateway log lines for bot $id ($cname) ---"
  if command -v docker >/dev/null 2>&1; then
    docker logs --tail 30 "$cname" 2>&1 | while IFS= read -r line; do
      log "  [$cname] $line"
    done || true
  fi
  c_err="$(container_error "$id" || true)"
  if [[ -n "$c_err" ]]; then
    log "  [$cname containerError] $c_err"
  fi
done

exit 1
