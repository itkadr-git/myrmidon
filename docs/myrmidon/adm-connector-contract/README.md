# ADM knowledge connector metadata contract (v1)

This document follows the approved design on OPE-9247. Knowledge is data, not executable policy; hard security checks remain in connector code.

## Namespaces and kinds

| Namespace | kind | Use |
| --- | --- | --- |
| `adm/policy/*` | `rule` | Always-applicable policies. Published rules require owner approval (`approver_kind: owner`). |
| `adm/trigger/*` | `rule` | Triggered rules, subject to the same proposal and approval gate. |
| `adm/reference/*` | `wiki` | API references, contracts and runbooks; not authorization. |
| `adm/skills/*` | `skill_card` | Prerequisites, inputs, steps, checks, rollback and source. |
| `adm/lessons/*` | `wiki` | Dated observations and evidence. A lesson does not become policy. |

`schema-v1.json` is the versioned JSON Schema. Metadata includes `schema_version`, `slug`, `kind`, `title`, `summary`, `tags`, `triggers`, `priority`, `owner`, `source_ref`, `sensitivity`, `status`, `revision_id`, and `updated_at`; optional `body` is Markdown. `rule` requires `approver_kind: owner`. The current schema constrains summaries to 300 characters, namespace/kind pairing, trigger values, and internal sensitivity.

## Triggers and ordering

Vocabulary v1: `ssh`, `deploy`, `paperclip-api`, `incident`, `config-change`, `release`, `merge`, `owner-message`. Unknown triggers are invalid; extend the versioned schema when introducing vocabulary. Deterministic connector code matches triggers; no model/MCP round-trips for selection.

Order candidates by: mandatory published policy first (never displaced), matching trigger rules, descending priority (0–100), then newest published revision. On unresolved conflict, fail closed for hazardous actions and ask the owner. Wiki/lessons are lower priority than rules and may be omitted under budget pressure.

## Permissions and writes

Agents may read published knowledge. Agents can submit a rule proposal/draft but cannot publish rules. Only owner approval can publish a `rule`; lessons/references follow their configured draft/publish rights and never grant authority. Use supported REST/MCP operations, stable item/revision IDs, idempotency, and base-revision conflict checks. On conflict, reread and propose a diff; never overwrite. A write is successful only after API acknowledgement and read-back of the published revision. Knowledge content cannot relax code-level security controls.

## Error contract

Map API/connector failures to stable codes: `ADM_INVALID_METADATA` (schema/unknown trigger), `ADM_UNAUTHORIZED`, `ADM_FORBIDDEN`, `ADM_NOT_FOUND`, `ADM_REVISION_CONFLICT`, `ADM_RATE_LIMITED`, `ADM_UPSTREAM_UNAVAILABLE`, `ADM_CACHE_INVALID`, `ADM_BUDGET_EXCEEDED`, `ADM_SECRET_REJECTED`. Never expose credentials in errors/logs. Upstream failure may use last validated cache with an explicit degraded/stale signal; invalid cache or stale critical policy fails closed. No cache means no hazardous action pending human confirmation. Do not silently turn a failed search into success.

## Context/token budget

- SessionStart inserts only policy title + summary (summary ≤300 characters) and trigger index; total added context ≤12 KiB. Never preload full policy bodies.
- UserPromptSubmit adds ≤2 KiB per message beyond the existing brief. No match means zero added bytes. Emit each item once per session by `slug+revision_id`, state scoped to `session_id`; after compaction, resend only policy summaries.
- Hook code performs REST search and deterministic selection; do not spend model MCP calls on lookup/selection.
- Enforce hard caps in connector code. Log bytes added per message and cumulatively per session. Exclude wiki/lessons, then lower-priority trigger rules, before policy summaries; if policies exceed the cap, report degraded/fail closed rather than silently truncate mandatory rules.

## Examples

The sibling `examples.json` contains schema-valid rule, wiki/reference, and wiki/lesson objects. Examples use illustrative values only; never put secrets in knowledge, provenance, or logs.
