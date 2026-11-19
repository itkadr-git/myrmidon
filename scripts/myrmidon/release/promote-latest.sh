#!/usr/bin/env bash
# scripts/myrmidon/release/promote-latest.sh
#
# RC-VERSIONS (owner requirement, 05.10): the GitHub `latest` marker is a
# DECISION, not a side effect of the publish. A release becomes Latest only
# after the version is rolled out on our production board and its work is
# verified there (health, attention list, the fleet taking tasks, bot
# images) and judged "годно". publish-github-release.sh never moves the
# marker; this script is the only way to move it.
#
# Before moving Latest, run verify-on-prod.mjs and pass its JSON report:
#   --verify-on-prod-report <report.json>   (REQUIRED)
#
# The report binds the production version to every task carrying the release
# label. Latest cannot move on a health check alone: every release task must
# be verified there first. --skip-health-check is a rehearsal-only escape
# hatch for the health poll; it never bypasses the report requirement.

set -euo pipefail

die() { printf '[myrmidon-promote-latest] ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[myrmidon-promote-latest] %s\n' "$*" >&2; }

tag="" health_url="" health_token_file="" verify_report="" skip_health=0
while (($#)); do
  case "$1" in
    --tag) tag="$2"; shift 2 ;;
    --health-url) health_url="$2"; shift 2 ;;
    --health-token-file) health_token_file="$2"; shift 2 ;;
    --verify-on-prod-report) verify_report="$2"; shift 2 ;;
    --skip-health-check) skip_health=1; shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
  esac
done

command -v gh >/dev/null 2>&1 || die "gh is not installed"
command -v jq >/dev/null 2>&1 || die "jq is not installed"

if [[ ! "$tag" =~ ^myr-v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  die "only a final release tag myr-vX.Y.Z can be promoted to Latest (got: $tag); a release candidate myr-vX.Y.Z-rc.N is the trial run — cut the final tag of the same commit first"
fi

if [[ -n "$verify_report" ]]; then
  [[ -f "$verify_report" ]] || die "VERIFY-ON-PROD report not found: $verify_report"
  jq -e --arg version "${tag#myr-v}" \
    '.verified == true and .version == $version and ((.tasks // []) | length > 0) and all(.tasks[]; .verified == true)' \
    "$verify_report" >/dev/null \
    || die "VERIFY-ON-PROD report is not a passing report for ${tag#myr-v} with every release task verified"
  log "VERIFY-ON-PROD report accepted: $verify_report"
else
  die "--verify-on-prod-report is required: Latest cannot move without per-task production verification"
fi

version="${tag#myr-v}"
repo="${GITHUB_REPOSITORY:-itkadr-git/myrmidon}"

# 2. the release exists and is not a pre-release.
release_json="$(gh release view "$tag" --repo "$repo" --json isPrerelease,isLatest 2>/dev/null)" \
  || die "release $tag not found in $repo (publish it first: the tag push runs scripts/myrmidon/release/publish-github-release.sh)"
[[ "$(jq -r '.isPrerelease' <<<"$release_json")" == "false" ]] \
  || die "release $tag is a pre-release; only a final release can be Latest"
if [[ "$(jq -r '.isLatest' <<<"$release_json")" == "true" ]]; then
  log "release $tag is already Latest — nothing to do"
  exit 0
fi

# 3. the release commit is on origin/main (the tag object dereferences to it).
ref_json="$(gh api "repos/$repo/git/ref/tags/$tag" 2>/dev/null)" || die "tag $tag not found on origin"
object_type="$(jq -r '.object.type' <<<"$ref_json")"
object_sha="$(jq -r '.object.sha' <<<"$ref_json")"
if [[ "$object_type" == "tag" ]]; then
  sha="$(gh api "repos/$repo/git/tags/$object_sha" --jq '.object.sha' 2>/dev/null)" \
    || die "could not resolve the commit of annotated tag $tag"
  sha="${sha//\"/}"
else
  sha="$object_sha"
fi
[[ "$(gh api "repos/$repo/commits/$sha/branches-where-head" --jq 'length' 2>/dev/null || echo 0)" != "0" || -n "$sha" ]] || die "tag $tag has no commit"
if ! gh api "repos/$repo/compare/main...$sha" --jq '.status' >/dev/null 2>&1; then
  die "cannot compare $sha with main (no network or no access?)"
fi
status="$(gh api "repos/$repo/compare/main...$sha" --jq '.status')"
ahead_by="$(gh api "repos/$repo/compare/main...$sha" --jq '.ahead_by')"
# The release commit must not sit BEHIND main on a side line: main must be
# able to reach it (it is an ancestor of main, or main IS at it).
if [[ "$status" != "identical" && "$status" != "behind" ]]; then
  # "behind" here means $sha is behind main, i.e. an ancestor of main — good.
  die "commit ${sha:0:12} of $tag is not on main (compare status: $status, ahead_by $ahead_by) — a release tag of a side branch never becomes Latest"
fi
log "tag $tag -> commit $sha (on main)"

# 4. the production board runs EXACTLY this version.
health_url="${health_url:-${MYRMIDON_PROD_HEALTH_URL:-${HEALTH_URL:-}}}"
health_token_file="${health_token_file:-${MYRMIDON_PROD_HEALTH_TOKEN_FILE:-${HEALTH_TOKEN_FILE:-}}}"
if ((skip_health)); then
  log "WARNING: --skip-health-check: the board-version proof is skipped (a rehearsed promotion only); the marker moves without evidence that $version runs on our production"
else
  [[ -n "$health_url" ]] \
    || die "no production board health URL: pass --health-url or set MYRMIDON_PROD_HEALTH_URL / HEALTH_URL (the promote refuses to move Latest without proof the board runs $version)"
  auth=()
  if [[ -n "$health_token_file" ]]; then
    [[ -r "$health_token_file" ]] || die "health token file not readable: $health_token_file"
    token="$(tr -d '[:space:]' <"$health_token_file")"
    [[ -n "$token" ]] || die "health token file is empty: $health_token_file"
    # Two separate curl arguments: the flag, then the whole header value.
    auth=(-H "Authorization: Bearer ${token}")
  fi
  # ${auth[@]+...}: an empty array must expand to nothing under `set -u`.
  body="$(curl -fsS --max-time 30 ${auth[@]+"${auth[@]}"} "$health_url")" \
    || die "the production board health endpoint $health_url is unreadable — refusing to move Latest without proof the board runs $version"
  [[ "$(jq -r '.status // empty' <<<"$body")" == "ok" ]] \
    || die "the production board does not report status ok ($health_url) — refusing to move Latest"
  board_version="$(jq -r '.version // empty' <<<"$body")"
  [[ -n "$board_version" ]] \
    || die "the production board reports no version (authenticated mode hides it from anonymous callers) — pass --health-token-file with a board API key"
  [[ "$board_version" == "$version" ]] \
    || die "the production board runs version $board_version, not $version — Latest is refused until the board runs this release (deploy it: scripts/myrmidon/deploy/deploy.sh --release $tag, then verify)"
  log "production board verified: $health_url reports version $board_version, status ok"
fi

gh release edit "$tag" --repo "$repo" --latest
log "release $tag (Myrmidon $version) is now the Latest release — it is the version running on our production board"
