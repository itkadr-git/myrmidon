# T3-A regression handoff

Test-only site fixture: `server/src/myrmidon/bot-containers/remote-site-t3-fixtures.ts` (`T3_A_FIXTURE`). Regression tests: `server/src/myrmidon/bot-containers/remote-site-t3-contract.myrmidon.test.ts`.

The suite is intended to run with the repository server Vitest configuration and exercises existing fleet-host parsing, effective host settings, fleet routing, gateway URL construction, profile compilation restart hashes, and Docker container template drift helpers. Assertions cover fixture parsing, no-host local compatibility, site endpoint/network/volume overrides, explicit remote selection failure without local fallback, dispatch to selected remote host only, remote host URL plus allocated gateway port, invalid/missing gateway port, model/key-reference/MCP changes affecting compiled restart hash, and image/resource drift. API-key values are synthetic fixture strings only.

Assertion-to-production map: `parseFleetHosts` -> `fleetd-hosts.ts`; local/remote effective settings and gateway URL -> `fleetd-placement.ts`; explicit remote failure/dispatch -> `fleetd-routing.ts`; model/key/MCP restart hash -> `profile-compiler.ts`; image/resource mismatch -> `buildCreateContainerRequestBody` and `templateDriftFields` in `docker-driver.ts`.

Gaps: this does not implement a site registry, agent, card-sync integration, rollout, or live acceptance. Production drift compares Docker template fields, including image and resource limits, but no production profileHash+imageDigest+limits composite drift contract was found. `latest`-without-digest validation and `mcpEndpoints` wiring into site profiles are not represented by the existing production helpers. The fixture's parsed MCP configuration is test data, not proof that runtime services consume it.

`git diff --check` passed. No JS runtime/package manager is installed (`node`, `pnpm`, `bun`, and `deno` absent); `gh auth status` is unauthenticated. Vitest and the negative-fixture mutation sensitivity run are therefore pending a CI-capable workflow. No local green claim is made.
