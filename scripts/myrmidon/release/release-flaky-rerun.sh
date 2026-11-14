#!/usr/bin/env bash
# Run failed jobs for a release-tag CI run and emit evidence for an audited waiver.
set -euo pipefail
repo="${GITHUB_REPOSITORY:-itkadr-git/myrmidon}"
tag=""
run_id=""
evidence_file=""
dry_run=0
while (($#)); do
  case "$1" in
    --tag) tag="${2:?--tag needs a value}"; shift 2;;
    --run) run_id="${2:?--run needs a value}"; shift 2;;
    --evidence-file) evidence_file="${2:?--evidence-file needs a value}"; shift 2;;
    --repo) repo="${2:?--repo needs a value}"; shift 2;;
    --dry-run) dry_run=1; shift;;
    -h|--help) printf 'Usage: %s --tag TAG [--run ID] [--evidence-file FILE] [--dry-run]\n' "${0##*/}"; exit 0;;
    *) printf 'ERROR: unknown argument: %s\n' "$1" >&2; exit 2;;
  esac
done
[[ -n "$tag" ]] || { printf 'ERROR: --tag is required\n' >&2; exit 2; }
command -v gh >/dev/null || { printf 'ERROR: gh is not installed\n' >&2; exit 1; }
export GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
[[ -n "$GH_TOKEN" ]] || { printf 'ERROR: GitHub token is not set\n' >&2; exit 1; }

if [[ -z "$run_id" ]]; then
  run_id="$(gh api --paginate "repos/$repo/actions/runs?per_page=100" --jq ".workflow_runs[] | select(.head_branch == \"$tag\" and (.path == \".github/workflows/myrmidon-ci-tag.yml\" or .name == \"Myrmidon CI (tag)\")) | select(.conclusion != \"success\") | [.id,.run_number,.head_sha,.status,.conclusion,.run_attempt,.html_url] | @tsv" | head -1 | cut -f1)"
fi
[[ -n "$run_id" ]] || { printf 'ERROR: no failed or incomplete tag run found for %s\n' "$tag" >&2; exit 1; }
run="$(gh api "repos/$repo/actions/runs/$run_id")"
head_sha="$(jq -r '.head_sha' <<<"$run")"
run_number="$(jq -r '.run_number' <<<"$run")"
attempt="$(jq -r '.run_attempt' <<<"$run")"
url="$(jq -r '.html_url' <<<"$run")"
jobs="$(gh api --paginate "repos/$repo/actions/runs/$run_id/jobs?per_page=100" --jq '[.jobs[] | {id,name,status,conclusion,runAttempt: .run_attempt}]')"
dispatched_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
evidence="$(jq -cn --arg tag "$tag" --arg headSha "$head_sha" --arg runId "$run_id" --argjson runNumber "$run_number" --argjson attempt "$attempt" --argjson jobs "$jobs" --arg url "$url" --arg dispatchedAt "$dispatched_at" '{tag,headSha,runId,runNumber,attempt,jobs,url,dispatchedAt}')"
if (( dry_run )); then
  printf '%s\n' "$evidence"
  exit 0
fi
gh run rerun "$run_id" --failed --repo "$repo" >/dev/null
printf '%s\n' "$evidence"
if [[ -n "$evidence_file" ]]; then
  mkdir -p "$(dirname "$evidence_file")"
  printf '%s\n' "$evidence" > "$evidence_file"
fi
