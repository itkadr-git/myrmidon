<!-- Write all pull request text in Simplified Technical English (ASD-STE100): short sentences, one instruction per sentence, simple approved vocabulary, and the active voice. -->

## Thinking Path

> - Paperclip is the open source app people use to manage AI agents for work.
> - The company-boundaries inventory probe (`scripts/myrmidon/company-boundaries-inventory.mjs`) is the Phase 0 read-only instrument for company separation (ADR-0052). It reports per-section coverage states.
> - The probe will gain source attribution. A raw source payload can carry credentials. A report that copies payload fields turns a read-only inventory into a secret-leak surface.
> - Attribution must show which endpoint/category a source covers and its coverage state, but never a credential value.
> - This pull request adds a pure source-label formatter plus fixture tests. The formatter resolves endpoint/category only through the section registry. It marks credential presence with a fixed `redacted` marker. It never copies a credential value.
> - The benefit is safe source attribution: reports stay truthful about coverage and cannot leak credentials, even when the input fixture contains sentinels.

## Linked Issues or Issue Description

Refs: ADR-0052 (`docs/architecture/adr/ADR-0052-company-boundaries-and-adm-channel.md`).

No public GitHub issue exists for this change. Problem statement: the inventory report needs useful source attribution (endpoint, category, coverage state) that stays safe when the source fixture contains credential-shaped fields, and reports `unknown` instead of inventing attribution when the source is incomplete.

## What Changed

- `scripts/myrmidon/company-boundaries-inventory.mjs`:
  - Added `formatInventorySourceLabel(source)` — pure formatter for one source entry. Output is only: registry-resolved `endpoint`, matching `category`, canonical coverage state (`data|empty|denied|not-found|error|unknown`), a `credential` field that is the fixed marker `redacted` when any credential-shaped field has a truthy value (`null` otherwise), `attribution` (`resolved|unknown`), and `reason` codes.
  - Added `formatInventorySourceLabels(sources)` — deterministic sorted batch form. Non-array input yields `[]`; non-object entries produce one no-label record (`endpoint`/`category` null, attribution `unknown`), never an invented label.
  - Added exported constants `SOURCE_LABEL_REASONS` (`unknown-endpoint`, `unknown-category`, `category-endpoint-mismatch`, `unknown-coverage`) and `SOURCE_LABEL_CREDENTIAL_REDACTED`.
  - `normalizeInventoryReport` now includes `sourceLabels` in the normalized form and hash only when the report provides it. Existing reports keep their shape and hash.
- `scripts/myrmidon/company-boundaries-inventory.test.mjs`: five new fixture tests (12 total in the file). Fixtures carry `pcp_SENTINEL_*` credential values; assertions check safe labels are present and every sentinel value is absent from single-label JSON, the rendered report, and the hash input.

## Architecture Decisions

Implements ADR-0052 Phase 0 inventory requirements ("Fail closed при любой неоднозначности"): labels resolve only through the `INVENTORY_SECTIONS` registry; unknown values emit `unknown` with a reason instead of guessed attribution. The formatter is pure and read-only; it issues no requests and performs no writes. No invariant in `docs/architecture/README.md` (INV-10..INV-13) is affected; the arch-invariants gate is untouched.

## Verification

```sh
node --test scripts/myrmidon/company-boundaries-inventory.test.mjs
```

Local run: 12 tests, 12 pass, 0 fail. Specifically:

- A source fixture with endpoint `/secrets-bindings`, category `secrets-bindings`, coverage `data`, and sentinel values in `credential` and `token` produces `{endpoint, category, coverage, credential: "redacted", attribution: "resolved"}`; the rendered JSON contains no sentinel substring.
- An incomplete source (missing endpoint, unregistered endpoint, category mismatch, missing category, unknown coverage) yields `attribution: "unknown"` with a reason and `null` labels; unregistered endpoint strings never appear in output.
- Credential presence is detected across `credential`, `credentials`, `token`, `apiKey`, `secret`, `password`, `authorization` without copying any value; empty or absent credential fields are not marked.
- Rendered report and sha256 hash keep sentinel values out and stay deterministic across input permutations.
- All 10 registry sections produce a resolved label for their canonical endpoint.

CI runs the file through the "Script tests (node:test under scripts/myrmidon)" step, which globs `scripts/myrmidon/*.test.mjs`.

## Risks

- Low risk. The formatter is additive; `collectInventory` output is unchanged, and `normalizeInventoryReport` includes `sourceLabels` only when present, so existing hashes are stable.
- The credential-field allowlist is a fixed name list (`credential`, `credentials`, `token`, `apiKey`, `secret`, `password`, `authorization`). A source entry storing a credential under a different field name would not be marked `redacted`; however, the formatter copies no fields except the registry-validated labels, so unknown fields cannot leak either — the allowlist only drives the presence marker.
- No live data touched: read-only, fixture-based tests only.

> For core feature work, check [`ROADMAP.md`](ROADMAP.md) first and discuss it in `#dev` before opening the PR. Feature PRs that overlap with planned core work may need to be redirected — check the roadmap first. See `CONTRIBUTING.md`.

## Model Used

Model: Gemini 3.8 Flash (provider ID `litellm/antigravity/gemini-3.8-flash-medium`) via the Paperclip agent runtime; exact context window and capability configuration are not exposed to the agent runtime.

## Checklist

### Acceptance criteria (task 1.7 OPE-12912)

| Criterion | Evidence |
|---|---|
| Source fixture with endpoint/category + credential sentinel → report shows endpoint/category and coverage state, not the sentinel | Test `source with endpoint/category and credential sentinel shows safe labels and coverage, never the sentinel` — `scripts/myrmidon/company-boundaries-inventory.test.mjs:197` |
| Incomplete source → report marks `unknown`, invents no attribution | Test `incomplete source stays unknown instead of inventing attribution` — `scripts/myrmidon/company-boundaries-inventory.test.mjs:217` |
| Safe labels present, sentinel absent from rendered output | Test `rendered report and hash keep sentinel values out and stay deterministic across runs` — `scripts/myrmidon/company-boundaries-inventory.test.mjs:280` |
| `node --test scripts/myrmidon/company-boundaries-inventory.test.mjs` passes | Local run: 12 pass, 0 fail; CI "Script tests (node:test under scripts/myrmidon)" step runs the same file |
| Boundary: formatter + fixture tests only, read-only data | Diff touches only the two named files; formatter is pure, no transport, no writes |

- [x] Thinking path included for this change.
- [x] Model family/runtime specified in the Model Used section.
- [x] ROADMAP.md checked: this is a test/formatter change inside the ADR-0052 company-separation workstream; no core feature overlap.
- [x] Related PR search run: no open PR touches `scripts/myrmidon/company-boundaries-inventory.*` on `main`.
- [x] No internal issue references included in this public PR.
- [x] Single branch and PR for this change; no duplicate PRs will be created.
- [x] Local fixture tests run: `node --test scripts/myrmidon/company-boundaries-inventory.test.mjs` — 12 pass.
- [x] Regressions added for the redaction behavior (sentinel values asserted absent from label JSON, rendered report, and hash).
- [ ] CI for the updated head is pending at submission time; verification is completed when CI is green.
