## changelog-en

### Server and client: add limit and before cursor for heartbeat-runs list (OPE-12210)

- `GET /api/companies/:id/heartbeat-runs` now defaults `limit` to 200 (max 1000, validates non-numeric input as 400) and supports `before` (ISO createdAt cursor) for efficient pagination without heavy full-table aggregation or unconstrained SELECTs.
- `heartbeat.list` and `listVersionKey` are scoped to the requested pagination window and return `X-Next-Cursor` when rows equal `limit`. The response remains a raw array of heartbeat runs for full backward compatibility.
- Updated UI (`AgentDetail`, `AgentDetail.production`, API clients) and CLI (`client run`, `heartbeat-run`) to support limit and pagination.

## changelog-ru

### Сервер и клиенты: лимит и курсор для списка heartbeat-runs (OPE-12210)

- `GET /api/companies/:id/heartbeat-runs` теперь имеет дефолтный `limit=200` (максимум 1000, нечисловое значение возвращает 400) и поддерживает параметр `before` (ISO createdAt) для эффективной пагинации без тяжёлой агрегации всей таблицы.
- Сервисные методы `heartbeat.list` и `listVersionKey` ограничены окном пагинации и возвращают заголовок `X-Next-Cursor`, если строк ровно `limit`. Ответ остаётся массивом прогонов для обратной совместимости.
- Обновлены UI (`AgentDetail`, API-клиенты) и CLI (`client run`, `heartbeat-run`) для работы с лимитами и пагинацией.
