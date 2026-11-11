# OPE-9520 corpus replay

This harness compares recorded RAGFlow outputs for live bot queries with the
company-scoped Myrmidon corpus SearchIndex. It does not claim data availability
or switch-readiness: the live export and external golden set must be supplied.

## Input

Create sanitized JSON Lines rows from an authorized RAGFlow MCP/gateway export:

```json
{"ts":"2026-10-20T12:00:00Z","bot_id":"bot-17","dataset":"<Myrmidon corpus dataset UUID>","query":"question","ragflow_ids":["chunk-a","chunk-b"],"ragflow_latency_ms":140}
```

`dataset` is the post-import Myrmidon corpus dataset UUID (or an exact dataset
name, unique within the company). `ragflow_ids` must use IDs that are comparable
to Myrmidon chunk IDs. If RAGFlow returns document IDs instead, preserve them
and use the same document-ID comparison convention on both backends; do not
silently mix chunk and document identifiers. Never include credentials or
unredacted user data in the export.

## Replay

After CORPUS-IMPORT is complete and the corpus module is enabled/configured, set
`CORPUS_REPLAY_TOKEN` to a scoped bearer token and run:

```sh
python3 scripts/corpus-replay.py \
  --input /path/to/sanitized-ragflow-7d.jsonl \
  --output /path/to/replay-report.json \
  --company-id <company-uuid> \
  --since 2026-10-20T00:00:00Z \
  --until 2026-10-27T00:00:00Z \
  --live-source <authorized-export-ref>
```

The script invokes `POST /api/myrmidon/companies/{companyId}/corpus/mcp` with
`corpus_search`, records module errors instead of hiding them, and reports top-5
intersection, empty rates and p95 latency. The recorded RAGFlow ranking and
latency are never fabricated or re-fetched.

## Golden set / limitations

The OPE-5002/OPE-5789 golden questions live outside this repository at
`BastionPrime/ops-tools/corpus-pilot/quality/golden/questions-{adm,bbq,work}-craft.jsonl`
(70 questions). This script currently does not execute that external golden
set nor call the RAGFlow API; report `golden_set.status=not_run` until a reviewed
runner has queried both backends against the approved gold set. The output
recommendation is therefore NO-GO until those metrics and a live export are
reviewed. Never infer switch readiness from synthetic fixtures or stale
baselines.
