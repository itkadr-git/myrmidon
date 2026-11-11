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
#      hindsight-recall-queries.json against the paperclip bank before and
#      after every change (autovacuum reloptions, relink, repack) and prints
#      hit counts + set hashes so two runs can be compared mechanically.
#      A mismatch is a RECALL REGRESSION: stop, investigate, roll back.
#
# READ-ONLY: SELECT against myrmidon-pg, POST recall to the hindsight API,
# nothing is written to the database or the API.
#
# USAGE:
#   hindsight-recall-gate.sh sizes --log /var/log/hindsight-sizes.jsonl \
#       [--pg-container myrmidon-pg] [--pg-user paperclip] [--db myrmidon_hindsight]
#   hindsight-recall-gate.sh recall --api http://127.0.0.1:9425 \
#       [--queries hindsight-recall-queries.json] [--bank default] \
#       [--key "$HINDSIGHT_API_KEY"] [--out gate-result.json]
#
# EXIT: 0 = ok / no regression; 1 = usage error, sizes failure, or recall
# regression (error or empty result on any query).

set -euo pipefail

PG_CONTAINER=myrmidon-pg
PG_USER=paperclip
DB=myrmidon_hindsight
API_URL=
API_KEY=${HINDSIGHT_API_KEY:-}
BANK=default
QUERIES_FILE=$(dirname "$0")/hindsight-recall-queries.json
LOG_FILE=
OUT_FILE=

die() { echo "ERROR: $*" >&2; exit "${2:-1}"; }

json_escape() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }

cmd_sizes() {
  [[ -n "$LOG_FILE" ]] || die "sizes: --log is required" 1
  local sql="SELECT
    now()::text AS ts,
    pg_size_pretty(pg_total_relation_size('memory_units')) AS units_total,
    pg_total_relation_size('memory_units') AS units_bytes,
    pg_total_relation_size('memory_units_toast') AS units_toast_bytes,
    pg_size_pretty(pg_total_relation_size('memory_units_toast')) AS units_toast_total,
    pg_total_relation_size('memory_links') AS links_bytes,
    pg_size_pretty(pg_total_relation_size('memory_links')) AS links_total,
    pg_size_pretty(pg_database_size('myrmidon_hindsight')) AS db_total,
    pg_database_size('myrmidon_hindsight') AS db_bytes;"
  local row
  row=$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$DB" -At -F'|' -c "$sql") \
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
  [[ -f "$QUERIES_FILE" ]] || die "recall: queries file not found: $QUERIES_FILE" 1
  python3 - "$API_URL" "$BANK" "$QUERIES_FILE" "$OUT_FILE" "$API_KEY" <<'PY'
import hashlib, json, sys, urllib.request

api_url, bank, queries_file, out_file, api_key = sys.argv[1:6]
qs = json.load(open(queries_file))
items = qs["queries"] if isinstance(qs, dict) else qs
url = f"{api_url.rstrip('/')}/v1/default/banks/{bank}/memories/recall"
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
out = json.dumps(report, ensure_ascii=False, indent=2)
if out_file:
    open(out_file, "w").write(out)
else:
    print(out)
sys.exit(1 if (failures or any(r["hits"] == 0 for r in results)) else 0)
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
    --out) OUT_FILE=$2; shift 2 ;;
    *) die "unknown argument: $1" 1 ;;
  esac
done

case "${MODE:-}" in
  sizes) cmd_sizes ;;
  recall) cmd_recall ;;
  *) die "usage: hindsight-recall-gate.sh sizes|recall ..." 1 ;;
esac
