---
title: Knowledge deliveries and KNOWLEDGE_INDEX
summary: Governed knowledge revisions, canonical export, and publication pointers
---

The knowledge module is the governed company-knowledge store. It complements searchable Hindsight memory and role-scoped [[wiki]] regulations: knowledge items are durable, reviewable records with explicit publication state.

## Model

One item can be a `note`, `wiki`, `answer`, `task_outcome`, or `rule`. Each item has append-only revisions, sources, suggestions, events, and extracted `[[slug]]` links. Items are company/nest scoped; the current wiring uses one nest per company. Full-text search is a port, backed by the PostgreSQL search implementation at the wiring boundary.

Item status follows an explicit state machine: draft, in review, published, archived, or superseded. Revision status is draft, submitted, approved, or rejected. A draft never moves `deliveredRevisionId`; publication is an explicit pointer move. Rollback writes one additional revision copied from the target, keeping the audit trail append-only.

Rules are stricter than ordinary notes: they must require approval and name an `approver_kind`. Approval without that kind, or by an actor of the wrong kind, is refused rather than defaulted to permissive behavior.

## Revision history and sources

Revisions maintain a durable audit trail of all changes made to a knowledge item:
- **Change notes (`note` / `changeSummary`):** Each revision records an optional change note summarizing what was updated and why. Agents provide this via the `changeSummary` parameter when creating or updating revisions with `knowledge_write_draft`.
- **Structured sources (`sources`):** Revisions can cite one or more supporting references documenting or justifying the change. Each source entry consists of:
  - `kind`: the reference category (`task`, `pr`, `issue`, `run`, `document`, `decision`, or `url`).
  - `ref`: the identifier, relative path, or external URL (e.g., issue key `OPE-10487`, PR link/number `#2187`, document slug, or run ID).
  - `note`: an optional explanatory note detailing the citation.
- **UI representation:** The revisions panel (`RevisionsPanel` in `Ui2Knowledge`) displays the revision log with author, timestamp, change summary (`.ui2-knowledge-revision-note`), and actionable links for cited sources (`.ui2-knowledge-revision-sources`) that navigate to issues, pull requests, runs, wiki documents, or external resources.

## KNOWLEDGE_INDEX contract

The canonical tree export is the interchange form for the knowledge index. It has fixed key order and length-prefixed content, so export -> import -> export is byte-for-byte stable. Import is scoped to the selected company/nest and preserves the revision and delivery semantics instead of silently publishing drafts.

The delivery read path selects the approved revision and requested language (`en` or `ru`), falling back to the approved canonical language when a translation is unavailable. Backlinks are derived from normalized `[[slug]]`, `[[slug|alias]]`, and `[[slug#anchor]]` targets. Search and delivery return source and revision identity so a consumer can explain where a result came from.

## Boundaries

The API layer calls the company-bound module; callers do not supply an arbitrary nest to cross a company boundary. Suggestions are separate from publication and require an explicit accept/decline decision. Knowledge delivery is not a replacement for the wiki approval path or for ephemeral Hindsight recall.

## Source map

- `server/src/myrmidon/knowledge/domain.ts` — kinds, state machines, links, language selection, and approval gates.
- `server/src/myrmidon/knowledge/store.ts` — revision persistence, delivery pointer, export/import, and search calls.
- `server/src/myrmidon/knowledge/service.ts` — company/nest binding and PostgreSQL search wiring.
- `server/src/myrmidon/knowledge/mcp.ts` — MCP tools (`knowledge_write_draft` with `changeSummary` and `sources`).
- `server/src/myrmidon/knowledge/index.ts` — public module surface and seed entry points.
- `server/src/myrmidon/evals/knowledge-gate.ts` — publication quality gate integration.
- `ui/src/ui2/screens/knowledge/Ui2Knowledge.tsx` — `RevisionsPanel` rendering revision notes and clickable source references.
- `ui/src/ui2/screens/knowledge/knowledgeModel.ts` — `KnowledgeRevisionSummary` and `KnowledgeSourceRef` interfaces.
- `ui/src/ui2/screens/knowledge/knowledgeApi.ts` — API client revision parsing and source mapping.

## Change log

- 03 Nov 2026 — documented revision change notes, structured sources, MCP tool contracts, and UI revision rendering — OPE-10487, PR #2187.

## Sources

- OPE-10487 — documentation review for PR #2187.
- https://github.com/itkadr-git/myrmidon/pull/2187 — revision journal notes, source links, MCP contract, and UI rendering.
- `fa99b6fabd6e582040c7a8e4d641664985cbaa34` — merge head verified in git history.
