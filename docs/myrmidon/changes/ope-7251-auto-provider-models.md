---
settings-section: Track 6 — security and models
---

## changelog-en

### Plugin provider model lifecycle synchronization (OPE-7251)

- Plugins can declare provider models in validated manifests. Lifecycle synchronization registers models with LiteLLM, updates agent key allow-lists, and exposes the company-scoped model catalog to the selector without a board restart.
- Disable/uninstall removes only models owned by that plugin; missing company credentials fail closed and cleanup is covered by regression tests.
- The private subscription-backed ChatGPT pool, periodic subscription discovery, and live isolated LiteLLM/first-call verification remain outside this change and are not claimed as complete.

## changelog-ru

### Синхронизация моделей провайдеров плагинов (OPE-7251)

- Плагины могут объявлять модели провайдера в проверяемых манифестах. Синхронизация жизненного цикла регистрирует модели в LiteLLM, обновляет allow-list ключей агентов и публикует каталог моделей компании для селектора без перезапуска доски.
- При отключении/удалении удаляются только модели данного плагина; отсутствие учётных данных компании обрабатывается безопасно, очистка покрыта регрессионными тестами.
- Закрытый ChatGPT pool с подпиской, периодическое обнаружение моделей и изолированная проверка реального LiteLLM/первого вызова не входят в подтверждённый объём этой части и не заявляются завершёнными.

## settings-en

