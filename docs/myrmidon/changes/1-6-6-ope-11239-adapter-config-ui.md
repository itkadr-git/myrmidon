## changelog-en

### Typed adapter settings in Agent Settings (SETTINGS-UI, OPE-11239)

- **Hermes gateway**: typed controls for the status poll interval, the run-create timeout, liveness by gateway events, raw debug events, runtime MCP URL rewrite and internal base URL, and central session history (switch, Hindsight URL, bank ID, turns to restore). There is no field for the central history API key: a credential is never typed into the form. The create timeout, the history URL and the MCP base URL are validated on save, because the gateway ignores bad values silently.
- **Claude / Codex local**: filesystem sandbox (workspace scope, extra paths; a path followed by `(rw)` is writable), network sandbox (deny or allowlist), the Claude hello-probe timeout and cleanup grace after the final result, and the Codex output inactivity timeout. Host paths are hidden under the managed-sandbox-only policy. These keys are validated on save with the parsers the run path uses, and changing a sandbox or permission key needs an instance admin (also on create and on agent hire). The create form's permission defaults are not a change.
- **Hermes local**: switch for including the configured MCP servers; values set on the create form (toolsets, sandbox, timeouts) are now stored. Comma-separated sandbox lists are honoured at run time instead of being ignored.
- **OpenClaw gateway**: client ID, mode and version, with the adapter defaults shown as placeholders.

## changelog-ru

### Типизированные настройки адаптеров в настройках агента (SETTINGS-UI, OPE-11239)

- **Hermes gateway**: поля для интервала опроса состояния, тайм-аута создания прогона, продления по событиям шлюза, сырых отладочных событий, переписывания URL runtime MCP и внутреннего базового URL, а также центральной истории сессии (переключатель, URL Hindsight, ID банка, число восстанавливаемых ходов). Поля для ключа API центральной истории нет: учётные данные в форму не вводятся. Тайм-аут создания, URL истории и базовый URL MCP проверяются при сохранении, потому что шлюз молча игнорирует неверные значения.
- **Claude / Codex local**: песочница файловой системы (область «рабочий каталог», дополнительные пути; путь с `(rw)` после него доступен для записи), сетевая песочница (запрет или белый список), тайм-аут проверочного запроса Claude и ожидание выхода после итогового результата, тайм-аут молчания вывода Codex. При политике «только управляемая песочница» пути хоста скрыты. Эти ключи проверяются при сохранении теми же разборщиками, что и при запуске; менять ключи песочницы и разрешений может только администратор экземпляра (при создании и найме агента тоже). Значения разрешений по умолчанию из формы создания изменением не считаются.
- **Hermes local**: переключатель «включать настроенные серверы MCP»; значения с формы создания (наборы инструментов, песочница, тайм-ауты) теперь сохраняются. Списки песочницы через запятую учитываются при запуске, а не игнорируются.
- **OpenClaw gateway**: ID, режим и версия клиента; значения адаптера по умолчанию показаны подсказкой в поле.

## divergence-new

### 1.6.6 — SETTINGS-UI: типизированная конфигурация адаптеров (OPE-11239)

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.6-SETTINGS-UI-ADAPTER-CONFIG | Типизированные элементы настроек адаптеров в Agent Settings (Hermes gateway: опрос, тайм-аут создания, события, runtime MCP, центральная история; Claude/Codex local: песочница файлов и сети, проверочные тайм-ауты; Hermes local: серверы MCP; OpenClaw: идентификация клиента); проверка при сохранении и право администратора на ключи песочницы и разрешений | `ui/src/adapters/hermes-gateway/config-fields.tsx`, `ui/src/adapters/local-workspace-runtime-fields.tsx`, `ui/src/adapters/openclaw-gateway/config-fields.tsx`, `server/src/myrmidon/agent-local-adapter-config.ts`, `server/src/routes/agents.ts`, `packages/adapter-utils/src/local-process-sandbox.ts`, `packages/adapters/*/src/ui/build-config.ts`, `ui/src/i18n/myrmidon-locales/areas/adapters-plugins-1.*.json` | Заменить правку JSON в adapterConfig типизированными и безопасными полями по аудиту B (OPE-11239) | `server/src/myrmidon/agent-local-adapter-config.myrmidon.test.ts`, `server/src/__tests__/agent-adapter-validation-routes.test.ts`, `ui/src/adapters/hermes-gateway/config-fields.test.tsx`, `packages/adapters/*/src/ui/build-config.test.ts`, `packages/adapter-utils/src/local-process-sandbox.test.ts` | Никогда, наше поведение. | PR #2450 |
