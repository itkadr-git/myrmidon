#!/usr/bin/env bash
# test-monitor-hindsight-failed-rate.sh — OPE-9845 fixture-тест
#
# Прогоняет monitor-hindsight-failed-rate.sh через граничные случаи приёмки:
#   >20% failed -> тревога; <=20% -> тишина; 0 успешных при попытках -> тревога;
#   нет попыток -> тишина; throttle внутри часа подавляет повтор.
# psql и curl подменены фикстурами (fixture-shim.sh): сеть и БД не трогаются,
# тревога реально не отправляется; проверяется, что тело комментария
# соответствует контракту OPE-9849 ("ALERT P1 hindsight-failed-rate ..." в
# задачу OPE-10620 = dbcda1db-a629-47ab-87e3-5ee2d7a64d3c).
#
# Значения алиаса (hindsight-probe-test, max_tokens<=16, >=1 раз в 5 мин)
# — доставленные ADM 02.11 в OPE-9849; боевые hindsight-mem /
# hindsight-consolidation фикстура не использует и не меняет.

set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MONITOR="${SCRIPT_DIR}/monitor-hindsight-failed-rate.sh"
TMPDIR_TEST="$(mktemp -d "${TMPDIR:-/tmp}/hindsight-failed-rate-test.XXXXXX")"
trap 'rm -rf "${TMPDIR_TEST}"' EXIT

PASS=0; FAIL=0
LAST_OUT=""; LAST_RC=0

run_case() { # name fixture_row state_content
  local name="$1" fixture="$2" state_content="${3:-}"
  local state_file="${TMPDIR_TEST}/state"
  printf '%s' "${state_content}" > "${state_file}"
  local out rc=0
  out=$(env -i PATH="${PATH}" HOME="${HOME}" \
    PSQL_FIXTURE="${fixture}" \
    DATABASE_URL="postgres://mock" \
    PAPERCLIP_API_KEY="mock-key" \
    PAPERCLIP_RUN_ID="run_test-run-id" \
    ALERT_ISSUE_ID="dbcda1db-a629-47ab-87e3-5ee2d7a64d3c" \
    NOSEND=0 \
    STATE_FILE="${state_file}" \
    SENT_BODY_FILE="${TMPDIR_TEST}/sent-body" \
    bash "${SCRIPT_DIR}/fixture-shim.sh" "${MONITOR}") || rc=$?
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

echo "== fixture-тест сторожа failed-rate (OPE-9845, маршрут OPE-9849) =="

run_case "failed_rate 30% > 20%" "100|30|70"
expect "failed_rate 30% > 20% -> ALERT" 10 "ALERT SENT"

run_case "failed_rate 20% == порог" "100|20|80"
expect "failed_rate 20% == порог -> тишина" 0 "порог не превышен"

run_case "0 succeeded / 50 attempts (инцидент 27-29.10)" "50|50|0"
expect "0 succeeded -> ALERT (повтор инцидента)" 10 "ALERT SENT"

run_case "0 attempts" "0|0|0"
expect "0 attempts -> тишина" 0 "попыток записи не было"

run_case "throttle внутри часа" "100|50|50" "$(date +%s)"
expect "throttle -> тишина" 0 "throttled"

SENT="$(cat "${TMPDIR_TEST}/sent-body" 2>/dev/null || true)"
if printf '%s' "${SENT}" | grep -q 'ALERT P1 hindsight-failed-rate'; then
  echo "PASS: тело комментария содержит 'ALERT P1 hindsight-failed-rate' (контракт OPE-9849)"
  PASS=$((PASS+1))
else
  echo "FAIL: тело комментария не соответствует контракту: ${SENT}"
  FAIL=$((FAIL+1))
fi

echo
echo "Итог: ${PASS} PASS, ${FAIL} FAIL"
[ "${FAIL}" -eq 0 ]
