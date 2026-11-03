#!/usr/bin/env bash
# Wrapper for Myrmidon center warm standby management tool (T9).
#
# ADM rehearsal feedback (03.11): myr-vm1 has no host-level Node.js.
# The wrapper runs standby-ctl.mjs inside a node:20-alpine container.
# PostgreSQL tools (psql, pg_basebackup, pg_ctl, pg_isready) are NOT executed
# via `docker run` — the node:20-alpine image has no docker CLI.  Instead,
# standby-ctl.mjs invokes them via `docker exec` into the running
# myrmidon-pg-standby container (see createPgRunner in standby-ctl.mjs).
#
# We install docker-cli inside the ephemeral node container so that
# standby-ctl.mjs can issue `docker exec` commands through the mounted
# docker socket.
#
# Set STANDBY_CTL_NO_DOCKER=1 to force host mode (requires host node + PG clients).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

run_in_docker() {
  local node_image="${STANDBY_NODE_IMAGE:-node:20-alpine}"
  # Mount the host docker socket so standby-ctl.mjs can `docker exec` into
  # the standby container for PG binaries.  Mount standby dirs read-write.
  # Install docker-cli inside the container via apk so node can call docker exec.
  exec docker run --rm \
    -v "$SCRIPT_DIR:/opt/standby:ro" \
    -v /srv/standby:/srv/standby \
    -v /srv/backups:/srv/backups \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -e STANDBY_PG_RUNNER="${STANDBY_PG_RUNNER:-docker}" \
    -e STANDBY_PG_CONTAINER="${STANDBY_PG_CONTAINER:-myrmidon-pg-standby}" \
    -e PG_REPLICATOR_PASSWORD="${PG_REPLICATOR_PASSWORD:-}" \
    -e PG_PASSFILE_PATH="${PG_PASSFILE_PATH:-}" \
    -e STANDBY_CREDENTIAL_PATH="${STANDBY_CREDENTIAL_PATH:-}" \
    -e PRIMARY_PG_HOST="${PRIMARY_PG_HOST:-}" \
    "$node_image" \
    sh -c "apk add --no-cache docker-cli >/dev/null 2>&1 && node /opt/standby/standby-ctl.mjs \"\$@\"" \
    sh "$@"
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
