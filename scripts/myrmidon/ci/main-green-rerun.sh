#!/usr/bin/env bash
# scripts/myrmidon/ci/main-green-rerun.sh
#
# MERGE-ON-RED-MAIN RERUN (OPE-10789):
# The "Main green gate" check (myrmidon-main-green.yml) fails on pull requests
# while main CI is red or in-flight.
#
# Once `main` CI completes green, open pull requests need their failed gate check
# re-evaluated so that GitHub auto-merge and review lanes unblock automatically.
#
# This script is called by myrmidon-main-green.yml on `workflow_run` (when Myrmidon CI
# completes on main), on schedule, and on workflow_dispatch.
#
# Environment:
#   GITHUB_REPOSITORY   owner/repo (defaults to origin)
#   GITHUB_TOKEN        actions:write + pull-requests:read + issues:read
#   MAIN_GREEN_CHECK    path to main-green-gate.sh (tests can override)
#   RERUN_WINDOW_DAYS   how far back failed gate runs are checked (default 3)

set -euo pipefail

log() { printf '[main-green-rerun] %s\n' "$*" >&2; }

dry_run=0
for arg in "${@:-}"; do
  case "$arg" in
    --dry-run)
      dry_run=1
      ;;
    -h|--help)
      printf 'Usage: %s [--dry-run]\n' "${0##*/}"
      printf 'Re-runs failed main-green gate workflow runs for current heads of open PRs.\n'
      exit 0
      ;;
  esac
done

command -v gh >/dev/null 2>&1 || { log "ERROR: gh is not installed"; exit 1; }
repo="${GITHUB_REPOSITORY:-}"
if [[ -z "$repo" ]]; then
  repo="$(git remote get-url origin 2>/dev/null | sed -E 's#.*github.com[:/]([^/]+/[^/.]+)(\.git)?#\1#' || true)"
fi
repo="${repo:-itkadr-git/myrmidon}"
export GITHUB_REPOSITORY="$repo"

export GH_TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
if [[ -z "$GH_TOKEN" ]] && command -v gh >/dev/null 2>&1; then
  GH_TOKEN="$(gh auth token 2>/dev/null || true)"
  export GH_TOKEN
fi
[[ -n "$GH_TOKEN" ]] || { log "ERROR: GITHUB_TOKEN is not set"; exit 1; }
export GITHUB_TOKEN="${GITHUB_TOKEN:-$GH_TOKEN}"

source="${BASH_SOURCE[0]}"
while [[ -L "$source" ]]; do
  target="$(readlink "$source")"
  if [[ "$target" == /* ]]; then
    source="$target"
  else
    source="$(dirname "$source")/$target"
  fi
done
here="$(cd "$(dirname "$source")" && pwd)"
check="${MAIN_GREEN_CHECK:-$here/main-green-gate.sh}"
workflow="myrmidon-main-green.yml"
window_days="${RERUN_WINDOW_DAYS:-3}"

# Main must be green right now. If it is still red or pending, re-running would only turn red again.
if ! "$check" --check; then
  log "main branch is not green yet — nothing to re-run"
  exit 0
fi

since="$(date -u -d "$window_days days ago" +%Y-%m-%d 2>/dev/null || date -u -v-"${window_days}"d +%Y-%m-%d 2>/dev/null || echo "")"
since_arg=()
[[ -n "$since" ]] && since_arg=("--created=>=$since")

heads="$(gh api --paginate "repos/$repo/pulls?state=open&base=main&per_page=100" \
  --jq '.[] | "\(.head.sha) \(.number)"' 2>/dev/null)" || { log "ERROR: cannot list open pull requests"; exit 1; }

failed_query="repos/$repo/actions/workflows/$workflow/runs?event=pull_request&status=failure&per_page=100"
[[ -n "$since" ]] && failed_query="${failed_query}&created=%3E%3D$since"

failed="$(gh api --paginate "$failed_query" \
  --jq '.workflow_runs[]? | "\(.id) \(.head_sha)"' 2>/dev/null)" || { log "ERROR: cannot list failed gate runs"; exit 1; }

declare -A pr_of_head=() seen=()
while read -r sha number; do
  [[ -n "${sha:-}" ]] && pr_of_head["$sha"]="$number"
done <<<"$heads"

rerun=0 skipped=0
while read -r run_id sha; do
  [[ -n "${run_id:-}" && -n "${sha:-}" ]] || continue
  [[ -n "${pr_of_head[$sha]:-}" ]] || continue            # head no longer active or PR closed
  [[ -z "${seen[$sha]:-}" ]] || continue                   # newest failed run per head only
  seen["$sha"]=1
  if [[ "$dry_run" -eq 1 ]]; then
    log "[dry-run] would re-run the gate run $run_id of PR #${pr_of_head[$sha]} (${sha:0:12})"
    rerun=$((rerun + 1))
  elif gh run rerun "$run_id" --failed --repo "$repo" >/dev/null 2>&1; then
    log "re-ran the gate run $run_id of PR #${pr_of_head[$sha]} (${sha:0:12})"
    rerun=$((rerun + 1))
  else
    log "WARN: could not re-run the gate run $run_id of PR #${pr_of_head[$sha]} (${sha:0:12})"
    skipped=$((skipped + 1))
  fi
done <<<"$failed"

if [[ "$dry_run" -eq 1 ]]; then
  log "[dry-run] would re-run $rerun gate run(s), $skipped could not be re-run"
else
  log "re-ran $rerun gate run(s), $skipped could not be re-run"
fi
