# Baseline snapshots API

The BASELINE module (1.6, part A) answers the six delivery metrics of a window
on `GET /api/myrmidon/companies/:companyId/baseline/metrics`. The three
endpoints below sit on top of it: they compute the same answer, store it whole
and keep it as a reference point ("as it was") that later measurements can be
compared against.

The stored row is the one the module writes: the frozen metrics answer lives in
`payload`, and the row is returned as-is (no field renaming, no separate
`metrics` array). `from`/`to` of the request are the `windowFrom`/`windowTo`
columns.

## POST /api/myrmidon/companies/:companyId/baseline/snapshots

Computes the metrics for the window in the body and stores the answer.

**Access:** board only — `assertBoard` plus the company access check. An agent
key is refused with `403`, and so is a board actor who is not a member of the
company (the read routes below accept an agent key of the same company).

**Body** (`application/json`):

| Field | Type | Required | Meaning |
|---|---|---|---|
| `from` | string, ISO 8601 | yes | Window start |
| `to` | string, ISO 8601 | yes | Window end |
| `label` | string | no | Human label; stored as `null` when omitted |
| `pinned` | boolean | no | Pin the new snapshot as the company's reference point; defaults to `false` |

**Response — `201 Created`**: the stored row.

```json
{
  "id": "5b1f0dd2-1a1e-4a3f-9c31-6a0b0a44f001",
  "companyId": "11111111-1111-4111-8111-111111111111",
  "windowFrom": "2026-09-19T08:28:00.000Z",
  "windowTo": "2026-10-03T08:28:00.000Z",
  "generatedAt": "2026-10-04T10:00:00.000Z",
  "payload": {
    "window": { "from": "2026-09-19T08:28:00.000Z", "to": "2026-10-03T08:28:00.000Z" },
    "generatedAt": "2026-10-04T10:00:00.000Z",
    "source": { "statusLog": "activity_log", "costs": "none" },
    "byProject": [],
    "byRole": []
  },
  "label": "Pre-pilot baseline",
  "pinned": true
}
```

**Errors**

- `400 Bad Request` — `from` or `to` missing:
  `{"error":"Both 'from' and 'to' are required"}`.
- `403 Forbidden` — not a board actor, or a board actor outside the company.

## GET /api/myrmidon/companies/:companyId/baseline/snapshots

**Access:** company access check (board, or an agent key of that company).

**Response — `200 OK`**: a JSON array of the stored rows, in the order the
database returns them (the route sets no order).

```json
[
  {
    "id": "5b1f0dd2-1a1e-4a3f-9c31-6a0b0a44f001",
    "companyId": "11111111-1111-4111-8111-111111111111",
    "windowFrom": "2026-09-19T08:28:00.000Z",
    "windowTo": "2026-10-03T08:28:00.000Z",
    "generatedAt": "2026-10-04T10:00:00.000Z",
    "payload": { "window": {}, "generatedAt": "", "source": {}, "byProject": [], "byRole": [] },
    "label": "Pre-pilot baseline",
    "pinned": true
  }
]
```

## GET /api/myrmidon/companies/:companyId/baseline/snapshots/:snapshotId

**Access:** company access check.

**Response — `200 OK`**: one stored row (the same shape as above).

**Errors** — `404 Not Found` when the company has no row with that id:
`{"error":"Snapshot not found"}`.

## Pinning

- Creating a snapshot with `pinned: true` first clears `pinned` on the
  snapshots of the company that are pinned now, then inserts the new row. A
  company therefore keeps a single reference point, and the previous one stays
  as an ordinary unpinned snapshot.
- `pinned: false` (the default) never touches the pinned row.
- The invariant is kept by those two statements and not by a unique index: the
  partial index `baseline_metric_snapshots_company_pinned_idx` only speeds the
  lookup up, it does not forbid a second pinned row written concurrently.

## Example

```bash
curl -X POST \
  https://board.example.test/api/myrmidon/companies/11111111-1111-4111-8111-111111111111/baseline/snapshots \
  -H 'Authorization: Bearer <board-api-key>' \
  -H 'Content-Type: application/json' \
  -d '{
    "from": "2026-09-19T08:28:00.000Z",
    "to": "2026-10-03T08:28:00.000Z",
    "label": "Pre-pilot baseline",
    "pinned": true
  }'
```