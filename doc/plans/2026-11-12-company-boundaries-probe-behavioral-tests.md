# Company-boundaries inventory probe — behavioral test plan (OPE-12873)

Scope: behavioral tests only for the existing read-only inventory probe. No data
sources change, no live writes, no migration.

## What the probe must prove

The Phase 0 read-only inventory (ADR-0052) may only inform the company
separation if repeated runs are safe and truthful:

1. **Read-only.** The probe issues only GET requests; no POST/PUT/PATCH/DELETE
   is ever issued. A transport observing a write method is a contract violation.
2. **Idempotent.** Two consecutive probe runs against the same stable fixture
   produce byte-identical normalized summaries and the same sha256 report hash.
3. **Truthful coverage.** A failed GET (transport failure, 5xx, malformed
   payload) stays an `error` state — it is never folded into `empty`, so it
   never counts as covered.

## Test map — scripts/myrmidon/company-boundaries-inventory.test.mjs

| Test | Acceptance criterion |
|---|---|
| probe issues exactly one GET per section and never a write method | mock transport counts methods and asserts GET only |
| write methods are a contract violation the transport refuses | mock transport rejects POST/PUT/DELETE |
| two consecutive runs on the same stable fixture produce the same normalized summary and hash | `collectInventory` twice on scripted fixtures → equal `summary`, `sections`, normalized form, `inventoryReportHash` |
| stable fixture resolves each section to its expected state and count | per-section state/count table for data/empty/denied/not-found/error |
| a failed GET stays an error-state coverage failure and is never reported as empty | reject / 500 / malformed payload → `error`, `covered: false`, `counts.empty === 0` |
| empty payloads stay covered and remain distinct from denied and not-found | 200 + `[]` → `empty`, covered, `denied`/`not-found` stay 0 |
| unknown sections are absent from the registry and cannot be covered | `sectionForPath('/not-a-section')` → `undefined` |
| a transient transport failure in the first run stays error and the retried run covers the section | reject on GET #1 → `error`, `covered: false`; second run → `data`, covered; exactly one GET per run (no hidden retry) |
| a transient 5xx in the first run stays error and the retried run covers the section | 503 on GET #1 → `error`; second run → `data`, covered; exactly one GET per run |
| when no retry is performed the report keeps surfacing the error instead of an empty inventory | repeated runs with a persistent 503 → `error` every run, `counts.empty === 0`, covered stays `total - 1` |
| agent ownership serialization keeps unknown owner refs unresolved with a reason | missing/empty/whitespace/null owner ref → `attribution: "unknown"`, `ownerCompanyId: null`, `reason: "missing-owner-ref"`, pseudonymized `entityRef` |
| agent ownership serialization resolves exact attribution only for known company ids | known ref → `attribution: "resolved"` + exact `ownerCompanyId`; unknown ref → `attribution: "unresolved"`, `ownerCompanyId: null`, `reason`, pseudonymized `ownerRefHash`; empty/omitted known set → every present ref `unresolved` (fail-closed), no raw id; no zero/current-domain fallback |
| probe report embeds agent ownership and hashes stay deterministic with unknown refs | `collectInventory(transport, { knownCompanyIds })` embeds `ownership.agents`; orphan/ghost fixtures keep unknown/unresolved states; repeated runs hash identically |
| serialized ownership never leaks raw unknown ids or sensitive values | raw unknown owner value never appears in `renderInventory` output |

## Probe module contract (scripts/myrmidon/company-boundaries-inventory.mjs)

- `collectInventory(transport, { knownCompanyIds? })` calls
  `transport.request({ method: 'GET', path })` once per registered section, in
  registry order, and embeds `ownership: { agents: [...] }` in the report;
  `normalizeInventoryReport` and the report hash cover ownership, keeping
  repeated runs byte-identical.
- `INVENTORY_METHOD = 'GET'` names the only method the probe may issue.
- `serializeAgentOwnership(entities, { knownCompanyIds })` — ownership
  serialization for one entity kind (agents). Missing/unusable owner ref stays
  `unknown` with reason `missing-owner-ref`; a ref outside `knownCompanyIds`
  stays `unresolved` with reason `owner-company-not-in-known-set`; a ref
  verifiably present in the known set serializes exact `ownerCompanyId`.
  Fail-closed: an empty or omitted known set makes every present ref
  `unresolved` (pseudonymized) — never resolved-by-default, so a raw owner id
  reaches the report only when the caller itself supplied it as known.
  Unknown refs never serialize as the zero or current domain. Raw entity ids
  and unknown owner refs are pseudonymized (truncated sha256), so reports stay
  deterministic without sensitive values.
- `normalizeInventoryReport(report)` — deterministic normalized form: object
  keys sorted recursively; section array order preserved (registry order is
  the canonical order).
- `inventoryReportHash(report)` — sha256 hex over the normalized form.
- `renderInventory(report)` — JSON of the normalized form.

The transport interface is `{ request({ method, path }) }`, so a mock can
record every issued method and fail the probe on any non-GET.

## Verification

```sh
node --test scripts/myrmidon/company-boundaries-inventory.test.mjs
```

14 tests, all green locally. No network, no database, no live board access.
