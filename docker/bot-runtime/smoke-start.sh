#!/usr/bin/env bash
# docker/bot-runtime/smoke-start.sh: smoke-start the hermes gateway container,
# wait for /health (with timeout), assert 200/ok, then stop and clean up.
# myrmidon(OPE-10755): CI smoke-start ensuring the gateway starts up and answers /health.
set -euo pipefail

IMAGE="${1:-myrmidon-hermes:pr-check}"
TIMEOUT="${TIMEOUT:-60}"
PORT="${PORT:-$(( 38000 + (RANDOM % 1000) * 2 ))}"
GATEWAY="http://127.0.0.1:${PORT}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/bot-runtime-smoke.XXXXXX")"
CONTAINER="smoke-gateway-${PORT}-$$"

cleanup() {
  set +e
  if [ -n "${CONTAINER:-}" ]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
  if [ -n "${WORK:-}" ] && [ -d "$WORK" ]; then
    rm -rf "$WORK" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

log() { printf '[smoke-start] %s\n' "$*"; }
fail() {
  printf '[smoke-start] FAIL: %s\n' "$*" >&2
  if docker inspect "$CONTAINER" >/dev/null 2>&1; then
    printf '[smoke-start] --- container logs ---\n' >&2
    docker logs "$CONTAINER" >&2 || true
    printf '[smoke-start] --- end logs ---\n' >&2
  fi
  exit 1
}

# Setup bot-runtime layout
mkdir -p "$WORK/bot/hermes" "$WORK/bot/workspace" "$WORK/bot/scratch"
API_KEY="$(openssl rand -hex 32)"
printf 'API_SERVER_KEY="%s"\nOPENAI_API_KEY="mock-smoke-key"\n' "$API_KEY" > "$WORK/bot/hermes/.env"
cat > "$WORK/bot/hermes/config.yaml" <<'YAMLEOF'
model:
  default: 'smoke-model'
  provider: 'custom:smoke'
custom_providers:
  - name: 'smoke'
    base_url: 'http://127.0.0.1:8642/v1'
    api_key_env: 'OPENAI_API_KEY'
command_allowlist:
- execute_code
YAMLEOF

# Permissions for uid 10001 (contract user)
chmod -R a+rwX "$WORK/bot"
chown -R 10001:10001 "$WORK/bot" 2>/dev/null || true

log "Starting gateway container from $IMAGE on port $PORT..."
docker run -d --name "$CONTAINER" \
  -p "127.0.0.1:${PORT}:8642" \
  -v "$WORK/bot:/bot" \
  -e "MYRMIDON_BOT_YOLO=1" \
  "$IMAGE" >/dev/null

log "Waiting for /health (timeout ${TIMEOUT}s)..."
deadline=$(( $(date +%s) + TIMEOUT ))
healthy=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  if resp="$(curl -fsS -m 5 "$GATEWAY/health" 2>/dev/null)"; then
    if echo "$resp" | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'; then
      healthy=1
      break
    fi
  fi
  # If container died prematurely, exit early with failure
  if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" != "true" ]; then
    fail "Container stopped unexpectedly before becoming healthy"
  fi
  sleep 1
done

if [ "$healthy" -ne 1 ]; then
  fail "Gateway did not become healthy within ${TIMEOUT}s"
fi

log "Gateway /health responded with status ok"
log "Stopping gateway container..."
docker stop "$CONTAINER" >/dev/null
log "Smoke test passed successfully for $IMAGE"
