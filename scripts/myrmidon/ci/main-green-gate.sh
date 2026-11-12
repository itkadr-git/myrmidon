#!/usr/bin/env bash
# scripts/myrmidon/ci/main-green-gate.sh
#
# MERGE-ON-RED-MAIN GATE (OPE-10789):
# Prevents GitHub auto-merge (and bot direct merges) from merging pull requests
# into `main` when the latest COMPLETED Myrmidon CI run on `main` is red
# (failed, timed out, cancelled). OPE-12889: a queued/in_progress run is not red —
# the verdict is taken from the last completed main CI run, so the ~40-minute
# main CI window after each merge no longer blocks green PRs.
#
# On 03.11 (OPE-10788), main broke at 12:34 IRK. GitHub native auto-merge
# (autoMergeRequest) only evaluates PR-level status checks (e.g. CI result on the PR
# branch). While ADM auto-merge loop backed off, GitHub's built-in auto-merge
# engine merged 5 more PRs (#2258, #1896, #2371, #1312) directly on top of the
# broken main, compounding the breakage.
#
# This gate acts as a required PR check (like release `freeze`):
#   - OPE-12889: the verdict comes from the latest COMPLETED Myrmidon CI run on
#     `main`. A queued/in_progress run is not red — while the previous completed
#     run is green, PRs may merge (main CI takes ~40 minutes per merge).
#   - OPE-12889 review: HEAD may have moved past the last completed run while a
#     new main CI run on the fresh HEAD is still queued/in_progress; that
#     in-flight run is not a verdict either. The gate stays green while a run for
#     the current HEAD exists and has not failed, and red once the run on HEAD
#     completes with a non-success conclusion.
#   - Exits 0 (GREEN) when the latest completed Myrmidon CI run on `main` has
#     conclusion: success AND no open issue labelled `main-red` exists (an
#     in-flight run on a moved HEAD does not change this).
#   - Exits 1 (RED) when the latest completed `main` CI run concluded with
#     failure/cancelled/timed_out/etc., an issue labelled `main-red` is open, or
#     no completed run exists at all (fail closed).
#   - Fails closed (RED) on API / auth errors so network/token glitches never
#     wave PRs through into an unverified main.
#
# When added to required status checks of `main`, GitHub's native auto-merge
# engine (`autoMergeRequest`) refuses to merge any PR while this check is red.
#
# Modes:
#   --check        Exits 0 if the last completed main CI run is green, 1 otherwise.
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
    -h|--help) sed -n '2,45p' "$0"; exit 0 ;;
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

# 2. Inspect the latest COMPLETED Myrmidon CI workflow run on base branch (event=push, branch=$base_branch)
# OPE-11694: Query workflow runs directly by branch and event=push, NOT check-runs on head commit SHA.
# Check-runs by commit SHA mix runs from release tags, other branches, or PRs sharing that SHA.
# Release tags run "Myrmidon CI (tag)" on the same SHA as main HEAD; a failure in tag CI must
# not block PR merges when main branch CI is green.
# OPE-12889: A queued/in_progress run is NOT the verdict — the gate reads the latest
# run whose status == completed, so the ~40-minute main CI window after a merge
# does not block PRs while the previous completed run is green.
head_sha="$(gh api "repos/$repo/commits/$base_branch" --jq '.sha' 2>/dev/null || true)"

runs_json="$(gh api "repos/$repo/actions/workflows/myrmidon-ci.yml/runs?branch=$base_branch&event=push&per_page=20" 2>/dev/null || true)"

if [[ -z "$runs_json" || "$(jq -r '.workflow_runs // empty' <<<"$runs_json")" == "[]" ]]; then
  runs_json="$(gh api "repos/$repo/actions/runs?branch=$base_branch&event=push&per_page=20" 2>/dev/null || true)"
fi

latest_run="$(jq -r '
  def match_workflow:
    (.path == null or .path == ".github/workflows/myrmidon-ci.yml" or .name == null or .name == "Myrmidon CI");
  (
    [.workflow_runs[]? | select(.head_branch == "'"$base_branch"'" and (.event == null or .event == "push") and match_workflow and .status == "completed")]
    | sort_by(.created_at) | reverse | .[0]
  ) // (
    [.workflow_runs[]? | select(.head_branch == "'"$base_branch"'" and (.event == null or .event == "push") and .status == "completed")]
    | sort_by(.created_at) | reverse | .[0]
  ) // empty
' <<<"$runs_json")"

# Runs on the current HEAD that have not completed yet (queued/in_progress).
# OPE-12889 review: their existence (not their state) decides whether a moved
# HEAD keeps the verdict of the last completed run.
head_pending_count="$(jq -r --arg sha "$head_sha" '
  ([.workflow_runs[]?
    | select(.head_sha == $sha and .status != "completed")]
   | length)
' <<<"$runs_json" 2>/dev/null || echo 0)"

# Newest run on the current HEAD, completed or not — used to catch a HEAD whose
# newest CI attempt already finished red while the last completed run overall is
# an older success (stale-green protection).
head_newest="$(jq -r --arg sha "$head_sha" '
  ([.workflow_runs[]?
    | select(.head_sha == $sha)]
   | sort_by(.created_at) | reverse | .[0]) // empty
' <<<"$runs_json" 2>/dev/null || true)"

pending_info="$(jq -r '
  (
    [.workflow_runs[]? | select(.status != "completed")]
    | sort_by(.created_at) | reverse | .[0]
    | "run #\(.id) is \(.status)"
  ) // empty
' <<<"$runs_json")"

if [[ -n "$latest_run" && "$latest_run" != "null" ]]; then
  run_id="$(jq -r '.id' <<<"$latest_run")"
  run_conclusion="$(jq -r '.conclusion // "unknown"' <<<"$latest_run")"
  run_sha="$(jq -r '.head_sha' <<<"$latest_run")"

  if [[ "$run_conclusion" == "success" ]]; then
    # OPE-12889: HEAD may have moved past the last completed run while a new
    # main CI run on the fresh HEAD is still queued/in_progress. That in-flight
    # run is not a verdict — the latest completed success keeps the gate green
    # (the rerun/disarm lane re-evaluates when the in-flight run completes).
    if [[ -n "$head_sha" && -n "$run_sha" && "$head_sha" != "$run_sha" ]]; then
      if [[ "${head_pending_count:-0}" -eq 0 ]]; then
        # Stale-green protection: HEAD moved but no run is in flight for it and
        # its newest attempt is not pending. If its newest attempt already
        # completed non-success, that run IS the verdict (fresh red); otherwise
        # no CI has started for the new HEAD at all — fail closed.
        head_conclusion="$(jq -r '.conclusion // "unknown"' <<<"${head_newest:-}" 2>/dev/null || true)"
        if [[ -n "$head_newest" && "$head_newest" != "null" && "$head_conclusion" != "success" ]]; then
          head_id="$(jq -r '.id' <<<"$head_newest")"
          reason="latest completed run #$run_id is stale: run #$head_id on the current HEAD $head_sha concluded with $head_conclusion"
          if [[ "$mode" == "status" ]]; then
            printf 'red:%s\n' "$reason"
            exit 0
          fi
          die "MAIN BRANCH CI IS RED ($reason) — PR merges are blocked until main CI is fixed and green"
        fi
        reason="head moved to $head_sha but no CI run has started or completed for it yet"
        if [[ "$mode" == "status" ]]; then
          printf 'pending:%s\n' "$reason"
          exit 0
        fi
        die "MAIN BRANCH HAS FRESH COMMITS WITHOUT GREEN CI ($reason)"
      fi
      log "main HEAD has CI in flight; verdict from last completed run #$run_id (success on commit $run_sha)."
    fi
    log "main branch CI is GREEN (latest completed run #$run_id succeeded on commit $run_sha). Merges permitted."
    [[ -n "$pending_info" ]] && log "current CI state: $pending_info (not a red verdict)"
    if [[ "$mode" == "status" ]]; then
      printf 'green\n'
    fi
    exit 0
  fi

  reason="latest completed run #$run_id concluded with $run_conclusion on commit $run_sha"
  if [[ "$mode" == "status" ]]; then
    printf 'red:%s\n' "$reason"
    exit 0
  fi
  die "MAIN BRANCH CI IS RED ($reason) — PR merges are blocked until main CI is fixed and green"
fi

# Default: could not verify green status. A queued/in_progress-only history
# (no completed run at all) also lands here and fails closed.
reason="no completed Myrmidon CI run found for $base_branch${pending_info:+ ($pending_info)}"
if [[ "$mode" == "status" ]]; then
  printf 'red:%s\n' "$reason"
  exit 0
fi
die "CANNOT CONFIRM GREEN STATUS FOR $base_branch ($reason) — failing closed (red)"
