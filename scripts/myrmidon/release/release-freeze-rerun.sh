#!/usr/bin/env bash
# scripts/myrmidon/release/release-freeze-rerun.sh
#
# OPE-10063: the "Release freeze gate" check (myrmidon-release-freeze.yml) is
# computed once per pull_request event. A PR pushed while the CI of a release
# tag runs gets a red `freeze` and stays red after the freeze lifts, until
# someone pushes again or re-runs it by hand (30.10: the CI of rc.19 turned
# `freeze` red on every open PR, the review lane read that as a failed CI).
#
# Run by the gate workflow when "Myrmidon CI (tag)" completes: if the gate is
# open again (release-freeze.sh --check passes), re-run the failed gate runs
# of the heads of the open pull requests into main — the newest failed run
# per head only. Best effort: a failed re-run is logged and skipped, the exit
# code is 0 unless the gate state itself cannot be decided.
#
# Environment:
#   GITHUB_REPOSITORY  owner/repo (the workflow sets it)
#   GITHUB_TOKEN       actions:write + pull-requests:read + issues:read
#   RELEASE_FREEZE_CHECK  the gate script (tests substitute a stub)
#   RERUN_WINDOW_DAYS  how far back failed gate runs are looked at (default 3)
#
# Tests: scripts/myrmidon/release/release-freeze-rerun.test.mjs (fake gh).

set -euo pipefail

log() { printf '[release-freeze-rerun] %s\n' "$*" >&2; }

command -v gh >/dev/null 2>&1 || { log "ERROR: gh is not installed"; exit 1; }
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"
export GH_TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
[[ -n "$GH_TOKEN" ]] || { log "ERROR: GITHUB_TOKEN is not set"; exit 1; }
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
check="${RELEASE_FREEZE_CHECK:-$here/release-freeze.sh}"
workflow="myrmidon-release-freeze.yml"
window_days="${RERUN_WINDOW_DAYS:-3}"

# The gate must be open: while a newer tag is frozen (or its state cannot be
# read) a re-run would only turn red again.
if ! "$check" --check; then
  log "the freeze is active or its state is unreadable — nothing to re-run"
  exit 0
fi

since="$(date -u -d "$window_days days ago" +%Y-%m-%d)"

heads="$(gh api --paginate "repos/$repo/pulls?state=open&base=main&per_page=100" \
  --jq '.[] | "\(.head.sha) \(.number)"')" || { log "ERROR: cannot list open pull requests"; exit 1; }
failed="$(gh api --paginate \
  "repos/$repo/actions/workflows/$workflow/runs?event=pull_request&status=failure&created=%3E%3D$since&per_page=100" \
  --jq '.workflow_runs[] | "\(.id) \(.head_sha)"')" || { log "ERROR: cannot list failed gate runs"; exit 1; }

declare -A pr_of_head=() seen=()
while read -r sha number; do
  [[ -n "${sha:-}" ]] && pr_of_head["$sha"]="$number"
done <<<"$heads"

rerun=0 skipped=0
while read -r run_id sha; do
  [[ -n "${run_id:-}" && -n "${sha:-}" ]] || continue
  [[ -n "${pr_of_head[$sha]:-}" ]] || continue            # a stale head or a closed PR
  [[ -z "${seen[$sha]:-}" ]] || continue                   # newest failed run per head only
  seen["$sha"]=1
  if gh run rerun "$run_id" --failed --repo "$repo" >/dev/null 2>&1; then
    log "re-ran the gate run $run_id of PR #${pr_of_head[$sha]} (${sha:0:12})"
    rerun=$((rerun + 1))
  else
    log "WARN: could not re-run the gate run $run_id of PR #${pr_of_head[$sha]} (${sha:0:12})"
    skipped=$((skipped + 1))
  fi
done <<<"$failed"

log "re-ran $rerun gate run(s), $skipped could not be re-run"
