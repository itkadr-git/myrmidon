#!/usr/bin/env bash
# fixture-shim-fallback.sh — подмена curl для fixture-теста сторожа мёртвой цепочки.
# Вызывается только из test-monitor-hindsight-fallback-chain.sh; в бой не идёт.
#
# PROBE_RESULTS — CSV HTTP-кодов ответов LiteLLM (по порядку вызовов).
# Порядок вызовов отслеживается через PROBE_IDX_FILE (файл-счётчик), т.к.
# pipe-subshell не сохраняет инкременты переменных между вызовами curl.

PROBE_IDX_FILE="${PROBE_IDX_FILE:?required}"

curl() {
  local url="" body="" is_probe=0
  while [ $# -gt 0 ]; do
    case "$1" in
      http://litellm*|https://litellm*) is_probe=1; url="$1" ;;
      http://*|https://*) url="$1" ;;
      -d) shift; body="$1" ;;
      -o|-w|-X|-H) shift ;;
    esac
    shift
  done

  if [ "${is_probe}" = "1" ]; then
    local idx code
    idx=$(cat "${PROBE_IDX_FILE}")
    echo $((idx+1)) > "${PROBE_IDX_FILE}"
    code=$(printf '%s' "${PROBE_RESULTS}" | cut -d',' -f$((idx+1)))
    [ -z "${code}" ] && code="200"
    printf '%s' "${code}"
    return 0
  fi

  # Иначе — POST комментария в OPE-10620
  printf '%s' "${body}" > "${SENT_BODY_FILE}"
  printf '%s' "${body}" | grep -q 'ALERT P1 hindsight-fallback-chain' || return 1
  case "${url}" in
    *"/api/issues/dbcda1db-a629-47ab-87e3-5ee2d7a64d3c/comments") echo "201"; return 0 ;;
    *) return 1 ;;
  esac
}
export -f curl
export PROBE_RESULTS PROBE_IDX_FILE SENT_BODY_FILE

exec bash "$1"
