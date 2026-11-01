# SETTINGS-UI E2 bounded security verification note

Version: 1.4 (source review and full CI verification)
Reviewed base: origin/main `68232bba7a` (2026-11-01); branch synchronized with current main in merge commit `e01d6eaeb`
Scope: repository source and automated CI test execution only. No environment values or actual secrets were read; no production access or changes were made.

## Source and test evidence

Relevant route tests: `server/src/myrmidon/secret-settings/store-routes.myrmidon.test.ts`.
Relevant resolver tests: `server/src/myrmidon/secret-settings/resolver.myrmidon.test.ts`.

Automated CI execution:
PR #2184 label `full-ci` triggered the complete GitHub Actions matrix on HEAD `ca92bc4b45a91aee18d75e50d13fdf964a85b08d`.
CI run: `41249196886`.
- `CI result`, `checks`, and `migration guard`: PASS.
- `tests (serialized 1/2)`, `tests (serialized 2/2)`: PASS.
- `tests (server 1/6)` through `tests (server 6/6)`: PASS.
- `tests (workspaces-a)`, `tests (workspaces-b)`, and `tests (other + runner)`: PASS.
- `typecheck + build`: PASS.

Subsequent exact-head CI on `babaa084faf8bbd7219e4a27a350d75ceb7e2ea1` (run `41281231789`) failed in both serialized shards. Failure analysis identified two unrelated main-level failures: `settings-routes.myrmidon.test.ts` expects accessMode/enabledRoles to persist, while `settings-routes.ts` normalizes to only apiUrl/keySecretName; `openapi-routes.test.ts` expected no unknown route files but found `guardrails.ts`. Both failures were reproduced on main SHA `6cac429a7bf454ef413f543add040b5ce398bc77` in run `41280153675`. Main fixed the OpenAPI coverage issue in `68232bba7a` (#2232); the agent-memory settings mismatch remains in current main. Current main CI run `41283862886` was in progress at the time of this update.

Attributable coverage in `store-routes.myrmidon.test.ts` (the route/authz suite is selected by the stable runner's route pattern and runs against embedded Postgres with a local encrypted provider):
1. Authorization controls: non-admin actors receive 403 Forbidden on secret-settings management endpoints; instance admins receive 200 OK.
2. Synthetic secret-ref lifecycle: set, swap, and revoke are exercised with synthetic fixtures; resolver bindings update accordingly.
3. Migration safety: dry-run and apply response checks ensure plaintext secret values are not returned.
4. Audit integrity: mutation audit behavior is covered; simulated audit failure rolls back the database mutation.

The full CI run is the passing targeted behavior evidence. The earlier local `devbuild` attempt that failed with `vitest not found` is retained as a failed local attempt, not used as acceptance evidence.

## Per-name and class disposition

The detailed existing inventory is `docs/myrmidon/e2-secret-consumers-e2-6.md` and the matrix summary is `docs/myrmidon/e2-secret-coverage-1.6.6.md` (E2.6 section). Review confirms:

- `MYRMIDON_*_KEY_SECRET` names are selectors/pointers to company-secret names, not secret values. Existing consumers resolve selected names through the secrets service. Keep them as process configuration selectors; do not register a pointer as an instance secret.
- `MYRMIDON_BROWSER_BRIDGE_PEPPER` is process-wide HMAC bootstrap material read during module initialization. Keep env/file bootstrap only. Rotation invalidates pairings; no store migration.
- `MYRMIDON_DECISION_SIGNING_SECRET` is bootstrap signing material read before the store can be used. Keep env or generated key-file bootstrap only; putting integrity key beside protected data weakens the trust boundary and rotation invalidates signatures.
- `MYRMIDON_TOOL_ACTION_SIGNING_SECRET` is bootstrap signing material read before the store can be used. Keep env or generated key-file bootstrap only; same trust-boundary and rotation concerns.

Evidence and scope: `docs/myrmidon/e2-secret-consumers-e2-6.md` lines 5-9, 16-32; `docs/myrmidon/e2-secret-coverage-1.6.6.md` E2.6 section; implementation in `server/src/myrmidon/secret-settings/registry.ts`, `runtime.ts`, `resolver.ts`, and `routes.ts`. Per-name selectors are enumerated in that existing E2.6 matrix. This note does not certify runtime authorization or rotation behavior beyond the cited source/tests.

## Open verification gaps / disposition

Automated repository behavior verification is complete and passing on CI run `41249196886` for the exact PR HEAD. Remaining deployed gaps are intentionally not claimed: no explicitly approved non-production live deployment was supplied for out-of-process HTTP probes (no auth, board API key only, ordinary authenticated non-admin, and instance admin over a live socket) or deployed log-drain scraping. In accordance with the security directive ("production и реальные секреты не использовать"), no production instances were probed and no real secrets were read. Live infrastructure verification remains deferred until an authorized non-production staging environment is provisioned.
