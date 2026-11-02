#!/usr/bin/env bash
# fixture-shim-balance.sh — подмена curl для fixture-теста сторожа balance-сигналов.
# Вызывается только из test-monitor-hindsight-balance-signals.sh; в бой не идёт.

curl() {
  local url="" body=""
  while [ $# -gt 0 ]; do
    case "$1" in
      http://*|https://*) url="$1" ;;
      -d) shift; body="$1" ;;
      -o|-w|-X|-H) shift ;;
    esac
    shift
  done
  printf '%s' "${body}" > "${SENT_BODY_FILE}"
  printf '%s' "${body}" | grep -q 'ALERT P1 hindsight-balance-signals' || return 1
  case "${url}" in
    *"/api/issues/dbcda1db-a629-47ab-87e3-5ee2d7a64d3c/comments") echo "201"; return 0 ;;
    *) return 1 ;;
  esac
}
export -f curl
export SENT_BODY_FILE

exec bash "$1"
