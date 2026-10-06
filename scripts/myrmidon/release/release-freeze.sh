#!/usr/bin/env bash
# scripts/myrmidon/release/release-freeze.sh
#
# RELEASE-FREEZE (the 1.6.4 incident): between the release cut and a green CI
# on the release tag, merges into main must wait. On 04.10 1.6.4 was merged at
# 04:31:06, the tag was pushed, and one minute later merge bots merged #475
# and three more PRs into main — the tag's CI run was superseded/cancelled,
# the autopublish gate refused, and the release had to be published by hand.
#
# The freeze state is derived from GitHub (no file flag to forget about):
#
#   - if no myr-v* tag exists, there is no freeze;
#   - otherwise take the NEWEST myr-v*.*.* tag by semantic version
#     (the cut that started the current release window);
#   - freeze is ACTIVE while that tag has no successful "Myrmidon CI" run
#     (matched by head_branch == the tag, or — because myrmidon-ci.yml has no
#     tag trigger — a green main-branch run of the SAME commit, the same rule
#     publish-github-release.sh uses);
#   - freeze CLEARS as soon as that CI run is green. A release the publish
#     gate would accept (its CI gate is the exact same check) unblocks main.
#
# Modes:
#   --set-state    (workflow_call; needs secrets.GH_FREEZE_TOKEN — a PAT with
#                  actions:write — or fails closed as "freeze stays active")
#      Maintains ONE open GitHub issue titled "release-freeze: <tag>" on the
#      board repo. The issue exists  <=>  the freeze is active. This is the
#      durable state that survives the tag's CI run being cancelled by newer
#      pushes to main (exactly what broke 1.6.4).
#      Prints one line: freeze=active | freeze=inactive
#   --check        (pull_request gate; read-only, no token required)
#      Exit 1 (red check) while the freeze is active: the freeze issue is
#      still open AND the newest tag's CI is not green yet. The closed-issue
#      check comes first so a green tag unblocks main even when --set-state
#      has not run yet; a still-red/in-progress tag keeps the freeze even if
#      the issue was closed by hand (the publish gate would refuse anyway).
#
# Environment:
#   GITHUB_REPOSITORY  owner/repo (the workflow sets it; tests override)
#   GH_FREEZE_TOKEN    issues:write token for --set-state (falls back to
#                      GITHUB_TOKEN, which is enough for --check)
#
# Tests: scripts/myrmidon/release/release-freeze.test.mjs (node --test, fake
# gh/jq in PATH, no network).

set -euo pipefail

die() { printf '[release-freeze] ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[release-freeze] %s\n' "$*" >&2; }

# Freeze decision: exit-code style (0 = active). $1 issue state
# (open|closed|absent), $2 tag CI verdict (success|failure|missing|in_progress).
freeze_active_decision() {
  # $1: freeze issue state (open|closed|absent)   $2: tag CI verdict (success|failure|missing|in_progress)
  local issue="$1" verdict="$2"
  if [[ "$issue" == "open" ]]; then
    [[ "$verdict" == "success" ]] && return 1   # green tag clears even before --set-state ran
    return 0                                     # issue open, tag not green yet -> freeze
  fi
  # No open freeze issue: the only way a freeze still applies is a tag whose
  # CI has not finished green (covers the window between cut and --set-state).
  case "$verdict" in
    success) return 1 ;;
    failure|mixed) return 1 ;;  # failed tag CI is not a freeze; it is a broken release (publish gate refuses it)
    *) return 0 ;;              # missing / in_progress -> freeze (cut happened, CI pending)
  esac
}

mode=""
while (($#)); do
  case "$1" in
    --set-state|--check) mode="${1#--}"; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n "$mode" ]] || die "one of --set-state / --check is required"

# -------------------------------------------------------------- live modes --
command -v gh >/dev/null 2>&1 || die "gh is not installed"
command -v jq >/dev/null 2>&1 || die "jq is not installed"
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"
token="${GH_FREEZE_TOKEN:-${GITHUB_TOKEN:-}}"
[[ -n "$token" ]] || die "GH_FREEZE_TOKEN (or GITHUB_TOKEN) is not set"
export GH_TOKEN="$token"

# Newest myr-vX.Y.Z[-rc.N] tag by version (an rc cut freezes main too) (NOT by ref list order — the API
# sorts by refname, so myr-v1.10.0 would sort below myr-v1.9.0 lexically).
newest_release_tag() {
  local ref
  ref="$(gh api --paginate "repos/$repo/git/refs/tags" --jq '.[].ref' 2>/dev/null \
    | sed -n 's#^refs/tags/\(myr-v[0-9]*\.[0-9]*\.[0-9]*\(-rc\.[0-9]*\)\{0,1\}\)$#\1#p' \
    | sort -V | tail -1 || true)"
  printf '%s\n' "$ref"
}

# CI verdict of the tag: success | <conclusion> | in_progress | missing.
# Same selection rule as publish-github-release.sh: head_branch == the tag,
# and for myrmidon-ci.yml (no tag trigger) also a main run of the same sha.
tag_ci_verdict() {
  local tag="$1" sha branches verdict status
  sha="$(gh api "repos/$repo/git/ref/tags/$tag" --jq '
      if .object.type == "tag" then .object.sha else .object.sha end' 2>/dev/null)" \
    || { printf 'missing\n'; return; }
  # annotated tag -> dereference
  local otype
  otype="$(gh api "repos/$repo/git/ref/tags/$tag" --jq '.object.type' 2>/dev/null || true)"
  if [[ "$otype" == "tag" ]]; then
    sha="$(gh api "repos/$repo/git/tags/$sha" --jq '.object.sha' 2>/dev/null || true)"
  fi
  [[ -n "$sha" ]] || { printf 'missing\n'; return; }
  branches='((.head_branch == "'"$tag"'") or (.head_branch == "main"))'
  verdict="$(gh api --paginate "repos/$repo/actions/runs?head_sha=$sha&per_page=100" \
      --jq '[.workflow_runs[]? | select(.path == ".github/workflows/myrmidon-ci.yml" and '"$branches"')]
            | ([.[] | select(.status == "completed")] | if length == 0 then "missing"
               else (map(.conclusion) | unique | if length == 1 then .[0] else "mixed" end) end)' 2>/dev/null)" \
    || verdict="missing"
  verdict="${verdict//\"/}"
  if [[ "$verdict" == "missing" ]]; then
    status="$(gh api --paginate "repos/$repo/actions/runs?head_sha=$sha&per_page=100" \
        --jq '[.workflow_runs[]? | select(.path == ".github/workflows/myrmidon-ci.yml" and '"$branches"')] | .[0].status // "missing"' 2>/dev/null)" \
      || status="missing"
    status="${status//\"/}"
    [[ "$status" == "missing" ]] || { printf 'in_progress\n'; return; }
  fi
  printf '%s\n' "$verdict"
}

freeze_issue_number() { # prints the open freeze issue number for $1 (tag) or nothing
  gh issue list --repo "$repo" --state open --limit 50 \
    --json number,title --jq ".[] | select(.title == \"release-freeze: $1\") | .number" 2>/dev/null | head -1
}

tag="$(newest_release_tag)"
if [[ -z "$tag" ]]; then
  # Distinguish "repo has no release tags" from "the tags listing failed"
  # (no auth, API down): a gate that cannot see the repo state must not
  # silently turn green during a release window — it fails CLOSED.
  if ! gh api "repos/$repo" --jq '.full_name' >/dev/null 2>&1; then
    die "cannot query the repo state (auth/API failure) — treating as freeze-active (fail-closed)"
  fi
  log "no myr-v* tags — no freeze"
  if [[ "$mode" == "set-state" ]]; then
    printf 'freeze=inactive\n'
  fi
  exit 0
fi
log "newest release tag: $tag"

verdict="$(tag_ci_verdict "$tag")"
log "tag CI verdict: $verdict"
issue="$(freeze_issue_number "$tag")"

if [[ "$mode" == "set-state" ]]; then
  if [[ "$verdict" == "success" ]]; then
    if [[ -n "$issue" ]]; then
      gh issue close "$issue" --repo "$repo" \
        --comment "Freeze cleared: Myrmidon CI is green on $tag — merges into main are open again." >/dev/null
      log "closed freeze issue #$issue (CI green on $tag)"
    else
      log "no open freeze issue — nothing to clear"
    fi
    printf 'freeze=inactive\n'
  else
    if [[ -n "$issue" ]]; then
      log "freeze issue #$issue already open (tag CI: $verdict)"
    else
      gh issue create --repo "$repo" --title "release-freeze: $tag" --label "release-freeze" \
        --body "Release freeze for \`$tag\`: merges into \`main\` are gated (the \`Release freeze gate\` check fails on PRs) until Myrmidon CI is green on the tag. Opened automatically by the release workflow; closed automatically when the tag CI succeeds. This issue existing in the open state IS the freeze — do not close by hand unless the release is abandoned." >/dev/null \
        || log "WARN: could not open the freeze issue (missing issues:write?) — the gate still fails closed via the tag-CI check"
      log "opened freeze issue for $tag (tag CI: $verdict)"
    fi
    printf 'freeze=active\n'
  fi
  exit 0
fi

# --check: the PR gate. Red while frozen.
issue_state="absent"; [[ -n "$issue" ]] && issue_state="open"
if freeze_active_decision "$issue_state" "$verdict"; then
  printf '[release-freeze] RELEASE FREEZE ACTIVE for %s (tag CI: %s, freeze issue: %s).\n' "$tag" "$verdict" "$issue_state" >&2
  printf '[release-freeze] Merges into main wait until Myrmidon CI is green on %s. See docs/myrmidon/deploy.md (release mode).\n' "$tag" >&2
  exit 1
fi
log "no freeze (tag CI: $verdict, freeze issue: $issue_state) — merges open"
exit 0
