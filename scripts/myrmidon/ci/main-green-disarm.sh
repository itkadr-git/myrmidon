#!/usr/bin/env bash
# Disarm native GitHub auto-merge when the current main CI is not green.
# A PR-level main-green check can remain successful after main later turns red;
# disabling auto-merge on the main CI completion event closes that race.
set -euo pipefail

log() { printf '[main-green-disarm] %s\n' "$*" >&2; }

command -v gh >/dev/null 2>&1 || { log "ERROR: gh is not installed"; exit 1; }
export GH_TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
[[ -n "$GH_TOKEN" ]] || { log "ERROR: GITHUB_TOKEN is not set"; exit 1; }

source="${BASH_SOURCE[0]}"
while [[ -L "$source" ]]; do
  target="$(readlink "$source")"
  [[ "$target" == /* ]] && source="$target" || source="$(dirname "$source")/$target"
done
here="$(cd "$(dirname "$source")" && pwd)"
check="${MAIN_GREEN_CHECK:-$here/main-green-gate.sh}"

if "$check" --check >/dev/null 2>&1; then
  log "main is green; no auto-merge requests to disarm"
  exit 0
fi

repo="${GITHUB_REPOSITORY:-itkadr-git/myrmidon}"
heads="$(gh api --paginate "repos/$repo/pulls?state=open&base=main&per_page=100" \
  --jq '.[] | select(.draft == false) | "\(.number) \(.head.sha)"' 2>/dev/null)" \
  || { log "ERROR: cannot list open pull requests"; exit 1; }

disarmed=0
while read -r number sha; do
  [[ -n "${number:-}" ]] || continue
  if gh pr merge "$number" --repo "$repo" --disable-auto >/dev/null 2>&1; then
    log "disabled auto-merge for PR #$number (${sha:0:12})"
    disarmed=$((disarmed + 1))
  else
    log "WARN: could not disable auto-merge for PR #$number"
  fi
done <<< "$heads"

log "disarmed $disarmed auto-merge request(s) while main was not green"
