# Google AI connector owner guide

> Русская версия: [Google-ai-connector.ru](Google-ai-connector.ru)


Status: C4 documentation update, based on the OPE-9128 source matrix checked 2026-10-25. This guide does not install the connector, grant access, or prove production readiness.

## 1. Connect and check status

Use the approved board/plugin owner path. Do not paste cookies, tokens, or keys into chat, tickets, source files, or logs.

1. Confirm the `google-ai-mcp` service is connected.
2. Read `GET /v1/health` and record only non-secret session state, service version, and quota/account status.
3. Confirm the agent's access profile/grant. Do not change grants or model settings without owner authorization.
4. If the approved deployment endpoint differs from `/v1/health`, record that exact endpoint in the verification result.

The source contract defines `/v1/health` with `session`, `quota`, and `version`. The owner report in OPE-9128 observed health 200 and `session: ok`, `multi=true`, with accounts 6/10/11 `ok` and 3/12 stale at the stated time. That is a historical owner observation, not current readiness.

## 2. Access and first test

The owner grants access through the board/plugin access profile. The source describes a plugin trial route for text/image/video and MCP tools, but no paid or live trial was performed for this C4. Before calling a tool, confirm the live tool is enabled and the account is authorized.

For a safe trial, use a non-sensitive prompt and record only success/error category and returned artifact path. Do not copy credentials or private prompts into the ticket.

## 3. Three tools

- `generate_image`, `kind: image`: available only when the connected service and access profile report it enabled. Returned paths are workspace paths and are not automatically portable.
- `creative_text`, `kind: text`: one-off text generation. It does not switch the agent's model channel.
- `generate_video`, `kind: video`: source code contains conditional video routing and a queued-job contract, but current production availability is unknown. Do not claim it is enabled or disabled without a current check.

Do not fabricate results. Do not retry in a loop after quota, transport, or session errors.

## 4. Gemini as the agent text model

The source defines additive OpenAI-compatible `/v1/models` and `/v1/chat/completions` contracts. If the live deployment exposes them, discover model IDs dynamically from `/v1/models`; never hardcode an ID. Select a model only from the owner-approved board allowlist.

The source documents audit attribution from `X-Agent-Id`, then request `user`, then configured default. Confirm the deployment's actual attribution behavior with an owner-approved read-only check before promising it. Model discovery, model-to-deployment mapping, allowlists, and complete agent responses were not confirmed live in OPE-9128; the owner report recorded `/v1/models` and `/v1/chat/completions` as 404 at that time.

Streaming and automatic fallback are not promised. The source says `stream: true` returns `501 not_implemented`; verify any later deployment change before documenting otherwise.

## 5. Errors, quotas, expiry, reconnect

- `session_stale` / HTTP 401: stop and ask the owner to reconnect through the approved board/plugin flow. Never request cookie values.
- `quota_exceeded`, `quota_paused`, `quota_refused` / HTTP 429: report the category and non-secret health/account status; do not loop retries.
- `transport_error` / HTTP 502: report the category and endpoint context without secrets; owner investigates.
- `video_disabled` / HTTP 403 and `job_not_found` / HTTP 404: preserve the returned category and follow the owner runbook.

The source describes session refresh, quota counters, account pools, and possible next-account routing. Production enablement and exact reconnect/fallback policy remain unknown. After the owner confirms reconnect or quota reset, read health again before retrying once.

## Evidence and handoff

Source matrix: OPE-9128, including module source HEAD `ccd89f0342caad62c8e4e9faa632fa2bab188370` and the owner report for tag `sha-51bd5e4`. The source/tests use fake transport and do not prove Google production behavior. The source EN/RU guides are preserved as reference; this owner guide is a synchronized C4 summary, not a replacement for those files.
