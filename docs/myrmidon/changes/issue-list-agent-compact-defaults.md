---
divergence-section: Трек 2 — ядро побудок и прогонов
---

## changelog-en

### Issues list defaults for agent actors: compact projection, limit 50, description only on request (1.6.5 F-16)

- `GET /api/companies/:companyId/issues` answered agents with the full vendor
  projection (limit up to `ISSUE_LIST_DEFAULT_LIMIT`, `description` inline).
  Every heartbeat wake embeds that list, so the payload dominated the wake
  prompt and answered bodies over 64 KB overflowed nginx's default proxy
  buffers.
- Agent actors (`req.actor.type === "agent"`) now default to the compact
  projection (the same serializer as `?view=compact`), `limit=50` when the
  query carries no `limit`, and no `description` field. Explicit requests win:
  `?view=compact`/`?view=full` choose the projection, `?includeDescription=true`
  restores the heavy field, an explicit `limit` is honored inside
  `clampIssueListLimit`, `?includeDescription=false` declines it on any view.
  Invalid `includeDescription` values answer 400. Task-bridge key actors are
  still rejected on this endpoint, so nothing they can reach changes.
- Board actors are untouched: no `view` parameter keeps the full projection,
  the vendor default limit and `description` (covered by a regression test).
- The response cache keys both projection axes (`view` + `includeDescription`),
  so a trimmed and a full answer never collide for one actor.
- Deploy: `scripts/myrmidon/deploy/nginx-proxy-buffers.conf.example` carries
  the reverse-proxy server-block fragment (`proxy_buffer_size 64k`,
  `proxy_buffers 16 64k`, `proxy_busy_buffers_size 128k`) sized for 64 KB+
  answers; docs/myrmidon/deploy(.ru).md explain where to merge it.

## changelog-ru

### Список задач для актёров-агентов: умолчание compact, limit 50, description по явному запросу (1.6.5 F-16)

- `GET /api/companies/:companyId/issues` отвечал агентам полной вендорской
  проекцией (limit до `ISSUE_LIST_DEFAULT_LIMIT`, `description` внутри). Ответ
  списка встраивается в каждую побудку heartbeat — он dominated промпт побудки,
  а тела больше 64 КБ не помещались в штатные прокси-буферы nginx.
- Актёр-агент (`req.actor.type === "agent"`) теперь по умолчанию получает
  compact-проекцию (тот же сериализатор, что `?view=compact`), `limit=50` без
  явного `limit` и без поля `description`. Явный запрос важнее умолчания:
  `?view=compact`/`?view=full` выбирают проекцию, `?includeDescription=true`
  возвращает тяжёлое поле, явный `limit` уважается в рамках
  `clampIssueListLimit`, `?includeDescription=false` отключает его на любой
  проекции. Некорректное значение `includeDescription` — 400. Task-bridge ключи
  на этом маршруте по-прежнему отклоняются.
- Board-актёр не затронут: без `view` — прежняя полная проекция, прежний
  вендорский limit и `description` (покрыто регрессионным тестом).
- Кэш ответов ключует обе оси проекции (`view` + `includeDescription`) —
  урезанный и полный ответы одного актёра не сталкиваются.
- Выкат: `scripts/myrmidon/deploy/nginx-proxy-buffers.conf.example` — фрагмент
  server-блока reverse-прокси (`proxy_buffer_size 64k`, `proxy_buffers 16 64k`,
  `proxy_busy_buffers_size 128k`) под ответы 64 КБ+; в docs/myrmidon/deploy(.ru).md
  указано, куда его вставлять.

## divergence

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
| --- | --- | --- | --- | --- | --- | --- |
| AGENT-ISSUE-LIST | GET /companies/:companyId/issues: для актёра-агента умолчания compact-проекция, limit=50, description только по явному запросу (view/limit/description явные — как у вендора); board-актёр не затронут | server/src/routes/issues.ts (list handler, issueListRequestKey) | Ответ списка попадает в промпт каждой побудки агента; полная проекция раздувала wake-пейлоад и вылезала за штатные nginx proxy_buffers | server/src/__tests__/issue-list-agent-compact-defaults.test.ts (agent defaults, explicit params, board no-regression) | вернуть `compactView = view === "compact"`, `limit = parsedLimit ?? ISSUE_LIST_DEFAULT_LIMIT` в handler'е, удалить stripIssueListDescriptions в двух ветках сериализации и модуль server/src/myrmidon/agent-issue-list-defaults.ts | бандл для переноса в upstream (rel/1.6.5-rc.7) |
