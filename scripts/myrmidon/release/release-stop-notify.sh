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
#   GITHUB_REPOSITORY          owner/repo (the workflow sets it)
#   GH_RELEASE_TOKEN / GITHUB_TOKEN  token with issues:write
#   RELEASE_TAG                the release tag the stopped workflow served
#   RELEASE_STEP               which step stopped (e.g. publish)
#   RELEASE_STOP_REASON        human-readable cause, shown verbatim
#   RELEASE_STOP_EVENT_ID      stop event key; defaults to GITHUB_RUN_ID
#   RELEASE_STEP_URL           link to the stopped workflow/job/run
#   RELEASE_RESPONSIBLE_LOGIN  required GitHub login to assign
#   RELEASE_STOP_LOOKUP_RETRY_DELAY  seconds between scan retries (default 2)
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

command -v gh >/dev/null 2>&1 || die "gh is not installed"
command -v jq >/dev/null 2>&1 || die "jq is not installed"
token="${GH_RELEASE_TOKEN:-${GITHUB_TOKEN:-}}"
[[ -n "$token" ]] || die "GH_RELEASE_TOKEN (or GITHUB_TOKEN) is not set"
export GH_TOKEN="$token"

title="release-stop: $tag ($event_id)"

# Idempotency: the title carries the stop event id, so an exact-title match
# over the full issue history is the dedupe key. `gh api --paginate` follows
# every page, so an older entry beyond the first page still suppresses a
# re-send; closed entries match too (state=all).
# Concurrency: the workflow pins one notification job per stop event id
# (concurrency group release-stop-notify-<workflow_run.id>), so retries of
# this notification serialize instead of racing a shared lookup window.
# A transient scan failure retries a few times; if the scan still fails the
# script exits non-zero WITHOUT creating an entry (a failed job is visible
# in the Actions UI; a silently duplicated issue is not).
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

printf -v body 'Release workflow stopped.\n\n- Tag: `%s`\n- Step: `%s`\n- Reason: %s\n- Step link: %s\n- Stop event: `%s`\n\nThis issue is the durable journal entry for that stop; the responsible (@%s) is assigned here. It is created once per workflow stop event: a re-run of the failed step does not duplicate it, a fresh workflow run opens a new entry.' \
  "$tag" "$step" "$reason" "$step_url" "$event_id" "$responsible"

url="$(gh issue create --repo "$repo" --title "$title" --label release-stop --body "$body" --assignee "$responsible" 2>/dev/null)" || \
  die "could not create the stop notification issue (assignment to $responsible included)"
log "opened stop entry for $tag (event $event_id), assigned to $responsible"
printf 'stop=created issue=%s event=%s\n' "${url:-unknown}" "$event_id"
