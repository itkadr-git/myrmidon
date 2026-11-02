#!/usr/bin/env bash
# monitor-hindsight-balance-signals.sh — сторож balance-сигналов DashScope/DeepSeek (OPE-9845, п.3 ТЗ).
#
# До инцидента 27–29.10 сигналы писали только в журнал/Zabbix, хозяина не было.
# Этот сторож читает те же источники и при отклонении пишет тревогу с хозяином
# (комментарий ALERT P1 hindsight-balance-signals … в задачу OPE-10620 — маршрут
# OPE-9849, доставка проверена ADM 02.11). Throttle: 1 час на источник.
#
# Источники (пути по умолчанию совпадают с тем, что видел ADM в инциденте):
#   DASHSCOPE_STATUS_FILE — файл со строкой DOWN (~/ops/dashscope-balance.status)
#   DEEPSEEK_BALANCE_CMD  — команда, печатающая числовой баланс DeepSeek
#   DEEPSEEK_BALANCE_MIN  — минимально допустимый баланс (по умолчанию 0)
#
# Требует env: PAPERCLIP_API_KEY, PAPERCLIP_API_URL (приватный адрес
# задаёт оператор при развёртывании — в коде значения по умолчанию нет,
# см. CONVENTIONS.md §9).

set -u

ALERT_ISSUE_ID=${ALERT_ISSUE_ID:-}             # UUID задачи-приёмника; по умолчанию резолвится по identifier OPE-10620
STATE_DIR=${STATE_DIR:-/var/lib/hindsight-monitor}
NOSEND=${NOSEND:-0}
DASHSCOPE_STATUS_FILE=${DASHSCOPE_STATUS_FILE:-/var/lib/hindsight-monitor/dashscope-balance.status}
DEEPSEEK_BALANCE_CMD=${DEEPSEEK_BALANCE_CMD:-}
DEEPSEEK_BALANCE_MIN=${DEEPSEEK_BALANCE_MIN:-0}

log() { printf '%s\n' "$*"; }
die() { log "ERROR: $*"; exit 2; }

[ -n "${PAPERCLIP_API_KEY:-}" ] || die "PAPERCLIP_API_KEY is required (env)"
[ -n "${PAPERCLIP_API_URL:-}" ] || die "PAPERCLIP_API_URL is required (env; private address set by operator, CONVENTIONS.md §9)"

mkdir -p "${STATE_DIR}"
NOW=$(date +%s)

OVERALL_RC=0

alert_source() { # source_name reason
  local source="$1" reason="$2"
  local state_file="${STATE_DIR}/balance-${source}.state"
  local last_alerted=0
  [ -f "${state_file}" ] && last_alerted=$(cat "${state_file}" 2>/dev/null || echo 0)
  if [ $(( NOW - last_alerted )) -lt 3600 ]; then
    log "${source}: throttled (alerted $(( (NOW - last_alerted) / 60 ))m ago)"
    return 0
  fi
  local body="ALERT P1 hindsight-balance-signals ${source}: ${reason}. Сторож: monitor-hindsight-balance-signals.sh (OPE-9845)."
  if [ "${NOSEND}" = "1" ]; then
    log "NOSEND=1: would alert -> ${body}"
    return 10
  fi
  local issue_id="${ALERT_ISSUE_ID}"
  if [ -z "${issue_id}" ]; then
    local issues_json
    issues_json=$(curl -fsS \
      -H "Authorization: Bearer ${PAPERCLIP_API_KEY}" \
      "${PAPERCLIP_API_URL}/api/issues?limit=200") \
      || die "cannot list issues to resolve OPE-10620"
    issue_id=$(printf '%s' "${issues_json}" \
      | python3 -c 'import sys,json
data=json.load(sys.stdin)
items=data.get("issues") or data.get("items") or (data if isinstance(data,list) else [])
for i in items:
    if i.get("identifier")=="OPE-10620":
        print(i.get("id","")); break')
    [ -n "${issue_id}" ] || die "OPE-10620 not found in issue list; set ALERT_ISSUE_ID"
  fi
  local run_id_hdr=()
  if [ -n "${PAPERCLIP_RUN_ID:-}" ]; then
    run_id_hdr=(-H "X-Paperclip-Run-Id: ${PAPERCLIP_RUN_ID#run_}")
  fi
  local http_code
  http_code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
    -H "Authorization: Bearer ${PAPERCLIP_API_KEY}" \
    -H "Content-Type: application/json" \
    "${run_id_hdr[@]}" \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"body": sys.argv[1]}))' "${body}")" \
    "${PAPERCLIP_API_URL}/api/issues/${issue_id}/comments" 2>/dev/null) || http_code="000"
  if [ "${http_code}" = "201" ] || [ "${http_code}" = "200" ]; then
    log "ALERT SENT (${http_code}) -> OPE-10620: ${body}"
    printf '%s' "${NOW}" > "${state_file}"
  else
    log "ALERT FAILED (HTTP ${http_code}): ${body}"
    OVERALL_RC=1
  fi
  return 0
}

# --- 1. DashScope статус ------------------------------------------------------

if [ -f "${DASHSCOPE_STATUS_FILE}" ]; then
  if grep -q 'DOWN' "${DASHSCOPE_STATUS_FILE}"; then
    alert_source "dashscope" "статус DOWN в ${DASHSCOPE_STATUS_FILE} (ключи недействительны)"
    rc=$?
    [ "${rc}" -eq 10 ] && OVERALL_RC=10
  else
    log "dashscope: OK (status file has no DOWN)"
  fi
else
  log "dashscope: status file ${DASHSCOPE_STATUS_FILE} не найден — пропуск (сторож не настроен)"
fi

# --- 2. DeepSeek баланс -------------------------------------------------------

if [ -n "${DEEPSEEK_BALANCE_CMD}" ]; then
  balance=$(bash -c "${DEEPSEEK_BALANCE_CMD}" 2>/dev/null | tr -d '[:space:]')
  if ! printf '%s' "${balance}" | grep -qE '^-?[0-9]+([.][0-9]+)?$'; then
    alert_source "deepseek" "не удалось получить баланс (команда вернула '${balance}')"
    rc=$?
    [ "${rc}" -eq 10 ] && OVERALL_RC=10
  else
    below=$(python3 -c "print(1 if float('${balance}') < float('${DEEPSEEK_BALANCE_MIN}') else 0)")
    if [ "${below}" = "1" ]; then
      alert_source "deepseek" "баланс ${balance} ниже порога ${DEEPSEEK_BALANCE_MIN}"
      rc=$?
      [ "${rc}" -eq 10 ] && OVERALL_RC=10
    else
      log "deepseek: OK (balance ${balance} >= ${DEEPSEEK_BALANCE_MIN})"
    fi
  fi
else
  log "deepseek: DEEPSEEK_BALANCE_CMD не задан — пропуск (сторож не настроен)"
fi

exit "${OVERALL_RC}"
