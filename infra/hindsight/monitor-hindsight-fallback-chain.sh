#!/usr/bin/env bash
# monitor-hindsight-fallback-chain.sh — сторож «мёртвой цепочки» моделей (OPE-9845, п.2 ТЗ).
#
# Для каждой модели с запасными каналами в LiteLLM (hindsight-mem,
# hindsight-consolidation) шлёт минимальный запрос каждому каналу цепочки
# раз в час; если ВСЯ цепочка модели мертва (ни один канал не ответил 200),
# пишет тревогу ALERT P1 hindsight-fallback-chain … в задачу OPE-10620
# (маршрут OPE-9849, доставка проверена ADM 02.11). Throttle: 1 час на модель.
#
# Только бесплатные модели и тестовый алиас; боевые цепочки не меняются.
#
# Требует env: PAPERCLIP_API_KEY, PAPERCLIP_API_URL (приватный адрес
# задаёт оператор при развёртывании — в коде значения по умолчанию нет,
# см. CONVENTIONS.md §9).

set -u

WINDOW_HOURS=${WINDOW_HOURS:-1}                # интервал пробы
PROBE_MAX_TOKENS=${PROBE_MAX_TOKENS:-8}        # OPE-9849: min probe, max_tokens <= 16
ALERT_ISSUE_ID=${ALERT_ISSUE_ID:-}             # UUID задачи-приёмника; по умолчанию резолвится по identifier OPE-10620
STATE_DIR=${STATE_DIR:-/var/lib/hindsight-monitor}
NOSEND=${NOSEND:-0}
LITELLM_BASE_URL=${LITELLM_BASE_URL:-}         # базовый URL LiteLLM, напр. http://litellm:4000
LITELLM_API_KEY=${LITELLM_API_KEY:-}           # ключ LiteLLM master/virtual key

log() { printf '%s\n' "$*"; }
die() { log "ERROR: $*"; exit 2; }

[ -n "${PAPERCLIP_API_KEY:-}" ] || die "PAPERCLIP_API_KEY is required (env)"
[ -n "${PAPERCLIP_API_URL:-}" ] || die "PAPERCLIP_API_URL is required (env; private address set by operator, CONVENTIONS.md §9)"
[ -n "${LITELLM_BASE_URL:-}" ] || die "LITELLM_BASE_URL is required (env)"
[ -n "${LITELLM_API_KEY:-}" ] || die "LITELLM_API_KEY is required (env)"

# Цепочки по ТЗ инцидента 27–29.10. Каналы перечислены в порядке приоритета;
# бесплатные каналы (laguna-s-2.1:free, ornith-1.5-122b:free) — основные,
# платные запасные (z.ai, DeepSeek) тоже проверяются, но их падение не
# критично, пока жив хотя бы один канал цепочки.
CHAIN_MEM=${CHAIN_MEM:-"hindsight-mem,hindsight-fb-zai,hindsight-fb-deepseek"}
CHAIN_CONS=${CHAIN_CONS:-"hindsight-consolidation"}

mkdir -p "${STATE_DIR}"

NOW=$(date +%s)

# --- 1. Проба каждого канала цепочки ------------------------------------------

probe_model() { # litellm_model_name -> 0 если ответ 200
  local model="$1" http_code
  http_code=$(curl -sS -o /dev/null -w '%{http_code}' \
    -X POST "${LITELLM_BASE_URL}/v1/chat/completions" \
    -H "Authorization: Bearer ${LITELLM_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"${model}\",\"max_tokens\":${PROBE_MAX_TOKENS}}" \
    --max-time 30 2>/dev/null) || http_code="000"
  [ "${http_code}" = "200" ]
}

check_chain() { # chain_name models_csv
  local chain_name="$1" models_csv="$2"
  local alive=0 dead_models="" model
  local IFS=','
  for model in ${models_csv}; do
    if probe_model "${model}"; then
      alive=$((alive+1))
      log "${chain_name}: ${model} OK"
    else
      dead_models="${dead_models}${model} "
      log "${chain_name}: ${model} DEAD"
    fi
  done
  unset IFS
  if [ "${alive}" -eq 0 ]; then
    REASON="${chain_name}: вся цепочка мертва (${dead_models% })"
    return 1
  fi
  return 0
}

# --- 2. Проверка каждой цепочки ------------------------------------------------

OVERALL_RC=0
ALERT_LINES=""
for spec in "hindsight-mem:${CHAIN_MEM}" "hindsight-consolidation:${CHAIN_CONS}"; do
  chain_name="${spec%%:*}"
  models_csv="${spec#*:}"
  STATE_FILE="${STATE_DIR}/fallback-chain-${chain_name}.state"
  LAST_ALERTED=0
  [ -f "${STATE_FILE}" ] && LAST_ALERTED=$(cat "${STATE_FILE}" 2>/dev/null || echo 0)
  if [ $(( NOW - LAST_ALERTED )) -lt $(( WINDOW_HOURS * 3600 )) ]; then
    log "${chain_name}: throttled (alerted $(( (NOW - LAST_ALERTED) / 60 ))m ago)"
    continue
  fi
  if check_chain "${chain_name}" "${models_csv}"; then
    continue
  fi
  # Вся цепочка мертва — тревога
  BODY="ALERT P1 hindsight-fallback-chain ${REASON}. Сторож: monitor-hindsight-fallback-chain.sh (OPE-9845)."
  if [ "${NOSEND}" = "1" ]; then
    log "NOSEND=1: would alert -> ${BODY}"
    ALERT_LINES="${ALERT_LINES}${BODY}\n"
    OVERALL_RC=10
    continue
  fi
  # Резолв задачи-приёмника
  ISSUE_ID="${ALERT_ISSUE_ID}"
  if [ -z "${ISSUE_ID}" ]; then
    ISSUES_JSON=$(curl -fsS \
      -H "Authorization: Bearer ${PAPERCLIP_API_KEY}" \
      "${PAPERCLIP_API_URL}/api/issues?limit=200") \
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
    RUN_ID_HDR=(-H "X-Paperclip-Run-Id: ${PAPERCLIP_RUN_ID#run_}")
  fi
  HTTP_CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
    -H "Authorization: Bearer ${PAPERCLIP_API_KEY}" \
    -H "Content-Type: application/json" \
    "${RUN_ID_HDR[@]}" \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"body": sys.argv[1]}))' "${BODY}")" \
    "${PAPERCLIP_API_URL}/api/issues/${ISSUE_ID}/comments" 2>/dev/null) || HTTP_CODE="000"
  if [ "${HTTP_CODE}" = "201" ] || [ "${HTTP_CODE}" = "200" ]; then
    log "ALERT SENT (${HTTP_CODE}) -> OPE-10620: ${BODY}"
    printf '%s' "${NOW}" > "${STATE_FILE}"
  else
    log "ALERT FAILED (HTTP ${HTTP_CODE}): ${BODY}"
    OVERALL_RC=1
  fi
done

if [ "${OVERALL_RC}" -eq 10 ] && [ -n "${ALERT_LINES}" ]; then
  printf '%b' "${ALERT_LINES}"
fi
exit "${OVERALL_RC}"
