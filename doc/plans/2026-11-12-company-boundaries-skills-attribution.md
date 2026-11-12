# Company-boundaries inventory — skills attribution coverage (OPE-12872)

**Scope:** OPE-12872, read-only Phase 0 inventory. This document covers the
skills domain only; it does not change ACLs, data, permissions, or migration
behavior.

## Where attribution appears in the report

`collectInventory(transport)` issues one GET per section through the probe
transport contract (`transport.request({ method: "GET", path })`, OPE-12873)
and attributes every payload row of a covered section that has a defined
owner mapping. The report carries:
- `sections[*].ownership` — the per-section `summarizeAttribution` result;
- `attribution` — the aggregate summary across attributed sections, included
  in `normalizeInventoryReport` and `inventoryReportHash`;
- `sections[*].missingAttribution` — unchanged coverage model (OPE-12870).

Covered sections without a defined owner mapping, and sections in `denied`,
`not-found`, or `error` state, carry no ownership block — the report never
invents attribution. A covered mapped section always carries the block, even
when empty (zero rows).

## Skills source fields (registry section `skills-policies`)

| Report field | Explicit source field | Result when absent |
|---|---|---|
| owner | `metadata.forkedByAgentId` | try `metadata.forkedByUserId` |
| owner | `metadata.forkedByUserId` | `unknown` |
| domain | `sharingScope` (`public_link`) | `unknown` for invalid/missing values |
| domain | `sharingScope` (`company`, `private`) | `company` |

The owner fields are written by the company-skills fork flow
(`server/src/services/company-skills.ts`, fork/upsert writers). `authorName`,
`metadata.owner`, repository names, keys, titles, and company membership are
not ownership evidence and are never used for attribution. `sharingScope` is
the only skills boundary field used for domain attribution. `public_link` is
reported separately because it is externally linkable; `company` and
`private` are reported as the company domain.

Note: the skills list endpoint
(`GET /api/companies/:companyId/skills`, `CompanySkillListItem`) does not
return `metadata`; owner attribution for the skills section requires a
payload that includes metadata (the transport supplies it), e.g. the full
skill rows (`CompanySkill`). Transport row shape is a caller decision; the
report only reads the declared fields above.

## Output guarantees

- Missing owner is represented as `owner: "unknown"`, `ownerKnown: false`.
- Missing or invalid skills scope is represented as `domain: "unknown"`.
- Owner and domain summaries are deterministic.
- Reports contain identifiers, fixed markers, and counts only; sensitive row
  values are stripped before attribution, and payload rows are never echoed.
- The module is read-only: transport is injected, and running the file
  directly performs no calls and no writes.

## Verification

`node --test scripts/myrmidon/company-boundaries-inventory.test.mjs` (37
tests) covers: explicit agent/user owner fields, missing owner, ignored
external provenance, all supported sharing scopes, missing scope,
deterministic aggregation, secret-value exclusion, and — new in this change —
the report-path behavior: skills rows attributed inside
`collectInventory` output (per-section `ownership` + aggregate `attribution`),
unmapped sections without an ownership block, denied/empty states never
inventing attribution, and repeatability of the attributed report.
