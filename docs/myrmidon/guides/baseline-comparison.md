# Baseline comparison on the Quality screen

The Quality screen (`/quality`) shows the six delivery metrics of a window —
per project and per role. Since 1.6.5 the page also carries a "Comparison with
the pinned snapshot" block under the two metrics tables: the same window set
against the company's pinned baseline snapshot, with per-row deltas.

The block reads
`GET /api/myrmidon/companies/:companyId/baseline/compare?from&to`
(merged in 1.6.2, PR #484) with the same `from`/`to` the page selected — the
window preset buttons (7/14/30 days) and the custom date inputs drive both the
metrics tables and the comparison.

## What the block shows

For every project and every role a row of five metrics, side by side:

| Column | Source |
|---|---|
| Current window | `current.byProject` / `current.byRole` of the compare answer |
| Baseline | `baseline.byProject` / `baseline.byRole` (the pinned snapshot's payload) |
| Delta | computed on the client from the two rows matched by key |

Metrics per row: tasks completed, cycle time (mean), review time (mean),
return rate, average cost per task. The delta is the absolute change plus the
percentage; the return rate delta is shown in percentage points. Color marks
the direction: green — better than the baseline, red — worse (cycle time,
review time, return rate and cost are "lower is better"; tasks completed is
"higher is better").

The server-side `differences` block of the compare answer carries the same
deltas per key: `differences.byProject[key]` and `differences.byRole[key]`
hold the per-metric `{ absolute, percentage }` pairs for every group present
on both sides of the comparison (there is no `reviewTimeP90` entry — the
BASELINE contract has no p90 for review time). A group that exists on only
one side gets no entry, and its row shows "—" instead of a delta — the
compare block derives its rows from `current.by*` and `baseline.by*` matched
by key, so the display does not depend on the server block. The delta
percentages are computed per key, so a task is never counted twice (once
under its project and once under its role). `percentage` is `null` when the
baseline value is 0: a change from 0 is real, but it has no meaningful
percentage. A `null` project key appears under the `""` record key.

## No pinned snapshot is not an error

When the company has no pinned snapshot the endpoint answers with
`baseline: null` and the block shows a neutral "no baseline" notice — the
metrics tables above keep working. The notice tells the operator how to pin
one (`POST .../baseline/snapshots` with `"pinned": true`, see
[baseline-snapshots-api.md](baseline-snapshots-api.md)).

A failed compare request (network error, 5xx) renders its own error notice
inside the block; it does not blank or break the rest of the Quality page.

## Files

- `ui/src/pages/BaselineCompareBlock.tsx` — the block component
  (`myrmidon(1.6.5-BASELINE-COMPARE-UI)`).
- `ui/src/pages/Quality.tsx`, `ui/src/pages/Quality.production.tsx` — import
  and placement under the by-role table (marked lines).
- `ui/src/i18n/myrmidon-locales/{en,ru}.json` — the `quality.compare.*` keys.
- `ui/src/pages/Quality.test.tsx` — component tests: the delta tables, the
  "no baseline" state (not an error), the isolated compare error state.
