---
divergence-section: KNOWLEDGE-2.0 — единый модуль знаний
---

## changelog-en

### Knowledge REST and MCP: one service, one set of rights (KNOWLEDGE-2.0 K-2 part B)

- New REST surface `/api/myrmidon/companies/:companyId/knowledge/*` (search,
  items, revisions, backlinks, suggestions, export/import, create, draft,
  submit, publish, approve, rollback, archive, supersede, propose) and one MCP
  endpoint `POST .../knowledge/mcp` over the same module and the same gates.
- Gate order: company access, tool grant (`permissions.toolAccess`), injection
  scan on writes, autonomy matrix, K-1 domain gates.
- Autonomy matrix: new action classes `knowledge_publish`, `rule_approve`,
  `skill_promote`, `knowledge_external_publish` with safe defaults
  (`rule_approve` forbidden for agents; `knowledge_publish` needs approval
  outside the auto sections). Publish, rollback, archive and supersede by an
  agent follow the same matrix; an agent never archives or supersedes a rule;
  a bulk import by an agent needs the matrix to say `allowed`.
- `POST .../knowledge/import` accepts the gzipped tree produced by `export`
  (own raw body parser on the route).
- OpenAPI entries and the guide `docs/myrmidon/guides/knowledge.md` (EN + RU).

## changelog-ru

- REST и MCP знаний: один сервис, одни права (люди и агенты). Порядок
  гейтов: компания, грант инструмента, сканер инъекций на запись, матрица
  автономии, доменные гейты K-1.
- Матрица автономии: классы `knowledge_publish`, `rule_approve`,
  `skill_promote`, `knowledge_external_publish` с безопасными умолчаниями.
  Публикация, откат, архивация и замена агентом идут через ту же матрицу;
  агент не архивирует и не заменяет регламент; массовый импорт агентом
  требует `allowed` в матрице.
- `POST .../knowledge/import` принимает gzip-дерево из `export`.

## divergence-new

### 1.6.6 — KNOWLEDGE-2.0 K-2 часть B: REST + MCP знаний и классы матрицы

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.6-KNOWLEDGE-B | REST и MCP модуля знаний с едиными гейтами (грант, инъекции, матрица, домен K-1); новые классы автономии с безопасными умолчаниями; архивация/замена/импорт агентом проходят матрицу; импорт принимает gzip-тело | Наши файлы: `server/src/myrmidon/knowledge/routes.ts`, `mcp.ts`, `packages/shared/src/myrmidon-knowledge-tools.ts`, `myrmidon-autonomy.ts`, `server/src/routes/openapi.ts`, `server/src/app.ts` (монтирование) | Люди и агенты ходят в знание одним сервисом с одними правами | `routes.myrmidon.test.ts` (П1–П4, импорт gzip, матрица для archive/supersede/import), `openapi-routes.test.ts` | Никогда, наше поведение | (этот PR) |
