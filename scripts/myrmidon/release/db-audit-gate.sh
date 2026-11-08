#!/usr/bin/env bash
# scripts/myrmidon/release/db-audit-gate.sh
#
# DB-AUDIT-GATE (DB-CARE / DBC-4). The owner decision of 08.10.2026: an audit
# of the board's database is mandatory before the final release, and the audit
# reports of the release build are produced by the datastore-care module
# (GET /api/myrmidon/datastores/board/audit-reports, exported as .md).
#
# This gate reads ONE audit report as JSON and turns its section-6 criteria
# into a release decision, so the check is not "somebody said the database is
# fine" but "these criteria, with these measured values".
#
# For 1.6.5 the gate runs in WARNING mode (the default): findings are printed
# and the release is NOT blocked. The audit of 08.10 was taken by hand and the
# hourly collection ships with this release; blocking a release on a criterion
# nobody has calibrated yet would be a guess. From the next release the same
# script is called with --mode block.
#
# Usage:
#   db-audit-gate.sh --report <report.json> [--mode warn|block] [--strict]
#                    [--max-age-hours 24] [--now <iso-8601>] [--json] [--quiet]
#
# The report file may be: the API answer ({"report": {...}}), the report object
# itself, or an array of reports (the newest generatedAt is used).
#
# Exit codes:
#   0  no blocking finding (warnings may have been printed)
#   1  blocking finding while --mode block
#   2  usage error, or the report file is missing / not JSON, or it has no criteria
set -euo pipefail

MODE="warn"
STRICT="0"
MAX_AGE_HOURS="24"
NOW=""
JSON_OUT="0"
QUIET="0"
REPORT_FILE=""

usage() {
  awk '
    /^# Usage:/ { capture = 1 }
    capture && /^#/ { sub(/^# ?/, ""); print; next }
    capture { exit }
  ' "$0"
}

say() {
  if [[ "$QUIET" != "1" ]]; then
    printf '%s\n' "$*"
  fi
}

die() {
  printf 'db-audit-gate: %s\n' "$*" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --report) REPORT_FILE="${2:-}"; shift 2 ;;
    --report=*) REPORT_FILE="${1#*=}"; shift ;;
    --mode) MODE="${2:-}"; shift 2 ;;
    --mode=*) MODE="${1#*=}"; shift ;;
    --max-age-hours) MAX_AGE_HOURS="${2:-}"; shift 2 ;;
    --max-age-hours=*) MAX_AGE_HOURS="${1#*=}"; shift ;;
    --now) NOW="${2:-}"; shift 2 ;;
    --now=*) NOW="${1#*=}"; shift ;;
    --strict) STRICT="1"; shift ;;
    --json) JSON_OUT="1"; shift ;;
    --quiet) QUIET="1"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

case "$MODE" in
  warn|block) ;;
  *) die "--mode must be warn or block, got: ${MODE}" ;;
esac
[[ -n "$REPORT_FILE" ]] || die "--report <report.json> is required"

command -v jq >/dev/null 2>&1 || die "jq is required"
[[ -f "$REPORT_FILE" ]] || die "report file not found: ${REPORT_FILE}"

if ! jq -e . "$REPORT_FILE" >/dev/null 2>&1; then
  die "report file is not JSON: ${REPORT_FILE}"
fi

# The report may arrive wrapped (`{"report": {...}}`), as an array of reports,
# or as the report object itself.
report=$(jq -c '
  if type == "object" and has("report") then .report
  elif type == "array" then (sort_by(.generatedAt) | last)
  else .
  end
' "$REPORT_FILE")

criteria_count=$(jq -r '(.criteria // []) | length' <<<"$report")
[[ "$criteria_count" != "0" ]] || die "report has no criteria: ${REPORT_FILE}"

generated_at=$(jq -r '.generatedAt // ""' <<<"$report")
target=$(jq -r '.datastoreKey // "board"' <<<"$report")
trigger=$(jq -r '.trigger // "unknown"' <<<"$report")

# Freshness: a report older than the window is a finding of its own — the
# release is being checked against a database that has since moved on.
if [[ -z "$NOW" ]]; then
  now_epoch=$(date -u +%s)
else
  now_epoch=$(date -u -d "$NOW" +%s 2>/dev/null) || die "--now is not an ISO-8601 date: ${NOW}"
fi

age_hours=""
stale="0"
if [[ -z "$generated_at" ]]; then
  stale="1"
  age_hours="unknown"
else
  report_epoch=$(date -u -d "$generated_at" +%s 2>/dev/null) || die "generatedAt is not an ISO-8601 date: ${generated_at}"
  age_seconds=$(( now_epoch - report_epoch ))
  [[ "$age_seconds" -lt 0 ]] && age_seconds=0
  age_hours=$(awk -v s="$age_seconds" 'BEGIN { printf "%.1f", s / 3600 }')
  if awk -v a="$age_hours" -v max="$MAX_AGE_HOURS" 'BEGIN { exit !(a > max) }'; then
    stale="1"
  fi
fi

fail_count=$(jq '[.criteria[] | select(.verdict == "fail")] | length' <<<"$report")
warn_count=$(jq '[.criteria[] | select(.verdict == "warn")] | length' <<<"$report")
unknown_count=$(jq '[.criteria[] | select(.verdict == "unknown")] | length' <<<"$report")
ok_count=$(jq '[.criteria[] | select(.verdict == "ok")] | length' <<<"$report")
worst=$(jq -r '.summary.worst // "unknown"' <<<"$report")

blocking=0
if [[ "$fail_count" -gt 0 ]]; then
  blocking=1
fi
if [[ "$stale" == "1" ]]; then
  blocking=1
fi
if [[ "$STRICT" == "1" && "$warn_count" -gt 0 ]]; then
  blocking=1
fi

say "db-audit-gate: target=${target} trigger=${trigger} generated=${generated_at:-none} age=${age_hours}h worst=${worst}"
say "db-audit-gate: criteria ok=${ok_count} warn=${warn_count} fail=${fail_count} unknown=${unknown_count}"

jq -r '.criteria[] | select(.verdict == "fail") | "db-audit-gate: FAIL \(.id): \(.value) (threshold \(.threshold))"' <<<"$report" | while read -r line; do say "$line"; done
jq -r '.criteria[] | select(.verdict == "warn") | "db-audit-gate: WARN \(.id): \(.value) (threshold \(.threshold))"' <<<"$report" | while read -r line; do say "$line"; done
jq -r '.criteria[] | select(.verdict == "unknown") | "db-audit-gate: NOTE \(.id): no value yet (\(.source))"' <<<"$report" | while read -r line; do say "$line"; done

if [[ "$stale" == "1" ]]; then
  say "db-audit-gate: STALE the report is older than ${MAX_AGE_HOURS}h (age ${age_hours}h) — the audit does not describe the database being released"
fi

print_json() {
  if [[ "$JSON_OUT" != "1" ]]; then
    return 0
  fi
  jq -c -n \
    --arg mode "$MODE" --arg target "$target" --arg trigger "$trigger" \
    --arg generatedAt "$generated_at" --arg ageHours "$age_hours" \
    --argjson ok "$ok_count" --argjson warn "$warn_count" --argjson fail "$fail_count" \
    --argjson unknown "$unknown_count" --argjson stale "$stale" \
    --argjson strict "$STRICT" --argjson blocking "$blocking" \
    '{mode: $mode, target: $target, trigger: $trigger, generatedAt: $generatedAt, ageHours: $ageHours,
      counts: {ok: $ok, warn: $warn, fail: $fail, unknown: $unknown},
      stale: ($stale == 1), strict: ($strict == 1), blocking: ($blocking == 1)}'
}

if [[ "$MODE" == "warn" ]]; then
  if [[ "$blocking" == "1" ]]; then
    say "db-audit-gate: WARNING MODE (1.6.5) — ${fail_count} failing criteria, stale=${stale}, release NOT blocked; fix before the next release"
  else
    say "db-audit-gate: WARNING MODE (1.6.5) — no blocking finding"
  fi
  print_json
  exit 0
fi

if [[ "$blocking" == "1" ]]; then
  printf 'db-audit-gate: BLOCKED — the audit of %s does not pass (fail=%s stale=%s strict=%s)\n' \
    "${target}" "$fail_count" "$stale" "$STRICT" >&2
  print_json
  exit 1
fi

say "db-audit-gate: OK — the audit of ${target} passes"
print_json
exit 0