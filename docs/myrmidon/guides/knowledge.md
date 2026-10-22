# Knowledge (KNOWLEDGE-2.0, 1.6.6)

> Russian version: [knowledge.ru.md](knowledge.ru.md)

Knowledge 2.0 is the company's own wiki module: one knowledge service that
people (the board UI) and agents (REST and MCP tools) call with **one set of
rights**. This guide covers the API surface shipped by K-2 Часть B on top of
the K-1 domain and store.

Design source: `ops/audit/knowledge-architecture-2.0.md` (§3.4 tables, §6).
Decision registry OPE-401: 04.10 — the wiki is our own module, the plugin goes
away; 08.10 — the plugin stays enabled as a bridge until the module covers it,
the knowledge transfer itself is K-6.

## Current state of the rollout

What the merged 1.6.6 code actually does:

- The REST surface lives under
  `/api/myrmidon/companies/:companyId/knowledge/*` — search, items, revisions,
  backlinks, suggestions, export/import, and the mutations (create, draft
  revision, submit, publish, approve, rollback, archive, supersede, propose,
  accept/decline suggestion).
- The MCP surface is one endpoint per company:
  `POST /api/myrmidon/companies/:companyId/knowledge/mcp` — JSON-RPC
  (`initialize`, `tools/list`, `tools/call`). The tool names and schemas are in
  `packages/shared/src/myrmidon-knowledge-tools.ts`.
- Both surfaces pass the same gates, in the same order, over the same module
  (`createKnowledgeModule`), so rights do not depend on the entry point.

## Gates (the same five on both surfaces)

1. **Company access.** `assertCompanyAccess` — a caller outside the company
   gets 403 before anything else.
2. **Tool grant (`permissions.toolAccess`, S6).** An agent caller must hold a
   grant for the named tool (`knowledge_search`, `knowledge_read`,
   `knowledge_propose`, `knowledge_write_draft`, `knowledge_publish`, …).
   Without one: HTTP 403, stable code `knowledge_tool_access_denied`, and no
   store work happens. Board users need no grant.
3. **Injection scan on write.** When `MYRMIDON_GUARDRAILS_INJECTION_ENABLED`
   is on, propose/draft/create bodies go through
   `scanForInjection` (`server/src/myrmidon/guardrails/injection.ts`); a
   flagged payload is refused with 422 `knowledge_injection_flagged` before
   the store sees it.
4. **Autonomy matrix.** `knowledge_publish` by an agent inside the `auto`
   sections (`glossary/…`, `releases/…`, `architecture/…`) publishes outright;
   outside them it parks an approval card (`tool_action_requests`,
   reason `requires_approval_policy`) and answers 409
   `knowledge_approval_required`. `rule_approve` by an agent is **forbidden
   outright** — see П4 below.
5. **Domain gates (K-1).** Slug grammar, status machine (draft → in_review →
   published), approver-kind match, supersede chains — the store's own rules
   surface as 4xx with stable codes.

## Acceptance criteria of K-2 Часть B

- **Agent without a grant → gateway refusal.** 403
  `knowledge_tool_access_denied`; the stub-module tests assert the store was
  never touched.
- **`knowledge_publish` outside the `auto` sections → approval card.** The
  item stays unpublished, a card is parked for the board, the caller gets 409
  `knowledge_approval_required` with the card id in the details.
- **`rule_approve` by an agent → forbidden, even by instruction (тест П4).**
  The gate runs **before** the tool-grant gateway on the approve route, so
  even an agent with every grant and an allowing matrix row is refused: a rule
  changes what every agent of a caste is told, only the human approves one.
  Stable code: `knowledge_rule_approve_forbidden`.
- **`knowledge_propose` without sources → 422.** Checked before the store:
  422 `knowledge_propose_requires_sources`.
- **Search p95 < 500 ms FTS on 1 000 pages** — covered by the K-3 search task
  (PG FTS index); the REST search route itself adds no extra queries.

## Autonomy matrix defaults

`AUTONOMY_ACTION_CLASSES` gained four classes
(`packages/shared/src/myrmidon-autonomy.ts`):

| action class                  | default for agents   | note                                   |
| ----------------------------- | -------------------- | -------------------------------------- |
| `knowledge_publish`           | `approval_required`  | `allowed` inside the `auto` sections   |
| `rule_approve`                | `forbidden`          | never overridable by agent instructions |
| `skill_promote`               | `approval_required`  | promotion of a skill to a caste        |
| `knowledge_external_publish`  | `forbidden`          | publishing knowledge outside the company |

Operators edit the matrix on the existing autonomy screen
(Settings → Autonomy); the safe defaults apply when no row matches.

## Using the MCP endpoint

```json
POST /api/myrmidon/companies/:companyId/knowledge/mcp
{"jsonrpc":"2.0","id":1,"method":"tools/list"}
```

`tools/call` example (`knowledge_search`):

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call",
 "params":{"name":"knowledge_search","arguments":{"q":"deploy runbook"}}}
```

Refusals come back as JSON-RPC errors carrying the same stable codes (403
`knowledge_tool_access_denied`, 409 `knowledge_approval_required`, …), so a
client can react to codes, not message text.

## Where the code lives

- `server/src/myrmidon/knowledge/routes.ts` — the REST router and its gates.
- `server/src/myrmidon/knowledge/mcp.ts` — the MCP endpoint and tool schemas.
- `server/src/myrmidon/knowledge/service.ts` — the per-company module.
- `packages/shared/src/myrmidon-knowledge-tools.ts` — tool names, auto
  sections, stable codes.
- `packages/shared/src/myrmidon-autonomy.ts` — the action classes and safe
  defaults.
- Tests: `server/src/myrmidon/knowledge/routes.myrmidon.test.ts` (П1–П4).
