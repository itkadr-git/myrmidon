## changelog-en

### Typed adapter configuration controls in Agent Settings (SETTINGS-UI, OPE-11239)

- Exposed typed UI controls in Agent Settings for adapter configuration parameters identified in Audit B:
  - Hermes gateway: request timeout (`createRequestTimeoutSec`), event liveness (`livenessEvents`), debug events (`debugEvents`), central history (`centralHistory`, `centralHistoryUrl`, `centralHistoryBank`, `centralHistoryTurnsLimit`), and runtime MCP URL controls (`runtimeMcpUrlRewrite`, `runtimeMcpUrlBase`).
  - Claude / Codex local adapters: local runtime workspace settings (`commandTimeoutSec`, `workspaceAutoCleanup`, `probeCommand`, `probeTimeoutSec`) and security parameters (`dangerouslyBypassApprovalsAndSandbox`, `fastMode`, `search`) are rendered via typed fields with secret references and permission guards.
  - OpenClaw gateway: session key strategy and key configuration are typed without plaintext secret exposures.
- Disallowed insecure plaintext API key controls for central history; secret-ref semantics are preserved.

## changelog-ru

### Типизированные элементы конфигурации адаптеров в настройках агента (SETTINGS-UI, OPE-11239)

- В интерфейсе настроек агента добавлены типизированные элементы управления для параметров адаптеров по результатам аудита B:
  - Hermes gateway: таймаут создания запроса (`createRequestTimeoutSec`), liveness событий (`livenessEvents`), отладочные события (`debugEvents`), центральная история (`centralHistory`, `centralHistoryUrl`, `centralHistoryBank`, `centralHistoryTurnsLimit`), а также параметры runtime MCP URL (`runtimeMcpUrlRewrite`, `runtimeMcpUrlBase`).
  - Claude / Codex local: параметры среды рабочего пространства (`commandTimeoutSec`, `workspaceAutoCleanup`, `probeCommand`, `probeTimeoutSec`) и безопасности (`dangerouslyBypassApprovalsAndSandbox`, `fastMode`, `search`) вынесены в типизированные поля с поддержкой secret-ref и проверкой прав.
  - OpenClaw gateway: стратегия и ключ сессии типизированы без открытой передачи учетных данных.
- Запрещён ввод открытых ключей API для central history в UI: обеспечена семантика secret-ref.

## divergence-new

### 1.6.6 — SETTINGS-UI: типизированная конфигурация адаптеров (OPE-11239)

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.6-SETTINGS-UI-ADAPTER-CONFIG | Типизированные элементы управления конфигурации адаптеров в Agent Settings (Hermes gateway runtime MCP, central history, events/timeouts, local adapter runtime controls) | `ui/src/adapters/hermes-gateway/config-fields.tsx`, `ui/src/adapters/hermes-gateway/config-fields.test.tsx`, `ui/src/i18n/myrmidon-locales/areas/adapters-plugins-1.en.json`, `ui/src/i18n/myrmidon-locales/areas/adapters-plugins-1.ru.json` | Предоставить типизированный и безопасный UI вместо прямого редактирования JSON в adapterConfig по аудиту B (OPE-11239) | `ui/src/adapters/hermes-gateway/config-fields.test.tsx` | Никогда, наше поведение. | PR #2450 |
