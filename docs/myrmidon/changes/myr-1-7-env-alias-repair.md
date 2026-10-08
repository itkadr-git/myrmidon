---
divergence-section: Трек 5 — эксплуатация
---

## changelog-en

### REBRAND-C env alias: codemod repair after main merge (OPE-4561)

- The REBRAND-C codemod had rewritten `delete process.env.X` into
  `delete readProductEnv(From)(...)` in the hermes adapter, the CLI onboard
  command and the native-session executor — a no-op at runtime that left the
  variable in the child environment and stopped type-checking after the main
  merge. Removal now goes through `deleteProductEnv`, dropping both the
  `MYRMIDON_*` and the legacy `PAPERCLIP_*` spelling.
- Call sites that used the `readProductEnv(From)` result as a guaranteed
  string (opencode-local / pi-local command override, server config path,
  agent-assigned-tools API base URL, startup-banner JWT file check) now bind
  the value once and narrow `undefined` explicitly.
- A stray commit `7b22807f` (Telegram `/accept` `/reject` commands, not part
  of this PR) and the OPE-4131 heartbeat list-perf edits it had pasted into
  `server/src/services/heartbeat.ts` were removed by a revert commit.

## changelog-ru

### REBRAND-C env alias: ремонт codemod после слияния main (OPE-4561)

- Codemod REBRAND-C переписал `delete process.env.X` в
  `delete readProductEnv(From)(...)` в адаптере hermes, команде onboard CLI и
  native-session-executor — no-op в рантайме, оставлявший переменную в
  окружении дочернего процесса и ломавший tsc после слияния main. Удаление
  теперь идёт через `deleteProductEnv`, снимающий и написание `MYRMIDON_*`,
  и старый алиас `PAPERCLIP_*`.
- Места, где результат `readProductEnv(From)` использовался как гарантированная
  строка (переопределение команды opencode-local / pi-local, путь конфига
  сервера, API base URL в agent-assigned-tools, проверка JWT из файла в
  startup-banner), теперь связывают значение один раз и явно сужают
  `undefined`.
- Посторонний коммит `7b22807f` (Telegram-команды `/accept` `/reject`, не из
  этого PR) и вклеенные им правки OPE-4131 по производительности списка
  heartbeat-прогонов в `server/src/services/heartbeat.ts` убраны откатным
  коммитом.

## divergence

| REBRAND-C-REPAIR | Ремонт codemod env-алиаса после слияния main: удаление переменных через `deleteProductEnv` (оба написания), сужение `string \| undefined` у `readProductEnv(From)`, откат постороннего коммита /accept /reject | Те же файлы, что трогал REBRAND-C; `deleteProductEnv` уже был в `packages/shared/src/env-alias.ts` | Codemod оставил невалидный `delete` результата функции и необработанный `undefined` | tsc server чистый; vitest shared env-alias 11/11; adapters 96 passed / 48 skipped; `check-forbidden-tokens` чистый | Никогда, ремонт нашего codemod | (этот PR) |
| REBRAND-C-test | Минимальная правка вендорского теста `worktree-config.test.ts`: `beforeEach` вырезает из `process.env` оба написания (раньше только `PAPERCLIP_*`), а помощник `activateWorktree` сбрасывает остаточные `MYRMIDON_*` от предыдущего вызова ремонта — эмуляция свежего процесса со старым окружением. Без правки тест красный: внутренняя запись ремонта пишет оба имени, и устаревшее `MYRMIDON_CONFIG` первого воркспейса затеняет свежий `PAPERCLIP_CONFIG` второго | `server/src/__tests__/worktree-config.test.ts` (2 правки с меткой `myrmidon(REBRAND-C)`) | Поведение чтения env изменилось (REBRAND-C) | тот же тест | Вместе с REBRAND-C: когда алиас убран, `beforeEach` возвращает вырезание одного префикса `MYRMIDON_*`, помощник — без сброса | (этот PR) |
| REBRAND-C | Все переменные окружения продукта читаются под именем `MYRMIDON_<AREA>_<NAME>`; старое написание `PAPERCLIP_*` работает один релиз как алиас: при заданном только старом имени значение используется и в журнал пишется однократное предупреждение об устаревании на имя переменной; при заданных обоих побеждает новое. Общая точка чтения — новый модуль `packages/shared/src/env-alias.ts` (`readProductEnv`/`readProductEnvFrom`); прямые чтения `process.env.PAPERCLIP_*` заменены в ~105 нетестовых файлах (пометка `myrmidon(REBRAND-C)` у каждого импорта); внутренние записи, которые сервер выставляет сам (`server/src/index.ts`, `worktree-config.ts`, `cli/src/commands/*`, env-объекты прогонов в `adapter-utils`/`adapters`/`server`), пишут оба написания (`writeProductEnv`), чтобы дочерние процессы и навыки, ожидающие `PAPERCLIP_*`, работали в окно алиаса; санитайзеры/фильтры префикса (`sanitizeRuntimeServiceBaseEnv`, `sanitizeInheritedPaperclipEnv`, `filterMyrmidonInheritedEnv`, `isPaperclipRuntimeEnvKey`, `VOLATILE_ENV_KEY_PREFIXES` локальных адаптеров, изоляция test-drive, заметки окружения адаптеров) вырезают/учитывают оба написания; env воркера плагинов (`plugin-loader.ts`) передаёт оба написания. Таблица соответствия имён — раздел «Name mapping» в `docs/myrmidon/SETTINGS.md`; гайды EN/RU — `docs/myrmidon/guides/env-names-alias{,.ru}.md` | `packages/shared/src/env-alias.ts` (+; и `env-alias.myrmidon.test.ts`), ~105 файлов `server/src/**`, `cli/src/**`, `packages/{adapter-utils,adapters/*,db,mcp-server,paperclip-runner,plugins/plugin-llm-wiki}/src/**` (замена чтений), `packages/adapters/{opencode-local,pi-local,hermes}/package.json`, `packages/paperclip-runner/package.json`, `packages/plugins/plugin-llm-wiki/package.json` (зависимость `@paperclipai/shared`), `server/src/__tests__/env-alias.myrmidon.test.ts` (+), `docs/myrmidon/SETTINGS{,.ru}.md`, `docs/myrmidon/guides/env-names-alias{,.ru}.md` (+) | REBRAND C (эпик OPE-3540, релиз 1.7): имя вендора уходит из области видимости, но установленные системы и навыки агентов не должны сломаться | `packages/shared/src/env-alias.myrmidon.test.ts`, `server/src/__tests__/env-alias.myrmidon.test.ts` | После релиза, следующего за 1.7: удалить алиас из `env-alias.ts` (оставить только `MYRMIDON_*`), убрать дублирующие записи `writeProductEnv` и строку из SETTINGS; на этапе вендора ничего не снимается | (этот PR) |

## settings-en-new

### Name mapping PAPERCLIP_* → MYRMIDON_*

Since 1.7 the product reads its environment variables as `MYRMIDON_<NAME>`;
the vendor `PAPERCLIP_<NAME>` spelling works for one release as an alias with a
one-time deprecation warning in the log (see
[guides/env-names-alias.md](guides/env-names-alias.md)). When both names are
set, `MYRMIDON_*` wins. The mapping of every variable the product reads:

| Old name | New name |
|---|---|
| `PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST` | `MYRMIDON_ACPX_PROVIDER_PACKAGE_MANIFEST` |
| `PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT` | `MYRMIDON_ACPX_PROVIDER_PACKAGE_ROOT` |
| `PAPERCLIP_ADAPTER_MODELS` | `MYRMIDON_ADAPTER_MODELS` |
| `PAPERCLIP_AGENT_JWT_AUDIENCE` | `MYRMIDON_AGENT_JWT_AUDIENCE` |
| `PAPERCLIP_AGENT_JWT_DISABLE_LEGACY_FALLBACK` | `MYRMIDON_AGENT_JWT_DISABLE_LEGACY_FALLBACK` |
| `PAPERCLIP_AGENT_JWT_ISSUER` | `MYRMIDON_AGENT_JWT_ISSUER` |
| `PAPERCLIP_AGENT_JWT_SECRET` | `MYRMIDON_AGENT_JWT_SECRET` |
| `PAPERCLIP_AGENT_JWT_TTL_SECONDS` | `MYRMIDON_AGENT_JWT_TTL_SECONDS` |
| `PAPERCLIP_ALLOWED_ATTACHMENT_TYPES` | `MYRMIDON_ALLOWED_ATTACHMENT_TYPES` |
| `PAPERCLIP_ALLOWED_HOSTNAMES` | `MYRMIDON_ALLOWED_HOSTNAMES` |
| `PAPERCLIP_ANNOUNCEMENTS_ENABLED` | `MYRMIDON_ANNOUNCEMENTS_ENABLED` |
| `PAPERCLIP_ANNOUNCEMENTS_FEED_URL` | `MYRMIDON_ANNOUNCEMENTS_FEED_URL` |
| `PAPERCLIP_API_BRIDGE_MODE` | `MYRMIDON_API_BRIDGE_MODE` |
| `PAPERCLIP_API_KEY` | `MYRMIDON_API_KEY` |
| `PAPERCLIP_API_URL` | `MYRMIDON_API_URL` |
| `PAPERCLIP_ATTACHMENT_MAX_BYTES` | `MYRMIDON_ATTACHMENT_MAX_BYTES` |
| `PAPERCLIP_AUTH_BASE_URL_MODE` | `MYRMIDON_AUTH_BASE_URL_MODE` |
| `PAPERCLIP_AUTH_DISABLE_SIGN_UP` | `MYRMIDON_AUTH_DISABLE_SIGN_UP` |
| `PAPERCLIP_AUTH_PUBLIC_BASE_URL` | `MYRMIDON_AUTH_PUBLIC_BASE_URL` |
| `PAPERCLIP_AUTH_RATE_LIMIT_ENABLED` | `MYRMIDON_AUTH_RATE_LIMIT_ENABLED` |
| `PAPERCLIP_AUTH_STORE` | `MYRMIDON_AUTH_STORE` |
| `PAPERCLIP_BIND` | `MYRMIDON_BIND` |
| `PAPERCLIP_BIND_HOST` | `MYRMIDON_BIND_HOST` |
| `PAPERCLIP_BRIDGE_HOST` | `MYRMIDON_BRIDGE_HOST` |
| `PAPERCLIP_BRIDGE_MAX_BODY_BYTES` | `MYRMIDON_BRIDGE_MAX_BODY_BYTES` |
| `PAPERCLIP_BRIDGE_MAX_QUEUE_DEPTH` | `MYRMIDON_BRIDGE_MAX_QUEUE_DEPTH` |
| `PAPERCLIP_BRIDGE_NONCE` | `MYRMIDON_BRIDGE_NONCE` |
| `PAPERCLIP_BRIDGE_POLL_INTERVAL_MS` | `MYRMIDON_BRIDGE_POLL_INTERVAL_MS` |
| `PAPERCLIP_BRIDGE_PORT` | `MYRMIDON_BRIDGE_PORT` |
| `PAPERCLIP_BRIDGE_QUEUE_DIR` | `MYRMIDON_BRIDGE_QUEUE_DIR` |
| `PAPERCLIP_BRIDGE_RESPONSE_TIMEOUT_MS` | `MYRMIDON_BRIDGE_RESPONSE_TIMEOUT_MS` |
| `PAPERCLIP_BRIDGE_TOKEN` | `MYRMIDON_BRIDGE_TOKEN` |
| `PAPERCLIP_BUILD_COMMIT` | `MYRMIDON_BUILD_COMMIT` |
| `PAPERCLIP_BUILD_VERSION` | `MYRMIDON_BUILD_VERSION` |
| `PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL` | `MYRMIDON_CHAT_WEBHOOK_PUBLIC_URL` |
| `PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN` | `MYRMIDON_CLOUD_TENANT_SERVER_TOKEN` |
| `PAPERCLIP_CODEX_PROVIDERS` | `MYRMIDON_CODEX_PROVIDERS` |
| `PAPERCLIP_COMPANY_ID` | `MYRMIDON_COMPANY_ID` |
| `PAPERCLIP_CONFIG` | `MYRMIDON_CONFIG` |
| `PAPERCLIP_CONTEXT` | `MYRMIDON_CONTEXT` |
| `PAPERCLIP_DB_BACKUP_ALERT_FILE` | `MYRMIDON_DB_BACKUP_ALERT_FILE` |
| `PAPERCLIP_DB_BACKUP_DIR` | `MYRMIDON_DB_BACKUP_DIR` |
| `PAPERCLIP_DB_BACKUP_ENABLED` | `MYRMIDON_DB_BACKUP_ENABLED` |
| `PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES` | `MYRMIDON_DB_BACKUP_INTERVAL_MINUTES` |
| `PAPERCLIP_DB_BACKUP_MAX_AGE_HOURS` | `MYRMIDON_DB_BACKUP_MAX_AGE_HOURS` |
| `PAPERCLIP_DB_BACKUP_RETENTION_DAYS` | `MYRMIDON_DB_BACKUP_RETENTION_DAYS` |
| `PAPERCLIP_DEBUG_VERSION_RESOLUTION` | `MYRMIDON_DEBUG_VERSION_RESOLUTION` |
| `PAPERCLIP_DECISIONS_OPEN_CAP` | `MYRMIDON_DECISIONS_OPEN_CAP` |
| `PAPERCLIP_DECISIONS_RECOVERY_GRACE_MS` | `MYRMIDON_DECISIONS_RECOVERY_GRACE_MS` |
| `PAPERCLIP_DECISIONS_SWEEP_BATCH_SIZE` | `MYRMIDON_DECISIONS_SWEEP_BATCH_SIZE` |
| `PAPERCLIP_DECISION_SIGNING_SECRET` | `MYRMIDON_DECISION_SIGNING_SECRET` |
| `PAPERCLIP_DEPLOYMENT_EXPOSURE` | `MYRMIDON_DEPLOYMENT_EXPOSURE` |
| `PAPERCLIP_DEPLOYMENT_ID` | `MYRMIDON_DEPLOYMENT_ID` |
| `PAPERCLIP_DEPLOYMENT_MODE` | `MYRMIDON_DEPLOYMENT_MODE` |
| `PAPERCLIP_DEV_SERVER_STATUS_TOKEN` | `MYRMIDON_DEV_SERVER_STATUS_TOKEN` |
| `PAPERCLIP_EMBEDDED_POSTGRES_PORT` | `MYRMIDON_EMBEDDED_POSTGRES_PORT` |
| `PAPERCLIP_EMBEDDED_POSTGRES_VERBOSE` | `MYRMIDON_EMBEDDED_POSTGRES_VERBOSE` |
| `PAPERCLIP_ENABLE_COMPANY_DELETION` | `MYRMIDON_ENABLE_COMPANY_DELETION` |
| `PAPERCLIP_ENABLE_DARWIN_SSH_ENV_LAB` | `MYRMIDON_ENABLE_DARWIN_SSH_ENV_LAB` |
| `PAPERCLIP_FEEDBACK_EXPORT_BACKEND_TOKEN` | `MYRMIDON_FEEDBACK_EXPORT_BACKEND_TOKEN` |
| `PAPERCLIP_FEEDBACK_EXPORT_BACKEND_URL` | `MYRMIDON_FEEDBACK_EXPORT_BACKEND_URL` |
| `PAPERCLIP_HOME` | `MYRMIDON_HOME` |
| `PAPERCLIP_IMPORT_ZIP_MAX_BYTES` | `MYRMIDON_IMPORT_ZIP_MAX_BYTES` |
| `PAPERCLIP_INSTANCE_ID` | `MYRMIDON_INSTANCE_ID` |
| `PAPERCLIP_IN_WORKTREE` | `MYRMIDON_IN_WORKTREE` |
| `PAPERCLIP_LISTEN_HOST` | `MYRMIDON_LISTEN_HOST` |
| `PAPERCLIP_LISTEN_PORT` | `MYRMIDON_LISTEN_PORT` |
| `PAPERCLIP_LOG_LEVEL` | `MYRMIDON_LOG_LEVEL` |
| `PAPERCLIP_MANAGED_RUNTIME_EXPOSURE` | `MYRMIDON_MANAGED_RUNTIME_EXPOSURE` |
| `PAPERCLIP_MANAGED_RUNTIME_HTTPS` | `MYRMIDON_MANAGED_RUNTIME_HTTPS` |
| `PAPERCLIP_MANAGED_RUNTIME_PUBLIC_URL` | `MYRMIDON_MANAGED_RUNTIME_PUBLIC_URL` |
| `PAPERCLIP_MCP_GATEWAY_AUTH_FAILURE_LIMIT` | `MYRMIDON_MCP_GATEWAY_AUTH_FAILURE_LIMIT` |
| `PAPERCLIP_MCP_GATEWAY_AUTH_FAILURE_WINDOW_MS` | `MYRMIDON_MCP_GATEWAY_AUTH_FAILURE_WINDOW_MS` |
| `PAPERCLIP_MCP_GATEWAY_REQUEST_LIMIT` | `MYRMIDON_MCP_GATEWAY_REQUEST_LIMIT` |
| `PAPERCLIP_MCP_GATEWAY_REQUEST_WINDOW_MS` | `MYRMIDON_MCP_GATEWAY_REQUEST_WINDOW_MS` |
| `PAPERCLIP_MCP_GATEWAY_SESSION_SETUP_LIMIT` | `MYRMIDON_MCP_GATEWAY_SESSION_SETUP_LIMIT` |
| `PAPERCLIP_MCP_GATEWAY_SESSION_SETUP_WINDOW_MS` | `MYRMIDON_MCP_GATEWAY_SESSION_SETUP_WINDOW_MS` |
| `PAPERCLIP_MCP_GATEWAY_TOKEN_REQUEST_LIMIT` | `MYRMIDON_MCP_GATEWAY_TOKEN_REQUEST_LIMIT` |
| `PAPERCLIP_MCP_GATEWAY_TOKEN_REQUEST_WINDOW_MS` | `MYRMIDON_MCP_GATEWAY_TOKEN_REQUEST_WINDOW_MS` |
| `PAPERCLIP_MIGRATION_AUTO_APPLY` | `MYRMIDON_MIGRATION_AUTO_APPLY` |
| `PAPERCLIP_MIGRATION_PROMPT` | `MYRMIDON_MIGRATION_PROMPT` |
| `PAPERCLIP_NATIVE_RUNTIME_CONTEXT_PATH` | `MYRMIDON_NATIVE_RUNTIME_CONTEXT_PATH` |
| `PAPERCLIP_NORMALIZED_SESSION_ID` | `MYRMIDON_NORMALIZED_SESSION_ID` |
| `PAPERCLIP_NO_BROWSER` | `MYRMIDON_NO_BROWSER` |
| `PAPERCLIP_ONBOARDING_SEED_ADAPTER_TYPE` | `MYRMIDON_ONBOARDING_SEED_ADAPTER_TYPE` |
| `PAPERCLIP_OPENCODE_COMMAND` | `MYRMIDON_OPENCODE_COMMAND` |
| `PAPERCLIP_OPENCODE_PERMISSION_MODE` | `MYRMIDON_OPENCODE_PERMISSION_MODE` |
| `PAPERCLIP_OPENCODE_PRINT_LOGS` | `MYRMIDON_OPENCODE_PRINT_LOGS` |
| `PAPERCLIP_OPENCODE_PROVIDERS` | `MYRMIDON_OPENCODE_PROVIDERS` |
| `PAPERCLIP_OPENCODE_RUNTIME_DIR` | `MYRMIDON_OPENCODE_RUNTIME_DIR` |
| `PAPERCLIP_OPENCODE_SMALL_MODEL` | `MYRMIDON_OPENCODE_SMALL_MODEL` |
| `PAPERCLIP_OPENCODE_STORAGE_DIR` | `MYRMIDON_OPENCODE_STORAGE_DIR` |
| `PAPERCLIP_OPEN_ON_LISTEN` | `MYRMIDON_OPEN_ON_LISTEN` |
| `PAPERCLIP_PAGES_API_URL` | `MYRMIDON_PAGES_API_URL` |
| `PAPERCLIP_PG_DUMP_PATH` | `MYRMIDON_PG_DUMP_PATH` |
| `PAPERCLIP_PI_COMMAND` | `MYRMIDON_PI_COMMAND` |
| `PAPERCLIP_PI_PROVIDERS` | `MYRMIDON_PI_PROVIDERS` |
| `PAPERCLIP_PROCESS_SESSION_COMMAND_B64` | `MYRMIDON_PROCESS_SESSION_COMMAND_B64` |
| `PAPERCLIP_PROCESS_SESSION_DIR` | `MYRMIDON_PROCESS_SESSION_DIR` |
| `PAPERCLIP_PROCESS_SESSION_STDIN_MAX_RETRIES` | `MYRMIDON_PROCESS_SESSION_STDIN_MAX_RETRIES` |
| `PAPERCLIP_PROCESS_SESSION_TERMINATE_GRACE_MS` | `MYRMIDON_PROCESS_SESSION_TERMINATE_GRACE_MS` |
| `PAPERCLIP_PROJECT_WORKSPACE_ID` | `MYRMIDON_PROJECT_WORKSPACE_ID` |
| `PAPERCLIP_PSQL_PATH` | `MYRMIDON_PSQL_PATH` |
| `PAPERCLIP_PUBLIC_URL` | `MYRMIDON_PUBLIC_URL` |
| `PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE` | `MYRMIDON_RESPONSIBLE_USER_AUTHZ_MODE` |
| `PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW` | `MYRMIDON_RESPONSIBLE_USER_AUTHZ_SHADOW` |
| `PAPERCLIP_RUNNER_BINARY` | `MYRMIDON_RUNNER_BINARY` |
| `PAPERCLIP_RUNNER_INSTANCE_ID` | `MYRMIDON_RUNNER_INSTANCE_ID` |
| `PAPERCLIP_RUNNER_NETWORK_ACCESS` | `MYRMIDON_RUNNER_NETWORK_ACCESS` |
| `PAPERCLIP_RUNNER_STATE_DIR` | `MYRMIDON_RUNNER_STATE_DIR` |
| `PAPERCLIP_RUNTIME_API_URL` | `MYRMIDON_RUNTIME_API_URL` |
| `PAPERCLIP_RUNTIME_TOOLS_TOKEN` | `MYRMIDON_RUNTIME_TOOLS_TOKEN` |
| `PAPERCLIP_RUN_ID` | `MYRMIDON_RUN_ID` |
| `PAPERCLIP_RUN_SCRATCH_DIR` | `MYRMIDON_RUN_SCRATCH_DIR` |
| `PAPERCLIP_SECRETS_AWS_DELETE_RECOVERY_DAYS` | `MYRMIDON_SECRETS_AWS_DELETE_RECOVERY_DAYS` |
| `PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID` | `MYRMIDON_SECRETS_AWS_DEPLOYMENT_ID` |
| `PAPERCLIP_SECRETS_AWS_ENDPOINT` | `MYRMIDON_SECRETS_AWS_ENDPOINT` |
| `PAPERCLIP_SECRETS_AWS_ENVIRONMENT` | `MYRMIDON_SECRETS_AWS_ENVIRONMENT` |
| `PAPERCLIP_SECRETS_AWS_KMS_KEY_ID` | `MYRMIDON_SECRETS_AWS_KMS_KEY_ID` |
| `PAPERCLIP_SECRETS_AWS_PREFIX` | `MYRMIDON_SECRETS_AWS_PREFIX` |
| `PAPERCLIP_SECRETS_AWS_PROVIDER_OWNER` | `MYRMIDON_SECRETS_AWS_PROVIDER_OWNER` |
| `PAPERCLIP_SECRETS_AWS_REGION` | `MYRMIDON_SECRETS_AWS_REGION` |
| `PAPERCLIP_SECRETS_MASTER_KEY` | `MYRMIDON_SECRETS_MASTER_KEY` |
| `PAPERCLIP_SECRETS_MASTER_KEY_FILE` | `MYRMIDON_SECRETS_MASTER_KEY_FILE` |
| `PAPERCLIP_SECRETS_PROVIDER` | `MYRMIDON_SECRETS_PROVIDER` |
| `PAPERCLIP_SECRETS_STRICT_MODE` | `MYRMIDON_SECRETS_STRICT_MODE` |
| `PAPERCLIP_SEED_EXPECTED_COMPANY_ID` | `MYRMIDON_SEED_EXPECTED_COMPANY_ID` |
| `PAPERCLIP_SERVER_HOST` | `MYRMIDON_SERVER_HOST` |
| `PAPERCLIP_SERVER_PORT` | `MYRMIDON_SERVER_PORT` |
| `PAPERCLIP_SERVICE_MANAGED` | `MYRMIDON_SERVICE_MANAGED` |
| `PAPERCLIP_SHIM_PATH` | `MYRMIDON_SHIM_PATH` |
| `PAPERCLIP_STORAGE_LOCAL_DIR` | `MYRMIDON_STORAGE_LOCAL_DIR` |
| `PAPERCLIP_STORAGE_PROVIDER` | `MYRMIDON_STORAGE_PROVIDER` |
| `PAPERCLIP_STORAGE_S3_BUCKET` | `MYRMIDON_STORAGE_S3_BUCKET` |
| `PAPERCLIP_STORAGE_S3_ENDPOINT` | `MYRMIDON_STORAGE_S3_ENDPOINT` |
| `PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE` | `MYRMIDON_STORAGE_S3_FORCE_PATH_STYLE` |
| `PAPERCLIP_STORAGE_S3_PREFIX` | `MYRMIDON_STORAGE_S3_PREFIX` |
| `PAPERCLIP_STORAGE_S3_REGION` | `MYRMIDON_STORAGE_S3_REGION` |
| `PAPERCLIP_TAILNET_BIND_HOST` | `MYRMIDON_TAILNET_BIND_HOST` |
| `PAPERCLIP_TAILSCALE_BROKER_SOCKET` | `MYRMIDON_TAILSCALE_BROKER_SOCKET` |
| `PAPERCLIP_TAILSCALE_DNS_NAME` | `MYRMIDON_TAILSCALE_DNS_NAME` |
| `PAPERCLIP_TASK_ID` | `MYRMIDON_TASK_ID` |
| `PAPERCLIP_TEAMS_CATALOG_DEFAULT_ADAPTER_TYPE` | `MYRMIDON_TEAMS_CATALOG_DEFAULT_ADAPTER_TYPE` |
| `PAPERCLIP_TEAMS_CATALOG_DIR` | `MYRMIDON_TEAMS_CATALOG_DIR` |
| `PAPERCLIP_TELEMETRY_BACKEND_TOKEN` | `MYRMIDON_TELEMETRY_BACKEND_TOKEN` |
| `PAPERCLIP_TELEMETRY_BACKEND_URL` | `MYRMIDON_TELEMETRY_BACKEND_URL` |
| `PAPERCLIP_TELEMETRY_DISABLED` | `MYRMIDON_TELEMETRY_DISABLED` |
| `PAPERCLIP_TELEMETRY_ENDPOINT` | `MYRMIDON_TELEMETRY_ENDPOINT` |
| `PAPERCLIP_TEST_CONNECTION_DELIVERY_HOLD` | `MYRMIDON_TEST_CONNECTION_DELIVERY_HOLD` |
| `PAPERCLIP_TEST_POSTGRES_RESERVED_PORTS` | `MYRMIDON_TEST_POSTGRES_RESERVED_PORTS` |
| `PAPERCLIP_TOKEN_BROKER_ALLOWED_HOSTS` | `MYRMIDON_TOKEN_BROKER_ALLOWED_HOSTS` |
| `PAPERCLIP_TOOL_ACTION_SIGNING_SECRET` | `MYRMIDON_TOOL_ACTION_SIGNING_SECRET` |
| `PAPERCLIP_TOOL_OAUTH_CLIENT_ID` | `MYRMIDON_TOOL_OAUTH_CLIENT_ID` |
| `PAPERCLIP_TOOL_OAUTH_CLIENT_SECRET` | `MYRMIDON_TOOL_OAUTH_CLIENT_SECRET` |
| `PAPERCLIP_TOOL_RUNTIME_TRUSTED_HOST` | `MYRMIDON_TOOL_RUNTIME_TRUSTED_HOST` |
| `PAPERCLIP_TRUSTED_MCP_RUNTIME_HOST` | `MYRMIDON_TRUSTED_MCP_RUNTIME_HOST` |
| `PAPERCLIP_UI_DEV_MIDDLEWARE` | `MYRMIDON_UI_DEV_MIDDLEWARE` |
| `PAPERCLIP_UPDATE_CHECK` | `MYRMIDON_UPDATE_CHECK` |
| `PAPERCLIP_UPDATE_CHECK_URL` | `MYRMIDON_UPDATE_CHECK_URL` |
| `PAPERCLIP_VITE_CACHE_DIR` | `MYRMIDON_VITE_CACHE_DIR` |
| `PAPERCLIP_VITE_HMR_PROTOCOL` | `MYRMIDON_VITE_HMR_PROTOCOL` |
| `PAPERCLIP_WORKSPACE_BASE_CWD` | `MYRMIDON_WORKSPACE_BASE_CWD` |
| `PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS` | `MYRMIDON_WORKSPACE_REAPER_COOLDOWN_DAYS` |
| `PAPERCLIP_WORKTREES_DIR` | `MYRMIDON_WORKTREES_DIR` |
| `PAPERCLIP_WORKTREE_START_POINT` | `MYRMIDON_WORKTREE_START_POINT` |
(address, key secret, model) is unnamed.

The PATCH accepts only `enabled`, `backend`, `model`, `language`, `diarization` and
`maxDurationSec` (a strict schema, an unknown field answers 400); `model: null`
clears the stored model back to the environment default. Every successful PATCH is
journaled as `myrmidon.stt.settings_saved`. The GET answers the effective settings
with the key secret's **name**, never its value, plus a `problem` object naming the
stable reason the path cannot serve yet; `problem` is `null` when the path is
ready.

The stable `transcribeAudio` error codes: `stt_disabled` (the path is off),
`stt_unconfigured` (the contour — address, key secret, model — is unnamed),
`audio_too_long` / `audio_too_large` (a limit answered before any outbound
request), `stt_timeout` (the backend call timed out), `stt_upstream_error`
(any other backend failure).

The container-bot side of the track — the media-mcp tools `audio_split` /
`stt_transcribe` and their `MEDIA_STT_*` service settings — is documented in
[media-tools.md](media-tools.md) («Speech-to-text»).

## settings-ru-new

### Соответствие имён PAPERCLIP_* → MYRMIDON_*

С 1.7 продукт читает свои переменные окружения под именем `MYRMIDON_<ИМЯ>`;
вендорское написание `PAPERCLIP_<ИМЯ>` работает один релиз как алиас с
однократным предупреждением об устаревании в журнале (см.
[guides/env-names-alias.ru.md](guides/env-names-alias.ru.md)). При заданных
обоих именах побеждает `MYRMIDON_*`. Полная таблица соответствия по каждой
переменной, которую читает продукт, — в английской версии
[SETTINGS.md](SETTINGS.md), раздел «Name mapping PAPERCLIP_* → MYRMIDON_*».
