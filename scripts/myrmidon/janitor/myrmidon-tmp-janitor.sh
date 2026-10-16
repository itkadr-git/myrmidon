#!/usr/bin/env bash
# Myrmidon /tmp Janitor
# Periodically cleans up abandoned browser profiles, deployment artifacts,
# and test sandboxes from /tmp based on a strict whitelist and TTL.
#
# Whitelist patterns:
#   - chr-* (Chromium agent profiles)
#   - native-* (Native agent run directories)
#   - mdep-* (Deployment artifacts)
#   - myrmidon-install-test-* (Install test sandboxes)
#
# Protected:
#   - claude-* (Live profiles such as claude-1002)
#   - Any directory/file with active open file descriptors (checked via fuser/lsof)
#   - Non-whitelisted items are never touched.

set -euo pipefail

TARGET_DIR="${MYRMIDON_JANITOR_TMP_DIR:-/tmp}"
TTL_MINUTES="${MYRMIDON_JANITOR_TTL_MINUTES:-60}"
DRY_RUN="${MYRMIDON_JANITOR_DRY_RUN:-0}"

log() {
  local level="$1"; shift
  local ts
  ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date +"%Y-%m-%dT%H:%M:%SZ")"
  printf '[%s] [tmp-janitor] [%s] %s\n' "$ts" "$level" "$*"
}

usage() {
  cat <<'EOF'
Usage: myrmidon-tmp-janitor.sh [OPTIONS]

Options:
  --target DIR          Directory to clean (default: /tmp)
  --ttl-minutes MIN     TTL in minutes; older entries are pruned (default: 60)
  --dry-run             Log candidate actions without deleting
  -h, --help            Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGET_DIR="$2"
      shift 2
      ;;
    --ttl-minutes)
      TTL_MINUTES="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ ! -d "$TARGET_DIR" ]]; then
  log "ERROR" "Target directory does not exist: $TARGET_DIR"
  exit 1
fi

# Whitelist glob prefixes
PATTERNS=("chr-*" "native-*" "mdep-*" "myrmidon-install-test-*")

is_whitelisted() {
  local name="$1"
  # Explicit protection against live profiles
  if [[ "$name" == claude-* || "$name" == *claude-1002* ]]; then
    return 1
  fi

  for pattern in "${PATTERNS[@]}"; do
    # shellcheck disable=SC2053
    if [[ "$name" == $pattern ]]; then
      return 0
    fi
  done
  return 1
}

is_in_use() {
  local path="$1"
  if command -v fuser >/dev/null 2>&1; then
    if fuser -s "$path" >/dev/null 2>&1; then
      return 0
    fi
  elif command -v lsof >/dev/null 2>&1; then
    if lsof +D "$path" >/dev/null 2>&1; then
      return 0
    fi
  fi
  return 1
}

is_older_than_ttl() {
  local path="$1"
  local ttl="$2"

  local matched
  matched="$(find "$path" -maxdepth 0 -mmin "+$ttl" 2>/dev/null || true)"
  [[ -n "$matched" ]]
}

log "INFO" "Starting janitor run on $TARGET_DIR (TTL: ${TTL_MINUTES}m, dry-run: $DRY_RUN)"

scanned=0
cleaned=0
skipped_active=0
skipped_young=0

# Iterate through top-level entries in TARGET_DIR matching whitelist patterns
shopt -s nullglob dotglob
candidates=()
for pattern in "${PATTERNS[@]}"; do
  for item in "$TARGET_DIR"/$pattern; do
    candidates+=("$item")
  done
done
shopt -u nullglob dotglob

for item in "${candidates[@]}"; do
  [[ -e "$item" || -L "$item" ]] || continue
  base="$(basename "$item")"
  scanned=$((scanned + 1))

  if ! is_whitelisted "$base"; then
    continue
  fi

  if ! is_older_than_ttl "$item" "$TTL_MINUTES"; then
    skipped_young=$((skipped_young + 1))
    continue
  fi

  if is_in_use "$item"; then
    log "WARN" "Skipping $item (active processes holding open files)"
    skipped_active=$((skipped_active + 1))
    continue
  fi

  size="unknown"
  if command -v du >/dev/null 2>&1; then
    size="$(du -sh "$item" 2>/dev/null | awk '{print $1}' || echo "unknown")"
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "DRY-RUN" "Would remove: $item (size: $size)"
    cleaned=$((cleaned + 1))
  else
    if rm -rf -- "$item" 2>/dev/null; then
      log "CLEANED" "Removed: $item (size: $size)"
      cleaned=$((cleaned + 1))
    else
      log "ERROR" "Failed to remove: $item"
    fi
  fi
done

log "INFO" "Completed run. Scanned: $scanned, cleaned: $cleaned, skipped active: $skipped_active, skipped young: $skipped_young."
exit 0
