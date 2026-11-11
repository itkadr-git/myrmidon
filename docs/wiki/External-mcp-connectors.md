# External MCP connectors: connect without fork code

> Русская версия: [External-mcp-connectors.ru](External-mcp-connectors.ru)

The board can connect a standards-compliant external MCP server — any HTTP
MCP endpoint the company operates or trusts — and hand its tools to selected
agents. Nothing in this guide is fork code: it is the vendor's generic
connection surface, described here because the deployment kept assuming a
custom extension point was needed. This guide is the delivery for the
"generic extension point" feature and the operator runbook for connecting a
new external MCP service.

## What already exists (the scout verdict)

The vendor surface, checked against `main` on 2026-10-02:

- **Company-scoped registry.** A connection row in `tool_connections`
  (company id, name, transport `mcp_remote`, `config.url`, status,
  enabled, health). Created without a code change through either entry
  point below.
- **Credentials via the secret service.** Bearer keys, custom headers,
  OAuth clients — every value becomes a Myrmidon secret, write-only,
  never echoed back. `McpConnectionCredentialRef` binds the secret to the
  connection; the tool gateway resolves it at call time
  (`server/src/services/tool-gateway.ts`, `secrets.resolveSecretValue`).
- **Per-agent grants.** Two layers: installs
  (`tool_connection_installs`, target `company` or `agent`) and tool
  profiles (entries per connection, bindings to agent/project/routine/
  issue, `defaultAction: deny`, per-tool allowlist, ask-first risk
  levels). An outside agent gets `deny_default` — proven by the vendor
  test `gives a generic connection the same review, access, install,
  gateway and revoke path`.
- **Agent-facing proxy.** Agents never dial the MCP endpoint directly:
  the run carries the assigned tool set (`resolveAgentAssignedToolSet` in
  `server/src/services/agent-assigned-tools.ts`) and every call goes
  through the tool gateway with the company's grant policy deciding
  allow/deny/require_approval. Tool names arrive namespaced as
  `mcp.<connection>:<tool>` (`connectedMcpToolsForCompany`).
- **Security rail.** SSRF/private-network guard with DNS pinning
  (`server/src/services/remote-http-endpoint-guard.ts`), header name
  allowlist (`packages/shared/src/mcp-remote-headers.ts`), OAuth endpoint
  validation (CIMD, DCR, PKCE) — all enforced for generic connections the
  same as curated ones.

What is **missing** and genuinely has no vendor surface: nothing found that
the rollout needs. Private-network plain-HTTP endpoints (a connector
container on the board network) are accepted because this deployment runs
`PAPERCLIP_DEPLOYMENT_MODE=authenticated` with
`PAPERCLIP_DEPLOYMENT_EXPOSURE=private` — the guard allows private
addresses in that mode. A public `authenticated/public` instance would
refuse them (`remote_http_private_endpoint`), and that is the documented
vendor behaviour, not a fork gap.

## The two entry points

| Route | Where | Use when |
| --- | --- | --- |
| Guided URL | Apps → Connect an app → **Connect your own MCP server** | You have the server's address; the board probes it and walks through auth. |
| Paste a config | Apps → Advanced → **Paste a config** | The service README gives an `mcpServers` JSON snippet, or it needs custom header names. |

Both normalize through the same backend contract; auth discovery, secret
handling, catalog refresh and review cannot diverge between them.

The authoritative vendor document is
[doc/connections/GENERIC-REMOTE-MCP.md](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/../../doc/connections/GENERIC-REMOTE-MCP.md)
in this repository; read it for the OAuth tiers, the "Unverified server"
labelling and the protocol conformance notes.

## Runbook: connect a new external MCP service

1. **Bring the service up on the board network** (its own container; the
   board's docker network name is deployment-specific). The endpoint must
   answer MCP Streamable HTTP (`initialize`, `tools/list`, `tools/call`).
2. **Connect.** Apps → Connect an app → Connect your own MCP server →
   paste `http://<host>:<port>/mcp` → **Check link**. Choose
   authentication:
   - no sign-in — the service is open on the network;
   - key or token — sent as `Authorization: Bearer ***`
   - custom headers — when the service names its own header(s);
   - advanced paste — when the service README ships an `mcpServers`
     snippet (custom header names survive this route).
   Every value entered becomes a company secret; only header *names* are
   ever displayed again.
3. **Review the catalog.** Discovered actions are listed; reads can be
   enabled for review, state-changing actions start off, newly discovered
   actions are quarantined until reviewed. Enable exactly the actions the
   agents should get.
4. **Grant to agents.** In access selection pick the agents (per-agent) or
   the whole company. Default profile is `deny` with explicit includes, so
   an unlisted agent sees nothing. Adjust later under Apps → Advanced →
   Profiles, or per agent in the agent card's tools section.
5. **Verify from a run.** Wake an agent that got the grant and ask it to
   list its MCP tools; the new tools appear as
   `mcp.<connection-name>…:<tool>`. A call from an ungranted agent is
   denied with `deny_default`.
6. **Health.** The connection card shows health status and message; a
   failing service turns the card to "needs attention" but — per fork row
   P9 — one tool's failure does not hide the connection's other tools, and
   a slow call does not mark the connection dead.

## Secrets rotation

Rotate a credential by re-entering the value on the connection
(reconnect) — the new value becomes a new secret version and the old one
is no longer used. The rotation flow for an owner-provided session
(cookie jar) is a connector-side concern: the connector service writes
the refreshed value back through the board secret-rotation REST API; the
connection keeps pointing at the same secret name, so no board-side
action is needed for routine refreshes.

## Gateway token lifetime and expiry monitoring

External clients connecting to the board's MCP gateway use gateway tokens (`tool_mcp_gateway_tokens`). To prevent unexpected service interruptions or abandoned credentials, the platform monitors token lifecycles through the operator attention feed (`mcp_gateway_token_expiring`):

- **14-day warning window**: Any active (unrevoked) token with `expiresAt <= now + 14 days` surfaces an attention card on the operator desk. Tokens with indefinite lifespans (`expiresAt IS NULL`) or already revoked tokens are omitted.
- **Rotation vs. revocation guidance**:
  - **Tokens expiring soon or active expired tokens**: Recommend `rotate` (verbs: `rotate`, `revoke` for expired, `dismiss`). Operators can generate a replacement token and update clients prior to or immediately after expiry.
  - **Expired unused tokens (`lastUsedAt` is null)**: Recommend `revoke` (verbs: `revoke`, `rotate`, `dismiss`). If a token expired without handling any calls, the card prompts revocation. Expired unused tokens are **never auto-revoked** — the operator maintains governance.
- **Credential confidentiality**: Cards never expose raw tokens, `tokenHash`, or `tokenPrefix` in card subjects, explanations, or metadata. Cards link directly to the gateway settings page (`/<prefix>/settings/gateways/:gatewayId`).
- **Card resolution**: The notice clears automatically once the operator rotates or revokes the token, updates its expiration date, or dismisses the card.

## What this deployment must check before going live

- The board env is `PAPERCLIP_DEPLOYMENT_MODE=authenticated`,
  `PAPERCLIP_DEPLOYMENT_EXPOSURE=private` — private endpoints are
  accepted. Do not flip exposure to `public` while a private-network
  connector is connected, or every call to it will fail the guard.
- The MCP service container must be on a network the board server can
  reach, and its name must resolve from the board process (the guard
  resolves and pins DNS before dialing).
- Credentials live in the company secret store, not in compose files.

## Related

- Fork row P9 (tool gateway resilience) changes how a failing tool
  affects the connection — see [../DIVERGENCE.md](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/DIVERGENCE.md),
  track 3.
- The vendor's governance document:
  [doc/MCP-ACCESS-GOVERNANCE.md](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/../../doc/MCP-ACCESS-GOVERNANCE.md).
