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
# DEPLOY-SMOKE-FALSE (the 08.11 incidents): a healthy fleet must not fail the
# smoke. Containers stopped BEFORE the deploy began are pre-deploy state, not
# deploy casualties; an `Exited (143)` container the fleet itself stopped by
# IDLE-STOP (the board's idleStopped flag) is a planned stop, not a crash.
# Abnormal means OOMKilled, a board/dockergate containerError, Docker
# unhealthy, or a non-zero exit AFTER the deploy started that is not the
# IDLE-STOP 143. Without the bot image rollout (--no-bot-rollout) no bot
# re-applies by design: the smoke then verifies the already-running gateways.
#
#   bot-apply-smoke.sh --board-url <http://host:3100/api> --token-file <file>
#                      --company <companyId> [--timeout 300] [--interval 10]
#                      [--agent <id>] [--summary <file>]
#                      [--min-healthy-percent <0-100>] [--no-bot-rollout]
#                      [--dry-run]
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
no_bot_rollout=0
deploy_started_at=""

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
    --no-bot-rollout) no_bot_rollout=1; shift ;;
    --deploy-started-at) deploy_started_at="$2"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) sed -n '2,34p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -n "$board_url" ]] || die "--board-url is required (the board API root, e.g. http://127.0.0.1:3100/api)"
[[ -n "$company" ]] || die "--company is required (the company whose agents to watch; the agents list is company-scoped)"
[[ "$timeout_sec" =~ ^[0-9]+$ ]] || die "--timeout must be a number of seconds"
[[ "$interval" =~ ^[1-9][0-9]*$ ]] || die "--interval must be a positive number of seconds"
[[ "$min_healthy_percent" =~ ^[0-9]+$ ]] || die "--min-healthy-percent must be an integer (0-100)"
(( min_healthy_percent >= 0 && min_healthy_percent <= 100 )) || die "--min-healthy-percent must be between 0 and 100"
if [[ -n "$deploy_started_at" ]]; then
  [[ "$deploy_started_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
    || die "--deploy-started-at must be an ISO-8601 UTC timestamp (YYYY-MM-DDTHH:MM:SSZ)"
  deploy_start_epoch="$(date -u -d "$deploy_started_at" +%s 2>/dev/null)" \
    || die "--deploy-started-at is not a parseable UTC timestamp: $deploy_started_at"
else
  deploy_start_epoch=0
fi

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

# DEPLOY-SMOKE-FALSE-2 (rc.17/rc.19, 10.11): the deciding signal for an
# unhealthy mark is THIS poll, not any poll — a bot whose gateway answers its
# own /health probe right now has already recovered (the Docker healthcheck and
# the board-side state both lag across a maintenance window).
gateway_responds() {
  docker exec "$1" curl -fsS --max-time 3 "http://127.0.0.1:8642/health" >/dev/null 2>&1
}

classify_bot() {
  local id="$1"
  local cname="$2"
  local agent_status="${3:-}"

  local bjson
  bjson="$(curl -fsS --max-time 10 "${auth_args[@]}" "$board_url/myrmidon/agents/$id/bot-container/status" 2>/dev/null || echo "{}")"
  local bstate bidle berr
  bstate="$(jq -r '.container.state // "missing"' <<<"$bjson" 2>/dev/null || echo "missing")"
  bidle="$(jq -r '(.container.idleStopped // .idleStopRuntime.idleStopped // false)' <<<"$bjson" 2>/dev/null || echo "false")"
  berr="$(jq -r '.containerError // ""' <<<"$bjson" 2>/dev/null || echo "")"

  local hstatus="missing" dstatus="missing" exitcode="0" oomkilled="false" finishedat="0"
  if command -v docker >/dev/null 2>&1; then
    local dinfo
    dinfo="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}|{{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}|{{if .State.FinishedAt}}{{.State.FinishedAt}}{{end}}' "$cname" 2>/dev/null || echo "missing|missing|0|false|")"
    IFS='|' read -r hstatus dstatus exitcode oomkilled finishedat <<<"$dinfo"
    # An inspect failure ("No such container") or an empty field must read as
    # "missing", never as an empty string — an empty status printed
    # "docker:"/"board:" and blocked the pass decision in the rc.19 incident.
    [[ -z "$hstatus" ]] && hstatus="missing"
    [[ -z "$dstatus" ]] && dstatus="$hstatus"
    [[ -z "$exitcode" ]] && exitcode="0"
    [[ -z "$oomkilled" ]] && oomkilled="false"
    [[ -z "$finishedat" ]] && finishedat="0"
  fi

  # DEPLOY-SMOKE-FALSE (the 08.11 incidents): a container that stopped BEFORE
  # the deploy began is pre-deploy state, not a deploy casualty — the deploy
  # cannot have crashed it. No deploy start recorded: every stop is in-window
  # (the conservative pre-08.11 behaviour).
  local stopped_before_deploy=0
  if (( deploy_start_epoch > 0 )) && [[ "$dstatus" == "exited" || "$hstatus" == "exited" ]]; then
    local finished_epoch=0
    if [[ "$finishedat" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2} ]]; then
      finished_epoch="$(date -u -d "${finishedat%%.*}" +%s 2>/dev/null || echo 0)"
      [[ "$finished_epoch" =~ ^[0-9]+$ ]] || finished_epoch=0
    fi
    if (( finished_epoch > 0 && finished_epoch < deploy_start_epoch )); then
      stopped_before_deploy=1
    fi
  fi

  # DEPLOY-SMOKE-FALSE: an `Exited (143)` of an IDLE-STOP is the fleet's own
  # planned stop (SIGTERM on the idle timeout), not an abnormal exit. The
  # board's idleStopped flag is the source of truth; with the flag present the
  # 143 is trusted even when the inspect FinishedAt is unavailable.
  local idle_stop_143=0
  if [[ "$bidle" == "true" && "$exitcode" == "143" ]]; then
    idle_stop_143=1
  fi

  # 1. Crash / abnormal exit checks (аварийный выход)
  if [[ -n "$berr" ]]; then
    echo "crashed:error"
    return 0
  fi
  # A prior Docker/board unhealthy mark is only a crash when the gateway's
  # current health probe also fails. This evaluates the current poll rather
  # than treating a transient maintenance-window healthcheck failure as sticky.
  # (In real Docker an unhealthy mark never occurs while State.Status is not
  # running, so the probe only succeeds on a live recovered container.)
  if [[ "$bstate" == "unhealthy" || "$hstatus" == "unhealthy" ]]; then
    if gateway_responds "$cname"; then
      echo "healthy"
      return 0
    fi
    if [[ "$hstatus" == "unhealthy" ]]; then
      echo "crashed:docker_unhealthy"
    else
      echo "crashed:board_unhealthy"
    fi
    return 0
  fi
  if [[ "$oomkilled" == "true" ]]; then
    # Docker preserves OOMKilled on an exited container until it is replaced.
    # Treat it as a deploy casualty only when its finish time is in-window.
    local oom_in_window=1
    if (( deploy_start_epoch > 0 )); then
      local oom_finished_epoch=0
      if [[ "$finishedat" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2} ]]; then
        oom_finished_epoch="$(date -u -d "${finishedat%%.*}" +%s 2>/dev/null || echo 0)"
        [[ "$oom_finished_epoch" =~ ^[0-9]+$ ]] || oom_finished_epoch=0
      fi
      (( oom_finished_epoch >= deploy_start_epoch )) || oom_in_window=0
    fi
    if (( oom_in_window == 1 )); then
      echo "crashed:oom"
      return 0
    fi
  fi
  # A missing runtime container is expected for agents stopped by idle-stop or
  # not yet applied. Without a live container (or a board-side error), it is not
  # evidence of a deploy crash.
  if [[ "$dstatus" == "missing" && "$hstatus" == "missing" && -z "$berr" ]]; then
    echo "idle_stopped"
    return 0
  fi
  if [[ "$dstatus" == "exited" || "$hstatus" == "exited" ]]; then
    if (( stopped_before_deploy == 1 )); then
      # Pre-deploy stop: not a deploy casualty, and not an active gateway
      # to wait for. Exclude from the smoke denominator as idle_stopped.
      echo "idle_stopped"
      return 0
    elif (( idle_stop_143 == 1 )); then
      echo "idle_stopped"
      return 0
    elif [[ "$exitcode" != "0" ]]; then
      echo "crashed:exit_${exitcode}"
      return 0
    fi
  fi

  # 2. Idle-stopped checks (штатно остановлен за простой)
  if [[ "$bidle" == "true" ]]; then
    echo "idle_stopped"
    return 0
  fi
  if [[ "$agent_status" == "idle" && ( "$bstate" == "stopped" || "$bstate" == "missing" ) ]]; then
    echo "idle_stopped"
    return 0
  fi
  if [[ ( "$dstatus" == "created" || "$hstatus" == "created" ) && ( "$bstate" == "stopped" || "$bstate" == "missing" || "$agent_status" == "idle" ) ]]; then
    echo "idle_stopped"
    return 0
  fi
  if [[ ( "$dstatus" == "exited" || "$hstatus" == "exited" ) && "$exitcode" == "0" && ( "$bstate" == "stopped" || "$agent_status" == "idle" ) ]]; then
    echo "idle_stopped"
    return 0
  fi
  # DEPLOY-SMOKE-FALSE: an exited container with no idle-stop signal and no
  # deploy-start reference can only be judged by its own facts: a clean 0 exit
  # is a planned stop, a non-zero one is abnormal (no in-window proof).
  if (( deploy_start_epoch == 0 )) && [[ ( "$dstatus" == "exited" || "$hstatus" == "exited" ) && "$exitcode" == "0" ]]; then
    echo "idle_stopped"
    return 0
  fi

  # 3. Healthy running checks
  if [[ "$bstate" == "running" || "$bstate" == "healthy" ]]; then
    if command -v docker >/dev/null 2>&1; then
      if [[ "$dstatus" == "running" || "$hstatus" == "healthy" || "$hstatus" == "running" ]]; then
        # Check /health probe if possible:
        if docker exec "$cname" curl -fsS --max-time 3 "http://127.0.0.1:8642/health" >/dev/null 2>&1; then
          echo "healthy"
          return 0
        fi
        if [[ "$hstatus" == "healthy" || "$hstatus" == "running" ]]; then
          echo "healthy"
          return 0
        fi
        echo "docker:$hstatus"
        return 0
      fi
      echo "docker:$hstatus"
      return 0
    else
      # Docker CLI not available, board reports running
      echo "healthy"
      return 0
    fi
  fi

  # 4. Other states (not healthy, not idle_stopped, not crashed)
  if [[ "$dstatus" != "missing" && "$dstatus" != "running" && "$dstatus" != "healthy" ]]; then
    echo "docker:$dstatus"
  elif [[ "$bstate" != "missing" ]]; then
    echo "board:$bstate"
  else
    # No container and no board state: the agent has nothing running (removed
    # after idle-stop). It cannot crash a deploy, and it is not an active
    # gateway to wait for.
    echo "idle_stopped"
  fi
  return 0
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
  agents_json="$(curl -fsS --max-time 10 "${auth_args[@]}" "$board_url/companies/$company/agents" 2>/dev/null || echo "[]")"

  target_raw="$(get_target_bot_ids || true)"
  target_ids=()
  for id in $target_raw; do
    [[ -n "$id" ]] && target_ids+=("$id")
  done

  total="${#target_ids[@]}"
  if (( total == 0 )); then
    log "no hermes_gateway agents listed (board not ready yet, or none in company $company)"
  else
    healthy_count=0
    idle_count=0
    crashed_count=0
    unhealthy_count=0
    healthy_ids=()
    crashed_ids=()
    unhealthy_ids=()
    status_details=()
    last_healthy_id=""

    for id in "${target_ids[@]}"; do
      cname="$(find_container "$id")"
      agent_status="$(jq -r --arg id "$id" 'first(.[]? | select(.id == $id) | .status // "")' <<<"$agents_json" 2>/dev/null || true)"
      bot_stat="$(classify_bot "$id" "$cname" "$agent_status")"
      case "$bot_stat" in
        healthy)
          healthy_count=$((healthy_count + 1))
          healthy_ids+=("$id")
          last_healthy_id="$id"
          status_details+=("${id##*-}:healthy")
          ;;
        idle_stopped)
          idle_count=$((idle_count + 1))
          status_details+=("${id##*-}:idle_stopped")
          ;;
        crashed:*)
          crashed_count=$((crashed_count + 1))
          crashed_ids+=("$id")
          unhealthy_ids+=("$id")
          status_details+=("${id##*-}:$bot_stat")
          ;;
        *)
          unhealthy_count=$((unhealthy_count + 1))
          unhealthy_ids+=("$id")
          status_details+=("${id##*-}:$bot_stat")
          ;;
      esac
    done

    active_total=$(( total - idle_count ))
    needed=$(( (active_total * min_healthy_percent + 99) / 100 ))
    if (( min_healthy_percent == 0 )); then
      needed=0
    elif (( needed < 1 && active_total > 0 )); then
      needed=1
    fi

    # Pass condition:
    # 1. No abnormal exits or crashes (crashed_count == 0)
    # 2. If active_total > 0: healthy_count >= needed
    # 3. If active_total == 0: all bots are idle-stopped (and none crashed)
    if (( crashed_count == 0 )); then
      if (( active_total == 0 )); then
        if (( no_bot_rollout == 1 )); then
          log "OK: no bot image rollout (--no-bot-rollout): $total bot gateways verified without re-apply (all idle-stopped, 0 crashed; release gate passed)"
        else
          log "OK: all $total bot gateways are idle-stopped (0 active, 0 crashed; release gate passed)"
        fi
        exit 0
      elif (( healthy_count >= needed )); then
        if (( no_bot_rollout == 1 )); then
          log "OK: bot container of agent ${last_healthy_id:-${target_ids[0]}} is running and healthy (no re-apply expected: --no-bot-rollout; $healthy_count/$active_total active bot gateways healthy, $idle_count idle-stopped, threshold: ${min_healthy_percent}%)"
        else
          log "OK: bot container of agent ${last_healthy_id:-${target_ids[0]}} is running and healthy (re-applied after the deploy; $healthy_count/$active_total active bot gateways healthy, $idle_count idle-stopped, threshold: ${min_healthy_percent}%)"
        fi
        exit 0
      fi
    fi

    log "waiting for bot gateways: $healthy_count/$active_total active healthy ($idle_count idle-stopped, ${crashed_count} crashed, required: $needed, ${min_healthy_percent}%; statuses: ${status_details[*]:-none})"
  fi
  sleep "$interval"
done

active_total=$(( total - idle_count ))
needed=$(( (active_total * min_healthy_percent + 99) / 100 ))
if (( min_healthy_percent == 0 )); then
  needed=0
elif (( needed < 1 && active_total > 0 )); then
  needed=1
fi

if (( crashed_count > 0 )); then
  log "SMOKE FAILED: DEPLOYED-DEGRADED: $crashed_count bot containers had abnormal exits / crashed within ${timeout_sec}s ($healthy_count/$active_total active healthy, $idle_count idle-stopped)"
else
  log "SMOKE FAILED: DEPLOYED-DEGRADED: only ${healthy_count:-0}/$active_total active bot gateways are healthy within ${timeout_sec}s ($idle_count idle-stopped, required: $needed, ${min_healthy_percent}%)"
fi

log "Diagnosis: trailing gateway logs for unhealthy bot containers:"
bad_ids=()
for id in "${crashed_ids[@]:-}" "${unhealthy_ids[@]:-}"; do
  [[ -n "$id" ]] && bad_ids+=("$id")
done
if (( ${#bad_ids[@]} == 0 )); then
  bad_ids=("${target_ids[@]}")
fi

for id in "${bad_ids[@]}"; do
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
