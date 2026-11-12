# 2026-11-12 Company boundaries inventory — coverage-state model (OPE-12870)

Parent: OPE-9214 (1.7). Spec context: ADR-0052 (Phase 0 read-only inventory).

## Intent

The read-only Phase 0 inventory (ADR-0052 «Dry-run, миграция и rollback», Фаза 0)
must never overstate what it actually observed. This task adds a coverage-state
model and reporting for the existing inventory sections in
`scripts/myrmidon/company-boundaries-inventory.mjs`, so the final report
distinguishes received data from denied or missing sections.

## Scope boundary

Only the coverage-state model and reporting. No enforcement, no ACL/data
changes, no transfers, no live writes — the inventory transport is injected and
the CLI entry refuses to run without one.

## Coverage states

| State       | Meaning                                        | Covered |
|-------------|------------------------------------------------|---------|
| `data`      | HTTP 2xx with a parsable non-empty section payload | yes |
| `empty`     | HTTP 2xx with a parsable empty payload         | yes     |
| `denied`    | HTTP 403                                        | no      |
| `not-found` | HTTP 404                                        | no      |
| `error`     | network failure, non-2xx/403/404, malformed payload, unknown shape | no |

Rules:

1. A response and an empty payload are distinguishable from `denied`,
   `not-found`, and `error` per section.
2. Only `data` and `empty` mark a section `covered`; an unknown or unprocessed
   section cannot be covered because unknown paths resolve to no section
   definition (`sectionForPath` returns `undefined`) and unknown payload shapes
   fall back to `error`.
3. For covered sections the report lists the concrete missing owner/dependency
   attribution fields (`missingAttribution`), section-defined only, with no
   sensitive values: ids, payloads, and contents are never included — counts
   only.

## Sections

Registry: `INVENTORY_SECTIONS` — agents, issues, projects-documents,
skills-policies, secrets-bindings, connections-tools, budgets-costs,
memory-knowledge-sessions, chat-exchange-wake, audit-approvals (from the
ADR-0052 boundaries matrix; each entry declares its attribution fields).

## Testing

`node --test scripts/myrmidon/company-boundaries-inventory.test.mjs` covers:
success-data, success-empty, 403/404, malformed/ignored payloads and transport
failures, summary repeatability, and the unknown-section guard.
