## changelog-en

### Validate identifier parameters on issue routes (1.6.9 ISSUES-LIST-BAD-ID)

- `GET /api/companies/:companyId/issues` validates identifier query parameters (`participantAgentId`, `projectId`, `workspaceId`, `executionWorkspaceId`, `labelId`) as UUIDs, returning 400 instead of a PostgreSQL 22P02 database error.
- Task reference parameters (`parentId`, `parentIssueId`, `descendantOf`, `createdFromIssueId`) resolve issue identifiers before UUID verification, returning 400 for malformed values.
- `POST /api/companies/:companyId/issues` validates that referenced entities (`projectId`, `parentId`, `assigneeAgentId`, `labelIds`, `goalId`) exist, returning 422 instead of a foreign key constraint violation.

## changelog-ru

### Валидация идентификаторов в маршрутах задач (1.6.9 ISSUES-LIST-BAD-ID)

- `GET /api/companies/:companyId/issues` валидирует параметры запроса идентификаторов (`participantAgentId`, `projectId`, `workspaceId`, `executionWorkspaceId`, `labelId`) как UUID, возвращая 400 вместо ошибки базы данных PostgreSQL 22P02.
- Параметры ссылки на задачи (`parentId`, `parentIssueId`, `descendantOf`, `createdFromIssueId`) разрешают ключи задач перед проверкой UUID и возвращают 400 при некорректном формате.
- `POST /api/companies/:companyId/issues` проверяет существование связанных сущностей (`projectId`, `parentId`, `assigneeAgentId`, `labelIds`, `goalId`) и возвращает 422 вместо нарушения foreign key constraint базы данных.
