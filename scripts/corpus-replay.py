#!/usr/bin/env python3
"""Offline replay of sanitized bot queries against the company corpus MCP endpoint.

Input JSONL fields: ts (timezone-aware ISO-8601), bot_id, dataset (corpus dataset
id), query, ragflow_ids (ordered IDs), ragflow_latency_ms. This tool does not
fetch logs or call RAGFlow; provide its recorded output to ensure a repeatable,
non-destructive comparison. Run after CORPUS-IMPORT with the same dataset IDs.
"""
from __future__ import annotations
import argparse
import datetime as dt
import json
import math
import os
import statistics
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


def parse_time(value: str) -> dt.datetime:
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamps must include a timezone")
    return parsed.astimezone(dt.timezone.utc)


def percentile(values: list[float], p: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    rank = (len(ordered) - 1) * p
    lo, hi = math.floor(rank), math.ceil(rank)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (rank - lo)


def load_rows(path: Path, since: dt.datetime, until: dt.datetime) -> list[dict[str, Any]]:
    rows = []
    with path.open(encoding="utf-8") as stream:
        for line, text in enumerate(stream, 1):
            if not text.strip():
                continue
            row = json.loads(text)
            required = ("ts", "bot_id", "dataset", "query", "ragflow_ids", "ragflow_latency_ms")
            missing = [key for key in required if key not in row]
            if missing:
                raise ValueError(f"line {line}: missing {', '.join(missing)}")
            if not isinstance(row["ragflow_ids"], list) or not all(isinstance(x, str) for x in row["ragflow_ids"]):
                raise ValueError(f"line {line}: ragflow_ids must be a string array")
            if not isinstance(row["ragflow_latency_ms"], (int, float)) or row["ragflow_latency_ms"] < 0:
                raise ValueError(f"line {line}: ragflow_latency_ms must be nonnegative")
            stamp = parse_time(str(row["ts"]))
            if since <= stamp < until:
                rows.append(row)
    return rows


def corpus_search(api: str, token: str, company_id: str, dataset: str, query: str, timeout: float) -> tuple[list[str], float]:
    from time import perf_counter
    endpoint = f"{api.rstrip('/')}/api/myrmidon/companies/{company_id}/corpus/mcp"
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
        "name": "corpus_search", "arguments": {"dataset": dataset, "query": query, "top_k": 10},
    }}).encode()
    req = urllib.request.Request(endpoint, body, headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
    }, method="POST")
    started = perf_counter()
    with urllib.request.urlopen(req, timeout=timeout) as response:
        envelope = json.load(response)
    latency = (perf_counter() - started) * 1000
    result = envelope.get("result") or {}
    structured = result.get("structuredContent")
    if result.get("isError") or not isinstance(structured, dict):
        raise ValueError("corpus MCP returned an error or no structuredContent")
    hits = structured.get("hits")
    if not isinstance(hits, list):
        raise ValueError("corpus MCP response has no hits array")
    ids = [hit.get("chunkId") for hit in hits if isinstance(hit, dict) and isinstance(hit.get("chunkId"), str)]
    return ids, latency


def aggregate(live: list[dict[str, Any]], replayed: list[dict[str, Any]], source: str | None, window: dict[str, str]) -> dict[str, Any]:
    overlaps = [len(set(row["ragflow_ids"][:5]) & set(row["module_ids"][:5])) for row in replayed]
    valid_latency = [float(row["module_latency_ms"]) for row in replayed if row.get("module_latency_ms") is not None]
    total = len(replayed)
    metrics = {
        "top5_overlap_mean_ids": statistics.mean(overlaps) if overlaps else None,
        "top5_overlap_fraction_of_five": statistics.mean(overlaps) / 5 if overlaps else None,
        "ragflow_empty_rate": sum(not row["ragflow_ids"] for row in live) / len(live) if live else None,
        "module_empty_rate": sum(not row["module_ids"] for row in replayed) / total if total else None,
        "module_error_rate": sum("module_error" in row for row in replayed) / total if total else None,
        "ragflow_p95_ms": percentile([float(row["ragflow_latency_ms"]) for row in live], .95),
        "module_p95_ms": percentile(valid_latency, .95),
    }
    return {
        "live_source": source,
        "window_utc": window,
        "live_query_count": len(live),
        "replayed_count": total,
        "metrics": metrics,
        "golden_set": {"status": "not_run", "source": "OPE-5002/OPE-5789 external golden corpus-pilot/quality/golden; run separately against both backends"},
        "recommendation": "NO-GO: this script only replays live rows. Run both 70-question golden sets through RAGFlow and Myrmidon, and review overlap/empty-rate/p95 before switching.",
        "records": replayed,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--api", default="http://localhost:3100")
    parser.add_argument("--company-id", required=True)
    parser.add_argument("--since", required=True)
    parser.add_argument("--until", required=True)
    parser.add_argument("--timeout", type=float, default=30)
    parser.add_argument("--live-source", help="provenance for the sanitized RAGFlow query export")
    args = parser.parse_args()
    since, until = parse_time(args.since), parse_time(args.until)
    if until <= since:
        parser.error("--until must be later than --since")
    token = os.environ.get("CORPUS_REPLAY_TOKEN")
    if not token:
        parser.error("set CORPUS_REPLAY_TOKEN to the corpus MCP bearer token")
    live = load_rows(args.input, since, until)
    records = []
    for row in live:
        try:
            module_ids, latency = corpus_search(args.api, token, args.company_id, str(row["dataset"]), row["query"], args.timeout)
            records.append({**row, "module_ids": module_ids, "module_latency_ms": latency})
        except (urllib.error.URLError, TimeoutError, ValueError) as error:
            records.append({**row, "module_ids": [], "module_latency_ms": None, "module_error": type(error).__name__})

    overlaps = [len(set(row["ragflow_ids"][:5]) & set(row["module_ids"][:5])) for row in records]
    valid_latency = [r["module_latency_ms"] for r in records if r["module_latency_ms"] is not None]
    report = {
        "live_source": args.live_source,
        "window_utc": {"since": args.since, "until": args.until},
        "live_query_count": len(live),
        "replayed_count": len(records),
        "metrics": {
            "top5_overlap_mean_ids": statistics.mean(overlaps) if overlaps else None,
            "top5_overlap_fraction_of_five": statistics.mean(overlaps) / 5 if overlaps else None,
            "ragflow_empty_rate": sum(not r["ragflow_ids"] for r in live) / len(live) if live else None,
            "module_empty_rate": sum(not r["module_ids"] for r in records) / len(records) if records else None,
            "module_error_rate": sum("module_error" in r for r in records) / len(records) if records else None,
            "ragflow_p95_ms": percentile([float(r["ragflow_latency_ms"]) for r in live], .95),
            "module_p95_ms": percentile([float(x) for x in valid_latency], .95),
        },
        "golden_set": {"status": "not_run", "source": "OPE-5002/OPE-5789 external golden corpus-pilot/quality/golden; run separately against both backends"},
        "recommendation": "NO-GO: this script only replays live rows. Run both 70-question golden sets through RAGFlow and Myrmidon, and review overlap/empty-rate/p95 before switching.",
        "records": records,
    }
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"live_query_count": len(live), "replayed_count": len(records), "report": str(args.output)}))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
