## changelog-en

### Instance core settings are editable from the board (1.6.6 SETTINGS-UI)

- Instance admins can configure the shared bot mount, including host path, write access and bot allowlist, with an explicit confirmation. Paths are checked before storage. Existing containers take mount changes on reconciliation/recreation, not as an in-place bind update.
- Run queue priority now uses the live `/api/myrmidon/run-priority` contract, including issue weights and starvation limits. Changes apply to the queue without a server restart.
- Prompt-budget deep analysis can target an agent selected from the current company.

## changelog-ru

### Основные настройки экземпляра доступны на доске (1.6.6 SETTINGS-UI)

- Администратор экземпляра настраивает общий каталог ботов, путь на хосте, запись и список ботов с явным подтверждением. Путь проверяется до сохранения. Работающие контейнеры получают новую привязку при пересоздании, а не без остановки.
- Приоритет очереди использует актуальный контракт `/api/myrmidon/run-priority`, включая веса задач и предел ожидания. Изменения применяются без перезапуска сервера.
- Для глубокого анализа prompt-budget можно выбрать агента текущей компании.
