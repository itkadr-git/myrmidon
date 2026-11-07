# T3-A regression handoff

Test-only site fixture: `server/src/myrmidon/bot-containers/remote-site-t3-fixtures.ts` (`T3_A_FIXTURE`). Regression tests: `server/src/myrmidon/bot-containers/remote-site-t3-contract.myrmidon.test.ts`.

The suite is intended to run with the repository server Vitest configuration and exercises existing fleet-host parsing, effective host settings, fleet routing, gateway URL construction, profile compilation restart hashes, and Docker container template drift helpers. Assertions cover fixture parsing, no-host local compatibility, site endpoint/network/volume overrides, explicit remote selection failure without local fallback, dispatch to selected remote host only, remote host URL plus allocated gateway port, invalid/missing gateway port, model/key-reference/MCP changes affecting compiled restart hash, and image/resource drift. API-key values are synthetic fixture strings only.

Assertion-to-production map: `parseFleetHosts` and host MCP parsing -> `fleetd-hosts.ts`; local/remote effective settings, host MCP propagation input, and gateway URL -> `fleetd-placement.ts` plus the profile input shape; explicit remote failure/dispatch -> `fleetd-routing.ts`; model/key/MCP restart hash -> `profile-compiler.ts`; latest-tag rejection -> `isImageAllowed` in `template.ts`; image/resource mismatch -> `buildCreateContainerRequestBody` and `templateDriftFields` in `docker-driver.ts`; composite `profileHash+imageDigest+limits` contract -> `t3CompositeDriftFields` adapter in `remote-site-t3-fixtures.ts`.

Completed in OPE-7650:
- Production composite drift calculation (`compositeDriftFields` in `drift.ts`) is wired directly into production reconciliation (`reconciler.ts`) and detects / repairs drift across profileHash, imageDigest, and limits.
- Production card sync (`createBotCardSync` and `createDbBotCardSyncPorts`) resolves active fleet sites, queries allocated gatewayPort from runtime status, and sets card `apiBaseUrl` to the site gateway.
- Production agent card save validation (`botContainerCardSaveProblem` / `botContainerImageSaveProblem`) rejects `:latest` without immutable sha256 digest.
- Image rollout waves (`bot-image-rollout.sh` and shared rollout schema) support the `--site` filter to target specific remote hosts (e.g. `myr-vm1`) without touching other sites.

`git diff --check` and the focused Vitest suite passed locally (12 tests, 0 failures; Node v22.20.0 with pnpm 9.15.9; repository requires Node >=24.11.0, so rerun in CI). Negative-fixture mutation sensitivity passed: changing the T3 allowlist from digest-pinned to a mutable tag made the suite fail (11 passed, 1 failed); the fixture was restored. `gh auth status` is unauthenticated; no PR/CI result is claimed.
