#!/usr/bin/env bash
# scripts/myrmidon/release/publish-github-release.sh
#
# RELEASE-PUBLISH (the 02.10 gap): every myr-vX.Y.Z tag gets its GitHub
# Release automatically. On 02.10 the tag myr-v1.5.0 existed for 40 minutes
# and the board ran 1.5.0, but GitHub still showed 1.4.0 as Latest because
# nobody had run `gh release create` by hand.
#
# RC-VERSIONS (owner requirement, 05.10): release candidate tags
# myr-vX.Y.Z-rc.N go through the same path and are published as a GitHub
# PRE-RELEASE. A publish (rc or final) NEVER moves the GitHub `latest`
# marker: the Latest release is only set by promote-latest.sh, which checks
# that the release is the version actually running on our production board
# before it edits the marker. The final tag myr-vX.Y.Z of the same commit
# publishes the SAME images the rc built — no rebuild.
#
# Called by .github/workflows/myrmidon-release.yml. Inputs:
#   --tag myr-vX.Y.Z | myr-vX.Y.Z-rc.N
#                      the release tag to publish (the workflow passes the
#                      pushed tag, or the tag input of a workflow_dispatch
#                      re-run; the tag must already exist on origin)
#
# Fail-closed and idempotent:
#   1. Resolve the tag's commit (annotated tags dereferenced).
#   2. GATE: require a successful "Myrmidon CI (tag)" run and a successful
#      "Myrmidon image" (board) run for THIS tag (runs are matched by
#      head_branch == the tag). TAG-CI (the 1.6.4 incident): the tag has its
#      own un-cancellable CI run (myrmidon-ci-tag.yml, its own concurrency
#      group with cancel-in-progress: false — a push to main that supersedes
#      the main-branch CI of the same commit can no longer cancel it). The
#      publish takes its green ONLY from the tag's own run: a main-branch
#      run of the same commit never satisfies the gate, and a CANCELLED tag
#      run refuses the publish loudly (an operator cancelling the tag run
#      must not silently fall back to the wait). A failed run (any lane)
#      exits 1 BEFORE anything is published. Dockergate and
#      fleetd are paths-filtered workflows, so their tag run may
#      legitimately be absent — but their digests must exist in the registry
#      (step 3) or the publish is refused (fail-closed, the RELEASE-GATE
#      contract). Runs still in progress are waited for (the image
#      workflows start alongside this workflow on a
#      tag push).
#   3. Build the body with scripts/myrmidon/release/release-body.mjs: the
#      `## X.Y.Z` section of docs/myrmidon/CHANGELOG.md (an rc reads the
#      section of its base version; missing = a release without notes =
#      defect, exit 1), the deploy line + "Upgrading from …" link, and the
#      component digest table from the registry (probed with the tag's own
#      version — the rc tags of the component images, X.Y.Z-rc.N).
#   4. `gh release create` — NEVER --latest, and an rc always goes out as a
#      pre-release; when the release exists, `gh release edit` (idempotent
#      re-run); then the machine-readable manifest (release-components.json:
#      every component digest) is uploaded as a release asset
#      (deploy.sh --release reads it). The `latest` marker moves only via
#      promote-latest.sh, after the release proved itself on our board.
#   5. Mark the previous minor/patch release title "(superseded)" (the manual
#      convention of 1.3.x/1.4.0). Final tags only: an rc supersedes nothing,
#      and a final tag never supersedes its own rc's (a pre-release keeps its
#      title).
#
# Uses only GITHUB_TOKEN (contents: write). Nothing host- or deployment-
# specific enters the body: the public repository rules (CONVENTIONS section
# 9) apply to the body exactly as to a committed file.

set -euo pipefail

usage() {
  sed -n '2,58p' "$0"
  exit 0
}

die() { printf '[myrmidon-release-publish] ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[myrmidon-release-publish] %s\n' "$*" >&2; }

tag=""
while (($#)); do
  case "$1" in
    --tag) tag="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) die "unknown argument: $1" ;;
  esac
done

command -v gh >/dev/null 2>&1 || die "gh is not installed"
command -v jq >/dev/null 2>&1 || die "jq is not installed"

# RC-VERSIONS: the tag is myr-vX.Y.Z or the release candidate myr-vX.Y.Z-rc.N.
[[ "$tag" =~ ^myr-v([0-9]+\.[0-9]+\.[0-9]+)(-rc\.([0-9]+))?$ ]] || die "tag must look like myr-vX.Y.Z or myr-vX.Y.Z-rc.N (got: $tag)"
version="${tag#myr-v}"
base_version="${BASH_REMATCH[1]}"
prerelease=0
title_suffix=""
if [[ -n "${BASH_REMATCH[2]:-}" ]]; then
  prerelease=1
  title_suffix=" (RC ${BASH_REMATCH[3]})"
fi
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ------------------------------------------------------------- 1. the tag ----
ref_json="$(gh api "repos/$repo/git/ref/tags/$tag" 2>/dev/null)" \
  || die "tag $tag not found on origin"
object_type="$(jq -r '.object.type' <<<"$ref_json")"
object_sha="$(jq -r '.object.sha' <<<"$ref_json")"
if [[ "$object_type" == "tag" ]]; then
  # Annotated tag: the ref points at the tag object; dereference to the commit.
  gh api "repos/$repo/git/tags/$object_sha" --jq '.object.sha' > "$here/.tag-commit" 2>/dev/null \
    || die "could not resolve the commit of annotated tag $tag"
  # --jq prints a JSON string: strip the quotes to get the bare sha.
  sha="$(sed -e 's/^"//' -e 's/"$//' "$here/.tag-commit")"
  rm -f "$here/.tag-commit"
else
  sha="$object_sha"
fi
log "tag $tag -> commit $sha"

# ------------------------------------------------------------- 2. CI gate ----
# Completed-run verdict of one workflow for THIS tag: prints "missing"
# when no completed run exists, else the unique conclusion, else "mixed"
# (at least two different conclusions — a failed attempt exists, fail closed).
#
# RELEASE-PUBLISH-WAIT: runs are selected by head_branch == the tag, not just by head_sha.
# The release commit normally lands on main BEFORE the tag is pushed, so the
# API also answers with the main-branch runs of the same commit; those build
# the `main`/`sha-<short>` image tags, not the `myr-vX.Y.Z` version tag this
# release publishes. Matching them made the publish skip the wait (1.6.1:
# the main image run was green, the tag image run was still building, and
# the digest probe then failed with "component image digests missing").
# branch_match_expr <branches...>: a jq expression true when the run's
# head_branch is one of the given values (the tag itself and, where allowed,
# the main branch of the same commit).
branch_match_expr() {
  local list
  list="$(printf '"%s",' "$@" | sed 's/,$//')"
  printf '((.head_branch) as $b | [%s] | index($b) != null)' "$list"
}

# Runs of one workflow for THIS tag (and, optionally, of the same commit from
# other branches such as main — the caller decides which branches count).
runs_of() {
  local workflow_file="$1" branches="$2"
  gh api --paginate "repos/$repo/actions/runs?head_sha=$sha&per_page=100" \
    --jq "[.workflow_runs[]? | select(.path == \"$workflow_file\" and $branches)]" 2>/dev/null || true
}

run_verdict() {
  local workflow_file="$1" branches verdict
  # TAG-CI (the 1.6.4 incident): the release green comes ONLY from the tag's
  # own runs (head_branch == the tag). A green main-branch run of the same
  # commit used to satisfy the CI gate (myrmidon-ci.yml had no tag trigger);
  # myrmidon-ci-tag.yml now runs the full pipeline on the tag itself, so the
  # main fallback is gone — and a push to main can no longer cancel the
  # tag's run (own concurrency group, cancel-in-progress: false).
  branches="$(branch_match_expr "$tag")"
  verdict="$(runs_of "$workflow_file" "$branches" \
    | jq "[.[] | select(.status == \"completed\")]
          | if length == 0 then \"missing\"
             else (map(.conclusion) | unique)
                  | if length == 1 then .[0] else \"mixed\" end end" 2>/dev/null)" \
    || verdict="missing"
  # jq output is a JSON string: strip the quotes to get the bare value.
  printf '%s\n' "${verdict//\"/}"
}

# Status of the newest run (any state) of one workflow for THIS tag.
run_status() {
  local workflow_file="$1" branches status
  branches="$(branch_match_expr "$tag")"
  status="$(runs_of "$workflow_file" "$branches" \
    | jq ".[0].status // \"missing\"" 2>/dev/null)" \
    || status="missing"
  printf '%s\n' "${status//\"/}"
}

# Poll cadence of the gate wait. Overridable for the tests (the default is
# sized for CI: image workflows on a tag push run up to ~40 minutes).
POLL_SECONDS="${MYRMIDON_RELEASE_POLL_SECONDS:-20}"
POLL_MAX="${MYRMIDON_RELEASE_POLL_MAX:-120}"

# wait_for <workflow_file> <must|soft> <label>
#   must — a completed run must exist and be success; a missing/failed run
#          refuses the publish.
#   soft — no completed run is acceptable (paths-filtered); a failed one is
#          not (it means this release's component build broke).
wait_for() {
  local workflow_file="$1" need="$2" label="$3" verdict status polled=0
  while ((1)); do
    verdict="$(run_verdict "$workflow_file")"
    if [[ "$verdict" != "missing" ]]; then
      break
    fi
    status="$(run_status "$workflow_file")"
    if [[ "$status" == "missing" ]]; then
      if [[ "$need" == "soft" ]]; then
        log "gate: no run of $label for $sha (paths-filtered) — accepted"
        return 0
      fi
      if ((polled >= POLL_MAX / 2)); then
        die "no run of $label found for commit $sha after $polled polls — refusing to publish"
      fi
    fi
    ((polled >= POLL_MAX)) && die "timed out waiting for $label runs on $sha after $polled polls"
    sleep "$POLL_SECONDS"
    polled=$((polled+1))
  done
  if [[ "$verdict" != "success" ]]; then
    if [[ "$need" == "must" ]]; then
      die "$label did not succeed for commit $sha (conclusion: $verdict) — NOT publishing. A release whose CI failed must not exist."
    fi
    die "$label failed for commit $sha (conclusion: $verdict) — NOT publishing."
  fi
  log "gate: $label success for $sha"
}

# TAG-CI (the 1.6.4 incident): the tag's own CI run is un-cancellable by
# main pushes, but an operator can still cancel it by hand. A cancelled tag
# run must refuse the publish loudly — never look like "no run yet" and
# fall back into the wait (the wait would time out ~40 minutes later with a
# misleading message).
refuse_if_cancelled() {
  local workflow_file="$1" label="$2" branches cancelled
  branches="$(branch_match_expr "$tag")"
  cancelled="$(runs_of "$workflow_file" "$branches" \
    | jq '[.[] | select(.status == "completed" and .conclusion == "cancelled")] | length' 2>/dev/null)" \
    || cancelled="0"
  cancelled="${cancelled//\"/}"
  [[ "$cancelled" =~ ^[0-9]+$ ]] || cancelled="0"
  if ((cancelled > 0)); then
    die "$label has a CANCELLED run for $sha (tag) — NOT publishing. Re-run Actions → Myrmidon CI (tag) for $tag (workflow_dispatch) and let it complete."
  fi
}

log "gate: Myrmidon CI (tag) on $sha"
refuse_if_cancelled ".github/workflows/myrmidon-ci-tag.yml" "Myrmidon CI (tag)"
wait_for ".github/workflows/myrmidon-ci-tag.yml" must "Myrmidon CI (tag)"
log "gate: Myrmidon image (board) on $sha"
wait_for ".github/workflows/myrmidon-image.yml" must "Myrmidon image (board)"
log "gate: Myrmidon dockergate image on $sha"
wait_for ".github/workflows/myrmidon-dockergate.yml" soft "Myrmidon dockergate image"
log "gate: Myrmidon fleetd image on $sha"
wait_for ".github/workflows/myrmidon-fleetd.yml" soft "Myrmidon fleetd image"

# ------------------------------------------------------ 3. the release body --
# release-body.mjs exits 1 when the CHANGELOG section or any component
# digest is missing — the script then dies before publishing anything.
# --registry-state (offline digest simulation) is for tests; CI resolves the
# digests from the live registry.
# RC-VERSIONS: the digest table and the manifest probe the rc's own image
# tags (X.Y.Z-rc.N — the workflows tag them that way); the CHANGELOG notes
# live under the base version (## X.Y.Z), the same section the final
# myr-vX.Y.Z publishes again from the same commit (no rebuild).
body_args=(--notes-version "$base_version")
if [[ -n "${MYRMIDON_RELEASE_REGISTRY_STATE:-}" ]]; then
  body_args+=(--registry-state "$MYRMIDON_RELEASE_REGISTRY_STATE")
fi
# --manifest-out: the machine-readable component manifest published as a
# release asset (release-components.json); deploy/release-manifest.sh reads it.
body_args+=(--manifest-out release-components.json)
node "$here/release-body.mjs" "${body_args[@]}" "$version" > release-body.md \
  || die "release body could not be built for $version (missing notes or component digests)"
log "release body built ($(wc -c < release-body.md) bytes)"

# ------------------------------------------ 3b. the vendor-share metric -------
# VENDOR-SHARE-METRIC (1.6.5): the share of files inherited from the vendor base
# and its delta to the previous release ride in the notes as the
# `## Vendor-derived files` section (see guides/vendor-share-release-metric.md).
# Advisory only: when the share cannot be computed the section reads
# «не посчитано» and the publish continues — the metric must never break a
# release (OPE-4152 acceptance). The previous release's own notes carry the
# line, so no second checkout is needed; --previous-body is fed from them via
# gh. MYRMIDON_RELEASE_VENDOR_SHARE_STATE (JSON share summary) and
# MYRMIDON_RELEASE_PREVIOUS_BODY (a body file) are the offline seams for tests,
# next to MYRMIDON_RELEASE_REGISTRY_STATE above.
vendor_prev_version="$(node "$here/release-body.mjs" --previous "$base_version" 2>/dev/null || true)"
vendor_prev_tag=""
[[ -n "$vendor_prev_version" ]] && vendor_prev_tag="myr-v$vendor_prev_version"
notes_vendor_section() {
  printf '\n## Vendor-derived files\n\n%s\n' "$1"
}
vendor_prev_body="${MYRMIDON_RELEASE_PREVIOUS_BODY:-}"
if [[ -z "$vendor_prev_body" && -n "$vendor_prev_tag" ]]; then
  vendor_prev_body="$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/vendor-share-prev.XXXXXX.md")"
  gh release view "$vendor_prev_tag" --repo "$repo" --json body --jq '.body' \
    > "$vendor_prev_body" 2>/dev/null || true
fi
vendor_args=()
[[ -n "$vendor_prev_tag" ]] && vendor_args+=(--previous-tag "$vendor_prev_tag")
[[ -n "$vendor_prev_body" ]] && vendor_args+=(--previous-body "$vendor_prev_body")
if vendor_line="$(node "$here/vendor-share-notes.mjs" "${vendor_args[@]}")"; then
  log "vendor-share section: $vendor_line"
else
  vendor_line="не посчитано (the vendor-share metric failed; the release continues)"
  log "vendor-share metric not computed — the notes say «не посчитано»"
fi
notes_vendor_section "$vendor_line" >> release-body.md

# -------------------------------------------------------- 4. publish --------
# RC-VERSIONS: a publish NEVER touches the `latest` marker — that is the
# explicit promote step (promote-latest.sh) after the release proved itself
# on our board. An rc tag always goes out as a pre-release.
title="Myrmidon $version$title_suffix"
prerelease_args=()
((prerelease)) && prerelease_args+=(--prerelease)
if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
  log "release $tag already exists — updating (idempotent re-run, never --latest)"
  gh release edit "$tag" --repo "$repo" --title "$title" "${prerelease_args[@]}" \
    --notes-file release-body.md
else
  gh release create "$tag" --repo "$repo" --title "$title" "${prerelease_args[@]}" \
    --notes-file release-body.md
fi

# The manifest asset: replaced on a re-run (--clobber), so it always matches
# the body of the same publish.
gh release upload "$tag" release-components.json --repo "$repo" --clobber
log "uploaded the component manifest asset release-components.json"

# ONE-COMMAND-INSTALL (1.6.6): the installer of a fresh installation rides with
# every release as the asset `install.sh`, so
# https://github.com/<repo>/releases/latest/download/install.sh always serves the
# installer of the latest release. The same file is committed at
# scripts/myrmidon/install/install.sh (the single source of truth).
installer="$here/../install/install.sh"
[[ -f "$installer" ]] || die "the installer script $installer is missing"
gh release upload "$tag" "$installer#install.sh" --repo "$repo" --clobber
log "uploaded the installer asset install.sh"

# ----------------------------------------------- 5. supersede the previous --
# The manual convention for 1.3.x/1.4.0: the previous minor/patch release's
# title gains "(superseded)". Idempotent: no-op when the marker is already
# there. The previous version is derived from the tag the same way the body
# builder derives it.
# RC-VERSIONS: final tags only. An rc supersedes nothing, and a final tag
# never supersedes its own release candidates — a pre-release keeps its
# title.
if ((prerelease == 0)); then
prev_version="$(node "$here/release-body.mjs" --previous "$base_version")"
if [[ -n "$prev_version" ]]; then
  prev_tag="myr-v$prev_version"
  prev_title="$(gh release view "$prev_tag" --repo "$repo" --json name --jq '.name' 2>/dev/null || true)"
  # RC-VERSIONS: never mark an rc "(superseded)".
  if [[ -n "$prev_title" ]] && [[ "$prev_title" != *"(RC "* ]] && ! grep -qi 'superseded' <<<"$prev_title"; then
    gh release edit "$prev_tag" --repo "$repo" --title "$prev_title (superseded)"
    log "marked $prev_tag title '(superseded)'"
  else
    log "previous release $prev_tag not found, an rc, or already superseded — no rename"
  fi
fi
else
  log "rc publish: no supersede (release candidates never rename other releases)"
fi

log "published release $tag ($title) — body from CHANGELOG section $base_version + digest table (never --latest; promote-latest.sh moves Latest after the release proved itself on our board)"
