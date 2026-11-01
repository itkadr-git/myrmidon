---
divergence-section: Трек 2 — агенты и касты
---

## changelog-en

### SWARM: agent list query filters q, status, role, reportsTo (OPE-10129)

- `GET /companies/:companyId/agents` now supports query filters `q`, `status`, `role`, and `reportsTo`.
- `q` matches against agent name, role, or title (case-insensitive substring match).
- `status` accepts a single status or a comma-separated list of agent statuses.
- `role` performs exact role matching.
- `reportsTo` accepts an agent ID or `none` for root agents (`reportsTo == null`).
- Filters combine via AND logic and are applied after actor permission filtering (`filterAgentsForActor`).
- Unsupported query parameters continue to return HTTP 400 with the list of unsupported parameters.
- ETag generation (`svc.listSummariesVersionKey`) includes normalized filters so filtered queries and unfiltered queries produce distinct version keys.
- UI client `agentsApi.list` accepts optional `AgentListFilters` parameter without changing parameterless calls.

## changelog-ru

### SWARM: фильтры списка агентов q, status, role, reportsTo (OPE-10129)

- Обработчик `GET /companies/:companyId/agents` теперь принимает query-фильтры `q`, `status`, `role` и `reportsTo`.
- Параметр `q` фильтрует агентов по подстроке имени, роли или должности без учёта регистра.
- Параметр `status` принимает один статус или список статусов через запятую.
- Параметр `role` проверяет точное совпадение роли агента.
- Параметр `reportsTo` принимает id руководителя или значение `none` для корневых агентов (`reportsTo == null`).
- Фильтры объединяются через логическое И (AND) и применяются строго после проверки прав (`filterAgentsForActor`).
- Неизвестные query-параметры по-прежнему возвращают HTTP 400 со списком только неподдерживаемых параметров.
- В генерацию ключа ETag (`svc.listSummariesVersionKey`) включён нормализованный набор параметров фильтрации, предотвращающий ложный ответ 304.
- Клиентский метод `agentsApi.list` в `ui/src/api/agents.ts` поддерживает опциональный аргумент `AgentListFilters`, сохраняя поведение вызовов без аргументов.

## divergence

| 1.7-UI-2.0-AGENTS-FILTERS | Серверные фильтры для `GET /companies/:companyId/agents`: `q` (подстрока имени, роли или должности без учёта регистра), `status` (одиночный или comma-separated список статусов), `role` (точная роль), `reportsTo` (id руководителя или `none` для корневых агентов). Фильтры объединяются через AND и применяются после `filterAgentsForActor`. Валидация неподдерживаемых query-параметров сохранена (400 с перечислением только неподдерживаемых). ETag ключа версии `svc.listSummariesVersionKey` включает нормализованные фильтры (304 не возвращается при смене фильтра; без фильтров ключ побайтно идентичен). Клиент `ui/src/api/agents.ts` принимает опциональный `AgentListFilters` | `packages/shared/src/types/agent.ts`, `packages/shared/src/types/index.ts`, `packages/shared/src/index.ts`, `server/src/services/agents-filters.ts`, `server/src/services/agents.ts`, `server/src/services/index.ts`, `server/src/routes/agents.ts`, `ui/src/api/agents.ts` | Экран «Рой» (ia-v2 §6.1 G5: дерево + таблица + фильтры) требует серверных фильтров | `server/src/__tests__/agents-list-filters.test.ts` (каждый фильтр по отдельности, все вместе (AND), fixture 5 агентов, ETag разделение, регресс без параметров, 400 на ?foo=1) | Никогда, наше поведение (1.7 UI-2.0 РОЙ) | OPE-10129 |
