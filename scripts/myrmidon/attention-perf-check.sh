#!/usr/bin/env bash
# OPE-5273 part B: env-gated attention perf proof (EXPLAIN ANALYZE + p95 gate).
# Static assertions always run in vitest; the live seeded-DB line runs only with
# ATTENTION_PERF_CHECK=1 (same shape as g4-contract-check.sh: cheap checks always,
# expensive path by env). Run it inside devbuild (vm-exec):
#
#   devbuild --image node:24-slim --mem 6g --cpus 2 <worktree> -- \
#     bash scripts/myrmidon/attention-perf-check.sh
#
# Env (defaults in parentheses):
#   ATTENTION_PERF_CHECK=1   required to run the live line
#   ATTENTION_PERF_VOLUME    seeded heartbeat_runs rows        (100000)
#   ATTENTION_PERF_SAMPLES   timed list() calls               (15)
#   ATTENTION_PERF_WINDOW_DAYS seed spread over last N days   (30)
#   ATTENTION_PERF_REPORT_DIR where to write plans/json        ("" = emit to log only)
set -euo pipefail
cd "$(dirname "$0")/../.."
corepack enable >/dev/null 2>&1
pnpm install --frozen-lockfile >/dev/null
exec pnpm --filter @paperclipai/server exec vitest run \
  --pool=threads --no-file-parallelism --testTimeout=1800000 \
  src/__tests__/attention-perf-proof.myrmidon.test.ts
