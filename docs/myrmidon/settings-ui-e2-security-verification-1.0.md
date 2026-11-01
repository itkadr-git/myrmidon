# SETTINGS-UI E2 bounded security verification note

Version: 1.9 (source review and full CI verification)
Reviewed base: origin/main `cd302fd12d5c049c2bd6bc5c9c4b591c1013ca1b` (2026-11-01); branch synchronized with current main in merge commit `1c8696bed2cfc286a01456173a89b520e444a7f2`
Scope: repository source and automated CI test execution only. No environment values or actual secrets were read; no production access or changes were made.

## Source and test evidence

Relevant route tests: `server/src/myrmidon/secret-settings/store-routes.myrmidon.test.ts`.
Relevant resolver tests: `server/src/myrmidon/secret-settings/resolver.myrmidon.test.ts`.

Automated CI execution:
PR #2184 label `full-ci` triggered the complete GitHub Actions matrix.
- Passing evidence: run `41249196886` on HEAD `ca92bc4b4`; all server, serialized, workspace, migration, typecheck/build, and checks lanes passed.
- Later full run `41286731155` on HEAD `8384b08ad` passed most lanes but exposed unrelated upstream failures in continuation-dedupe and agent-memory settings.
- Exact-head run `41288698880` on HEAD `4d497edd3` passed checks, go tools, migration guard, typecheck/build, all server shards, workspace shard 2, serialized shard 2, and other/runner. It failed only workspace shard 1 on `ui/src/components/Layout.test.tsx > renders a mobile company settings selector on company settings routes` and serialized shard 1 on the unrelated `agent-memory/settings-routes.myrmidon.test.ts` contract mismatch.
- Run `41291124745` on HEAD `d080be74c103b119fd290ead384fa511196d9559` failed: serialized 1/2 `agent-memory/settings-routes.myrmidon.test.ts > stores a patch and reports it as in force` (expected `accessMode`/`enabledRoles` absent from result); workspaces-a `Layout.test.tsx > renders a mobile company settings selector on company settings routes` (expected selector was null); workspaces-b `sandbox-callback-bridge.test.ts > drains already-queued requests on stop` timed out at 5 seconds.
- Latest exact-head CI run `41294633046` on `f4cd09360ec809433adb94a72098e33d8dd0eb44` completed FAILURE: 3 failed jobs, 22 passed. `tests (serialized 2/2)` failed on the same agent-memory contract mismatch (`server/src/myrmidon/agent-memory/settings-routes.myrmidon.test.ts:41`, expected `accessMode: roles` and `enabledRoles: [engineer, lead]`, received only `apiUrl` and `keySecretName`; shard summary 1 failed, 83 passed/102 files). `tests (workspaces-a (1/2))` failed on `ui/src/components/Layout.test.tsx > renders a mobile company settings selector on company settings routes`, selector null and unhandled missing `useOptionalCompany` export from the test mock (shard summary 1 failed, 394 passed/395 files). Both failing suites/files are unchanged relative to the reviewed main branch; the PR does not modify them or `CompanySettingsNav.tsx`. The test failures are outside this PR's changed files, but exact-head CI is still red and review handoff is not eligible. CI failure evidence: jobs `124812841079` and `124812840947`; exact run `41294633046`.
- Run `41299872429` on exact HEAD `1c8696bed2cfc286a01456173a89b520e444a7f2` is not green: server 2/6 failed `owner-telegram-delivery.myrmidon.test.ts` (a pending board-only interaction publication was present where the unchanged test expected none); workspaces-a (2/2) failed `AgentActionButtons.test.tsx` twice because query invalidation keys now use detail/runtime/task-session keys rather than the stale expected company key; serialized 2/2 failed `issue-comment-reopen-routes.test.ts` because the unchanged test expected an `issue_reopened_via_comment` wake while the implementation emitted an `issue_status_changed` wake. These failing files are unchanged by this PR; the only PR files are the verification note and the unrelated date-stabilization test. The freeze gate also failed because release freeze is active for `myr-v1.6.6-rc.27` while tag CI is in progress. Exact-head CI remains red; review handoff is not eligible.
CI must be green on the final pushed head before review handoff.

Attributable coverage in `store-routes.myrmidon.test.ts` (the route/authz suite is selected by the stable runner's route pattern and runs against embedded Postgres with a local encrypted provider):
1. Authorization controls: non-admin actors receive 403 Forbidden on secret-settings management endpoints; instance admins receive 200 OK.
2. Synthetic secret-ref lifecycle: set, swap, and revoke are exercised with synthetic fixtures; resolver bindings update accordingly.
3. Migration safety: dry-run and apply response checks ensure plaintext secret values are not returned.
4. Audit integrity: mutation audit behavior is covered; simulated audit failure rolls back the database mutation.

Passing full-CI run `41249196886` executed these suites green on HEAD `ca92bc4b4`; the PR diff itself touches no source under test. The later exact-head failures listed above are all outside this PR's files. The earlier local `devbuild` attempt that failed with `vitest not found` is retained as a failed local attempt, not used as acceptance evidence.

## Per-name and class disposition

The detailed existing inventory is `docs/myrmidon/e2-secret-consumers-e2-6.md` and the matrix summary is `docs/myrmidon/e2-secret-coverage-1.6.6.md` (E2.6 section). Review confirms:

- `MYRMIDON_*_KEY_SECRET` names are selectors/pointers to company-secret names, not secret values. Existing consumers resolve selected names through the secrets service. Keep them as process configuration selectors; do not register a pointer as an instance secret.
- `MYRMIDON_BROWSER_BRIDGE_PEPPER` is process-wide HMAC bootstrap material read during module initialization. Keep env/file bootstrap only. Rotation invalidates pairings; no store migration.
- `MYRMIDON_DECISION_SIGNING_SECRET` is bootstrap signing material read before the store can be used. Keep env or generated key-file bootstrap only; putting integrity key beside protected data weakens the trust boundary and rotation invalidates signatures.
- `MYRMIDON_TOOL_ACTION_SIGNING_SECRET` is bootstrap signing material read before the store can be used. Keep env or generated key-file bootstrap only; same trust-boundary and rotation concerns.

Evidence and scope: `docs/myrmidon/e2-secret-consumers-e2-6.md` lines 5-9, 16-32; `docs/myrmidon/e2-secret-coverage-1.6.6.md` E2.6 section; implementation in `server/src/myrmidon/secret-settings/registry.ts`, `runtime.ts`, `resolver.ts`, and `routes.ts`. Per-name selectors are enumerated in that existing E2.6 matrix. This note does not certify runtime authorization or rotation behavior beyond the cited source/tests.

## Open verification gaps / disposition

Automated repository behavior verification is supported by passing run `41249196886` on HEAD `ca92bc4b4` for the targeted suites; current PR exact-head CI is not green, as detailed above, so a green final-head verification remains open. Remaining deployed gaps are intentionally not claimed: no explicitly approved non-production live deployment was supplied for out-of-process HTTP probes (no auth, board API key only, ordinary authenticated non-admin, and instance admin over a live socket) or deployed log-drain scraping. In accordance with the security directive ("production и реальные секреты не использовать"), no production instances were probed and no real secrets were read. Live infrastructure verification remains deferred until an authorized non-production staging environment is provisioned.
