## changelog-en

### ADM archive migration and REST context hook

- Add deterministic migration reports, source provenance, secret removal, and guarded draft import.
- Add bounded REST context delivery with session deduplication and byte metrics.
- See [the operator guide](guides/adm-knowledge-migration.md) for dry-run, apply, environment variables, and rollback. Production installation is a separate operator action.

## changelog-ru

### Перенос архива ADM и REST-хук контекста

- Добавлены воспроизводимый отчёт миграции, происхождение источников, вырезка секретов и управляемый импорт черновиков.
- Добавлена ограниченная доставка контекста через REST с дедупликацией по сессии и метриками байтов.
- Dry-run, apply, переменные окружения и откат описаны в [инструкции оператора](guides/adm-knowledge-migration.md). Установка на бою — отдельное действие оператора.
