## changelog-en

### Settings UI: execution policy badge and attention feed panel (SETTINGS-UI S, OPE-11234)

- Mounted `AttentionFeedSettingsPanel` in Settings > Instance > General, allowing administrators to view and update attention feed windows (`attentionFailedRunHorizonDays` and `attentionFeedCacheTtlSeconds`).
- Displayed `general.executionMode` as a read-only badge (`execution-mode-badge`) in Settings > Instance > General, clarifying that execution targets are cloud/platform-configured and cannot be modified via human toggle.
- Added localized UI descriptions (EN/RU) and test coverage in `InstanceGeneralSettings.test.tsx`.
- Published administrator guides in `docs/myrmidon/guides/instance-execution-policy-and-attention(.ru).md`.

## changelog-ru

### Настройки: отображение политики выполнения и панель ленты внимания (SETTINGS-UI S, OPE-11234)

- Смонтирована панель `AttentionFeedSettingsPanel` в Settings > Instance > General для настройки окон ленты внимания (`attentionFailedRunHorizonDays` и `attentionFeedCacheTtlSeconds`).
- `general.executionMode` отображается в виде бейджа только для чтения (`execution-mode-badge`) в Settings > Instance > General с пояснением, что политика выполнения управляется платформой и не переключается вручную.
- Добавлена локализация интерфейса (RU/EN) и тестовое покрытие в `InstanceGeneralSettings.test.tsx`.
- Опубликованы руководства администратора в `docs/myrmidon/guides/instance-execution-policy-and-attention(.ru).md`.

## divergence-new

### 1.6.6 — SETTINGS-UI S: отображение политики выполнения и панель ленты внимания (OPE-11234)

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.6-SETTINGS-UI-S | Панель `AttentionFeedSettingsPanel` и read-only бейдж `executionMode` в общих настройках инстанса, руководства и локализация | `ui/src/pages/InstanceGeneralSettings.tsx`, `ui/src/pages/InstanceGeneralSettings.test.tsx`, `ui/src/i18n/myrmidon-locales/en.json`, `ui/src/i18n/myrmidon-locales/ru.json`, `docs/myrmidon/guides/instance-execution-policy-and-attention.md`, `docs/myrmidon/guides/instance-execution-policy-and-attention.ru.md`, `docs/myrmidon/README.md` | Выполнить аудит настроек (OPE-11230 / OPE-11234): предоставить UI для настроек ленты внимания и визуализировать действующий режим политики выполнения агентов | `ui/src/pages/InstanceGeneralSettings.test.tsx` | Никогда, наше поведение. | (этот PR) |
