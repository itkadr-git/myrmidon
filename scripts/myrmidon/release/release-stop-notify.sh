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
# Modes: none (only this one behaviour). Callers:
#   - .github/workflows/myrmidon-release.yml "Notify the responsible on a
#     release stop" step (if: failure()).
#
# Environment:
#   GITHUB_REPOSITORY          owner/repo (the workflow sets it)
#   GH_RELEASE_TOKEN / GITHUB_TOKEN  token with issues:write
#   RELEASE_TAG                the release tag the stopped workflow served
#   RELEASE_STEP               which step stopped (e.g. publish)
#   RELEASE_STOP_REASON        human-readable cause, shown verbatim
#   RELEASE_STOP_EVENT_ID      stop event key; defaults to GITHUB_RUN_ID
#   RELEASE_STEP_URL           link to the stopped workflow/job/run
#   RELEASE_RESPONSIBLE_LOGIN  optional GitHub login to assign
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

command -v gh >/dev/null 2>&1 || die "gh is not installed"
command -v jq >/dev/null 2>&1 || die "jq is not installed"
token="${GH_RELEASE_TOKEN:-${GITHUB_TOKEN:-}}"
[[ -n "$token" ]] || die "GH_RELEASE_TOKEN (or GITHUB_TOKEN) is not set"
export GH_TOKEN="$token"

title="release-stop: $tag ($event_id)"

# Idempotency: the title carries the stop event id, so a lookup by exact
# title is the dedupe key. Search all states: a manually closed entry must
# still suppress a re-send for the same stop event on the next retry.
existing="$(gh issue list --repo "$repo" --state all --limit 200 \
  --json number,title --jq ".[] | select(.title == $(jq -Rn --arg t "$title" '$t')) | .number" 2>/dev/null | head -1 || true)"
if [[ -n "$existing" ]]; then
  log "stop entry already exists for event $event_id (issue #$existing) — deduplicated"
  printf 'stop=deduplicated issue=%s event=%s\n' "$existing" "$event_id"
  exit 0
fi

body="Release workflow stopped.\n\n- Tag: \`$tag\`\n- Step: \`$step\`\n- Reason: $reason\n- Step link: $step_url\n- Stop event: \`$event_id\`\n\nThis issue is the durable journal entry for that stop: the responsible is assigned here. It is created once per workflow stop event; a re-run of the failed step does not duplicate it, a fresh workflow run opens a new entry."

args=(issue create --repo "$repo" --title "$title" --label release-stop --body "$body")
responsible="${RELEASE_RESPONSIBLE_LOGIN:-}"
if [[ -n "$responsible" ]]; then
  args+=(--assignee "$responsible")
fi

url="$(gh "${args[@]}" 2>/dev/null)" || die "could not create the stop notification issue"
log "opened stop entry for $tag (event $event_id)"
printf 'stop=created issue=%s event=%s\n' "${url:-unknown}" "$event_id"
