#!/bin/sh
set -eu

: "${BASE_URL:?Set BASE_URL to the LiteLLM instance URL}"
: "${COMPANY_ID:?Set COMPANY_ID to the test company}"
: "${BOARD_API_URL:?Set BOARD_API_URL to the Myrmidon instance URL}"
: "${BOARD_API_TOKEN:?Set BOARD_API_TOKEN to an instance-admin bearer token}"
DURATION=${DURATION:-150}
RPS=${RPS:-8}
OUTPUT=${OUTPUT:-"$PWD/ope6419-results.jsonl"}
mkdir -p "$(dirname "$OUTPUT")"
export DURATION RPS OUTPUT

python3 "$(dirname "$0")/load_test.py"
