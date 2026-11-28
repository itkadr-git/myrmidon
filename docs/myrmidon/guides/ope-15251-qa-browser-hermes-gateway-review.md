# OPE-15251 — read-only architecture review

Date: 2026-11-28
Scope: supported browser-tool/control-plane integration for `hermes_gateway` and `adm-qa`; no production change, secret value, shared CDP, owner identity, or foreign run was used.

## Decision

The repository provides a supported named MCP gateway control-plane entry point, but the reviewed sources do not establish a supported browser integration for `adm-qa` in `hermes_gateway` today.

The concrete control-plane endpoint is:

`POST /mcp/gateways/:gatewayPublicId`

using streamable HTTP and a named gateway bearer token. The protocol supports `initialize`, `tools/list`, and `tools/call`; the route is implemented in `server/src/routes/tool-gateway.ts:224-236`, with dispatch in `server/src/routes/tool-gateway.ts:104-209`. This is the integration point to use if a QA browser control-plane is registered as an MCP connection. It is not evidence that a browser endpoint, mTLS client certificate, or QA binding is already registered there.

## Evidence matrix

| Concern | Confirmed fact | Boundary / gap |
| --- | --- | --- |
| Hermes gateway transport | `packages/adapters/hermes/src/gateway/server/execute.ts:739-823` builds a `/v1/runs` request body; `:444-465` sends Hermes API bearer authentication, idempotency, run, and session headers. | The reviewed adapter does not register browser tools or select a browser endpoint. It forwards the run to Hermes; browser exposure must come from the configured tool/control-plane path. |
| MCP gateway registration | `server/src/routes/tool-gateway.ts:224-236` exposes `/mcp/gateways/:gatewayPublicId`; `:104-143` exposes filtered `tools/list`; `:146-195` dispatches `tools/call`. | A database gateway/profile/connection for QA was not inspected or created in this read-only task. |
| Named-token principal | `server/src/services/tool-gateway.ts:7100-7343` hashes the bearer and joins it to an active gateway/token; validates token status, expiry, action allowlist, company; `heartbeat_run` tokens validate UUID, active run, agent, and run context (`:7170-7240`). | The source does not prove which principal or token a historical `adm-qa` request used. A QA registration must use a dedicated agent/run-bound principal, not owner identity. |
| Run binding | For a bot `gateway_client`, `:7241-7307` selects the agent's single active run; zero or multiple active runs produce an unbound session. The session records `runId`, `agentId`, issue/project context, and `botGatewayRunBinding`. | This is configuration/code evidence, not runtime proof for `adm-qa`; a live initialize/list/call and audit row are still required. |
| Profile isolation | `server/src/services/tool-gateway.ts:5269-5290` selects only active/enabled MCP connections whose `toolProfileEntries.profileId` equals `session.gatewayProfileId`, same company, selector `connection`, and effect `include`. | The negative cross-profile runtime test was not executed. The code path supports the expected denial boundary; runtime proof requires two profiles and an attempted call from the wrong profile, with a 403/denial audit event. |
| Outbound network guard | `server/src/services/tool-gateway.ts:5293-5334` sends remote MCP JSON-RPC through `guardedRemoteHttpFetch`; `:3336-3356` supplies private-network policy and typed guard errors. `server/src/services/remote-http-fetch.ts:75-94` documents one-time resolution/address pinning, direct dialing, SNI/certificate hostname preservation, connected-address recheck, and no redirects. | This is SSRF/DNS-rebinding protection, not proof of a QA network ACL or endpoint assignment. In the reviewed call path I found endpoint/header credential resolution, but no established mTLS client-certificate wiring for the browser endpoint. That is an explicit integration gap, not permission to add one. |
| Browser bridge | `docs/myrmidon/guides/browser-bridge-gateway.md:26-37` documents a separate extension WebSocket `/bridge/v1`, pairing, and panel routes; `:46-69` documents capability negotiation and deny-by-default; `:97-106` documents the domain allowlist. | This bridge is not shown as an MCP connection consumed by `hermes_gateway`; pairing/device token and domain allowlist do not prove `adm-qa` access to the QA browser. |
| QA binding | OPE-15223 comment `f70088c9-9b39-416f-9a04-fb54ce07dffb` records the owner-provided binding name `QA_OPE15221_BROWSER` and origin, with an explicit prohibition on reading/publishing its value. OPE-15223 comment `ab7dfed2-e665-4a1e-93d1-b35f55f8e90e` records the safe historical use: parse the adapter env in `adm-qa`, create a temporary protected P12, use Playwright `clientCertificates`, do not disable TLS verification, and remove the temporary file. | Presence of the binding and a prior browser login do not prove that `hermes_gateway` can consume it. The binding value, cookies, session DB, and secret API were not read here. |
| UI path | OPE-15223 comment `d2164701-64ac-49c1-9022-d276323fc363` records the canonical viewer path `https://pr01.eatmeat.club:8445/OPE/adm`: login 200, target 200, native ADM UI mounted, and visible UI text. | The old `/adm` path was shown to resolve as an organization prefix, not the plugin page. Viewer plugin actions including `getSettings` returned 403 in the same report; this is an application permission/API boundary, not proof that the browser route is absent. |

## Proposed supported shape (not implemented or authorized)

1. Register a dedicated QA browser control-plane as an MCP remote connection under a dedicated tool profile.
2. Bind that profile only to `adm-qa`/its active run and issue a named gateway token whose allowed actions are limited to `initialize`, `tools/list`, and the required browser `tools/call` operations.
3. Make the remote connection resolve its endpoint and mTLS material through the existing credential-reference mechanism, without putting the binding value in an issue, prompt, log, or request body visible to the model. The reviewed source does not yet prove that client-certificate transport is supported; the browser-service owner must provide that contract or this design stops at the gap.
4. From the isolated QA runtime, use the secret binding only to establish the QA TLS/browser session; open the canonical company-scoped path `/OPE/adm`. Keep temporary material mode 0600, do not disable TLS verification, do not save storage state, and remove temporary material in `finally`.
5. Verify `initialize` → `tools/list` → one harmless browser operation, then verify the audit principal/run/profile. Separately attempt a browser call with a different profile/token and require a denial plus an audit record. Do not use shared CDP/8931 or owner identity.

## Required next evidence

The exact missing source is the registration/runtime contract that maps `adm-qa`, `QA_OPE15221_BROWSER`, the QA browser control-plane endpoint, and mTLS client credentials into a named MCP gateway connection usable by `hermes_gateway`. Until that contract and a live isolated negative test exist, the supported integration is not proven and no production change should be made.
