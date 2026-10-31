# SETTINGS-UI E2 bounded security verification note

Version: 1.0 (source review; verification incomplete)
Reviewed base: origin/main `892786e0d96d329162c4e18a5b57b77793fce5f4` (2026-10-31)
Scope: repository source and automated-test inventory only. No environment values or actual secrets were read; no production access or changes were made.

## Source and test evidence

Relevant route tests: `server/src/myrmidon/secret-settings/store-routes.myrmidon.test.ts`. Relevant resolver tests: `server/src/myrmidon/secret-settings/resolver.myrmidon.test.ts`. Existing suite cases include unauthorized access, admin access, synthetic secret ref set/swap/revoke, dry-run and apply response checks, audit behavior, and rollback on audit failure. Test presence is not a passing test result.

Attempted command through the repository devbuild wrapper:
`devbuild 'node scripts/run-vitest-stable.mjs --mode serialized --no-bail'`
Result: wrapper selected 197 serialized suites, then test execution failed: `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "vitest" not found` (exit 254). No tests passed in this attempt. `gh run list` was also attempted for main CI but GitHub returned HTTP 403 installation API rate limit; no CI outcome was obtained.

Earlier invocation attempts (`devbuild` with pnpm workspace filtering and direct `pnpm exec vitest`) did not execute the intended tests; they returned pnpm help/no matching project or missing Vitest. Those are failed attempts, not test results.

## Per-name and class disposition

The detailed existing inventory is `docs/myrmidon/e2-secret-consumers-e2-6.md` and the matrix summary is `docs/myrmidon/e2-secret-coverage-1.6.6.md` (E2.6 section). Review confirms:

- `MYRMIDON_*_KEY_SECRET` names are selectors/pointers to company-secret names, not secret values. Existing consumers resolve selected names through the secrets service. Keep them as process configuration selectors; do not register a pointer as an instance secret.
- `MYRMIDON_BROWSER_BRIDGE_PEPPER` is process-wide HMAC bootstrap material read during module initialization. Keep env/file bootstrap only. Rotation invalidates pairings; no store migration.
- `MYRMIDON_DECISION_SIGNING_SECRET` is bootstrap signing material read before the store can be used. Keep env or generated key-file bootstrap only; putting integrity key beside protected data weakens the trust boundary and rotation invalidates signatures.
- `MYRMIDON_TOOL_ACTION_SIGNING_SECRET` is bootstrap signing material read before the store can be used. Keep env or generated key-file bootstrap only; same trust-boundary and rotation concerns.

Evidence and scope: `docs/myrmidon/e2-secret-consumers-e2-6.md` lines 5-9, 16-32; `docs/myrmidon/e2-secret-coverage-1.6.6.md` E2.6 section; implementation in `server/src/myrmidon/secret-settings/registry.ts`, `runtime.ts`, `resolver.ts`, and `routes.ts`. Per-name selectors are enumerated in that existing E2.6 matrix. This note does not certify runtime authorization or rotation behavior beyond the cited source/tests.

## Open verification gaps / disposition

Incomplete; keep OPE-10294 open. No successful automated test result has yet been obtained. No explicitly approved non-production deployment was supplied, so HTTP checks for no auth, board API key only, ordinary authenticated non-admin, and instance admin remain unperformed. Runtime migration dry-run/apply response and logs, and deployed audit success/failure effects, likewise remain unverified. Do not probe production. Continue only with a successful targeted CI/test run and explicit non-production authorization for deployed HTTP/log checks.
