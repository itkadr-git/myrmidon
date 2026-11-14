---
settings-section: Track 1 — Core API and backend
---

## changelog-en

### Validate identifier parameters on issue list and creation routes (OPE-13073)

Passing an issue key or invalid UUID to `GET /api/companies/:companyId/issues` filter parameters previously triggered Postgres error `22P02` (invalid input syntax for type uuid), resulting in a 500 response. The filter parameters (`projectId`, `workspaceId`, `executionWorkspaceId`, `participantAgentId`, `labelId`, `parentId`, `parentIssueId`, `descendantOf`, `createdFromIssueId`) now properly resolve issue identifiers or return HTTP 400 when malformed. In addition, `POST /api/companies/:companyId/issues` validates referenced entities (`projectId`, `parentId`, `assigneeAgentId`, `goalId`, `labelIds`) upfront and returns HTTP 422 instead of triggering a 500 foreign key violation.

## changelog-ru

### Валидация идентификаторов в параметрах списка и создания задач (OPE-13073)

Передача ключа задачи или некорректного UUID в параметры фильтрации `GET /api/companies/:companyId/issues` ранее приводила к ошибке Postgres `22P02` (неверный синтаксис UUID) и ответу 500. Параметры фильтрации (`projectId`, `workspaceId`, `executionWorkspaceId`, `participantAgentId`, `labelId`, `parentId`, `parentIssueId`, `descendantOf`, `createdFromIssueId`) теперь разрешают ключ задачи или возвращают HTTP 400 при некорректном формате. Также ручка `POST /api/companies/:companyId/issues` предварительно валидирует ссылочные сущности (`projectId`, `parentId`, `assigneeAgentId`, `goalId`, `labelIds`) и возвращает 422 вместо 500 при нарушении внешних ключей.
