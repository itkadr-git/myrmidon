# Knowledge-on-change metrics (KNOWLEDGE-ON-CHANGE, 1.6.6)

> Russian version: [knowledge-on-change-metrics.ru.md](knowledge-on-change-metrics.ru.md)

The knowledge-on-change metrics track how well the company follows the
rule «wiki before closing a system-change task» (skill `knowledge-on-change`,
parent task OPE-10225). They are read from the board database by the
guarded collector on `GET /metrics` and cover a rolling 7-day window.

## The two families

| Family | Type | What it answers |
|---|---|---|
| `myrmidon_knowledge_on_change_share` | gauge | Of the tasks closed in the last 7 days that changed the system (merged PR), how many have a wiki revision citing the task |
| `myrmidon_knowledge_revision_delay_seconds` | summary (quantile 0.5 / 0.95) | How long after the PR merge did the wiki revision citing that PR land |

## Denominator: what counts as a system change

A task contributes to the denominator when all of the following hold:

- `issues.status` is `done` or `cancelled`;
- `issues.completed_at` is inside the 7-day window;
- the task has at least one `issue_work_products` row with
  `type = 'pull_request'` and `status = 'merged'`.

A task without a merged PR is **not** a system change and stays out of
both numerator and denominator, even if it has a wiki revision.

## Numerator: what counts as coverage

A system-change task is covered when a `knowledge_sources` row exists
with `kind = 'task'` and `ref = issues.identifier` of that task. The
source row is created by the knowledge module when a revision cites the
task in its «Источники» section.

The share is `covered / changed`. When no system-change task closed in
the window, the gauge renders HELP/TYPE without samples (`null`), the
same shape the run-duration summary uses with no rows.

## Delay: merge to revision

For every `knowledge_sources` row with `kind = 'pr'`, the collector
joins `knowledge_revisions` on `revision_id` and looks up the merge time
of the cited PR among merged `issue_work_products` matched by
`external_id` or `url`. The delay is

```
knowledge_revisions.created_at - issue_work_products.updated_at
```

in seconds. Samples that are negative, non-finite or unmatched are
dropped. Both quantiles are linear-interpolated percentiles over the
remaining ascending-sorted sample. When no PR has a citing revision, the
summary renders HELP/TYPE without samples.

## Failure mode

Both families are wrapped in the existing `guarded()` collector: a DB
read error never kills the scrape, it only suppresses the samples for
that family and increments `scrape_errors`. `METRIC_FAMILIES` lists both
names, so the selfcheck endpoint on a broken DB still enumerates them.

Every sample carries the existing `role` label (`api` | `worker` |
`all`); compare values from the same process.

## Reading the numbers

- Share close to 1.0 — the wiki rule holds. Share drifting down —
  system changes are closing without a wiki record; find the offending
  tasks with the SQL behind the metric and nudge the owners.
- p50 delay of hours — revisions land the same day as the merge. p95
  growing into days — the wiki write is being deferred; check whether
  the gate (`MYRMIDON_KNOWLEDGE_GATE_MODE`) is in `warning` instead of
  `enforce`.

## Sources

- Implementation: `server/src/myrmidon/monitoring/metrics/metrics.ts`
  (`readKnowledgeOnChangeMetrics`, `METRIC_FAMILIES`).
- Tests: `server/src/myrmidon/monitoring/metrics/collector.db.myrmidon.test.ts`.
- Runbook: `docs/myrmidon/runbooks/metrics-scrape-failing.md`.
- Merged in PR #2211 (head 28e5f776).
