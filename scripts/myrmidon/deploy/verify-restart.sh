#!/usr/bin/env bash
# Post-restart health gate of the update executor (OPE-12088, 1.7
# AUTO-UPDATE-ROLLBACK).
#
#   verify-restart.sh --config deploy.env [--url <health-url>] [--digest <ref>]
#                     [--retries 5] [--interval 5]
#
# After deploy.sh (or rollback.sh) restarts the service, the executor must not
# trust the process being up: the service has to ANSWER. This script polls the
# health endpoint up to --retries times with a pause between the attempts, and
# returns the service's own verdict:
#
#   exit 0 — the service reports status ok (and, with --digest, runs the
#            expected image revision);
#   exit 2 — the service is up but reports a wrong status/version/commit, or
#            did not answer within the retries (or curl itself failed on
#            every attempt);
#   exit 3 — the script was misconfigured (no config, no URL, missing tools).
#
# --retries (default 5) sets the number of polls; HEALTH_RETRIES in the
# config sets the same default (a --retries flag wins). The pause between the
# attempts comes from --interval or POLL_INTERVAL_SEC (5s when neither is
# set).
#
# On failure it writes an event into the deploy journal ($STATE_DIR/history.log
# via lib.sh record_history) — the same log the update/orchestrator already
# reads — so the rollback signal survives even when the caller discards the
# script's stdout. A curl failure (connection refused, timeout) also records a
# history event before exiting 2, so "service never came up" is always visible
# in the update log, not only in a possibly lost console output.
#
# The endpoint, token and interval defaults come from deploy.env (HEALTH_URL,
# HEALTH_TOKEN_FILE, POLL_INTERVAL_SEC); --url overrides the endpoint (used by
# the executor for component health probes), --digest sets the expected
# org.opencontainers.image.revision.
set -euo pipefail
# shellcheck source=lib.sh source-path=SCRIPTDIR
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

# myrmidon(HEALTH-EXIT-CODES, OPE-12088): the exit contract is more granular
# than the lib.sh die() code (1): misconfiguration must report 3 so the
# orchestrator can tell "gate misconfigured" from "service did not come up"
# (2). bash maps an EXIT trap return over $?; save it and re-exit with it.
exit_code=0
trap 'exit_code=$?; exit "$exit_code"' EXIT

config="" url="" digest="" retries="" interval=""
# myrmidon(HEALTH-EXIT-CODES, OPE-12088): misconfiguration reports exit 3 so
# the orchestrator can tell "gate misconfigured" from "service did not come
# up" (2). config_error is die with the misconfiguration exit code.
config_error() { printf '[myrmidon-deploy] ERROR: %s\n' "$*" >&2; exit 3; }
while (($#)); do
  case "$1" in
    --config) config="$2"; shift 2 ;;
    --url) url="$2"; shift 2 ;;
    --digest) digest="$2"; shift 2 ;;
    --retries) retries="$2"; shift 2 ;;
    --interval) interval="$2"; shift 2 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) config_error "unknown argument: $1" ;;
  esac
done

[[ -n "$config" || -n "$url" ]] || config_error "give --config deploy.env or --url <health-url>"
if [[ -n "$config" ]]; then
  [[ -r "$config" ]] || config_error "config not readable: $config"
  # shellcheck source=/dev/null
  source "$config"
fi
# HEALTH_URL comes from deploy.env (the same endpoint deploy.sh verifies); an
# explicit --url wins and needs no config at all.
[[ -n "${HEALTH_URL:-}" || -n "$url" ]] || config_error "HEALTH_URL is required (set it in deploy.env or pass --url)"
url="${url:-$HEALTH_URL}"
# The retry count: --retries flag > HEALTH_RETRIES in the config > 5. An
# invalid value is a misconfiguration (exit 3) — before the first probe.
retries="${retries:-${HEALTH_RETRIES:-5}}"
[[ "$retries" =~ ^[0-9]+$ && "$retries" -ge 1 ]] || config_error "--retries must be a positive integer (got $retries)"
interval="${interval:-${POLL_INTERVAL_SEC:-5}}"
[[ "$interval" =~ ^[0-9]+([.][0-9]+)?$ ]] || config_error "interval must be numeric (got $interval)"
command -v curl >/dev/null 2>&1 || config_error "required command not found: curl"
command -v jq >/dev/null 2>&1 || config_error "required command not found: jq"
token_file="${HEALTH_TOKEN_FILE:-}"

# record_health_event <verdict> <detail>: one line in the update/deploy
# journal (the same $STATE_DIR/history.log deploy.sh's record_history writes).
# The HISTORY_FILE path is derived here the same way load_config does, so the
# gate works with a bare --config that only sets STATE_DIR/HEALTH_URL. Without
# --config there is no state dir, and a read-only STATE_DIR must not turn a
# probing question ("is the service up?") into a hard failure: both cases skip
# the journal line (best-effort).
record_health_event() { # record_health_event <verdict> <detail>
  [[ -n "${STATE_DIR:-}" ]] || return 0
  local file="$STATE_DIR/history.log"
  mkdir -p "$STATE_DIR" 2>/dev/null || return 0
  printf '%s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "health-check:$1" "$2" >>"$file" 2>/dev/null || true
}

body=""
attempt=0
last_detail=""
while (( attempt < retries )); do
  attempt=$((attempt + 1))
  if ! body="$(curl -fsS --max-time "${HEALTH_TIMEOUT_SEC:-30}" ${token_file:+-H "Authorization: Bearer $(cat "$token_file")"} "$url" 2>/dev/null)"; then
    last_detail="attempt $attempt/$retries: curl failed (connection/timeout) on $url"
    record_health_event failed "$last_detail"
    (( attempt < retries )) && sleep "$interval"
    continue
  fi
  status="$(jq -r '.status // empty' <<<"$body" 2>/dev/null || true)"
  if [[ "$status" == "ok" ]]; then
    version="$(jq -r '.version // empty' <<<"$body" 2>/dev/null || true)"
    commit="$(jq -r '.commit // empty' <<<"$body" 2>/dev/null || true)"
    if [[ -n "$digest" && "$commit" != "$digest" ]]; then
      last_detail="attempt $attempt/$retries: service up but wrong revision: got ${commit:-<none>}, expected $digest"
      record_health_event failed "$last_detail"
      (( attempt < retries )) && sleep "$interval"
      continue
    fi
    log "health: status ok, version ${version:-<hidden>}, commit ${commit:-<none>}"
    record_health_event ok "status ok, version ${version:-<hidden>}, commit ${commit:-<none>}"
    exit 0
  fi
  last_detail="attempt $attempt/$retries: status is '${status:-<none>}' on $url"
  record_health_event failed "$last_detail"
  (( attempt < retries )) && sleep "$interval"
done

log "health FAILED after $retries attempts: $last_detail"
record_health_event failed "health FAILED after $retries attempts: $last_detail"
exit 2
