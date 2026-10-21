---
divergence-section: Трек 2 — ядро побудок и прогонов
---

## changelog-en

### Processes apply committed instance settings across processes (SETTINGS-APPLIERS)

- A successful PATCH commits the settings document under the row lock, then publishes `settings_changed` with the changed keys. Each process treats the event as an invalidation hint and re-reads the committed row before applying local effects; it never applies request-body values from the event.
- The applier registry handles `runLimits`, `teamLiveness`, `myrmidonMaintenance`, and `processes`. Applies run one at a time per process in arrival order, and periodic sweeps remain the fallback for processes that were offline or temporarily disconnected.

## changelog-ru

### Процессы применяют сохранённые настройки экземпляра (SETTINGS-APPLIERS)

- Успешный PATCH фиксирует документ настроек под блокировкой строки, затем публикует `settings_changed` с изменёнными ключами. Каждый процесс воспринимает событие как подсказку для инвалидации и перечитывает сохранённую строку перед применением локальных эффектов; значения из тела запроса не используются.
- Реестр применителей обрабатывает `runLimits`, `teamLiveness`, `myrmidonMaintenance` и `processes`. Применения в каждом процессе сериализованы, а периодические обходы остаются резервом для процессов, которые были отключены или временно потеряли соединение.
