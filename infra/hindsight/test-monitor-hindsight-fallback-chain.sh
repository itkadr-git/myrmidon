#!/usr/bin/env bash
# test-monitor-hindsight-fallback-chain.sh — fixture-тест сторожа мёртвой цепочки (OPE-9845, п.2 ТЗ).
#
# Кейсы:
#   - вся цепочка hindsight-mem мертва → ALERT
#   - один канал мёртв, остальные живы → тишина
#   - вся цепочка hindsight-consolidation мертва → ALERT
#   - throttle подавляет повторную тревогу
#   - тело комментария соответствует контракту OPE-9849
#
# Маршрут: ALERT P1 hindsight-fallback-chain … в OPE-10620.

set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MONITOR="${SCRIPT_DIR}/monitor-hindsight-fallback-chain.sh"
TMPDIR_TEST="$(mktemp -d "${TMPDIR:-/tmp}/hindsight-fallback-test.XXXXXX")"
trap 'rm -rf "${TMPDIR_TEST}"' EXIT

PASS=0; FAIL=0
LAST_OUT=""; LAST_RC=0

run_case() { # name probe_results_csv state_dir
  local name="$1" results_csv="$2" state_dir="$3"
  mkdir -p "${state_dir}"
  local idx_file="${TMPDIR_TEST}/probe-idx-${name}"
  echo 0 > "${idx_file}"
  local out rc=0
  out=$(env -i PATH="${PATH}" HOME="${HOME}" \
    PROBE_RESULTS="${results_csv}" \
    PROBE_IDX_FILE="${idx_file}" \
    PAPERCLIP_API_KEY="mock-key" \
    PAPERCLIP_API_URL="http://paperclip.invalid" \
    PAPERCLIP_RUN_ID="run_test-run-id" \
    ALERT_ISSUE_ID="dbcda1db-a629-47ab-87e3-5ee2d7a64d3c" \
    LITELLM_BASE_URL="http://litellm.mock" \
    LITELLM_API_KEY="mock-litellm-key" \
    NOSEND=0 \
    STATE_DIR="${state_dir}" \
    SENT_BODY_FILE="${TMPDIR_TEST}/sent-body-${name}" \
    bash "${SCRIPT_DIR}/fixture-shim-fallback.sh" "${MONITOR}") || rc=$?
  LAST_OUT="${out}"
  LAST_RC="${rc}"
}

expect() { # name expected_rc expected_substr
  local name="$1" expected_rc="$2" expected_substr="$3"
  if [ "${LAST_RC}" = "${expected_rc}" ] && printf '%s' "${LAST_OUT}" | grep -qF "${expected_substr}"; then
    echo "PASS: ${name} (rc=${LAST_RC})"
    PASS=$((PASS+1))
  else
    echo "FAIL: ${name} — rc=${LAST_RC} (want ${expected_rc}), substr '${expected_substr}' not found in:"
    printf '%s\n' "${LAST_OUT}" | sed 's/^/    /'
    FAIL=$((FAIL+1))
  fi
}

echo "== fixture-тест сторожа мёртвой цепочки (OPE-9845 п.2, маршрут OPE-9849) =="

# CASE 1: вся цепочка hindsight-mem мертва (все 3 канала DEAD)
run_case "all-dead-mem" "000,000,000" "${TMPDIR_TEST}/state1"
expect "вся цепочка мертва -> ALERT" 0 "ALERT SENT"

SENT1="$(cat "${TMPDIR_TEST}/sent-body-all-dead-mem" 2>/dev/null || true)"
if printf '%s' "${SENT1}" | grep -q 'ALERT P1 hindsight-fallback-chain'; then
  echo "PASS: тело содержит 'ALERT P1 hindsight-fallback-chain'"
  PASS=$((PASS+1))
else
  echo "FAIL: тело не соответствует контракту: ${SENT1}"
  FAIL=$((FAIL+1))
fi

# CASE 2: один канал мёртв, остальные живы → тишина
run_case "one-dead" "200,000,200" "${TMPDIR_TEST}/state2"
expect "один канал мёртв -> тишина" 0 "hindsight-fb-zai DEAD"

# CASE 3: вся цепочка hindsight-consolidation мертва
run_case "all-dead-cons" "200,200,200,000" "${TMPDIR_TEST}/state3"
# 4 значения: 3 для mem (все OK) + 1 для consolidation (DEAD)
expect "consolidation мертва -> ALERT" 0 "ALERT SENT"

# CASE 4: throttle — повторный запуск сразу после тревоги
run_case "throttled" "000,000,000" "${TMPDIR_TEST}/state1"
expect "throttle -> тишина" 0 "throttled"

echo
echo "Итог: ${PASS} PASS, ${FAIL} FAIL"
[ "${FAIL}" -eq 0 ]
