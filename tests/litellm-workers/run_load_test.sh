#!/bin/sh
set -eu

DURATION=${DURATION:-150}
RPS=${RPS:-8}
OUTPUT=${OUTPUT:-"$PWD/ope6419-results.jsonl"}
mkdir -p "$(dirname "$OUTPUT")"
fixture_pid=""
cleanup() {
    if [ -n "$fixture_pid" ]; then
        kill "$fixture_pid" 2>/dev/null || true
        wait "$fixture_pid" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

# The default is a self-contained disposable protocol fixture. Set FIXTURE=0
# to run against an externally provisioned board and LiteLLM instance.
if [ "${FIXTURE:-1}" = 1 ]; then
    fixture_port=${FIXTURE_PORT:-$((31000 + ($$ % 1000)))}
    litellm_port=${LITELLM_PORT:-$((32000 + ($$ % 1000)))}
    python3 "$(dirname "$0")/fixture_server.py" --board-port "$fixture_port" --litellm-port "$litellm_port" &
    fixture_pid=$!
    BASE_URL=${BASE_URL:-"http://127.0.0.1:$litellm_port"}
    COMPANY_ID=${COMPANY_ID:-fixture-company}
    BOARD_API_URL=${BOARD_API_URL:-"http://127.0.0.1:$fixture_port"}
    BOARD_API_TOKEN=${BOARD_API_TOKEN:-fixture-admin-token}
    LITELLM_API_TOKEN=${LITELLM_API_TOKEN:-local-test-key}
    export BASE_URL COMPANY_ID BOARD_API_URL BOARD_API_TOKEN LITELLM_API_TOKEN
else
    : "${BASE_URL:?Set BASE_URL to the LiteLLM instance URL}"
    : "${COMPANY_ID:?Set COMPANY_ID to the test company}"
    : "${BOARD_API_URL:?Set BOARD_API_URL to the Myrmidon instance URL}"
    : "${BOARD_API_TOKEN:?Set BOARD_API_TOKEN to an instance-admin bearer token}"
fi
export DURATION RPS OUTPUT

python3 "$(dirname "$0")/load_test.py"
