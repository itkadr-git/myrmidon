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
#   - OPE-12889 (incl. review round): while the CURRENT main HEAD has a
#     queued/in_progress CI run, the verdict comes from the latest COMPLETED
#     run with conclusion success — an in-flight run is not a verdict, and a
#     cancelled run (superseded by the next push before it could finish) is not
#     a red verdict either. When the in-flight run completes, the rerun/disarm
#     lane re-evaluates: success keeps main green, failure turns it red.
#   - Exits 0 (GREEN) when the verdict run has conclusion: success AND no open
#     issue labelled `main-red` exists.
#   - Exits 1 (RED) when the verdict run concluded with
#     failure/cancelled/timed_out/etc. (no in-flight run on the current HEAD to
#     defer to, and no completed success to fall back to), an issue labelled
#     `main-red` is open, or no completed run exists at all (fail closed).
#   - Fails closed (RED) on API / auth errors so network/token glitches never
#     wave PRs through into an unverified main.
#
# When added to required status checks of `main`, GitHub's native auto-merge
# engine (`autoMergeRequest`) refuses to merge any PR while this check is red.
#
# Modes:
#   --check        Exits 0 if the main CI verdict is green, 1 otherwise.
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
    -h|--help) sed -n '2,46p' "$0"; exit 0 ;;
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

# 2. Inspect Myrmidon CI workflow runs on base branch (event=push, branch=$base_branch)
# OPE-11694: Query workflow runs directly by branch and event=push, NOT check-runs on head commit SHA.
# Check-runs by commit SHA mix runs from release tags, other branches, or PRs sharing that SHA.
# Release tags run "Myrmidon CI (tag)" on the same SHA as main HEAD; a failure in tag CI must
# not block PR merges when main branch CI is green.
# OPE-12889: A queued/in_progress run is NOT the verdict — the gate reads completed runs, so
# the ~40-minute main CI window after a merge does not block PRs.
head_sha="$(gh api "repos/$repo/commits/$base_branch" --jq '.sha' 2>/dev/null || true)"

runs_json="$(gh api "repos/$repo/actions/workflows/myrmidon-ci.yml/runs?branch=$base_branch&event=push&per_page=20" 2>/dev/null || true)"

if [[ -z "$runs_json" || "$(jq -r '.workflow_runs // empty' <<<"$runs_json")" == "[]" ]]; then
  runs_json="$(gh api "repos/$repo/actions/runs?branch=$base_branch&event=push&per_page=20" 2>/dev/null || true)"
fi

select_completed="$(cat <<'JQ'
  def match_workflow:
    (.path == null or .path == ".github/workflows/myrmidon-ci.yml" or .name == null or .name == "Myrmidon CI");
  (
    [.workflow_runs[]? | select(.head_branch == "BASEBRANCH" and (.event == null or .event == "push") and match_workflow and EXTRA and .status == "completed")]
    | sort_by(.created_at) | reverse | .[0]
  ) // (
    [.workflow_runs[]? | select(.head_branch == "BASEBRANCH" and (.event == null or .event == "push") and EXTRA and .status == "completed")]
    | sort_by(.created_at) | reverse | .[0]
  ) // empty
JQ
)"

latest_run="$(sed -e 's#BASEBRANCH#'"$base_branch"'#g' -e 's#EXTRA#true#' <<<"$select_completed" | jq -r "$(cat)" <<<"$runs_json")"

# Latest COMPLETED run with conclusion success — the fallback verdict while the
# current HEAD has CI in flight (OPE-12889 review).
last_success="$(sed -e 's#BASEBRANCH#'"$base_branch"'#g' -e 's#EXTRA#.conclusion == "success"#' <<<"$select_completed" | jq -r "$(cat)" <<<"$runs_json")"

# Runs on the current HEAD that have not completed yet (queued/in_progress).
# OPE-12889 review: their existence (not their state) decides whether the
# verdict defers to the latest completed success.
head_pending_count="$(jq -r --arg sha "$head_sha" '
  ([.workflow_runs[]?
    | select(.head_sha == $sha and .status != "completed")]
   | length)
' <<<"$runs_json" 2>/dev/null || echo 0)"

# Newest run on the current HEAD, completed or not — used to catch a HEAD whose
# newest CI attempt already finished red while the last completed success is an
# older commit and nothing is in flight (stale-green protection).
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

green_exit() {
  local run_id="$1" run_sha="$2" deferred="$3"
  if [[ "$deferred" == "1" ]]; then
    log "main HEAD has CI in flight (${pending_info:-unknown}); verdict from latest completed success run #$run_id (commit $run_sha)."
  fi
  log "main branch CI is GREEN (latest completed success run #$run_id on commit $run_sha). Merges permitted."
  [[ -n "$pending_info" ]] && [[ "$deferred" != "1" ]] && log "current CI state: $pending_info (not a red verdict)"
  if [[ "$mode" == "status" ]]; then
    printf 'green\n'
  fi
  exit 0
}

red_exit() {
  local reason="$1"
  if [[ "$mode" == "status" ]]; then
    printf 'red:%s\n' "$reason"
    exit 0
  fi
  die "MAIN BRANCH CI IS RED ($reason) — PR merges are blocked until main CI is fixed and green"
}

# 3. In-flight deferral (OPE-12889 review): while the current HEAD has a
# queued/in_progress main CI run, the verdict is the latest COMPLETED run with
# conclusion success. A cancelled run superseded by the next push is not red.
if [[ "${head_pending_count:-0}" -gt 0 && -n "$last_success" && "$last_success" != "null" ]]; then
  s_id="$(jq -r '.id' <<<"$last_success")"
  s_sha="$(jq -r '.head_sha' <<<"$last_success")"
  green_exit "$s_id" "$s_sha" 1
fi

if [[ -n "$latest_run" && "$latest_run" != "null" ]]; then
  run_id="$(jq -r '.id' <<<"$latest_run")"
  run_conclusion="$(jq -r '.conclusion // "unknown"' <<<"$latest_run")"
  run_sha="$(jq -r '.head_sha' <<<"$latest_run")"

  if [[ "$run_conclusion" == "success" ]]; then
    if [[ -n "$head_sha" && -n "$run_sha" && "$head_sha" != "$run_sha" ]]; then
      # HEAD moved past the completed success and nothing is in flight for it.
      if [[ -n "$head_newest" && "$head_newest" != "null" ]]; then
        h_conclusion="$(jq -r '.conclusion // "unknown"' <<<"$head_newest")"
        if [[ "$h_conclusion" != "success" ]]; then
          h_id="$(jq -r '.id' <<<"$head_newest")"
          red_exit "latest completed run #$run_id is stale: run #$h_id on the current HEAD $head_sha concluded with $h_conclusion"
        fi
      fi
      # Fail closed: HEAD moved but no CI run has even started for it yet.
      reason="head moved to $head_sha but no CI run has started or completed for it yet"
      if [[ "$mode" == "status" ]]; then
        printf 'pending:%s\n' "$reason"
        exit 0
      fi
      die "MAIN BRANCH HAS FRESH COMMITS WITHOUT GREEN CI ($reason)"
    fi
    green_exit "$run_id" "$run_sha" 0
  fi

  red_exit "latest completed run #$run_id concluded with $run_conclusion on commit $run_sha"
fi

# Default: could not verify green status. A queued/in_progress-only history
# (no completed run at all) also lands here and fails closed.
reason="no completed Myrmidon CI run found for $base_branch${pending_info:+ ($pending_info)}"
if [[ "$mode" == "status" ]]; then
  printf 'red:%s\n' "$reason"
  exit 0
fi
die "CANNOT CONFIRM GREEN STATUS FOR $base_branch ($reason) — failing closed (red)"
