#!/usr/bin/env bash
# Wrapper for Myrmidon center warm standby management tool (T9).
#
# D9: myr-vm1 has no host-level Node.js or PostgreSQL client binaries.
# When docker is available we run standby-ctl.mjs inside a node:20-alpine
# container with the standby scripts and data directories bind-mounted.
# Set STANDBY_CTL_NO_DOCKER=1 (or STANDBY_PG_RUNNER=host) to force host mode.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

run_in_docker() {
  local node_image="${STANDBY_NODE_IMAGE:-node:20-alpine}"
  exec docker run --rm \
    -v "$SCRIPT_DIR:/opt/standby:ro" \
    -v /srv/standby:/srv/standby \
    -v /srv/backups:/srv/backups \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -e STANDBY_PG_RUNNER="${STANDBY_PG_RUNNER:-docker}" \
    -e STANDBY_PG_IMAGE="${STANDBY_PG_IMAGE:-pgvector/pgvector:pg18}" \
    -e PG_REPLICATOR_PASSWORD="${PG_REPLICATOR_PASSWORD:-}" \
    -e PG_PASSFILE_PATH="${PG_PASSFILE_PATH:-}" \
    -e STANDBY_CREDENTIAL_PATH="${STANDBY_CREDENTIAL_PATH:-}" \
    -e PRIMARY_PG_HOST="${PRIMARY_PG_HOST:-}" \
    "$node_image" \
    node /opt/standby/standby-ctl.mjs "$@"
}

if [ "${STANDBY_CTL_NO_DOCKER:-0}" != "1" ] && command -v docker >/dev/null 2>&1; then
  run_in_docker "$@"
fi

NODE_BIN="${NODE_BIN:-node}"

if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  printf 'ERROR: neither docker nor node binary found in PATH\n' >&2
  exit 1
fi

exec "$NODE_BIN" "$SCRIPT_DIR/standby-ctl.mjs" "$@"
