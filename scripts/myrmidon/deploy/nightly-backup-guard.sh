#!/usr/bin/env bash
set -euo pipefail
# Both remote commands have to succeed; ';' alone would hide the first failure.
archives=$(runuser -u openclaw-adm2 -- ssh -o BatchMode=yes hostkey-dedik 'sudo pvesm list pbs-offsite --vmid 100') || { echo 'PBS query failed: archives' >&2; exit 1; }
tasks=$(runuser -u openclaw-adm2 -- ssh -o BatchMode=yes hostkey-dedik 'sudo pvesh get /nodes/hk01/tasks --typefilter vzdump --limit 3 --output-format json') || { echo 'PBS query failed: tasks' >&2; exit 1; }
printf '%s\n' "$archives" | python3 "$(dirname "$0")/nightly-backup-guard.py" "$tasks"
