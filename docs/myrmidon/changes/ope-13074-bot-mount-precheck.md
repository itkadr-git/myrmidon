## changelog-en

### Fixed: reject agent card save when extraMounts source is not in MYRMIDON_BOT_MOUNT_SOURCES (1.6.9 OPE-13074)

- Saving or updating an agent card (`POST /api/agents`, `PATCH /api/agents/:id`) with `adapterConfig.container.extraMounts` now immediately validates mount sources against the effective allowlist (UI-saved `bot_mount_sources` takes precedence over `MYRMIDON_BOT_MOUNT_SOURCES`) using `validateExtraMounts`.
- An update specifying a disallowed extra mount source is rejected immediately with HTTP 422 naming the offending source and referencing `MYRMIDON_BOT_MOUNT_SOURCES`, rather than saving the card and crashing bot container reconciliation in a loop. Partial updates that do not supply `extraMounts` do not reject already-saved mounts.
- The reconciler and container build validation remain unchanged as defense-in-depth against direct database edits.

## changelog-ru

### Исправлено: отклонение сохранения карточки агента с extraMounts вне разрешённых источников (1.6.9 OPE-13074)

- При сохранении или обновлении карточки агента (`POST /api/agents`, `PATCH /api/agents/:id`) с `adapterConfig.container.extraMounts` источники томов теперь сразу валидируются против действующего списка (сохранённый в UI `bot_mount_sources` имеет приоритет над `MYRMIDON_BOT_MOUNT_SOURCES`) через `validateExtraMounts`.
- Попытка сохранить неразрешённый источник тома отклоняется сразу с HTTP 422 с указанием имени источника и упоминанием `MYRMIDON_BOT_MOUNT_SOURCES`, предотвращая зацикливание падений сборки контейнера бота. Частичное обновление карточки без `extraMounts` не отклоняет уже сохранённые тома.
- Сборка контейнера и её проверка источников остаются без изменений в качестве эшелонированной защиты при прямых правках в базе данных.
