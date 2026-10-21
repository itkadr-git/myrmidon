---
title: Knowledge deliveries and KNOWLEDGE_INDEX
summary: Governed knowledge revisions, canonical export, and publication pointers
---

The knowledge module is the governed company-knowledge store. It complements searchable Hindsight memory and role-scoped [[wiki]] regulations: knowledge items are durable, reviewable records with explicit publication state.

## Model

One item can be a `note`, `wiki`, `answer`, `task_outcome`, or `rule`. Each item has append-only revisions, sources, suggestions, events, and extracted `[[slug]]` links. Items are company/nest scoped; the current wiring uses one nest per company. Full-text search is a port, backed by the PostgreSQL search implementation at the wiring boundary.

Item status follows an explicit state machine: draft, in review, published, archived, or superseded. Revision status is draft, submitted, approved, or rejected. A draft never moves `deliveredRevisionId`; publication is an explicit pointer move. Rollback writes one additional revision copied from the target, keeping the audit trail append-only.

Rules are stricter than ordinary notes: they must require approval and name an `approver_kind`. Approval without that kind, or by an actor of the wrong kind, is refused rather than defaulted to permissive behavior.

## KNOWLEDGE_INDEX contract

The canonical tree export is the interchange form for the knowledge index. It has fixed key order and length-prefixed content, so export -> import -> export is byte-for-byte stable. Import is scoped to the selected company/nest and preserves the revision and delivery semantics instead of silently publishing drafts.

The delivery read path selects the approved revision and requested language (`en` or `ru`), falling back to the approved canonical language when a translation is unavailable. Backlinks are derived from normalized `[[slug]]`, `[[slug|alias]]`, and `[[slug#anchor]]` targets. Search and delivery return source and revision identity so a consumer can explain where a result came from.

## Boundaries

The API layer calls the company-bound module; callers do not supply an arbitrary nest to cross a company boundary. Suggestions are separate from publication and require an explicit accept/decline decision. Knowledge delivery is not a replacement for the wiki approval path or for ephemeral Hindsight recall.

## Source map

- `server/src/myrmidon/knowledge/domain.ts` — kinds, state machines, links, language selection, and approval gates.
- `server/src/myrmidon/knowledge/store.ts` — revision persistence, delivery pointer, export/import, and search calls.
- `server/src/myrmidon/knowledge/service.ts` — company/nest binding and PostgreSQL search wiring.
- `server/src/myrmidon/knowledge/index.ts` — public module surface and seed entry points.
- `server/src/myrmidon/evals/knowledge-gate.ts` — publication quality gate integration.
