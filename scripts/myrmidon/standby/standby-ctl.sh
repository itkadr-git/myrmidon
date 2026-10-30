#!/usr/bin/env bash
# Wrapper for Myrmidon center warm standby management tool (T9).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="${NODE_BIN:-node}"

if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  printf 'ERROR: node binary not found in PATH\n' >&2
  exit 1
fi

exec "$NODE_BIN" "$SCRIPT_DIR/standby-ctl.mjs" "$@"
