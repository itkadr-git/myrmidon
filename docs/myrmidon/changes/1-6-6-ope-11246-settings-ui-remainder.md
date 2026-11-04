## changelog-en

### Settings UI: remaining product modules without editing (SETTINGS-UI, OPE-11246)

- Added settings UI and verified stored controls for product modules identified in audit:
  - Foraging: enable/disable per foraging source through the existing registry PUT (`/api/myrmidon/foraging/sources/:name`).
  - LiteLLM budget synchronization: distinct settings panel on Instance → General for `enabled`, `signalOnly`, and `sweepIntervalSec` via `/api/myrmidon/litellm-budget-sync/settings`.
  - Skill lifecycle pilot: settings panel on Instance → General with stored GET/PUT controls via `/api/myrmidon/skills/pilot`.
- Plugin entitlement expiration: retained read-only display with clarification that expiration is part of the cryptographically signed entitlement payload and cannot be edited locally without invalidating the signature.

## changelog-ru

### Настройки: остатки продуктовых модулей без редактирования (SETTINGS-UI, OPE-11246)

- Добавлены экраны и элементы управления для продуктовых модулей по аудиту:
  - Foraging: переключатель активности (enabled) для каждого источника фуражировки через существующий PUT реестра (`/api/myrmidon/foraging/sources/:name`).
  - Синхронизация бюджета LiteLLM: отдельная панель настроек на Instance → General для `enabled`, `signalOnly` и `sweepIntervalSec` через `/api/myrmidon/litellm-budget-sync/settings`.
  - Пилот жизненного цикла навыков (skill lifecycle pilot): панель настроек на Instance → General с хранимыми GET/PUT через `/api/myrmidon/skills/pilot`.
- Срок действия лицензии плагина (plugin entitlement expiry): оставлен только для чтения с пояснением, что срок зашит в криптографически подписанный entitlement и не может редактироваться локально.

## divergence-new

### 1.6.6 — SETTINGS-UI: остатки продуктовых модулей без редактирования (OPE-11246)

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.6-SETTINGS-UI-REMAINDER | Интерфейс настроек для остатков продуктовых модулей (foraging source toggle, LiteLLM budget sync panel, skill pilot settings) и фиксация неизменяемости подписанного expiry плагинов | `ui/src/pages/InstanceGeneralSettings.tsx`, `ui/src/components/myrmidon/LiteLlmBudgetSyncSettingsPanel.tsx`, `ui/src/pages/Foraging.tsx`, `ui/src/components/myrmidon/PluginEntitlementSettingsPanel.tsx`, `ui/src/i18n/myrmidon-locales/en.json`, `ui/src/i18n/myrmidon-locales/ru.json` | Предоставить доступ к редактированию хранимых настроек для оставшихся модулей по результатам аудита (OPE-11246) | `ui/src/pages/InstanceGeneralSettings.test.tsx`, `ui/src/components/myrmidon/LiteLlmBudgetSyncSettingsPanel.test.tsx`, `ui/src/pages/Foraging.test.tsx` | Никогда, наше поведение. | (этот PR) |
