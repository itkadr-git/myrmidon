#!/usr/bin/env bash
# fixture-shim.sh — подмена psql/curl для fixture-теста сторожа (OPE-9845).
# Вызывается только из test-monitor-hindsight-failed-rate.sh; в бой не идёт.

psql() { printf '%s\n' "${PSQL_FIXTURE}"; }
export -f psql
export PSQL_FIXTURE

curl() {
  local url="" body=""
  while [ $# -gt 0 ]; do
    case "$1" in
      http://*|https://*) url="$1" ;;
      -d) shift; body="$1" ;;
      -o|-w|-X|-H) shift ;; # флаги с параметром — игнорируем
    esac
    shift
  done
  printf '%s' "${body}" > "${SENT_BODY_FILE}"
  # Контракт OPE-9849: "ALERT P1 hindsight-failed-rate ..." в задачу OPE-10620
  printf '%s' "${body}" | grep -q 'ALERT P1 hindsight-failed-rate' || return 1
  case "${url}" in
    *"/api/issues/dbcda1db-a629-47ab-87e3-5ee2d7a64d3c/comments") echo "201"; return 0 ;;
    *) return 1 ;;
  esac
}
export -f curl

exec bash "$1"
