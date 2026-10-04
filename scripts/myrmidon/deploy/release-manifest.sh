#!/usr/bin/env bash
# scripts/myrmidon/deploy/release-manifest.sh
#
# ONE-DEPLOY: reads the component digests of a release, so one deploy can
# update every component from the same source of truth. Read-only.
#
#   release-manifest.sh --tag myr-vX.Y.Z      read the release from GitHub
#   release-manifest.sh --from-file <file>    read a manifest file (an offline
#                                             copy of the release asset)
#
# Source, strongest first:
#   1. the release asset release-components.json (machine-readable, written by
#      the release publish step: scripts/myrmidon/release/publish-github-release.sh);
#   2. the "Component images (digests)" table of the release body, for a
#      release published before the manifest existed.
#
# Prints one line per component found:
#
#   board=sha256:<64 hex>
#   dockergate=sha256:<64 hex>
#   fleetd=sha256:<64 hex>
#   hermes=sha256:<64 hex>          the default bot image
#   hermes-dev=sha256:<64 hex>      only when the release has it
#   hermes-node=sha256:<64 hex>     only when the release has it
#
# Exit 1 with a reason on stderr when the release cannot be read, names a
# repository other than the fixed CI repository of the component, or a digest
# is malformed. A component that is missing is NOT reported here: the caller
# (deploy.sh) decides which components its release must have.
#
# Settings (environment): MYRMIDON_RELEASE_REPO (default itkadr-git/myrmidon),
# MYRMIDON_RELEASE_API_URL (default https://api.github.com),
# MYRMIDON_RELEASE_TOKEN_FILE (optional bearer token file for a private
# repository; the token is never printed).
set -euo pipefail

log() { printf '[myrmidon-release-manifest] %s\n' "$*" >&2; }
die() { printf '[myrmidon-release-manifest] ERROR: %s\n' "$*" >&2; exit 1; }

tag="" file=""
while (($#)); do
  case "$1" in
    --tag) tag="$2"; shift 2 ;;
    --from-file) file="$2"; shift 2 ;;
    -h|--help) sed -n '2,33p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n "$tag" || -n "$file" ]] || die "give --tag or --from-file"
[[ -z "$tag" || -z "$file" ]] || die "give --tag or --from-file, not both"
command -v jq >/dev/null 2>&1 || die "jq is not installed"

# name -> fixed repository (the same CI repositories as the component scripts).
declare -A REPOSITORIES=(
  [board]="ghcr.io/itkadr-git/myrmidon"
  [dockergate]="ghcr.io/itkadr-git/myrmidon-dockergate"
  [fleetd]="ghcr.io/itkadr-git/myrmidon-fleetd"
  [hermes]="ghcr.io/itkadr-git/myrmidon-hermes"
  [hermes-dev]="ghcr.io/itkadr-git/myrmidon-hermes-dev"
  [hermes-node]="ghcr.io/itkadr-git/myrmidon-hermes-node"
)
ORDER=(board dockergate fleetd hermes hermes-dev hermes-node)

manifest=""
body=""

fetch() {
  local url="$1" accept="${2:-application/vnd.github+json}"
  local -a auth=()
  if [[ -n "${MYRMIDON_RELEASE_TOKEN_FILE:-}" ]]; then
    [[ -r "$MYRMIDON_RELEASE_TOKEN_FILE" ]] || die "token file not readable: $MYRMIDON_RELEASE_TOKEN_FILE"
    auth=(-H "Authorization: Bearer $(tr -d '[:space:]' <"$MYRMIDON_RELEASE_TOKEN_FILE")")
  fi
  curl -fsSL --max-time 30 -H "Accept: $accept" "${auth[@]}" "$url"
}

if [[ -n "$file" ]]; then
  [[ -f "$file" ]] || die "manifest file not found: $file"
  manifest="$(cat "$file")"
else
  [[ "$tag" =~ ^myr-v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "tag must look like myr-vX.Y.Z (got: $tag)"
  api="${MYRMIDON_RELEASE_API_URL:-https://api.github.com}"
  repo="${MYRMIDON_RELEASE_REPO:-itkadr-git/myrmidon}"
  release="$(fetch "$api/repos/$repo/releases/tags/$tag")" \
    || die "cannot read release $tag of $repo (is it published?)"
  jq -e . >/dev/null 2>&1 <<<"$release" || die "release $tag: the answer is not JSON"
  asset_url="$(jq -r 'first(.assets[]? | select(.name == "release-components.json") | .url) // empty' <<<"$release" 2>/dev/null || true)"
  if [[ -n "$asset_url" ]]; then
    manifest="$(fetch "$asset_url" application/octet-stream)" \
      || die "cannot download the manifest asset of release $tag"
  else
    body="$(jq -r '.body // empty' <<<"$release" 2>/dev/null || true)"
    [[ -n "$body" ]] || die "release $tag has neither a release-components.json asset nor a body"
    log "release $tag has no manifest asset; reading the digest table of its body"
  fi
fi

# One "name repository digest" triple per line, from the manifest or the table.
triples=""
if [[ -n "$manifest" ]]; then
  jq -e '.schema == 1 and (.components | type == "object")' >/dev/null 2>&1 <<<"$manifest" \
    || die "the manifest is not a schema 1 release manifest"
  triples="$(jq -r '.components | to_entries[] | "\(.key) \(.value.repository) \(.value.digest)"' <<<"$manifest")"
else
  # | board | `ghcr.io/itkadr-git/myrmidon@sha256:...` |   (the `bot` row is hermes)
  triples="$(sed -nE 's/^\|[[:space:]]*([a-z-]+)[[:space:]]*\|[[:space:]]*`([^`@]+)@(sha256:[0-9a-f]{64})`[[:space:]]*\|.*/\1 \2 \3/p' <<<"$body" | sed -E 's/^bot /hermes /')"
fi
[[ -n "$triples" ]] || die "no component digests found"

declare -A FOUND=()
while read -r name repository digest; do
  [[ -n "$name" ]] || continue
  [[ -n "${REPOSITORIES[$name]:-}" ]] || { log "ignoring unknown component '$name'"; continue; }
  [[ "$repository" == "${REPOSITORIES[$name]}" ]] \
    || die "component $name names repository '$repository'; only ${REPOSITORIES[$name]} is deployed"
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die "component $name has a malformed digest: $digest"
  FOUND["$name"]="$digest"
done <<<"$triples"

for name in "${ORDER[@]}"; do
  [[ -n "${FOUND[$name]:-}" ]] && printf '%s=%s\n' "$name" "${FOUND[$name]}"
done
exit 0
