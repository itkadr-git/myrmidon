# Environment inventory for SETTINGS (OPE-4102)

This inventory scans tracked `server/src` files at PR HEAD `4d42181fd3303d0c859b6369a1ccd34b5399b867`. It compares literal
`process.env.KEY` / `env.KEY` and bracket accesses with EN and RU SETTINGS rows
and the pending SETTINGS fragment. Dynamic names (notably `MYRMIDON_MCP_TOKEN_*`)
need separate source review; this static scan does not claim to find dynamic keys.
Do not count every token in a comment, fixture or string as an environment read.

Reproduce on the exact checked-out PR head (not `origin/main`):

```bash
git rev-parse HEAD
git ls-files server/src | xargs rg -n 'process\.env|\benv[.\[]' > "$TMPDIR/ope-4102-env-reads.txt"
rg -n 'MYRMIDON_MCP_TOKEN_|MYRMIDON_BOT_CANARY_|PAPERCLIP_TEST_CAPTURE_PATH' server/src
node scripts/myrmidon/release/collect-fragments.mjs --version 0.0.0 --dry-run
```

For each exact `MYRMIDON_*` or `PAPERCLIP_*` identifier in those reads,
compare its first-column row in both `docs/myrmidon/SETTINGS.md` and
`docs/myrmidon/SETTINGS.ru.md`, including the pending
`docs/myrmidon/changes/settings-docs-ope-4102.md` fragment. The inventory below
records a representative source path for each match. Some `env` objects are
function arguments rather than `process.env`; inspect the listed consumer for context.
Wildcard rows cover generated keys with the listed prefix. This is a literal
static audit, not a runtime assertion of all possible computed env names.

The eight broken RU canary rows (`240i|` to `247i|`) already exist on main.
The `settings-ru-replace` block in this PR targets their real first cells and
replaces them with clean `|` rows at release collection. The fragment collector
recognizes numeric-prefixed rows. The source registry is not edited directly
because the release collector owns registry publication.

## Coverage decisions

- `EN+RU`: a matching row (or wildcard) exists in each registry or pending fragment.
- `Added: behavior`: a behavioral env override was missing. This PR adds EN/RU
  rows with the "UI (1.7)" migration marker. It does not implement the UI.
- `Excluded: infrastructure`: a service credential, deployment binding, host
  path or capacity/tenant-control knob. It is listed individually below;
  do not move it into a UI setting. Keep credentials in a secret store.
- `Excluded: vendor`: a `PAPERCLIP_*` compatibility/internal input. This
  follows the vendor-default exclusion stated in SETTINGS, except the
  `PAPERCLIP_TEST_CAPTURE_PATH` test harness row, which is explicitly documented.
- `Excluded: test`: only test or fixture consumers; not a production setting.
  These names are still enumerated below, rather than omitted from the count.

## Exact-head reconciliation

| Variable | EN row | RU row | Classification | Reason and representative source |
|---|---|---|---|---|
Literal env reads: 222. Every read has exactly one row below.

- Added: behavior: 20
- EN+RU: 53
- Excluded: infrastructure: 15
- Excluded: test: 133
- Excluded: vendor: 1

| `MYRMIDON_ACCESS_HUB_SSH_TIMEOUT_MS` | yes | no | Excluded: infrastructure | SSH transport timeout; infrastructure override; `server/src/myrmidon/access-hub/ssh-ops.ts` |
| `MYRMIDON_ADAPTER_MODELS` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/adapter-models.test.ts` |
| `MYRMIDON_AGENT_ID` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/heartbeat-local-environment.test.ts` |
| `MYRMIDON_AGENT_JWT_SECRET` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/agent-conversations.test.ts` |
| `MYRMIDON_ALERT_RECOVERY_HOLD_MINUTES` | yes | yes | Added: behavior | UI (1.7) override; pending EN/RU fragment; `server/src/myrmidon/monitoring/alert-recovery/issues.ts` |
| `MYRMIDON_API_KEY` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/heartbeat-local-environment.test.ts` |
| `MYRMIDON_API_URL` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/heartbeat-local-environment.test.ts` |
| `MYRMIDON_AUTH_DISABLE_SIGN_UP` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/better-auth-credential-signup.integration.test.ts` |
| `MYRMIDON_AUTH_SELF_SIGN_UP` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/users-admin-a.integration.test.ts` |
| `MYRMIDON_BOT_CONTAINERS` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/__tests__/server-startup-feedback-export.test.ts` |
| `MYRMIDON_BOT_SCOPE_ROOT` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/myrmidon/bot-containers/scope-wiring.ts` |
| `MYRMIDON_BOT_VOLUME_ROOT` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/myrmidon/architect-data/service.ts` |
| `MYRMIDON_BROWSER_BRIDGE_PEPPER` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/myrmidon/browser-bridge/index.ts` |
| `MYRMIDON_BROWSER_FLEET` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/myrmidon/browser-console/service.ts` |
| `MYRMIDON_CHANNEL_ACCESS_MODE` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/__tests__/chat-telegram-dm-conversation.myrmidon.test.ts` |
| `MYRMIDON_CHAT_RECONCILE_FALLBACK_INTERVAL_MS` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/myrmidon/chat-reconciliation/reconcile-interval.ts` |
| `MYRMIDON_CHAT_RECONCILE_INTERVAL_MS` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/myrmidon/chat-reconciliation/reconcile-interval.ts` |
| `MYRMIDON_CLOUD_API_ORIGIN` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/cloud-runtime-identity.test.ts` |
| `MYRMIDON_CLOUD_CONNECTOR_REDIRECT_BASE` | yes | no | Excluded: infrastructure | Cloud connector redirect origin; deployment-only; `server/src/myrmidon/cloud-connector/index.ts` |
| `MYRMIDON_COMPANY_ID` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/heartbeat-local-environment.test.ts` |
| `MYRMIDON_CONFIG` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/dev-runner-worktree.test.ts` |
| `MYRMIDON_CONTEXT` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/dev-runner-worktree.test.ts` |
| `MYRMIDON_CONTINUATION_ENVELOPE_BYTES` | no | no | Excluded: test | Only test/fixture consumers; `server/src/services/execution-continuation.myrmidon.test.ts` |
| `MYRMIDON_CONTINUATION_HISTORY_CHARS` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/services/execution-continuation.myrmidon.test.ts` |
| `MYRMIDON_CONTINUATION_HISTORY_LIMIT` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/services/execution-continuation.myrmidon.test.ts` |
| `MYRMIDON_CONTINUATION_MESSAGE_CHARS` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/services/execution-continuation.myrmidon.test.ts` |
| `MYRMIDON_CONTINUATION_MESSAGE_MAX_CHARS` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/services/execution-continuation.myrmidon.test.ts` |
| `MYRMIDON_CTO_CHAT_BASE_URL` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/myrmidon/agent-chat-bridge/commands/plan.myrmidon.test.ts` |
| `MYRMIDON_CTO_CHAT_KEY_SECRET` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/myrmidon/agent-chat-bridge/commands/plan.myrmidon.test.ts` |
| `MYRMIDON_DATABASE_URL` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/server-startup-feedback-export.test.ts` |
| `MYRMIDON_DATA_DIR` | no | no | Excluded: infrastructure | Assistant data directory; filesystem deployment path; `server/src/routes/admin-assistant.ts` |
| `MYRMIDON_DB_BACKUP_CATCHUP_WINDOW` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/myrmidon/runs-queue-settings/live.ts` |
| `MYRMIDON_DB_BACKUP_FILE_PREFIX` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/myrmidon/data-retention/backup-gate.ts` |
| `MYRMIDON_DEPLOY_HEALTH_URL` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/myrmidon/deploy-jobs/index.ts` |
| `MYRMIDON_DEPLOY_REGISTRY_INSPECT_URL` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/myrmidon/deploy-jobs/settings.ts` |
| `MYRMIDON_DEPLOY_REPORTS_DIR` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/myrmidon/deploy-jobs/index.ts` |
| `MYRMIDON_DEPLOY_UPDATE_MODE` | yes | yes | Added: behavior | UI (1.7) override; pending EN/RU fragment; `server/src/myrmidon/deploy-jobs/auto-update.ts` |
| `MYRMIDON_DEPLOY_UPDATE_WINDOW_DAYS` | yes | yes | Added: behavior | UI (1.7) override; pending EN/RU fragment; `server/src/myrmidon/deploy-jobs/auto-update.ts` |
| `MYRMIDON_DEPLOY_UPDATE_WINDOW_FROM` | yes | yes | Added: behavior | UI (1.7) override; pending EN/RU fragment; `server/src/myrmidon/deploy-jobs/auto-update.ts` |
| `MYRMIDON_DEPLOY_UPDATE_WINDOW_TO` | yes | yes | Added: behavior | UI (1.7) override; pending EN/RU fragment; `server/src/myrmidon/deploy-jobs/auto-update.ts` |
| `MYRMIDON_DEVFLOW_APPROVED_NOT_MERGED_MS` | yes | yes | Added: behavior | UI (1.7) override; pending EN/RU fragment; `server/src/myrmidon/devflow-health/thresholds.ts` |
| `MYRMIDON_DEVFLOW_NO_MERGES_MS` | yes | yes | Added: behavior | UI (1.7) override; pending EN/RU fragment; `server/src/myrmidon/devflow-health/thresholds.ts` |
| `MYRMIDON_DEV_PROCESS_PROJECT_IDS` | no | no | Excluded: infrastructure | Internal review continuation project allowlist; `server/src/myrmidon/review-continuation.ts` |
| `MYRMIDON_DISABLE_HERMES_LOCAL` | yes | yes | Added: behavior | UI (1.7) override; pending EN/RU fragment; `server/src/adapters/registry.ts` |
| `MYRMIDON_EVALS_API_KEY` | no | no | Excluded: test | Only test/fixture consumers; `server/src/myrmidon/scent.myrmidon.test.ts` |
| `MYRMIDON_EVALS_BASE_URL` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/myrmidon/features/ports.ts` |
| `MYRMIDON_EXECUTION_LIVE_SIGNAL_WINDOW_SEC` | no | no | Excluded: test | Only test/fixture consumers; `server/src/services/execution-projection.test.ts` |
| `MYRMIDON_FLEET_HOSTS` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/myrmidon/bot-containers/fleet-move-wiring.ts` |
| `MYRMIDON_FLEET_HOSTS_COMPANY_IDS` | no | no | Excluded: infrastructure | Fleet host tenant scope; deployment-only; `server/src/myrmidon/bot-containers/site-registry.ts` |
| `MYRMIDON_GITHUB_EVENTS_MAX_SILENCE_MIN` | yes | yes | Added: behavior | UI (1.7) override; pending EN/RU fragment; `server/src/services/github-connection-events.ts` |
| `MYRMIDON_GITHUB_VENDOR_CONNECTOR` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/__tests__/setup-supertest.ts` |
| `MYRMIDON_GUARDRAILS_INJECTION_ENABLED` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/myrmidon/guardrails/routes-modes.myrmidon.test.ts` |
| `MYRMIDON_GUARDRAILS_INJECTION_SCORE` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/myrmidon/guardrails/routes-modes.myrmidon.test.ts` |
| `MYRMIDON_GUARD_RETURN_INTERVAL_SEC` | yes | yes | Added: behavior | UI (1.7) override; pending EN/RU fragment; `server/src/myrmidon/guard-return/sweep.ts` |
| `MYRMIDON_HA_GEO_STANDBY_URL` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/ha-routes.test.ts` |
| `MYRMIDON_HINDSIGHT_API_KEY` | no | no | Excluded: test | Only test/fixture consumers; `server/src/myrmidon/agent-memory/hindsight-models-adapter.myrmidon.test.ts` |
| `MYRMIDON_HOME` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/dev-runner-worktree.test.ts` |
| `MYRMIDON_HOST_DISK_CONSUMER_PATHS` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/myrmidon/host-disk/index.ts` |
| `MYRMIDON_HOST_DISK_DATA_ROOT` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/myrmidon/host-disk/index.ts` |
| `MYRMIDON_IDLE_START_HEALTH_TIMEOUT_MS` | yes | yes | Added: behavior | UI (1.7) override; pending EN/RU fragment; `server/src/myrmidon/idle-stop-startup.ts` |
| `MYRMIDON_IDLE_STOP_AFTER_SEC` | yes | yes | Added: behavior | UI (1.7) override; pending EN/RU fragment; `server/src/myrmidon/idle-stop-startup.ts` |
| `MYRMIDON_IDLE_STOP_ENABLED` | yes | yes | Added: behavior | UI (1.7) override; pending EN/RU fragment; `server/src/myrmidon/idle-stop-startup.ts` |
| `MYRMIDON_INFRA_INTERRUPT_CODES` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/services/legacy-execution-recovery.myrmidon.test.ts` |
| `MYRMIDON_INSTANCE_ID` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/dev-runner-worktree.test.ts` |
| `MYRMIDON_IN_WORKTREE` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/dev-runner-worktree.test.ts` |
| `MYRMIDON_KNOWLEDGE_GATE_MODE` | yes | yes | Added: behavior | UI (1.7) override; pending EN/RU fragment; `server/src/myrmidon/knowledge-gate/guard.myrmidon.test.ts` |
| `MYRMIDON_KNOWLEDGE_GATE_START_DATE` | yes | yes | Added: behavior | UI (1.7) override; pending EN/RU fragment; `server/src/myrmidon/knowledge-gate/guard.ts` |
| `MYRMIDON_LESSON_DISTILL_ENABLED` | yes | yes | Added: behavior | UI (1.7) override; pending EN/RU fragment; `server/src/myrmidon/lesson-distill/settings.ts` |
| `MYRMIDON_LESSON_DISTILL_PERIOD_MINUTES` | yes | yes | Added: behavior | UI (1.7) override; pending EN/RU fragment; `server/src/myrmidon/lesson-distill/settings.ts` |
| `MYRMIDON_LESSON_DISTILL_REPEAT_THRESHOLD` | yes | yes | Added: behavior | UI (1.7) override; pending EN/RU fragment; `server/src/myrmidon/lesson-distill/settings.ts` |
| `MYRMIDON_LESSON_DISTILL_WINDOW_HOURS` | yes | yes | Added: behavior | UI (1.7) override; pending EN/RU fragment; `server/src/myrmidon/lesson-distill/settings.ts` |
| `MYRMIDON_LITELLM_ADMIN_KEY` | no | no | Excluded: infrastructure | LiteLLM service credential; keep in secret store; `server/src/__tests__/adapter-models.test.ts` |
| `MYRMIDON_LITELLM_ADMIN_KEY_SECRET` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/myrmidon/litellm-budget-sync/routes.ts` |
| `MYRMIDON_LITELLM_API_KEY` | no | no | Excluded: infrastructure | LiteLLM service credential; keep in secret store; `server/src/__tests__/adapter-models.test.ts` |
| `MYRMIDON_LITELLM_BASE_URL` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/__tests__/adapter-models.test.ts` |
| `MYRMIDON_LITELLM_KEY` | no | no | Excluded: infrastructure | LiteLLM service credential; keep in secret store; `server/src/__tests__/adapter-models.test.ts` |
| `MYRMIDON_LITELLM_MASTER_KEY` | no | no | Excluded: infrastructure | LiteLLM service credential; keep in secret store; `server/src/__tests__/adapter-models.test.ts` |
| `MYRMIDON_LLM_GATEWAY_BASE_URL` | no | no | Excluded: infrastructure | Corpus LLM service endpoint; deployment-only; `server/src/myrmidon/corpus/adapters.ts` |
| `MYRMIDON_MAINTENANCE_HOOK_TIMEOUT_MS` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/myrmidon/maintenance/drain-complete.myrmidon.test.ts` |
| `MYRMIDON_MAX_CONCURRENT_STARTS` | no | no | Excluded: infrastructure | Docker driver startup concurrency; host capacity knob; `server/src/myrmidon/bot-containers/docker-driver.ts` |
| `MYRMIDON_MAX_HOST_CPU_BUSY_PERCENT` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/__tests__/setup-supertest.ts` |
| `MYRMIDON_MAX_HOST_LOAD_PERCENT_PER_CORE` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/setup-supertest.ts` |
| `MYRMIDON_MAX_RUN_STARTS_PER_MINUTE` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/__tests__/setup-supertest.ts` |
| `MYRMIDON_MCP_TOKEN_PAPERCLIP_BOARD` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/myrmidon/bot-containers/profile-input.myrmidon.test.ts` |
| `MYRMIDON_MEMORY_API_KEY` | no | no | Excluded: infrastructure | Memory service credential; keep in secret store; `server/src/myrmidon/lesson-distill/settings.ts` |
| `MYRMIDON_MEMORY_BASE_URL` | no | no | Excluded: infrastructure | Memory service endpoint; deployment-only; `server/src/myrmidon/lesson-distill/settings.ts` |
| `MYRMIDON_MIN_FREE_HOST_MEMORY_MB` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/__tests__/setup-supertest.ts` |
| `MYRMIDON_OPTIONAL` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/dev-runner-worktree.test.ts` |
| `MYRMIDON_PAUSE_DRAINS` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/__tests__/stranded-operator-pause.myrmidon.test.ts` |
| `MYRMIDON_PROCESS_CONTAINER` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/myrmidon/process-registry/domain.ts` |
| `MYRMIDON_PROCESS_ROLE` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/server-startup-feedback-export.test.ts` |
| `MYRMIDON_PUBLIC_URL` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/owner-telegram-delivery.myrmidon.test.ts` |
| `MYRMIDON_QUEUED_RUN_STALE_AFTER_SEC` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/services/attention.ts` |
| `MYRMIDON_RUN_DIR` | no | no | Excluded: test | Only test/fixture consumers; `server/src/services/run-scratch.test.ts` |
| `MYRMIDON_RUN_ENV_ALLOW` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/__tests__/run-env-adapters.myrmidon.test.ts` |
| `MYRMIDON_RUN_ID` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/heartbeat-local-environment.test.ts` |
| `MYRMIDON_RUN_SCRATCH_DIR` | no | no | Excluded: test | Only test/fixture consumers; `server/src/services/run-scratch.test.ts` |
| `MYRMIDON_SCENT_BASE_URL` | no | no | Excluded: test | Only test/fixture consumers; `server/src/myrmidon/scent.myrmidon.test.ts` |
| `MYRMIDON_SCRATCH_DIR` | no | no | Excluded: test | Only test/fixture consumers; `server/src/services/run-scratch.test.ts` |
| `MYRMIDON_SETTLED_HOLDS_BLOCK_EXPLICIT_WAKES` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/myrmidon/flags-killswitch.myrmidon.test.ts` |
| `MYRMIDON_SKIP_IDLE_HEARTBEATS` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/__tests__/heartbeat-idle-skip.myrmidon.test.ts` |
| `MYRMIDON_STACK_CHECK_INTERVAL_SEC` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/myrmidon/stack-registry/stack-check.myrmidon.test.ts` |
| `MYRMIDON_STALE_LEASE_GRACE_MS` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/__tests__/heartbeat-environment-leases.myrmidon.test.ts` |
| `MYRMIDON_STRANDED_AUTOPOLICY_ENABLED` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/services/recovery/review-stage-recovery.myrmidon.test.ts` |
| `MYRMIDON_SWARM_CLAIM_ENABLED` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/myrmidon/swarm-claim-supervisor/view.ts` |
| `MYRMIDON_TASK_PR_SYNC_WAKE_GUARD_ENABLED` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/myrmidon/task-pr-sync/wake-guard.myrmidon.test.ts` |
| `MYRMIDON_TASK_PR_SYNC_WAKE_GUARD_TTL_SEC` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/myrmidon/task-pr-sync/wake-guard.myrmidon.test.ts` |
| `MYRMIDON_TASK_SCRATCH_DIR` | no | no | Excluded: test | Only test/fixture consumers; `server/src/services/run-scratch.test.ts` |
| `MYRMIDON_TELEGRAM_DM_LANGUAGE` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/myrmidon/ui2-language/routes.myrmidon.test.ts` |
| `MYRMIDON_TELEGRAM_FILE_LIMIT_BYTES` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/myrmidon/chat-attachment-omission.ts` |
| `MYRMIDON_TELEGRAM_VOICE_STT` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/__tests__/chat-channels.integration.test.ts` |
| `MYRMIDON_TEST_CAPTURE_PATH` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/__tests__/run-env-adapters.myrmidon.test.ts` |
| `MYRMIDON_TMPDIR` | no | no | Excluded: test | Only test/fixture consumers; `server/src/services/run-scratch.test.ts` |
| `MYRMIDON_TOOL_AUTONOMY_MAPPING_JSON` | yes | yes | Added: behavior | UI (1.7) override; pending EN/RU fragment; `server/src/myrmidon/autonomy/tool-mapping-store.ts` |
| `MYRMIDON_WORKER_HOST` | no | no | Excluded: infrastructure | Worker bind address; deployment-only; `server/src/services/process-role.ts` |
| `MYRMIDON_WORKER_PORT` | no | no | Excluded: infrastructure | Worker bind port; deployment-only; `server/src/services/process-role.ts` |
| `MYRMIDON_WRITE_LOCK_REQUIRES_LIVE_RUN` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts` |
| `MYRMIDON_ZABBIX_HOST_GROUPS` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/myrmidon/maintenance/zabbix.ts` |
| `MYRMIDON_ZABBIX_MAX_WINDOW_SEC` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/myrmidon/maintenance/zabbix.ts` |
| `MYRMIDON_ZABBIX_TOKEN_REF` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/myrmidon/maintenance/zabbix.ts` |
| `MYRMIDON_ZABBIX_URL` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/myrmidon/maintenance/zabbix.ts` |
| `PAPERCLIP_ADAPTER_MODELS` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/adapter-models.test.ts` |
| `PAPERCLIP_AGENT_ID` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/heartbeat-local-environment.test.ts` |
| `PAPERCLIP_AGENT_JWT_SECRET` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/agent-auth-middleware.test.ts` |
| `PAPERCLIP_AGENT_JWT_TTL_SECONDS` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/agent-auth-middleware.test.ts` |
| `PAPERCLIP_API_BRIDGE_MODE` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/claude-local-execute.test.ts` |
| `PAPERCLIP_API_KEY` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/claude-local-execute.test.ts` |
| `PAPERCLIP_API_URL` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/agent-assigned-tools.myrmidon.test.ts` |
| `PAPERCLIP_ATTACHMENT_MAX_BYTES` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/__tests__/company-portability.test.ts` |
| `PAPERCLIP_AUTH_DISABLE_SIGN_UP` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/better-auth-credential-signup.integration.test.ts` |
| `PAPERCLIP_AUTH_PUBLIC_BASE_URL` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/cloud-runtime-identity.test.ts` |
| `PAPERCLIP_AUTH_RATE_LIMIT_ENABLED` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/better-auth-credential-signup.integration.test.ts` |
| `PAPERCLIP_CLOUD_CONNECTOR_BASE_URL` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/cloud-runtime-identity.test.ts` |
| `PAPERCLIP_CLOUD_CONNECTOR_ENVIRONMENT` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/cloud-runtime-identity.test.ts` |
| `PAPERCLIP_CLOUD_CONNECTOR_INSTANCE_ID` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/cloud-runtime-identity.test.ts` |
| `PAPERCLIP_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/cloud-runtime-identity.test.ts` |
| `PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/cloud-runtime-identity.test.ts` |
| `PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/cloud-control-task-drain.test.ts` |
| `PAPERCLIP_CLOUD_STACK_ID` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/cloud-control-task-drain.test.ts` |
| `PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/adapter-routes-authz.test.ts` |
| `PAPERCLIP_COMPANY_ID` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/heartbeat-local-environment.test.ts` |
| `PAPERCLIP_CONFIG` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/config-file.test.ts` |
| `PAPERCLIP_CONTEXT` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/dev-runner-options.test.ts` |
| `PAPERCLIP_DB_BACKUP_ENABLED` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/worktree-config.test.ts` |
| `PAPERCLIP_DEBUG_VERSION_RESOLUTION` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/version.test.ts` |
| `PAPERCLIP_DECISIONS_RECOVERY_GRACE_MS` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/decisions-service.test.ts` |
| `PAPERCLIP_DECISIONS_SWEEP_BATCH_SIZE` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/decisions-service.test.ts` |
| `PAPERCLIP_DECISION_SIGNING_SECRET` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/decisions-service.test.ts` |
| `PAPERCLIP_DEV_SERVER_STATUS_FILE` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/health-dev-server-token.test.ts` |
| `PAPERCLIP_DEV_SERVER_STATUS_TOKEN` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/health-dev-server-token.test.ts` |
| `PAPERCLIP_DISABLE_PLUGIN_AUTOBUILD` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/plugin-install-autobuild.test.ts` |
| `PAPERCLIP_ENV_LIVE_SSH_HOST` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/environment-live-ssh.test.ts` |
| `PAPERCLIP_ENV_LIVE_SSH_KNOWN_HOSTS` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/environment-live-ssh.test.ts` |
| `PAPERCLIP_ENV_LIVE_SSH_KNOWN_HOSTS_PATH` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/environment-live-ssh.test.ts` |
| `PAPERCLIP_ENV_LIVE_SSH_NO_AUTO_FIXTURE` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/environment-live-ssh.test.ts` |
| `PAPERCLIP_ENV_LIVE_SSH_PORT` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/environment-live-ssh.test.ts` |
| `PAPERCLIP_ENV_LIVE_SSH_PRIVATE_KEY` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/environment-live-ssh.test.ts` |
| `PAPERCLIP_ENV_LIVE_SSH_PRIVATE_KEY_PATH` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/environment-live-ssh.test.ts` |
| `PAPERCLIP_ENV_LIVE_SSH_REMOTE_WORKSPACE_PATH` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/environment-live-ssh.test.ts` |
| `PAPERCLIP_ENV_LIVE_SSH_STRICT_HOST_KEY_CHECKING` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/environment-live-ssh.test.ts` |
| `PAPERCLIP_ENV_LIVE_SSH_USERNAME` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/environment-live-ssh.test.ts` |
| `PAPERCLIP_EXECUTION_LIVE_SIGNAL_WINDOW_SEC` | no | no | Excluded: test | Only test/fixture consumers; `server/src/services/execution-projection.test.ts` |
| `PAPERCLIP_EXECUTION_MODE` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/environment-routes.test.ts` |
| `PAPERCLIP_FAKE_GIT_PID_PATH` | no | no | Excluded: test | Only test/fixture consumers; `server/src/services/workspace-git-operation-scheduler.test.ts` |
| `PAPERCLIP_FILE_DELIVERY_DAYTONA` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/file-delivery-bridges.test.ts` |
| `PAPERCLIP_GITHUB_EVENTS_MAX_SILENCE_MIN` | no | no | Excluded: vendor | Vendor compatibility/internal input, not a new Myrmidon operator setting; `server/src/services/github-connection-events.ts` |
| `PAPERCLIP_HA_GEO_STANDBY_URL` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/ha-routes.test.ts` |
| `PAPERCLIP_HIDDEN_SETTINGS` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/access-routes-hidden-floor.test.ts` |
| `PAPERCLIP_HOME` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/access-routes-permissions-upgrade.test.ts` |
| `PAPERCLIP_INSTANCE_ID` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/access-routes-permissions-upgrade.test.ts` |
| `PAPERCLIP_INSTANCE_ROOT` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/environment-live-ssh.test.ts` |
| `PAPERCLIP_IN_WORKTREE` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/access-routes-permissions-upgrade.test.ts` |
| `PAPERCLIP_LISTEN_HOST` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/paperclip-env.test.ts` |
| `PAPERCLIP_LISTEN_PORT` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/paperclip-env.test.ts` |
| `PAPERCLIP_LIVE_BROKER_EXERCISE` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/workspace-runtime-https-live-exercise.test.ts` |
| `PAPERCLIP_LOG_DIR` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/access-routes-permissions-upgrade.test.ts` |
| `PAPERCLIP_MANAGED_CONFIG` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/cloud-instance.test.ts` |
| `PAPERCLIP_MANAGED_RUNTIME_HTTPS` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/setup-supertest.ts` |
| `PAPERCLIP_ONBOARDING_SEED_ADAPTER_TYPE` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/onboarding-seed-route.test.ts` |
| `PAPERCLIP_OPENCODE_COMMAND` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/adapter-models.test.ts` |
| `PAPERCLIP_PRIMARY_HOST` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/cloud-runtime-identity.test.ts` |
| `PAPERCLIP_PROCESS_ROLE` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/server-startup-feedback-export.test.ts` |
| `PAPERCLIP_PUBLIC_URL` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/agent-chat-bridge-links.myrmidon.test.ts` |
| `PAPERCLIP_REQUIRE_RUNNER_API_INTEGRATION` | no | no | Excluded: test | Only test/fixture consumers; `server/src/services/native-runtime/runner-api.integration.test.ts` |
| `PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/authz-company-access.test.ts` |
| `PAPERCLIP_RUNNER_API_TOOLS_COMPANY_IDS` | no | no | Excluded: test | Only test/fixture consumers; `server/src/services/native-runtime/paperclip-runner-tool-authority.test.ts` |
| `PAPERCLIP_RUNNER_API_TOOLS_ENABLED` | no | no | Excluded: test | Only test/fixture consumers; `server/src/services/native-runtime/paperclip-runner-tool-authority.test.ts` |
| `PAPERCLIP_RUNNER_BINARY` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/services/native-runtime/native-warm-transition-restart.integration.test.ts` |
| `PAPERCLIP_RUNNER_STATE_DIR` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/chat-channels.integration.test.ts` |
| `PAPERCLIP_RUNTIME_API_CANDIDATES_JSON` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/server-startup-feedback-export.test.ts` |
| `PAPERCLIP_RUNTIME_API_URL` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/codex-local-execute.test.ts` |
| `PAPERCLIP_RUN_DIR` | no | no | Excluded: test | Only test/fixture consumers; `server/src/services/run-scratch.test.ts` |
| `PAPERCLIP_RUN_ID` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/agent-conversations.test.ts` |
| `PAPERCLIP_RUN_SCRATCH_DIR` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/myrmidon/bot-containers/site-agent-security-harness.myrmidon.test.ts` |
| `PAPERCLIP_SCRATCH_DIR` | no | no | Excluded: test | Only test/fixture consumers; `server/src/myrmidon/bot-containers/site-agent-security-harness.myrmidon.test.ts` |
| `PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/aws-secrets-manager-provider.test.ts` |
| `PAPERCLIP_SECRETS_AWS_KMS_KEY_ID` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/aws-secrets-manager-provider.test.ts` |
| `PAPERCLIP_SECRETS_AWS_REGION` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/aws-secrets-manager-provider.test.ts` |
| `PAPERCLIP_SECRETS_MASTER_KEY` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/secret-provider-registry.test.ts` |
| `PAPERCLIP_SECRETS_MASTER_KEY_FILE` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/agent-hire-auth-inheritance-routes.test.ts` |
| `PAPERCLIP_SECRETS_PROVIDER` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/environment-routes.test.ts` |
| `PAPERCLIP_SLACK_STREAM_ADAPTER_MODULE` | no | no | Excluded: test | Only test/fixture consumers; `server/src/services/chat-publication-ready-stream.test.ts` |
| `PAPERCLIP_STACK_SLUG` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/cloud-runtime-identity.test.ts` |
| `PAPERCLIP_TAILSCALE_BROKER_SOCKET` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/workspace-runtime-https-live-exercise.test.ts` |
| `PAPERCLIP_TASK_SCRATCH_DIR` | no | no | Excluded: test | Only test/fixture consumers; `server/src/services/run-scratch.test.ts` |
| `PAPERCLIP_TEAMS_CATALOG_DEFAULT_ADAPTER_TYPE` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/teams-catalog-service.test.ts` |
| `PAPERCLIP_TELEGRAM_STOP_ADAPTER_MODULE` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/chat-channels.integration.test.ts` |
| `PAPERCLIP_TEST_ARGS_PATH` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/cursor-local-adapter-environment.test.ts` |
| `PAPERCLIP_TEST_CAPTURE_PATH` | yes | yes | EN+RU | Registry row (or pending fragment); `server/src/__tests__/claude-local-execute.test.ts` |
| `PAPERCLIP_TEST_DATABASE_URL` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/chat-channels.integration.test.ts` |
| `PAPERCLIP_TEST_HELP_COUNT_PATH` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/claude-local-execute.test.ts` |
| `PAPERCLIP_TEST_STATE_PATH` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/claude-local-execute.test.ts` |
| `PAPERCLIP_TMPDIR` | no | no | Excluded: test | Only test/fixture consumers; `server/src/services/run-scratch.test.ts` |
| `PAPERCLIP_TOOL_ACCESS_TEST_DATABASE_URL` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/tool-access-service.test.ts` |
| `PAPERCLIP_TOOL_ACTION_SIGNING_SECRET` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/worktree-config.test.ts` |
| `PAPERCLIP_UI_DEV_MIDDLEWARE` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/workspace-runtime.test.ts` |
| `PAPERCLIP_WAKE_PAYLOAD_JSON` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/codex-local-execute.test.ts` |
| `PAPERCLIP_WARM_TRANSITION_FIXTURE_DIRECTORY` | no | no | Excluded: test | Only test/fixture consumers; `server/src/services/native-runtime/native-warm-transition-restart.integration.test.ts` |
| `PAPERCLIP_WARM_TRANSITION_MANAGED_FIXTURE_DIRECTORY` | no | no | Excluded: test | Only test/fixture consumers; `server/src/services/native-runtime/native-warm-transition-restart.integration.test.ts` |
| `PAPERCLIP_WORKSPACE_HANDOFF_SECRET` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/workspace-login-handoff-issuer.test.ts` |
| `PAPERCLIP_WORKTREES_DIR` | yes | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/workspace-runtime.test.ts` |
| `PAPERCLIP_WORKTREE_NAME` | no | no | Excluded: test | Only test/fixture consumers; `server/src/__tests__/worktree-config.test.ts` |
