#!/usr/bin/env bash
# scripts/myrmidon/deploy/predeploy-board-check.sh
#
# PREDEPLOY-DB-CHECK (the 05.10 incident). Release 1.6.3's board image came up
# against the CI database (empty) and crashed at startup on production DATA: an
# attention card whose key was not a uuid. Nothing on the board side was wrong
# except the assumption that CI's empty database looks like production. The
# failure surfaced only in the maintenance window, the fleet stood still and the
# board had to be rolled back to 1.6.2 by hand.
#
# This step runs BEFORE the window: the new board image is started against a
# COPY of the production database (the snapshot the predeploy dump already
# takes) and must come up healthy there. When it does not, deploy.sh stops
# before the maintenance window and nothing on production changes.
#
#   predeploy-board-check.sh --config deploy.env --digest sha256:<64 hex> \
#                            --dump <predeploy dump> \
#                            [--dockergate-digest sha256:<64 hex>] [--dry-run]
#
# The throwaway stack, and what it deliberately is NOT:
#   * the dump is restored into a NEW Postgres container
#     (MYRMIDON_PREDEPLOY_POSTGRES_IMAGE); production is only READ, for the dump;
#   * the NEW dockergate image of the same release runs next to the copy, so the
#     board is checked against the new dockergate and not the running one. The
#     05.10 board never became `ok` against the OLD dockergate
#     (`route_not_allowed`), and dockergate rolled out after the board check:
#     the order itself was part of the incident;
#   * everything runs on its OWN docker network (MYRMIDON_PREDEPLOY_NETWORK):
#     neither the bot containers nor the production dockergate are on it, so the
#     copy cannot reach them and they cannot reach the copy;
#   * the board's port is published on 127.0.0.1 only.
#
# The check waits for /api/health to answer `status: ok` with the version and
# commit of the new image, then walks the attention list and the main company
# API routes (MYRMIDON_PREDEPLOY_API_PATHS) — the data paths that broke 1.6.3.
# On any failure the throwaway containers' logs are printed and the exit status
# is non-zero, so deploy.sh stops before the window.
#
# The route walk may carry a token (MYRMIDON_PREDEPLOY_TOKEN_FILE, an optional
# input). Without one the walk still runs and a 401/403 on a route is a warning;
# with one, the token file is checked next to the other inputs of this step,
# before the first docker call, so an unusable token file fails early — and not
# while waiting for health, after Postgres and the dump are already up.
#
# The stack is removed on exit — containers, the network and the copy's data
# volume (myr-predeploy-dbvol-<digest8>-<pid>, DEPLOY-HYGIENE: an anonymous
# volume would survive `docker rm -f` and stay on the disk forever).
# MYRMIDON_PREDEPLOY_KEEP=1 keeps it and prints
# the container names instead. The production DATABASE_URL of the settings file
# is ignored on purpose: the throwaway board talks to the copy only.
set -euo pipefail
# shellcheck source=lib.sh source-path=SCRIPTDIR
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

config="" board_digest="" dockergate_digest="" dump_file=""
DRY_RUN=0
while (($#)); do
  case "$1" in
    --config) config="$2"; shift 2 ;;
    --digest) board_digest="$2"; shift 2 ;;
    --dockergate-digest) dockergate_digest="$2"; shift 2 ;;
    --dump) dump_file="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,48p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
load_config "$config"
require_cmd docker curl jq

valid_digest "$board_digest" || die "predeploy check needs --digest sha256:<64 hex> (got: '${board_digest:-<none>}')"
if [[ -n "$dockergate_digest" ]]; then
  valid_digest "$dockergate_digest" || die "--dockergate-digest must be sha256:<64 hex> (got: $dockergate_digest)"
fi

# The throwaway stack is off with MYRMIDON_PREDEPLOY_CHECK=0, loudly: an install
# that turns it off deploys an image nothing proved against production data.
if [[ "${MYRMIDON_PREDEPLOY_CHECK:-1}" != "1" ]]; then
  log "PREDEPLOY-DB-CHECK: disabled (MYRMIDON_PREDEPLOY_CHECK=0); the new board image is NOT proven against a copy of the production database"
  log "PREDEPLOY-DB-CHECK: the 05.10 incident (a board that started fine on the empty CI database and crashed on production data) is exactly what this step exists for"
  exit 0
fi

postgres_image="${MYRMIDON_PREDEPLOY_POSTGRES_IMAGE:-}"
db_name="${MYRMIDON_PREDEPLOY_DB_NAME:-myrmidon}"
db_user="${MYRMIDON_PREDEPLOY_DB_USER:-myrmidon}"
board_env_file="${MYRMIDON_PREDEPLOY_BOARD_ENV_FILE:-}"
dockergate_env_file="${MYRMIDON_PREDEPLOY_DOCKERGATE_ENV_FILE:-}"
board_args="${MYRMIDON_PREDEPLOY_BOARD_ARGS:-}"
dockergate_args="${MYRMIDON_PREDEPLOY_DOCKERGATE_ARGS:-}"
board_port="${MYRMIDON_PREDEPLOY_BOARD_PORT:-13110}"
health_timeout="${MYRMIDON_PREDEPLOY_HEALTH_TIMEOUT_SEC:-${HEALTH_TIMEOUT_SEC}}"
keep="${MYRMIDON_PREDEPLOY_KEEP:-0}"
company_id="${BOARD_COMPANY_ID:-}"
token_file="${MYRMIDON_PREDEPLOY_TOKEN_FILE:-${HEALTH_TOKEN_FILE:-${BOARD_TOKEN_FILE:-}}}"
api_paths="${MYRMIDON_PREDEPLOY_API_PATHS:-/api/health,/api/companies/:company:/attention,/api/companies/:company:/issues?limit=1,/api/companies/:company:/agents,/api/companies/:company:/dashboard}"

db_ready_command="${MYRMIDON_PREDEPLOY_DB_READY_COMMAND:-}"
# shellcheck disable=SC2016  # the quotes are part of the command the operator overrides
[[ -n "$db_ready_command" ]] || db_ready_command='docker exec "$MYR_PREDEPLOY_DB_CONTAINER" pg_isready -U "$MYR_PREDEPLOY_DB_USER" -d "$MYR_PREDEPLOY_DB_NAME"'

restore_command="${MYRMIDON_PREDEPLOY_RESTORE_COMMAND:-}"
# myrmidon(PREDEPLOY-NO-ACL) (OPE-4875): --no-acl is part of the default, not an
# operator option. The production dump carries GRANTs to roles that exist only on
# the production server (e.g. backup_ro); the throwaway Postgres does not have
# them and pg_restore aborted with `role "backup_ro" does not exist` — the check
# died on the restore of every production dump that used such roles. The check
# proves the board reads the production DATA on the copy; ownership and ACLs of
# the production roles are not what is being proven, so the default skips them
# (--no-owner --no-acl). An operator who wants the production grants modelled on
# the copy pre-creates the roles and overrides MYRMIDON_PREDEPLOY_RESTORE_COMMAND.
# shellcheck disable=SC2016  # the quotes are part of the command the operator overrides
[[ -n "$restore_command" ]] || restore_command='docker exec -i -e PGPASSWORD="$MYR_PREDEPLOY_DB_PASSWORD" "$MYR_PREDEPLOY_DB_CONTAINER" pg_restore -U "$MYR_PREDEPLOY_DB_USER" -d "$MYR_PREDEPLOY_DB_NAME" --no-owner --no-acl < "$DUMP_FILE"'

# myrmidon(PREDEPLOY-ANALYZE): pg_restore loads rows but not planner statistics,
# so the planner of a fresh copy works on default estimates. The issues list
# then exceeded the 30 s route budget (rc.8 stopped at 07.10 while the same route answered on
# production). ANALYZE is a step of its own, after ANY restore command, so an
# overridden MYRMIDON_PREDEPLOY_RESTORE_COMMAND gets the statistics too.
analyze_command="${MYRMIDON_PREDEPLOY_ANALYZE_COMMAND:-}"
# shellcheck disable=SC2016  # the quotes are part of the command the operator overrides
[[ -n "$analyze_command" ]] || analyze_command='docker exec -e PGPASSWORD="$MYR_PREDEPLOY_DB_PASSWORD" "$MYR_PREDEPLOY_DB_CONTAINER" psql -U "$MYR_PREDEPLOY_DB_USER" -d "$MYR_PREDEPLOY_DB_NAME" -c ANALYZE'

# Fail closed: without these the step would quietly prove nothing.
[[ -n "$postgres_image" ]] || die "MYRMIDON_PREDEPLOY_POSTGRES_IMAGE is required: the check restores the predeploy dump into its own Postgres (set MYRMIDON_PREDEPLOY_CHECK=0 to deploy without the check); nothing was changed"
[[ -n "$board_env_file" ]] || die "MYRMIDON_PREDEPLOY_BOARD_ENV_FILE is required: the throwaway board needs the board's own environment (secrets, tokens) to start like the production board; nothing was changed"
[[ -f "$board_env_file" ]] || die "MYRMIDON_PREDEPLOY_BOARD_ENV_FILE not found: $board_env_file; nothing was changed"
# The token is optional — without one the route walk answers 401/403 and that
# stays a WARNING (the route was reached, the data path was not exercised).
# A token file that IS set but unusable is an input of this step, so it fails
# here with the other inputs, before the first docker call — and not later in
# auth_header_args while waiting for health, after Postgres has been started and
# the dump restored.
if [[ -n "$token_file" ]]; then
  [[ -f "$token_file" ]] || die "MYRMIDON_PREDEPLOY_TOKEN_FILE is set but is not a file: $token_file (an input of the predeploy check: the token is read when the routes are walked); nothing was changed"
  [[ -r "$token_file" ]] || die "MYRMIDON_PREDEPLOY_TOKEN_FILE is set but is not readable: $token_file (an input of the predeploy check: the token is read when the routes are walked); nothing was changed"
  [[ -s "$token_file" ]] || die "MYRMIDON_PREDEPLOY_TOKEN_FILE is set but is empty: $token_file (an input of the predeploy check: an empty token cannot be sent, so the route walk would only answer 401/403); nothing was changed"
fi
if [[ -n "$dockergate_digest" && -z "$dockergate_env_file" ]]; then
  log "PREDEPLOY-DB-CHECK: WARNING: no MYRMIDON_PREDEPLOY_DOCKERGATE_ENV_FILE: the throwaway dockergate starts with its image defaults; a config it needs (caller mode, volumeRoot, allowed images) must come from MYRMIDON_PREDEPLOY_DOCKERGATE_ARGS"
fi
if [[ "$api_paths" == *":company:"* && -z "$company_id" ]]; then
  die "BOARD_COMPANY_ID is required: the attention list (GET /api/companies/<id>/attention) is the route whose data broke 1.6.3 and it cannot be walked without it; nothing was changed"
fi
[[ -n "$dump_file" ]] || die "--dump <predeploy dump> is required: the check restores the predeploy snapshot into the copy; nothing was changed"
[[ -s "$dump_file" ]] || die "dump file missing or empty: $dump_file; nothing was changed"

short_digest="${board_digest#sha256:}"
suffix="$(printf '%s-%s' "${short_digest:0:8}" "$$")"
network="${MYRMIDON_PREDEPLOY_NETWORK:-myr-predeploy-$suffix}"
db_ctr="myr-predeploy-db-$suffix"
dg_ctr="myr-predeploy-dockergate-$suffix"
board_ctr="myr-predeploy-board-$suffix"
# DEPLOY-HYGIENE (OPE-5107): the copy's data lives in a NAMED volume of this
# run, removed by the same trap that removes the containers. An anonymous
# volume (-v /var/lib/postgresql/data) survives `docker rm -f` and stays on
# the disk forever — the 3.4/3.6 GB orphans of 05.10 and rc.3.
db_vol="${MYRMIDON_PREDEPLOY_DB_VOLUME:-myr-predeploy-dbvol-$suffix}"
board_ref="$MYRMIDON_IMAGE@$board_digest"
dockergate_ref=""
[[ -n "$dockergate_digest" ]] && dockergate_ref="ghcr.io/itkadr-git/myrmidon-dockergate@$dockergate_digest"

# A throwaway database gets a throwaway password: it is generated here and never
# leaves the copy's network and the 0600 env file in STATE_DIR.
db_password="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | cut -c1-24)"
env_file="$STATE_DIR/predeploy-board.env"

if [[ "$DRY_RUN" == "1" ]]; then
  log "dry run: nothing will be changed. Predeploy check plan:"
  plan "0. read the predeploy dump $dump_file ($(wc -c <"$dump_file" | tr -d ' ') bytes) as the production snapshot (read-only)"
  plan "1. docker network create $network (no bot container, no production dockergate on it)"
  plan "2. docker run -d --name $db_ctr --network $network -v $db_vol:/var/lib/postgresql/data $postgres_image (database $db_name, user $db_user, generated password)"
  plan "3. wait for the copy to accept connections, then restore the dump into it"
  if [[ -n "$dockergate_ref" ]]; then
    plan "4. docker run -d --name $dg_ctr --network $network $dockergate_ref (the NEW dockergate of this release)"
  else
    plan "4. no dockergate digest given: the board is checked without the new dockergate (the release names none)"
  fi
  plan "5. docker run -d --name $board_ctr --network $network -p 127.0.0.1:$board_port:3100 $board_ref (production DATABASE_URL ignored; the copy's URL is set)"
  plan "6. wait for http://127.0.0.1:$board_port/api/health: status ok, version/commit of $board_ref (timeout ${health_timeout}s)"
  plan "7. walk ${api_paths//:company:/$company_id} against the copy"
  plan "8. remove the throwaway stack (network $network, $db_ctr, $dg_ctr, $board_ctr, volume $db_vol)"
  plan "any failure stops deploy.sh BEFORE the maintenance window; production is never touched"
  exit 0
fi

log "PREDEPLOY-DB-CHECK: proving $board_ref against a copy of the production database (dump: $dump_file)"

# The throwaway stack never outlives this run — and neither does the copy's
# data volume (DEPLOY-HYGIENE): the trap runs on success, on failure and on an
# interrupt alike.
cleanup() {
  local names=() n
  for n in "$board_ctr" "$dg_ctr" "$db_ctr"; do [[ -n "$n" ]] && names+=("$n"); done
  if [[ "$keep" == "1" ]]; then
    log "PREDEPLOY-DB-CHECK: keeping the throwaway stack (MYRMIDON_PREDEPLOY_KEEP=1): network=$network db=$db_ctr dockergate=${dg_ctr:-<none>} board=$board_ctr (port $board_port) volume=$db_vol"
    return 0
  fi
  docker rm -f "${names[@]}" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker volume rm -f "$db_vol" >/dev/null 2>&1 || true
}
trap cleanup EXIT

dump_logs() {
  local name="$1"
  [[ -n "$name" ]] || return 0
  log "PREDEPLOY-DB-CHECK: logs of $name (last 40 lines):"
  docker logs --tail 40 "$name" 2>&1 >&2 || true
}

# The board's own environment, minus DATABASE_URL: the copy's URL is set here,
# so the throwaway board can only reach the throwaway database.
mkdir -p "$STATE_DIR"
umask 077
{
  if grep -vE '^[[:space:]]*(export[[:space:]]+)?DATABASE_URL[[:space:]]*=' "$board_env_file"; then :; fi
  printf 'DATABASE_URL=postgres://%s:%s@%s:5432/%s\n' "$db_user" "$db_password" "$db_ctr" "$db_name"
} >"$env_file"
chmod 600 "$env_file"
if grep -qE '^[[:space:]]*(export[[:space:]]+)?DATABASE_URL[[:space:]]*=' "$board_env_file"; then
  log "PREDEPLOY-DB-CHECK: the DATABASE_URL of $board_env_file is ignored: the throwaway board talks to the copy ($db_ctr) only"
fi

log "PREDEPLOY-DB-CHECK: 1/6 isolated network $network"
docker network create "$network" >/dev/null || die "cannot create the isolated network $network; nothing was changed on production"

export MYR_PREDEPLOY_DB_CONTAINER="$db_ctr"
export MYR_PREDEPLOY_DB_USER="$db_user"
export MYR_PREDEPLOY_DB_NAME="$db_name"
export MYR_PREDEPLOY_DB_PASSWORD="$db_password"
export DUMP_FILE="$dump_file"

log "PREDEPLOY-DB-CHECK: 2/6 copy of the production database ($postgres_image)"
# shellcheck disable=SC2086  # the operator's extra docker arguments are word-split on purpose
docker run -d --name "$db_ctr" --network "$network" \
  -v "$db_vol:/var/lib/postgresql/data" \
  -e POSTGRES_DB="$db_name" -e POSTGRES_USER="$db_user" -e POSTGRES_PASSWORD="$db_password" \
  $postgres_image >/dev/null || die "cannot start the throwaway Postgres ($postgres_image); production was not touched"

ready_deadline=$((SECONDS + health_timeout))
until bash -c "$db_ready_command" >/dev/null 2>&1; do
  if ((SECONDS >= ready_deadline)); then
    dump_logs "$db_ctr"
    die "the throwaway database did not accept connections within ${health_timeout}s; production was not touched"
  fi
  sleep "$POLL_INTERVAL_SEC"
done
log "PREDEPLOY-DB-CHECK: restoring the predeploy dump into the copy"
bash -c "$restore_command" >/dev/null || { dump_logs "$db_ctr"; die "cannot restore $dump_file into the throwaway database; production was not touched"; }
log "PREDEPLOY-DB-CHECK: analyze: collecting planner statistics on the copy (a restored dump has none)"
bash -c "$analyze_command" >/dev/null || { dump_logs "$db_ctr"; log "PREDEPLOY-DB-CHECK: WARNING: analyze failed on the copy: the board runs on default planner estimates and a slow route may be a false alarm"; }

if [[ -n "$dockergate_ref" ]]; then
  log "PREDEPLOY-DB-CHECK: 3/6 new dockergate of this release next to the copy ($dockergate_ref)"
  # shellcheck disable=SC2086  # the operator's extra docker arguments are word-split on purpose
  docker run -d --name "$dg_ctr" --network "$network" \
    ${dockergate_env_file:+--env-file "$dockergate_env_file"} $dockergate_args \
    "$dockergate_ref" >/dev/null || die "cannot start the throwaway dockergate ($dockergate_ref); production was not touched"
else
  log "PREDEPLOY-DB-CHECK: 3/6 no dockergate digest: the board is checked without the new dockergate"
fi

log "PREDEPLOY-DB-CHECK: 4/6 new board on the copy (port 127.0.0.1:$board_port)"
# shellcheck disable=SC2086  # the operator's extra docker arguments are word-split on purpose
docker run -d --name "$board_ctr" --network "$network" \
  --env-file "$env_file" -p "127.0.0.1:$board_port:3100" $board_args \
  "$board_ref" >/dev/null || { dump_logs "$db_ctr"; die "cannot start the throwaway board ($board_ref); production was not touched"; }

expect_version="$(image_label "$board_ref" org.opencontainers.image.version)"
expect_commit="$(image_label "$board_ref" org.opencontainers.image.revision)"
[[ -n "$expect_version" || -n "$expect_commit" ]] || die "the image has no version/revision labels; the check cannot prove which build answered"

auth=()
mapfile -t auth < <(auth_header_args "$token_file")
# "no credentials" vs "the configured credentials were refused": the token file
# was checked with the other inputs of this step, so a token here is a readable,
# non-empty one.
has_token=0
[[ -n "$token_file" ]] && has_token=1

# 5/6: the health the 05.10 image never reached.
log "PREDEPLOY-DB-CHECK: 5/6 waiting for status ok (timeout ${health_timeout}s)"
deadline=$((SECONDS + health_timeout))
last_seen="<no answer>"
board_ok=0
while :; do
  body="$(curl -fsS --max-time 10 "${auth[@]}" "http://127.0.0.1:$board_port/api/health" 2>/dev/null)" || body=""
  if [[ -n "$body" ]]; then
    status="$(jq -r '.status // empty' <<<"$body" 2>/dev/null || true)"
    version="$(jq -r '.version // empty' <<<"$body" 2>/dev/null || true)"
    commit="$(jq -r '.commit // empty' <<<"$body" 2>/dev/null || true)"
    last_seen="status='${status:-<none>}' version='${version:-<none>}' commit='${commit:-<none>}'"
    if [[ "$status" == "ok" ]] \
      && { [[ -z "$expect_version" ]] || [[ "$version" == "$expect_version" ]]; } \
      && { [[ -z "$expect_commit" ]] || [[ "$commit" == "$expect_commit" ]]; }; then
      board_ok=1
      break
    fi
  fi
  if ((SECONDS >= deadline)); then break; fi
  sleep "$POLL_INTERVAL_SEC"
done
if ((board_ok != 1)); then
  log "PREDEPLOY-DB-CHECK: the new board did not come up on the copy within ${health_timeout}s (expected version '$expect_version', commit '$expect_commit'; last answer: $last_seen)"
  dump_logs "$board_ctr"
  dump_logs "$dg_ctr"
  die "the board image does not start on the copy of the production database; the deploy stops BEFORE the maintenance window, production was not touched"
fi
log "PREDEPLOY-DB-CHECK: board ok on the copy ($last_seen)"

# 6/6: the attention list and the main company routes, against the copy.
log "PREDEPLOY-DB-CHECK: 6/6 the attention list and the main APIs"
IFS=',' read -r -a paths <<<"$api_paths"
for path in "${paths[@]}"; do
  [[ -n "$path" ]] || continue
  path="${path//:company:/$company_id}"
  rc=0
  out="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 "${auth[@]}" "http://127.0.0.1:$board_port$path" 2>/dev/null)" || rc=$?
  if ((rc != 0)); then
    dump_logs "$board_ctr"
    die "the copy did not answer $path (curl exit $rc); the board is not usable on production data, the deploy stops BEFORE the maintenance window"
  fi
  code="$(printf '%s' "$out" | tail -n1 | tr -d '\r')"
  if [[ "$code" =~ ^[0-9]{3}$ ]]; then
    case "$code" in
      2*) log "PREDEPLOY-DB-CHECK:   ok  $path (HTTP $code)" ;;
      401|403)
        if ((has_token)); then
          dump_logs "$board_ctr"
          die "$path refused the configured credentials (HTTP $code); the data path behind the route was not exercised, the deploy stops BEFORE the maintenance window"
        fi
        log "PREDEPLOY-DB-CHECK:   WARNING $path answered HTTP $code: the route was reached, but no credentials are configured (MYRMIDON_PREDEPLOY_TOKEN_FILE) so the data path behind it was not exercised" ;;
      *)
        dump_logs "$board_ctr"
        die "$path answered HTTP $code on the copy; the board is not usable on production data, the deploy stops BEFORE the maintenance window" ;;
    esac
  else
    log "PREDEPLOY-DB-CHECK:   ok  $path (answered)"
  fi
done

log "PREDEPLOY-DB-CHECK: passed: $board_ref comes up ok on a copy of the production database and answers the attention list and the main APIs"