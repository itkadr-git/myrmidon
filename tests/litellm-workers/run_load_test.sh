#!/bin/sh
set -eu

IMAGE=${LITELLM_IMAGE:-ghcr.io/berriai/litellm:v1.104.1}
NETWORK=${NETWORK:-ope6419-net}
LITELLM=${LITELLM_CONTAINER:-ope6419-litellm}
MOCK=${MOCK_CONTAINER:-ope6419-mock}
DURATION=${DURATION:-150}
RPS=${RPS:-8}

cleanup() {
  docker rm -f "$LITELLM" "$MOCK" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker network create "$NETWORK" >/dev/null
docker run -d --name "$MOCK" --network "$NETWORK" --network-alias mock \
  -v "$PWD/mock_backend.py:/mock_backend.py:ro" -e MOCK_DELAY=0.2 \
  python:3.13-alpine python /mock_backend.py >/dev/null
docker run -d --name "$LITELLM" --network "$NETWORK" --network-alias litellm \
  --cpus 1 --memory 3g \
  -v "$PWD/config.yaml:/app/config.yaml:ro" \
  -v "$PWD/load_test.py:/app/load_test.py:ro" \
  -v "$PWD:/results" \
  "$IMAGE" --config /app/config.yaml --run_gunicorn --num_workers 2 >/dev/null

until docker exec "$LITELLM" python -c 'import urllib.request; urllib.request.urlopen("http://localhost:4000/health/liveliness", timeout=2)' >/dev/null 2>&1; do
  sleep 1
done
MASTER=$(docker exec "$LITELLM" sh -c 'pgrep -f "gunicorn.*master" | head -n 1')
docker exec "$LITELLM" python /app/load_test.py "http://127.0.0.1:4000" "$MASTER" "$DURATION" "$RPS"
