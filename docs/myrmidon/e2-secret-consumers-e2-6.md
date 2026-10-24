# E2.6 application secret consumer inventory (OPE-9039)

Audit basis: source on main `bf496ae5493081a6df3f2118745b6756c232e35c` (shared resolver PR #1730). This is a source-only review; no environment values or production secret values were read. The E2.1 resolver is instance-setting scoped. It must not be applied to process-wide configuration, agent credentials, or one-way signing material without an explicit scope/security design. `MYRMIDON_DECISION_SIGNING_SECRET` and `MYRMIDON_TOOL_ACTION_SIGNING_SECRET` are registered by `server/src/myrmidon/secret-masking.ts` under aliases `PAPERCLIP_DECISION_SIGNING_SECRET` and `PAPERCLIP_TOOL_ACTION_SIGNING_SECRET`; the E1-named variables are not directly read there.

Status vocabulary:
- Existing secret-store path: source already resolves a named secret; still needs explicit UI/binding and the OPE-9034 slice-2 picker unless stated otherwise.
- Process env: current consumer reads process configuration. No safe scoped ref integration is present in this slice.
- Decision required: semantics are one-way key material or existing `_REF`; do not migrate by treating it as an ordinary credential setting.

| E1 name | Current source / evidence | Current disposition | E2.6 integration status |
|---|---|---|---|
| `MYRMIDON_ACCESS_HUB_SSH_ADMIN_KEY_SECRET` | `server/src/myrmidon/access-hub/routes.ts` (`ACCESS_HUB_SSH_ADMIN_KEY_SECRET_ENV`) | Process env | Gap: access-hub runtime reads env; needs explicit instance binding and admin picker. |
| `MYRMIDON_ALERTS_WEBHOOK_TOKEN_REF` | `server/src/myrmidon/monitoring/alerts/token.ts`; `token.myrmidon.test.ts`; `routes.ts` | Existing `_REF` token-ref contract | Gap: retain ref semantics; do not wrap as another plaintext binding. Verify target picker and server-side scope. |
| `MYRMIDON_BROWSER_BRIDGE_PEPPER` | `server/src/myrmidon/browser-bridge/index.ts` | Process env; random per-start fallback and fail-closed pairing behavior documented inline | Decision required: process-wide HMAC pepper; rotation affects existing pairings. Not an ordinary setting. |
| `MYRMIDON_BROWSER_CONSOLE_TOKEN` | `server/src/myrmidon/browser-console/screen-console-client.ts` | Process env | Gap: privileged node bearer credential, currently paired with host configuration. Needs scope/UI design. |
| `MYRMIDON_CTO_CHAT_KEY_SECRET` | `server/src/myrmidon/cto-chat/settings.ts`; `agent-chat-bridge/commands/plan.myrmidon.test.ts` | Process env | Gap: server consumer; needs explicit binding, masking and missing/denied/rotation tests. |
| `MYRMIDON_DEBATE_KEY_SECRET` | `server/src/myrmidon/debates/gateway.ts`; `gateway.myrmidon.test.ts` | Process env | Gap: gateway provider credential. |
| `MYRMIDON_DECISION_SIGNING_SECRET` | alias only in `server/src/myrmidon/secret-masking.ts` (`PAPERCLIP_DECISION_SIGNING_SECRET`) | E1 name is not directly consumed in main source | Decision required: signing key is integrity-critical and should not be rebound without rotation/verification design. |
| `MYRMIDON_DISTILL_KEY_SECRET` | `server/src/myrmidon/distill/settings.ts`; `distill-domain.test.ts`, `flags-killswitch.myrmidon.test.ts` | Process env | Gap: distill provider credential. |
| `MYRMIDON_EVALS_API_KEY` | `server/src/myrmidon/scent/queue.ts`; `scent/routes.ts` | Process env | Gap: external eval API consumer. |
| `MYRMIDON_EVALS_KEY_SECRET` | `server/src/myrmidon/debates/gateway.ts`; evals routes/judge/index tests and code | Process env | Gap: eval provider credential. |
| `MYRMIDON_EVALS_LANGFUSE_KEY` | `server/src/myrmidon/evals/langfuse.ts` | Process env | Gap: Langfuse integration. |
| `MYRMIDON_FORAGING_KEY_SECRET` | `server/src/myrmidon/foraging/domain.ts`; `reader.myrmidon.test.ts`, `settings.myrmidon.test.ts` | Process env | Gap: foraging provider credential. |
| `MYRMIDON_LITELLM_ADMIN_KEY_SECRET` | `server/src/myrmidon/litellm-budget-sync/routes.ts`, `sweep.ts`; `litellm-sync`, provider wiring and related tests | Process env | Gap: shared admin credential used across modules; coordinate its binding/consumer boundary before wiring. |
| `MYRMIDON_LITELLM_KEY_SECRET` | `server/src/myrmidon/litellm-costs/litellm-costs.ts`, `attention.ts`, `litellm-fallback-signal/sweep.ts`, `tracing-health/probes.ts`; tests | Process env | Gap: shared LiteLLM consumer across cost, fallback and tracing modules; define one scope and consumer set. |
| `MYRMIDON_METRICS_TOKEN` | `server/src/myrmidon/monitoring/metrics/routes.ts` (`resolveMetricsToken`) | Emergency process env fallback | Existing env precedence is after secret-name lookup; acceptance test/evidence exists in module tests. |
| `MYRMIDON_METRICS_TOKEN_SECRET` | `server/src/myrmidon/monitoring/metrics/routes.ts` (`resolveMetricsToken`); metrics tests | Existing company-secret name lookup; server-side value read | Existing secret-store path. Gap: settings UI/binding and formal scoped consumer integration. |
| `MYRMIDON_OCR_KEY_SECRET` | `server/src/myrmidon/ocr/index.ts`, `settings.ts`; `runtime.myrmidon.test.ts` | Process env | Gap: OCR provider credential. |
| `MYRMIDON_SCENT_KEY_SECRET` | `server/src/myrmidon/scent/queue.ts` | Process env | Gap: scent provider credential. |
| `MYRMIDON_STACK_GITHUB_TOKEN` | `server/src/myrmidon/stack-registry/settings.ts`, `releases.ts`; `stack-check.myrmidon.test.ts` | Process env | Gap: GitHub API token. |
| `MYRMIDON_STT_DEEPGRAM_KEY_SECRET` | `server/src/myrmidon/stt/backend-deepgram.ts`, `settings.ts` | Process env | Gap: Deepgram credential; share STT binding contract with generic STT key. |
| `MYRMIDON_STT_KEY_SECRET` | `server/src/myrmidon/stt/settings.ts` | Process env | Gap: generic STT provider credential. |
| `MYRMIDON_TOOL_ACTION_SIGNING_SECRET` | alias only in `server/src/myrmidon/secret-masking.ts` (`PAPERCLIP_TOOL_ACTION_SIGNING_SECRET`); tool guard tests | E1 name is not directly consumed in main source | Decision required: action-signing integrity key; preserve alias semantics and design rotation. |
| `MYRMIDON_TRACING_CLICKHOUSE_PASSWORD` | `server/src/myrmidon/tracing-health/probes.ts`; `routes.myrmidon.test.ts` | Process env | Gap: tracing probe DB credential; avoid exposing connection details in status/errors. |
| `MYRMIDON_ZABBIX_TOKEN_REF` | `server/src/myrmidon/maintenance/zabbix.ts`; `zabbix.test.ts` | Existing `_REF` (`env:`/`file:`) resolver | The E1 note that direct use was not found is stale: current main has direct consumer and test. Do not duplicate as ordinary secret value; secret-store reference and scope/UI need reconciliation. |

## Acceptance gap

This inventory does not claim implementation of secret-ref bindings for the process-env entries. Most are process configuration loaded outside an authenticated request; a server-side resolver needs an explicit instance/process scope, consumer id, reload behavior, masking registration, failure mode, and rotation impact. Browser bridge pepper and signing keys additionally affect authentication/integrity and require an approved rotation design. Existing alert, metrics and Zabbix reference mechanisms must be reconciled rather than duplicated. The UI picker dependency is the OPE-9034 slice 2 noted in the assignment.

No values were migrated, read from runtime environments, or changed. No production configuration was touched.
