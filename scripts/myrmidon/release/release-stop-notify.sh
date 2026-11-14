#!/usr/bin/env bash
# scripts/myrmidon/release/release-stop-notify.sh
#
# RELEASE-STOP-NOTIFY (OPE-13006): one durable notification per release
# workflow stop. The stop event's journal entry is a GitHub issue titled
# "release-stop: <tag> (<event id>)" assigned to the responsible person.
# The event id defaults to the workflow run id, so re-running a failed
# shell step within the same workflow run cannot open a second issue for
# the same stop; a fresh workflow run of the same tag is a NEW stop event
# and gets its own entry.
#
# Concurrency and deduplication:
#   1. Lookup: gh api --paginate scans existing issues (state=all). If an
#      entry already exists for this exact stop event, it deduplicates and exits 0.
#   2. Atomic lock: before creating an issue, the script acquires an atomic
#      lock by creating a unique repo label "release-stop-lock-<event id>".
#      If another execution holds the lock, this runner waits and polls for the
#      issue to be published, suppressing concurrent duplicate creation.
#   3. Lock rescan: immediately upon acquiring the lock, the script rescans
#      for existing entries to ensure no concurrent run created the issue
#      and released the lock before this run acquired it.
#   4. Post-creation verification: if concurrent creations ever race past the
#      lock, any duplicate is immediately closed in favor of the canonical lowest
#      issue number.
#   5. Cleanup: the temporary lock label is released on exit.
#
# Failure posture (fail closed): if the responsible login is missing, the
# duplicate scan cannot complete, or the issue create fails, the script
# exits non-zero WITHOUT creating an unassigned or possibly-duplicate
# entry. The failed notification job is then visible in the Actions UI.
#
# Modes: none (only this one behaviour). Callers:
#   - .github/workflows/myrmidon-release-stop-notify.yml (workflow_run
#     completed trigger; the job cannot be skipped by the failed run).
#
# Environment:
#   GITHUB_REPOSITORY               owner/repo (the workflow sets it)
#   GH_RELEASE_TOKEN / GITHUB_TOKEN token with issues:write
#   RELEASE_TAG                     the release tag the stopped workflow served
#   RELEASE_STEP                    which step stopped (e.g. publish)
#   RELEASE_STOP_REASON             human-readable cause, shown verbatim
#   RELEASE_STOP_EVENT_ID           stop event key; defaults to GITHUB_RUN_ID
#   RELEASE_STEP_URL                link to the stopped workflow/job/run
#   RELEASE_RESPONSIBLE_LOGIN       required GitHub login to assign
#   RELEASE_STOP_LOOKUP_RETRY_DELAY seconds between scan retries (default 2)
#   RELEASE_STOP_LOCK_TIMEOUT       seconds to wait for lock / issue (default 15)
#   RELEASE_STOP_LOCK_POLL_DELAY    seconds between lock polling checks (default 1)
#
# Output: "stop=created issue=<url> event=<id>" or
#         "stop=deduplicated issue=<number> event=<id>".
#
# Tests: scripts/myrmidon/release/release-stop-notify.test.mjs (node --test,
# fake gh in PATH, no network).

set -euo pipefail

die() { printf '[release-stop-notify] ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[release-stop-notify] %s\n' "$*" >&2; }

repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"
tag="${RELEASE_TAG:?RELEASE_TAG is not set}"
step="${RELEASE_STEP:?RELEASE_STEP is not set}"
reason="${RELEASE_STOP_REASON:?RELEASE_STOP_REASON is not set}"
event_id="${RELEASE_STOP_EVENT_ID:-${GITHUB_RUN_ID:-}}"
step_url="${RELEASE_STEP_URL:-${GITHUB_SERVER_URL:-https://github.com}/${repo}/actions/runs/${event_id}}"
[[ -n "$event_id" ]] || die "RELEASE_STOP_EVENT_ID (or GITHUB_RUN_ID) is not set"
responsible="${RELEASE_RESPONSIBLE_LOGIN:-}"
[[ -n "$responsible" ]] || die "RELEASE_RESPONSIBLE_LOGIN is not set; refusing to deliver a stop notification without a responsible"
lookup_retry_delay="${RELEASE_STOP_LOOKUP_RETRY_DELAY:-2}"
lock_timeout="${RELEASE_STOP_LOCK_TIMEOUT:-15}"
lock_poll_delay="${RELEASE_STOP_LOCK_POLL_DELAY:-1}"

command -v gh >/dev/null 2>&1 || die "gh is not installed"
command -v jq >/dev/null 2>&1 || die "jq is not installed"
token="${GH_RELEASE_TOKEN:-${GITHUB_TOKEN:-}}"
[[ -n "$token" ]] || die "GH_RELEASE_TOKEN (or GITHUB_TOKEN) is not set"
export GH_TOKEN="$token"

title="release-stop: $tag ($event_id)"
lock_label="release-stop-lock-$event_id"
lock_acquired=0

release_lock() {
  if [[ "$lock_acquired" -eq 1 ]]; then
    lock_acquired=0
    gh label delete "$lock_label" --repo "$repo" --yes >/dev/null 2>&1 || true
  fi
}
trap release_lock EXIT

acquire_lock() {
  local out
  if out="$(gh label create "$lock_label" --repo "$repo" --description "Deduplication lock for stop event $event_id" --color "ededed" 2>&1)"; then
    lock_acquired=1
    return 0
  fi
  if [[ "$out" == *"already exists"* ]]; then
    return 2
  fi
  log "failed to acquire lock label $lock_label: $out"
  return 1
}

# Idempotency: the title carries the stop event id, so an exact-title match
# over the full issue history is the dedupe key. `gh api --paginate` follows
# every page, so an older entry beyond the first page still suppresses a
# re-send; closed entries match too (state=all).
scan_for_existing() {
  local attempt out
  for attempt in 1 2 3; do
    if out="$(gh api --paginate \
      -H 'Accept: application/vnd.github+json' \
      "/repos/$repo/issues?state=all&per_page=100" \
      --jq ".[] | select(.title == $(jq -Rn --arg t "$title" '$t')) | .number" 2>/dev/null)"; then
      printf '%s\n' "$out"
      return 0
    fi
    log "duplicate scan attempt $attempt failed; retrying"
    sleep "$lookup_retry_delay"
  done
  return 1
}

existing="$(scan_for_existing | head -1)" || die "the duplicate scan failed; refusing to create a possibly-duplicate stop entry"
if [[ -n "$existing" ]]; then
  log "stop entry already exists for event $event_id (issue #$existing) — deduplicated"
  printf 'stop=deduplicated issue=%s event=%s\n' "$existing" "$event_id"
  exit 0
fi

# Concurrency serialization: acquire unique repository lock label for this stop event.
acquire_attempts=0
while true; do
  acquire_rc=0
  acquire_lock || acquire_rc=$?
  if [[ "$acquire_rc" -eq 0 ]]; then
    # Rescan after acquiring the lock to guarantee no prior run created the issue
    # and released the lock before this run acquired it.
    existing="$(scan_for_existing | head -1)" || {
      release_lock
      die "the duplicate scan failed; refusing to create a possibly-duplicate stop entry"
    }
    if [[ -n "$existing" ]]; then
      log "stop entry already exists for event $event_id (issue #$existing) — deduplicated"
      release_lock
      printf 'stop=deduplicated issue=%s event=%s\n' "$existing" "$event_id"
      exit 0
    fi
    break
  elif [[ "$acquire_rc" -eq 2 ]]; then
    log "concurrent notification in progress for event $event_id; waiting for issue"
    waited=0
    issue_found=""
    while [[ "$waited" -lt "$lock_timeout" ]]; do
      sleep "$lock_poll_delay"
      waited=$((waited + 1))
      issue_found="$(scan_for_existing | head -1 || true)"
      if [[ -n "$issue_found" ]]; then
        log "stop entry already exists for event $event_id (issue #$issue_found) — deduplicated"
        printf 'stop=deduplicated issue=%s event=%s\n' "$issue_found" "$event_id"
        exit 0
      fi
    done
    acquire_attempts=$((acquire_attempts + 1))
    if [[ "$acquire_attempts" -ge 2 ]]; then
      die "timed out waiting for concurrent stop notification to complete for event $event_id"
    fi
  else
    die "could not acquire deduplication lock for event $event_id"
  fi
done

printf -v body 'Release workflow stopped.\n\n- Tag: `%s`\n- Step: `%s`\n- Reason: %s\n- Step link: %s\n- Stop event: `%s`\n\nThis issue is the durable journal entry for that stop; the responsible (@%s) is assigned here. It is created once per workflow stop event: a re-run of the failed step does not duplicate it, a fresh workflow run opens a new entry.' \
  "$tag" "$step" "$reason" "$step_url" "$event_id" "$responsible"

create_out=""
if ! create_out="$(gh issue create --repo "$repo" --title "$title" --label release-stop --body "$body" --assignee "$responsible" 2>&1)"; then
  release_lock
  die "could not create the stop notification issue (assignment to $responsible included): $create_out"
fi
url="$create_out"

# Post-creation check: defense in depth against concurrent creation
created_num="$(printf '%s\n' "$url" | grep -oE '[0-9]+$' || true)"
all_existing="$(scan_for_existing 2>/dev/null || true)"
if [[ -n "$all_existing" ]]; then
  canonical_num="$(printf '%s\n' "$all_existing" | grep -E '^[0-9]+$' | sort -n | head -1 || true)"
  if [[ -n "$canonical_num" && -n "$created_num" && "$created_num" -gt "$canonical_num" ]]; then
    log "duplicate issue #$created_num created concurrently with canonical #$canonical_num; closing duplicate"
    gh issue close "$created_num" --repo "$repo" --comment "Duplicate notification for stop event $event_id (canonical issue is #$canonical_num) — closing." >/dev/null 2>&1 || true
    release_lock
    printf 'stop=deduplicated issue=%s event=%s\n' "$canonical_num" "$event_id"
    exit 0
  fi
fi

release_lock
log "opened stop entry for $tag (event $event_id), assigned to $responsible"
printf 'stop=created issue=%s event=%s\n' "${url:-unknown}" "$event_id"
