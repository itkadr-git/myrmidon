#!/usr/bin/env bash
# Wrapper for Myrmidon center warm standby management tool (T9).
#
# ADM rehearsal feedback (03.11): myr-vm1 has no host-level Node.js.
# The wrapper runs standby-ctl.mjs inside a node:20-alpine container.
# PostgreSQL tools (psql, pg_basebackup, pg_ctl, pg_isready) are NOT executed
# via `docker run` of the node image - it has no PG binaries.  Instead,
# standby-ctl.mjs invokes them via `docker exec` into the running
# myrmidon-pg-standby container (or, for setup/switchback while that container is
# stopped, via a one-shot `docker compose run` of the same service; see
# createPgRunner / dockerOneShotArgs in standby-ctl.mjs).
#
# We install docker-cli (+ the compose plugin and curl) inside the ephemeral node
# container so that standby-ctl.mjs can issue `docker exec` / `docker compose` / health
# checks through the mounted docker socket.  The container runs as root on the host
# network namespace (127.0.0.1 is the host, so --check-health reaches the board) and
# is what lets setup/switchback hand the bind-mounted data directory to the in-container
# postgres uid (999).
#
# Secrets (PG_REPLICATOR_PASSWORD, BETTER_AUTH_SECRET, MYRMIDON_DB_PASSWORD — or its
# deprecated alias PAPERCLIP_DB_PASSWORD) are
# inherited by NAME (-e NAME); their values never appear on a command line.
#
# STANDBY_APP_COMPOSE_DIR=<dir> additionally mounts the production application compose directory
# (needed only for `failover --restart-app`).
#
# Set STANDBY_CTL_NO_DOCKER=1 to force host mode (requires host node + PG clients).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

run_in_docker() {
  local node_image="${STANDBY_NODE_IMAGE:-node:20-alpine}"
  # Optional: directory holding the PRODUCTION application compose file used by
  # `failover --restart-app --app-compose-file=<file>`; mounted read-only at the same path so the
  # file (and its relative env_file/bind paths) resolve exactly as on the host.
  local extra_mounts=()
  if [ -n "${STANDBY_APP_COMPOSE_DIR:-}" ]; then
    extra_mounts+=(-v "${STANDBY_APP_COMPOSE_DIR}:${STANDBY_APP_COMPOSE_DIR}:ro")
  fi
  # Mount the host docker socket so standby-ctl.mjs can `docker exec` into
  # the standby container for PG binaries.  Mount standby dirs read-write.
  # Credential files given with --credentials must live under /srv/standby or /srv/backups
  # (the only host paths visible in this container).
  exec docker run --rm \
    --network host \
    -v "$SCRIPT_DIR:/opt/standby:ro" \
    -v /srv/standby:/srv/standby \
    -v /srv/backups:/srv/backups \
    -v /var/run/docker.sock:/var/run/docker.sock \
    ${extra_mounts[@]+"${extra_mounts[@]}"} \
    -e STANDBY_PG_RUNNER="${STANDBY_PG_RUNNER:-docker}" \
    -e STANDBY_PG_CONTAINER="${STANDBY_PG_CONTAINER:-myrmidon-pg-standby}" \
    -e PG_REPLICATOR_PASSWORD \
    -e PG_PASSFILE_PATH="${PG_PASSFILE_PATH:-}" \
    -e STANDBY_CREDENTIAL_PATH="${STANDBY_CREDENTIAL_PATH:-}" \
    -e PRIMARY_PG_HOST="${PRIMARY_PG_HOST:-}" \
    -e PRIMARY_PG_PORT="${PRIMARY_PG_PORT:-}" \
    -e STANDBY_DRILL_DIR="${STANDBY_DRILL_DIR:-}" \
    -e STANDBY_APP_COMPOSE_FILE="${STANDBY_APP_COMPOSE_FILE:-}" \
    -e COMPOSE_BOARD_IMAGE="${COMPOSE_BOARD_IMAGE:-}" \
    -e MYRMIDON_DB_PASSWORD \
    -e PAPERCLIP_DB_PASSWORD \
    -e BETTER_AUTH_SECRET \
    "$node_image" \
    sh -c "apk add --no-cache docker-cli docker-cli-compose curl >/dev/null 2>&1 && node /opt/standby/standby-ctl.mjs \"\$@\"" \
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
