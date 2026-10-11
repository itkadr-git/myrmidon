#!/usr/bin/env bash
# End-to-end LiteLLM workers scale test: preflight, baseline load through the
# gateway, UI-path worker-count change under load, change back, median report.
# Part C rig for OPE-5391 (LITELLM-WORKERS).
#
# Required environment:
#   BOARD_URL          board/API origin, e.g. http://127.0.0.1:3100
#   BOARD_API_KEY      board API key with instance-admin rights (never printed)
#   STAND_COMPANY_ID   company whose LiteLLM workers to drive
#   LITELLM_URL        gateway origin, e.g. http://127.0.0.1:4000
# Optional:
#   LITELLM_KEY        gateway key for authenticated load (default: none)
#   LITELLM_MODEL      model name for chat-completion load (default: none -> gateway GET)
#   TARGET (4) DURATION_S (60) CONCURRENCY (6) P95_MS (20000) LOG_DIR
set -euo pipefail

BOARD_URL="${BOARD_URL:-http://127.0.0.1:3100}"
LITELLM_URL="${LITELLM_URL:-http://127.0.0.1:4000}"
TARGET="${TARGET:-4}"
DURATION_S="${DURATION_S:-60}"
CONCURRENCY="${CONCURRENCY:-6}"
P95_MS="${P95_MS:-20000}"
LOG_DIR="${LOG_DIR:-./test-results/litellm-workers}"
HERE="$(cd "$(dirname "$0")" && pwd)"

: "${BOARD_API_KEY:?BOARD_API_KEY must be set}"
: "${STAND_COMPANY_ID:?STAND_COMPANY_ID must be set}"

mkdir -p "$LOG_DIR"
echo "== LiteLLM workers scale test =="
echo "board: $BOARD_URL  gateway: $LITELLM_URL  company: $STAND_COMPANY_ID"
echo "load: ${CONCURRENCY}x for ${DURATION_S}s  target workers: $TARGET"

# Preflight: board, workers contract and gateway must be reachable.
curl -fsS --max-time 10 "$BOARD_URL/api/health" > "$LOG_DIR/health.json"
curl -fsS --max-time 10 -H "authorization: Bearer $BOARD_API_KEY" \
  "$BOARD_URL/api/myrmidon/companies/$STAND_COMPANY_ID/litellm/workers" \
  > "$LOG_DIR/workers-before.json"
pool_now() { node -e 'const w=require(process.argv[1]);console.log(w.current ?? w.target)' "$LOG_DIR/workers-before.json"; }
echo "preflight ok: pool now $(pool_now)"
FROM_COUNT="$(pool_now)"

LOAD_ARGS=(--url "$LITELLM_URL/v1/chat/completions" --duration "$DURATION_S" --concurrency "$CONCURRENCY")
if [ -n "${LITELLM_MODEL:-}" ]; then LOAD_ARGS+=(--model "$LITELLM_MODEL"); fi

run_load() { # tag
  node "$HERE/load-test.mjs" "${LOAD_ARGS[@]}" --tag "$1" | tee "$LOG_DIR/load-$1.jsonl"
}

echo "== phase 1: baseline load =="
BASE_SUMMARY=$(run_load baseline)

echo "== phase 2: change workers under load =="
( run_load during ) &
LOAD_PID=$!
sleep 2
node "$HERE/change-workers.mjs" --base "$BOARD_URL" --company "$STAND_COMPANY_ID" --to "$TARGET" \
  | tee "$LOG_DIR/change-up.json" || true
echo "-- holding load for ${DURATION_S}s"
sleep "$DURATION_S"
wait $LOAD_PID || true
DURING_SUMMARY=$(tail -n 1 "$LOG_DIR/load-during.jsonl")

echo "== phase 3: change back to $FROM_COUNT =="
sleep 5
node "$HERE/change-workers.mjs" --base "$BOARD_URL" --company "$STAND_COMPANY_ID" --to "$FROM_COUNT" \
  | tee "$LOG_DIR/change-down.json" || true

echo "== phase 4: post-change load =="
AFTER_SUMMARY=$(run_load after)

echo "== report =="
node - "$LOG_DIR" "$BASE_SUMMARY" "$DURING_SUMMARY" "$AFTER_SUMMARY" <<'NODE'
const fs = require('fs');
const dir = process.argv[2];
const [base, during, after] = process.argv.slice(3).map((s) => JSON.parse(s));
const [up, down] = ['change-up.json', 'change-down.json']
  .map((f) => { try { return JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')); } catch { return null; } });
const ok = (s) => s && s.failures === 0;
const verdict = ok(base) && ok(during) && ok(after);
const rows = [
  ['baseline', base], ['during-change', during], ['after', after],
].map(([name, s]) => ({
  phase: name,
  requests: s.requests,
  failures: s.failures,
  failureRate: Number(s.failureRate.toFixed(5)),
  medianMs: s.medianMs,
  p95Ms: s.p95Ms,
}));
const report = {
  verdict: verdict ? 'PASS' : 'FAIL',
  toleranceMs: Number(process.env.P95_MS || 20000),
  phases: rows,
  changes: { up, down },
  criteria: 'zero failed requests (5xx/timeout/connection) across all phases',
};
fs.writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 2) + '\n');
fs.writeFileSync(`${dir}/report.md`,
  `# LiteLLM workers scale test report\n\n` +
  `Verdict: **${report.verdict}** (median tolerance ${report.toleranceMs} ms)\n\n` +
  `| phase | requests | failures | median ms | p95 ms |\n|---|---|---|---|---|\n` +
  rows.map((r) => `| ${r.phase} | ${r.requests} | ${r.failures} | ${Math.round(r.medianMs ?? -1)} | ${Math.round(r.p95Ms ?? -1)} |`).join('\n') +
  `\n\nWorker changes: ${JSON.stringify({ up, down })}\n`);
console.log(JSON.stringify(report, null, 2));
process.exitCode = verdict ? 0 : 1;
NODE
echo "artifacts in $LOG_DIR (report.md, report.json)"
