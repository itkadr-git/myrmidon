#!/usr/bin/env bash
# monitor-hindsight-failed-rate.sh — OPE-9845
#
# Сторож записи памяти Hindsight: доля failed среди retain/batch_retain
# в myrmidon_hindsight.async_operations за последние 15 минут.
# Порог приёмки: failed_rate > 20% ИЛИ (попытки > 0 И успешных == 0) -> тревога.
#
# Доставка тревоги: комментарий "ALERT P1 hindsight-failed-rate ..." в задачу
# OPE-10620 через Paperclip API (маршрут проверен ADM 02.11, OPE-9849).
#
# Запуск: как systemd timer с периодом <= 15 минут (тогда тревога придёт
# хозяину <= 15 минут после начала инцидента — критерий приёмки).
#
# Env (боевые значения задаёт оператор при развёртывании, в репо секретов нет):
#   DATABASE_URL            — подключение к Postgres с БД myrmidon_hindsight
#   PAPERCLIP_API_URL       — URL Paperclip API (обязателен, приватный адрес
#                             должен задаваться только через env при деплое,
#                             в коде значения по умолчанию нет)
#   PAPERCLIP_API_KEY       — ключ агента-сторожа
#   PAPERCLIP_RUN_ID        — UUID текущего run (сырой, без префикса run_)
#   ALERT_ISSUE_ID          — UUID приёмника тревоги (OPE-10620); можно задать
#                             однократно, чтобы не искать по идентификатору
#   FAILED_RATE_THRESHOLD   — по умолчанию 20 (%)
#   WINDOW_MINUTES          — по умолчанию 15
#   NOSEND=1                — рассчитать и напечатать решение, НЕ отправлять тревогу
#   STATE_FILE              — файл для throttle одинаковых тревог (по умолчанию
#                             /var/lib/monitor-hindsight/failed-rate.state)
#
# Fixture-тест: infra/hindsight/test-monitor-hindsight-failed-rate.sh (mock API/DB).

set -u

FAILED_RATE_THRESHOLD="${FAILED_RATE_THRESHOLD:-20}"
WINDOW_MINUTES="${WINDOW_MINUTES:-15}"
NOSEND="${NOSEND:-0}"
STATE_FILE="${STATE_FILE:-/var/lib/monitor-hindsight/failed-rate.state}"
ALERT_ISSUE_ID="${ALERT_ISSUE_ID:-}"
PAPERCLIP_API_URL="${PAPERCLIP_API_URL:-}"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }
die() { log "ERROR: $*"; exit 2; }

[ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL is not set"
[ -n "${PAPERCLIP_API_KEY:-}" ] || die "PAPERCLIP_API_KEY is not set"
[ -n "${PAPERCLIP_API_URL:-}" ] || die "PAPERCLIP_API_URL is not set (задаётся оператором при развёртывании)"

# --- 1. Считаем статистику записи памяти за окно -----------------------------

read -r TOTAL FAILED SUCCEEDED <<'SQL'
psql "${DATABASE_URL}" -Atc "
SELECT
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE status = 'failed') AS failed,
  COUNT(*) FILTER (WHERE status = 'completed') AS succeeded
FROM myrmidon_hindsight.async_operations
WHERE created_at >= now() - interval '${WINDOW_MINUTES} minutes'
  AND operation_type IN ('retain','batch_retain');
"
SQL

# psql вернёт одну строку "total|failed|succeeded"; делаем разбор явно
ROW=$(psql "${DATABASE_URL}" -Atc "
SELECT
  COUNT(*) || '|' ||
  COUNT(*) FILTER (WHERE status = 'failed') || '|' ||
  COUNT(*) FILTER (WHERE status = 'completed')
FROM myrmidon_hindsight.async_operations
WHERE created_at >= now() - interval '${WINDOW_MINUTES} minutes'
  AND operation_type IN ('retain','batch_retain');
") || die "psql query failed"
TOTAL="${ROW%%|*}"; REST="${ROW#*|}"; FAILED="${REST%%|*}"; SUCCEEDED="${REST#*|}"
TOTAL=${TOTAL:-0}; FAILED=${FAILED:-0}; SUCCEEDED=${SUCCEEDED:-0}

if [ "${TOTAL}" -eq 0 ]; then
  log "window=${WINDOW_MINUTES}m total=0 — попыток записи не было, тревога не нужна"
  exit 0
fi

# failed_rate в процентах с одним знаком (целочисленная арифметика: rate*10)
RATE_X10=$(( FAILED * 1000 / TOTAL ))

log "window=${WINDOW_MINUTES}m total=${TOTAL} failed=${FAILED} succeeded=${SUCCEEDED} failed_rate=$((RATE_X10/10)).$((RATE_X10%10))% (threshold=${FAILED_RATE_THRESHOLD}%)"

ALERT=0
REASON=""
if [ "${SUCCEEDED}" -eq 0 ]; then
  ALERT=1
  REASON="0 successful retain/batch_retain out of ${TOTAL} attempts in ${WINDOW_MINUTES}m (incident 27–29.10 pattern)"
elif [ "${RATE_X10}" -gt $(( FAILED_RATE_THRESHOLD * 10 )) ]; then
  ALERT=1
  REASON="failed_rate $((RATE_X10/10)).$((RATE_X10%10))% > ${FAILED_RATE_THRESHOLD}% over ${TOTAL} attempts in ${WINDOW_MINUTES}m"
fi

[ "${ALERT}" -eq 1 ] || { log "OK: порог не превышен"; exit 0; }

# --- 2. Throttle: не дублируем одну и ту же тревогу чаще раза в час ----------

mkdir -p "$(dirname "${STATE_FILE}")" 2>/dev/null || true
NOW=$(date +%s)
LAST_ALERTED=0
[ -f "${STATE_FILE}" ] && LAST_ALERTED=$(cat "${STATE_FILE}" 2>/dev/null || echo 0)
if [ $(( NOW - LAST_ALERTED )) -lt 3600 ]; then
  log "throttled: alert for '${REASON}' was already sent $(( (NOW - LAST_ALERTED) / 60 ))m ago"
  exit 0
fi

BODY="ALERT P1 hindsight-failed-rate ${REASON}. window=${WINDOW_MINUTES}m total=${TOTAL} failed=${FAILED} succeeded=${SUCCEEDED}. Сторож: monitor-hindsight-failed-rate.sh (OPE-9845)."

if [ "${NOSEND}" = "1" ]; then
  log "NOSEND=1: would alert -> ${BODY}"
  exit 10
fi

# --- 3. Доставка тревоги в OPE-10620 ----------------------------------------

ISSUE_ID="${ALERT_ISSUE_ID}"
if [ -z "${ISSUE_ID}" ]; then
  ISSUES_JSON=$(curl -fsS \
    -H "Authorization: Bearer ${PAPERCLIP_API_KEY}" \
    "${PAPERCLIP_API_URL}/api/issues?limit=200" ) \
    || die "cannot list issues to resolve OPE-10620"
  ISSUE_ID=$(printf '%s' "${ISSUES_JSON}" \
    | python3 -c 'import sys,json
data=json.load(sys.stdin)
items=data.get("issues") or data.get("items") or (data if isinstance(data,list) else [])
for i in items:
    if i.get("identifier")=="OPE-10620":
        print(i.get("id","")); break')
  [ -n "${ISSUE_ID}" ] || die "OPE-10620 not found in issue list; set ALERT_ISSUE_ID"
fi

RUN_ID_HDR=()
if [ -n "${PAPERCLIP_RUN_ID:-}" ]; then
  # run_ prefix ломает запись (OPE-10602 pre-rc.30): передаём сырой UUID
  RAW_RUN_ID="${PAPERCLIP_RUN_ID#run_}"
  RUN_ID_HDR=(-H "X-Paperclip-Run-Id: ${RAW_RUN_ID}")
fi

HTTP=$(curl -sS -o /tmp/.hindsight-alert-resp.$$ -w '%{http_code}' \
  -X POST \
  -H "Authorization: Bearer ${PAPERCLIP_API_KEY}" \
  "${RUN_ID_HDR[@]}" \
  -H 'Content-Type: application/json' \
  -d "$(python3 -c 'import json,sys; print(json.dumps({"body": sys.argv[1]}))' "${BODY}")" \
  "${PAPERCLIP_API_URL}/api/issues/${ISSUE_ID}/comments" || echo "000")

rm -f /tmp/.hindsight-alert-resp.$$
if [ "${HTTP}" = "200" ] || [ "${HTTP}" = "201" ]; then
  echo "${NOW}" > "${STATE_FILE}"
  log "ALERT SENT (HTTP ${HTTP}) -> OPE-10620: ${REASON}"
  exit 10
else
  die "alert delivery failed: HTTP ${HTTP} (маршрут OPE-10620, известный P0 OPE-10602 на записи)"
fi
