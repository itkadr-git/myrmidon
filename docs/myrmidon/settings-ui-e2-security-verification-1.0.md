# SETTINGS-UI E2 bounded security verification note

Version: 1.2 (source review and full CI verification)
Reviewed base: origin/main `2a6af3f0f9ba71b5e7ecca354d0834cf511d56aa` (2026-10-31); branch synchronized with current main in merge commit `cc247b73a8755937ee8316414b7bba47f6c88a17`
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
