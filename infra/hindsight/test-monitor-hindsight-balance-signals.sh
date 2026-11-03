#!/usr/bin/env bash
# test-monitor-hindsight-balance-signals.sh — fixture-тест сторожа balance-сигналов (OPE-9845, п.3 ТЗ).
#
# Кейсы:
#   - DashScope status DOWN -> тревога
#   - DashScope status OK -> тишина
#   - DeepSeek баланс ниже порога -> тревога
#   - DeepSeek баланс в норме -> тишина
#   - throttle подавляет повторную тревогу
#
# Маршрут: ALERT P1 hindsight-balance-signals … в OPE-10620.

set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MONITOR="${SCRIPT_DIR}/monitor-hindsight-balance-signals.sh"
TMPDIR_TEST="$(mktemp -d "${TMPDIR:-/tmp}/hindsight-balance-test.XXXXXX")"
trap 'rm -rf "${TMPDIR_TEST}"' EXIT

PASS=0; FAIL=0
LAST_OUT=""; LAST_RC=0

run_case() { # name dashscope_content deepseek_cmd state_dir
  local name="$1" dashscope_content="$2" deepseek_cmd="$3" state_dir="$4"
  mkdir -p "${state_dir}"
  local status_file="${TMPDIR_TEST}/dashscope-${name}.status"
  if [ "${dashscope_content}" != "__ABSENT__" ]; then
    printf '%s\n' "${dashscope_content}" > "${status_file}"
  else
    status_file="${TMPDIR_TEST}/absent-${name}.status"
    rm -f "${status_file}"
  fi
  local out rc=0
  out=$(env -i PATH="${PATH}" HOME="${HOME}" \
    PAPERCLIP_API_KEY="mock-key" \
    PAPERCLIP_API_URL="http://paperclip.invalid" \
    PAPERCLIP_RUN_ID="run_test-run-id" \
    ALERT_ISSUE_ID="dbcda1db-a629-47ab-87e3-5ee2d7a64d3c" \
    DASHSCOPE_STATUS_FILE="${status_file}" \
    DEEPSEEK_BALANCE_CMD="${deepseek_cmd}" \
    DEEPSEEK_BALANCE_MIN="0" \
    NOSEND=0 \
    STATE_DIR="${state_dir}" \
    SENT_BODY_FILE="${TMPDIR_TEST}/sent-body-${name}" \
    bash "${SCRIPT_DIR}/fixture-shim-balance.sh" "${MONITOR}") || rc=$?
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

echo "== fixture-тест сторожа balance-сигналов (OPE-9845 п.3, маршрут OPE-9849) =="

# CASE 1: DashScope DOWN -> тревога
run_case "dashscope-down" "DOWN" ":" "${TMPDIR_TEST}/state1"
expect "dashscope DOWN -> ALERT" 0 "ALERT SENT"

SENT1="$(cat "${TMPDIR_TEST}/sent-body-dashscope-down" 2>/dev/null || true)"
if printf '%s' "${SENT1}" | grep -q 'ALERT P1 hindsight-balance-signals'; then
  echo "PASS: тело содержит 'ALERT P1 hindsight-balance-signals'"
  PASS=$((PASS+1))
else
  echo "FAIL: тело не соответствует контракту: ${SENT1}"
  FAIL=$((FAIL+1))
fi

# CASE 2: DashScope OK -> тишина
run_case "dashscope-ok" "OK" ":" "${TMPDIR_TEST}/state2"
expect "dashscope OK -> тишина" 0 "dashscope: OK"

# CASE 3: DeepSeek баланс ниже порога -> тревога
run_case "deepseek-low" "OK" "echo -0.03" "${TMPDIR_TEST}/state3"
expect "deepseek low -> ALERT" 0 "ALERT SENT"

# CASE 4: DeepSeek баланс в норме -> тишина
run_case "deepseek-ok" "OK" "echo 1.50" "${TMPDIR_TEST}/state4"
expect "deepseek ok -> тишина" 0 "deepseek: OK"

# CASE 5: throttle — повторный запуск сразу после тревоги
run_case "throttled" "DOWN" ":" "${TMPDIR_TEST}/state1"
expect "throttle -> тишина" 0 "throttled"

echo
echo "Итог: ${PASS} PASS, ${FAIL} FAIL"
[ "${FAIL}" -eq 0 ]
