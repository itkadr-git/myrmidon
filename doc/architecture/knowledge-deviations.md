---
title: Knowledge deviations
summary: Record and resolve differences between documented knowledge and verified reality
---

The knowledge module can keep a deviation ledger when documented information no longer matches verified reality. A deviation records the affected page, what was true, what changed, how the change was verified, and an optional task reference. The ledger is separate from knowledge-item revisions: it records a discrepancy and its follow-up, not a replacement publication.

## Lifecycle

A new deviation is open by default. List operations return open entries unless the caller asks to include resolved entries; open counts are scoped to the selected nest. Resolution changes the status to resolved and updates the timestamp. The ledger also supports finding open entries without a task reference that are older than 24 hours, for a daily alert. This query does not itself assign or create a task.

The data model stores company and nest identifiers, page, previous and current descriptions (`was` and `became`), verification details, an optional task reference, status, actor identifiers, and timestamps. Entries are ordered by creation time when listed or retrieved for the stale-unassigned alert.

## API and boundaries

The company-scoped endpoints are:

- `POST /api/myrmidon/companies/:companyId/knowledge/deviations` — record a deviation.
- `GET /api/myrmidon/companies/:companyId/knowledge/deviations` — list entries; `includeResolved` and `limit` control the result.
- `GET /api/myrmidon/companies/:companyId/knowledge/deviations/count` — count open entries.
- `POST /api/myrmidon/companies/:companyId/knowledge/deviations/:id/resolve` — resolve an entry.

The route binds the nest through the company-scoped knowledge service. Callers must not use an arbitrary nest identifier to cross company boundaries. Listing defaults to 100 entries when no limit is supplied. The stale-unassigned query is a service capability; it is not the same as the public list endpoint.

## Source map

- `packages/db/src/schema/knowledge.ts` — deviation table and inferred types.
- `packages/db/src/migrations/0436_knowledge_deviations.sql` — table, foreign keys, and indexes.
- `server/src/myrmidon/knowledge/deviations.ts` — record, list, count, stale query, and resolution operations.
- `server/src/myrmidon/knowledge/routes.ts` — company-scoped HTTP endpoints.
- `server/src/myrmidon/knowledge/deviations.myrmidon.test.ts` — behavior coverage.
