#!/usr/bin/env bash
# scripts/myrmidon/deploy/hindsight-recall-gate.sh
#
# OPE-12680: the acceptance gate for the hindsight DB-growth work.
#
# Two jobs, both read-only:
#   1. SIZES SNAPSHOT — appends one JSON line to a file with
#      pg_total_relation_size() for memory_units (+TOAST) and memory_links.
#      Run it daily (cron) before and after the change; the growth criterion
#      is < 200 MB/day across 3 consecutive days (OPE-12680 acceptance).
#   2. RECALL GATE — replays the 10 canonical queries from
#      hindsight-recall-queries.json against ONE bank (--bank is required: the
#      growth sits in the big banks, e.g. adm / bbq) before and after every
#      change (autovacuum reloptions, relink, repack) and prints hit counts +
#      set hashes so two runs can be compared mechanically (the sha16 can
#      legitimately differ when the bank received new facts in between; hits
#      dropping to 0 is the regression signal the exit code reports).
#      A mismatch is a RECALL REGRESSION: stop, investigate, roll back.
#
# NO WRITES of its own: SELECT of pg_*_size() against myrmidon-pg and POST
# recall to the hindsight API. (Recall itself bumps the access counters the
# API maintains on the facts it returns; ten queries are noise next to the
# traffic of the bank.)
#
# USAGE:
#   hindsight-recall-gate.sh sizes --log /var/log/hindsight-sizes.jsonl \
#       [--pg-container myrmidon-pg] [--pg-user paperclip] [--db myrmidon_hindsight]
#   hindsight-recall-gate.sh recall --api http://127.0.0.1:8890 --bank adm \
#       [--queries hindsight-recall-queries.json] \
#       [--baseline baseline-result.json] [--key "$HINDSIGHT_API_KEY"] [--out gate-result.json]
# The board role (paperclip) is enough for `sizes`: pg_total_relation_size()
# needs no privilege on the table. On vm-core docker needs root:
#   DOCKER="sudo docker" hindsight-recall-gate.sh sizes ...
#
# EXIT: 0 = ok / no regression; 1 = usage error, sizes failure, or recall
# regression (error or empty result on any query, a baseline hit-count drop, or
# a query file that still holds the <fill: ...> placeholders).

set -euo pipefail

DOCKER=${DOCKER:-docker}
PG_CONTAINER=myrmidon-pg
PG_USER=paperclip
DB=myrmidon_hindsight
API_URL=
API_KEY=${HINDSIGHT_API_KEY:-}
BANK=
QUERIES_FILE=$(dirname "$0")/hindsight-recall-queries.json
BASELINE_FILE=
LOG_FILE=
OUT_FILE=

die() { echo "ERROR: $1" >&2; exit "${2:-1}"; }

cmd_sizes() {
  [[ -n "$LOG_FILE" ]] || die "sizes: --log is required" 1
  # The TOAST table of memory_units is pg_toast.pg_toast_<oid>, not a relation
  # named after the table: it is reached through pg_class.reltoastrelid, by oid
  # (pg_total_relation_size(oid) needs no access to the pg_toast schema).
  local sql="SELECT
    now()::text AS ts,
    pg_size_pretty(pg_total_relation_size('memory_units')) AS units_total,
    pg_total_relation_size('memory_units') AS units_bytes,
    COALESCE(pg_total_relation_size(
      (SELECT reltoastrelid FROM pg_class WHERE oid = 'memory_units'::regclass)), 0) AS units_toast_bytes,
    pg_size_pretty(COALESCE(pg_total_relation_size(
      (SELECT reltoastrelid FROM pg_class WHERE oid = 'memory_units'::regclass)), 0)) AS units_toast_total,
    pg_total_relation_size('memory_links') AS links_bytes,
    pg_size_pretty(pg_total_relation_size('memory_links')) AS links_total,
    pg_size_pretty(pg_database_size(current_database())) AS db_total,
    pg_database_size(current_database()) AS db_bytes;"
  local row
  # PGOPTIONS: a hung query must not sit in the database shared with the board.
  # shellcheck disable=SC2086 # DOCKER may be "sudo docker"
  row=$($DOCKER exec -e PGOPTIONS='-c statement_timeout=30000' "$PG_CONTAINER" \
    psql -U "$PG_USER" -d "$DB" -At -F'|' -c "$sql") \
    || die "sizes: psql failed" 2
  local IFS='|'
  read -r ts units_total units_bytes units_toast_bytes units_toast_total links_bytes links_total db_total db_bytes <<<"$row"
  local line
  line=$(printf '{"ts":"%s","units_total":"%s","units_bytes":%s,"units_toast_bytes":%s,"units_toast_total":"%s","links_bytes":%s,"links_total":"%s","db_total":"%s","db_bytes":%s}' \
    "$ts" "$units_total" "$units_bytes" "$units_toast_bytes" "$units_toast_total" "$links_bytes" "$links_total" "$db_total" "$db_bytes")
  echo "$line" | tee -a "$LOG_FILE"
  # growth since the previous line, if any
  if [[ -f "$LOG_FILE" ]] && [[ $(wc -l < "$LOG_FILE") -ge 2 ]]; then
    python3 - "$LOG_FILE" <<'PY'
import json, sys
lines = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
if len(lines) >= 2:
    a, b = lines[-2], lines[-1]
    import datetime as dt
    t = lambda r: dt.datetime.fromisoformat(r["ts"])
    days = max((t(b) - t(a)).total_seconds() / 86400, 1e-9)
    g_units = (b["units_bytes"] - a["units_bytes"]) / days / 1024**2
    g_links = (b["links_bytes"] - a["links_bytes"]) / days / 1024**2
    g_db = (b.get("db_bytes", 0) - a.get("db_bytes", 0)) / days / 1024**2
    print(f"growth/day: units {g_units:.1f} MB, links {g_links:.1f} MB, db {g_db:.1f} MB (acceptance: < 200 MB/day)")
PY
  fi
}

cmd_recall() {
  [[ -n "$API_URL" ]] || die "recall: --api is required" 1
  [[ -n "$BANK" ]] || die "recall: --bank is required (the hindsight bank to replay against, e.g. adm)" 1
  [[ -f "$QUERIES_FILE" ]] || die "recall: queries file not found: $QUERIES_FILE" 1
  # The key goes through the environment, not argv (visible in ps).
  # The baseline is optional; without it this run is a snapshot for the first comparison.
  HINDSIGHT_GATE_KEY="$API_KEY" python3 - "$API_URL" "$BANK" "$QUERIES_FILE" "$BASELINE_FILE" "$OUT_FILE" <<'PY'
import hashlib, json, os, sys, urllib.parse, urllib.request

api_url, bank, queries_file, baseline_file, out_file = sys.argv[1:6]
api_key = os.environ.get("HINDSIGHT_GATE_KEY", "")
qs = json.load(open(queries_file))
items = qs["queries"] if isinstance(qs, dict) else qs
# A baseline taken on the unfilled template compares nothing: refuse it.
unfilled = [q.get("name", "?") if isinstance(q, dict) else str(q)
            for q in items
            if "<fill:" in (q.get("query", "") if isinstance(q, dict) else str(q))]
if unfilled:
    print("ERROR: " + queries_file + " still holds <fill: ...> placeholders: " + ", ".join(unfilled))
    sys.exit(1)
url = f"{api_url.rstrip('/')}/v1/default/banks/{urllib.parse.quote(bank, safe='')}/memories/recall"
results, failures = [], 0
for q in items:
    name, text = (q["name"], q["query"]) if isinstance(q, dict) else (q, q)
    body = json.dumps({"query": text, "budget": "mid", "max_tokens": 1024}).encode()
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    if api_key:
        req.add_header("Authorization", "Bearer " + api_key)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            payload = json.loads(r.read().decode())
        texts = [m.get("text", "") for m in (payload.get("results") or [])]
    except Exception as e:
        print(f"FAIL {name}: {e}")
        failures += 1
        texts = []
    h = hashlib.sha256("\n".join(texts).encode()).hexdigest()[:16]
    print(f"{name}: hits={len(texts)} sha16={h}")
    results.append({"name": name, "hits": len(texts), "sha16": h})
report = {"bank": bank, "queries": results, "failures": failures}
regressions = []
if baseline_file:
    try:
        baseline = json.load(open(baseline_file))
        baseline_by_name = {r["name"]: r for r in baseline.get("queries", [])}
        for result in results:
            before = baseline_by_name.get(result["name"])
            if before is None:
                regressions.append(f"{result['name']}: missing from baseline")
            elif result["hits"] < before.get("hits", 0):
                regressions.append(f"{result['name']}: hits {result['hits']} < baseline {before.get('hits', 0)}")
        report["baseline"] = baseline_file
        report["regressions"] = regressions
    except (OSError, json.JSONDecodeError, TypeError, KeyError) as e:
        print(f"ERROR: invalid baseline {baseline_file}: {e}", file=sys.stderr)
        sys.exit(1)
report["regressions"] = regressions
out = json.dumps(report, ensure_ascii=False, indent=2)
if out_file:
    open(out_file, "w").write(out)
else:
    print(out)
sys.exit(1 if (failures or any(r["hits"] == 0 for r in results) or regressions) else 0)
PY
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    sizes) MODE=sizes; shift ;;
    recall) MODE=recall; shift ;;
    --pg-container) PG_CONTAINER=$2; shift 2 ;;
    --pg-user) PG_USER=$2; shift 2 ;;
    --db) DB=$2; shift 2 ;;
    --log) LOG_FILE=$2; shift 2 ;;
    --api) API_URL=$2; shift 2 ;;
    --bank) BANK=$2; shift 2 ;;
    --key) API_KEY=$2; shift 2 ;;
    --queries) QUERIES_FILE=$2; shift 2 ;;
    --baseline) BASELINE_FILE=$2; shift 2 ;;
    --out) OUT_FILE=$2; shift 2 ;;
    *) die "unknown argument: $1" 1 ;;
  esac
done

case "${MODE:-}" in
  sizes) cmd_sizes ;;
  recall) cmd_recall ;;
  *) die "usage: hindsight-recall-gate.sh sizes|recall ..." 1 ;;
esac
