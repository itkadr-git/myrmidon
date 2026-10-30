# E2.6 application secret consumers (OPE-9039)

Basis: source on main after the shared resolver (PR #1730, `e5a3cbda4`) and the code in this PR. Source-only review; no environment or production secret values were read or changed.

Key finding of the per-name review: most `MYRMIDON_*_KEY_SECRET` variables do not hold a credential. They hold the NAME of a company secret, which the consumer resolves server-side through the existing secrets service (`readKey` / `secrets.getByKey` + `resolveSecretValue`). They are selectors (non-secret pointers into the standard store), already store-backed, and are not registered as instance secret settings. Registering them would put a pointer behind a pointer.

Value-carrying variables are registered in `server/src/myrmidon/secret-settings/registry.ts` and read through `resolveOptionalInstanceSecret` (`secret-settings/runtime.ts`): consumer scope, then the emergency env override (set and non-empty wins), then the bound ref. A missing ref reads as null (the optional integration stays off); a denied, inactive or revoked ref fails closed (null) and is logged by error code only. The ref is picked in the existing instance secret-settings API and the OPE-9034 picker (#1736); the dry-run `migration-plan` lists the new names without values.

Tests: `server/src/myrmidon/secret-settings/consumers.myrmidon.test.ts` (per registered name: missing ref, denied consumer, change, revoke/inactive, env priority, no value in status/plan/errors; tracing and browser-console wiring).

| E1 name | Evidence | Disposition |
|---|---|---|
| `MYRMIDON_STACK_GITHUB_TOKEN` | `stack-registry/settings.ts`, `check.ts` | Value. Registered `stack.github_token`, consumer `stack-registry`; `checkStackReleases` resolves per run. Env is the emergency override. |
| `MYRMIDON_TRACING_CLICKHOUSE_PASSWORD` | `tracing-health/probes.ts` (`withClickhousePassword`), `routes.ts`, `attention-sweep.ts` | Value. Registered `tracing.clickhouse_password`, consumer `tracing-health`; resolved per check, env wins. |
| `MYRMIDON_BROWSER_CONSOLE_TOKEN` | `browser-console/screen-console-client.ts` (`lazyScreenConsoleClient`), `wiring.ts` | Value. Registered `browser_console.node_token`, consumer `browser-console`; resolved per call, so change/revoke apply without restart. Unconfigured answers 503. |
| `MYRMIDON_ACCESS_HUB_SSH_ADMIN_KEY_SECRET` | `access-hub/routes.ts:311-316` | Selector: NAME of a company secret, resolved through the secrets service. Store-backed, not registered. |
| `MYRMIDON_CTO_CHAT_KEY_SECRET` | `cto-chat/settings.ts:67` | Selector (secret name). Store-backed. |
| `MYRMIDON_DEBATE_KEY_SECRET` | `debates/gateway.ts:37` | Selector (secret name, falls back to the evals name). Store-backed. |
| `MYRMIDON_DISTILL_KEY_SECRET` | `distill/settings.ts:121` | Selector (secret name). Store-backed. |
| `MYRMIDON_EVALS_KEY_SECRET` | `evals/judge.ts:88`, `debates/gateway.ts:24` | Selector (secret name). Store-backed. |
| `MYRMIDON_EVALS_API_KEY` | `scent/queue.ts:75`, `scent/routes.ts:49` | Not an env read: it is the default company-secret NAME used when `MYRMIDON_SCENT_KEY_SECRET` is unset. Store-backed. |
| `MYRMIDON_SCENT_KEY_SECRET` | `scent/queue.ts:36` | Selector (secret name). Store-backed. |
| `MYRMIDON_FORAGING_KEY_SECRET` | `foraging/settings.ts:65`, `reader.ts:107` | Selector (secret name). Store-backed. |
| `MYRMIDON_OCR_KEY_SECRET` | `ocr/settings.ts:76` | Selector (secret name). Store-backed. |
| `MYRMIDON_STT_KEY_SECRET`, `MYRMIDON_STT_DEEPGRAM_KEY_SECRET` | `stt/settings.ts:108-119` | Selectors (secret names; Deepgram falls back to the generic one). Store-backed. |
| `MYRMIDON_LITELLM_KEY_SECRET` | `litellm-costs/litellm-costs.ts:93`, `tracing-health/probes.ts:62` | Selector (secret name). Store-backed. |
| `MYRMIDON_LITELLM_ADMIN_KEY_SECRET` | `litellm-budget-sync/sweep.ts:51`, `routes.ts:54` | Selector (secret name). Store-backed. |
| `MYRMIDON_METRICS_TOKEN_SECRET`, `MYRMIDON_METRICS_TOKEN` | `monitoring/metrics/routes.ts` (`resolveMetricsToken`) | Already the target contract: secret-name lookup through the store, plain env only as the emergency fallback. Not duplicated. |
| `MYRMIDON_EVALS_LANGFUSE_KEY` | `evals/langfuse.ts:15,28` | Non-secret: the code documents it as a static Langfuse PUBLIC key (basic-auth user part, empty password). An identifier, not a credential; not moved. |
| `MYRMIDON_ALERTS_WEBHOOK_TOKEN_REF`, `MYRMIDON_ZABBIX_TOKEN_REF` | `monitoring/alerts/token.ts`, `maintenance/zabbix.ts` (`env:<NAME>` / `file:<path>`) | Pointers, not values; the referent is a deployment env var or a mounted file (Docker secret). Zabbix has a live consumer and test (the E1 note that none was found is stale). Kept: file-mounted secrets are the preferred deployment form; a `secret:` scheme is a follow-up, not needed for the release. |
| `MYRMIDON_BROWSER_BRIDGE_PEPPER` | `browser-bridge/index.ts:100` | Bootstrap, env only. Process-wide HMAC pepper read at module start; rotation invalidates every pairing, and it is needed before any request/DB context. Unset gives a random per-start pepper and a fail-closed pairing (documented inline). Threat model: it is derived key material, never returned; env or file mount only. Not registered. |
| `MYRMIDON_DECISION_SIGNING_SECRET`, `MYRMIDON_TOOL_ACTION_SIGNING_SECRET` | `secret-masking.ts:28-29`, `services/decision-signing.ts`, `services/tool-content-guards.ts`, `worktree-config.ts` | Bootstrap, env (or generated key file) only. Integrity keys: anyone who can write the store could mint signatures if the key lived beside the data it protects, and a rebind would invalidate stored signatures. Read before the store is available. Masked in logs (aliases `PAPERCLIP_*`). Not registered. |

Not claimed: no value was migrated, rotated or read; no production configuration was touched.
