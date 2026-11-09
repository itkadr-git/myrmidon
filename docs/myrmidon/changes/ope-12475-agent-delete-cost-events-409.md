## changelog-en

### Financial history integrity: deleting agents with cost_events rejected with 409 Conflict (OPE-12475)

- Deleting an agent (`DELETE /api/agents/:id`) that has recorded financial cost events (`cost_events`) is now rejected with `HTTP 409 Conflict` (`code: "agent_has_cost_events"`). Callers must terminate the agent (`POST /api/agents/:id/terminate`) instead of deleting it to preserve financial audit history.
- Deletion failures caused by remaining foreign-key references are handled cleanly and return `HTTP 409 Conflict` (`code: "agent_referenced"`) instead of uncaught 500 errors.
- Pre-deletion checks verify `cost_events` under row-level lock before native run dependency cleanups or record deletions.

## changelog-ru

### Целостность финансовой истории: удаление агентов с cost_events отклоняется с 409 Conflict (OPE-12475)

- Удаление агента (`DELETE /api/agents/:id`), у которого есть записи расходов (`cost_events`), теперь отклоняется с ошибкой `HTTP 409 Conflict` (`code: "agent_has_cost_events"`). Для сохранения финансовой истории и аудита вызывающая сторона должна завершить агента (`POST /api/agents/:id/terminate`), а не удалять его.
- Ошибки удаления из-за остаточных ссылок по внешним ключам перехватываются и возвращаются как `HTTP 409 Conflict` (`code: "agent_referenced"`) вместо ошибки 500.
- Проверка наличия `cost_events` выполняется под блокировкой строки агента до очистки зависимостей нативных прогонов и каких-либо изменений в базе данных.
