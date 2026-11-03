#!/usr/bin/env bash
# scripts/myrmidon/ci/main-green-gate.sh
#
# MERGE-ON-RED-MAIN GATE (OPE-10789):
# Prevents GitHub auto-merge (and bot direct merges) from merging pull requests
# into `main` when the latest Myrmidon CI run on `main` is red (failed, timed out,
# cancelled) or still running/pending.
#
# On 03.11 (OPE-10788), main broke at 12:34 IRK. GitHub native auto-merge
# (autoMergeRequest) only evaluates PR-level status checks (e.g. CI result on the PR
# branch). While ADM auto-merge loop backed off, GitHub's built-in auto-merge
# engine merged 5 more PRs (#2258, #1896, #2371, #1312) directly on top of the
# broken main, compounding the breakage.
#
# This gate acts as a required PR check (like release `freeze`):
#   - Exits 0 (GREEN) only when the latest Myrmidon CI on `main` has completed
#     with conclusion: success AND no open issue labelled `main-red` exists.
#   - Exits 1 (RED) when `main` CI is failing, running, queued, cancelled,
#     or an issue labelled `main-red` is open.
#   - Fails closed (RED) on API / auth errors so network/token glitches never
#     wave PRs through into an unverified main.
#
# When added to required status checks of `main`, GitHub's native auto-merge
# engine (`autoMergeRequest`) refuses to merge any PR while this check is red.
#
# Modes:
#   --check        Exits 0 if main is green, 1 if main is red or pending.
#   --status       Prints a one-line status (green | red:<reason> | pending:<reason>).
#
# Environment:
#   GITHUB_REPOSITORY  owner/repo (defaults to origin)
#   BASE_BRANCH        base branch to check (defaults to main)
#   GH_TOKEN / GITHUB_TOKEN  GitHub token (read-only checks sufficient)

set -euo pipefail

die() { printf '[main-green-gate] ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[main-green-gate] %s\n' "$*" >&2; }

mode="check"
while (($#)); do
  case "$1" in
    --check) mode="check"; shift ;;
    --status) mode="status"; shift ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

command -v gh >/dev/null 2>&1 || die "gh is not installed"
command -v jq >/dev/null 2>&1 || die "jq is not installed"

repo="${GITHUB_REPOSITORY:-}"
if [[ -z "$repo" ]]; then
  repo="$(git remote get-url origin 2>/dev/null | sed -E 's#.*github.com[:/]([^/]+/[^/.]+)(\.git)?#\1#' || true)"
fi
repo="${repo:-itkadr-git/myrmidon}"
export GITHUB_REPOSITORY="$repo"

token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
if [[ -z "$token" ]] && command -v gh >/dev/null 2>&1; then
  token="$(gh auth token 2>/dev/null || true)"
fi
if [[ -n "$token" ]]; then
  export GH_TOKEN="$token"
  export GITHUB_TOKEN="$token"
fi

base_branch="${BASE_BRANCH:-main}"

# Fail-closed check: verify we can reach the repository
if ! gh api "repos/$repo" --jq '.full_name' >/dev/null 2>&1; then
  die "cannot query repository state for $repo (auth or API failure) — failing closed (red)"
fi

# 1. Check for open issues labelled `main-red`
# The `report-main` job of myrmidon-ci.yml maintains an open issue labelled `main-red`
# while main is failing, and closes it when main turns green.
open_red_issues="$(gh issue list --repo "$repo" --state open --label main-red --limit 5 \
  --json number,title --jq '.[].number' 2>/dev/null || true)"

if [[ -n "$open_red_issues" ]]; then
  red_numbers="$(tr '\n' ' ' <<<"$open_red_issues" | sed 's/[[:space:]]*$//')"
  reason="open main-red issue(s): #$red_numbers"
  if [[ "$mode" == "status" ]]; then
    printf 'red:%s\n' "$reason"
    exit 0
  fi
  die "MAIN BRANCH IS RED ($reason) — PR merges are blocked until main CI is fixed and green"
fi

# 2. Inspect the latest Myrmidon CI workflow run on base branch
# Query runs of myrmidon-ci.yml on the base branch for push events
runs_json="$(gh api "repos/$repo/actions/workflows/myrmidon-ci.yml/runs?branch=$base_branch&event=push&per_page=5" 2>/dev/null || true)"

# Fallback: if workflow query returned empty, query general actions/runs on branch
if [[ -z "$runs_json" || "$(jq -r '.workflow_runs // empty' <<<"$runs_json")" == "[]" ]]; then
  runs_json="$(gh api "repos/$repo/actions/runs?branch=$base_branch&event=push&per_page=5" 2>/dev/null || true)"
fi

latest_run="$(jq -r '
  [.workflow_runs[]? | select(.head_branch == "'"$base_branch"'")]
  | sort_by(.created_at) | reverse | .[0] // empty
' <<<"$runs_json")"

head_sha="$(gh api "repos/$repo/commits/$base_branch" --jq '.sha' 2>/dev/null || true)"

# If a run exists, evaluate status and conclusion
if [[ -n "$latest_run" && "$latest_run" != "null" ]]; then
  run_id="$(jq -r '.id' <<<"$latest_run")"
  run_status="$(jq -r '.status' <<<"$latest_run")"
  run_conclusion="$(jq -r '.conclusion // "pending"' <<<"$latest_run")"
  run_sha="$(jq -r '.head_sha' <<<"$latest_run")"

  if [[ "$run_status" != "completed" ]]; then
    reason="run #$run_id is $run_status (head $run_sha)"
    if [[ "$mode" == "status" ]]; then
      printf 'pending:%s\n' "$reason"
      exit 0
    fi
    die "MAIN BRANCH CI IS NOT COMPLETED ($reason) — PR merges are blocked until main CI completes successfully"
  fi

  case "$run_conclusion" in
    success)
      # Check if HEAD moved beyond the completed run
      if [[ -n "$head_sha" && -n "$run_sha" && "$head_sha" != "$run_sha" ]]; then
        # HEAD moved: check if head_sha already has a completed CI result check run
        checks="$(gh api "repos/$repo/commits/$head_sha/check-runs?check_name=CI%20result&per_page=10" \
          --jq '[.check_runs[]? | select(.status == "completed") | .conclusion] | unique | join(",")' 2>/dev/null || true)"
        if [[ "$checks" != "success" ]]; then
          reason="head moved to $head_sha and its CI is pending"
          if [[ "$mode" == "status" ]]; then
            printf 'pending:%s\n' "$reason"
            exit 0
          fi
          die "MAIN BRANCH HAS FRESH COMMITS WITHOUT GREEN CI ($reason)"
        fi
      fi
      log "main branch CI is GREEN (commit ${head_sha:-$run_sha}, run #$run_id). Merges permitted."
      if [[ "$mode" == "status" ]]; then
        printf 'green\n'
      fi
      exit 0
      ;;
    failure|cancelled|timed_out|startup_failure|action_required)
      reason="run #$run_id concluded with $run_conclusion on commit $run_sha"
      if [[ "$mode" == "status" ]]; then
        printf 'red:%s\n' "$reason"
        exit 0
      fi
      die "MAIN BRANCH CI IS RED ($reason) — PR merges are blocked until main CI is fixed and green"
      ;;
    *)
      reason="run #$run_id has conclusion: $run_conclusion"
      if [[ "$mode" == "status" ]]; then
        printf 'pending:%s\n' "$reason"
        exit 0
      fi
      die "MAIN BRANCH CI IS NOT GREEN ($reason)"
      ;;
  esac
fi

# Fallback: if no workflow run record was found, check commit check-runs on head_sha
if [[ -n "$head_sha" ]]; then
  checks="$(gh api "repos/$repo/commits/$head_sha/check-runs?check_name=CI%20result&per_page=10" \
    --jq '[.check_runs[]? | select(.status == "completed") | .conclusion] | unique | join(",")' 2>/dev/null || true)"
  if [[ "$checks" == "success" ]]; then
    log "main branch CI result is GREEN on head commit $head_sha. Merges permitted."
    if [[ "$mode" == "status" ]]; then
      printf 'green\n'
    fi
    exit 0
  fi
fi

# Default: could not verify green status
reason="no completed green Myrmidon CI run found for $base_branch"
if [[ "$mode" == "status" ]]; then
  printf 'pending:%s\n' "$reason"
  exit 0
fi
die "CANNOT CONFIRM GREEN STATUS FOR $base_branch ($reason) — failing closed (red)"
