---
divergence-section: Трек 3 — шлюз инструментов и адаптер Hermes
---

## changelog-en
### Tools gallery and connections accept a granted agent, not only a board actor (F22)

- `GET /companies/:companyId/tools/gallery`, `GET /companies/:companyId/tools/connections`,
  `GET /tool-connections/:id`, `POST /companies/:companyId/tools/connections`,
  `PATCH /tool-connections/:id` and `PUT /tool-connections/:id/installs` now admit an
  agent actor holding an explicit company grant: `tools:admin` or
  `tools:manage_connections` for reads, `tools:manage_connections` for mutations.
  Without a grant the agent gets 403; board actors keep their previous semantics.
- `DELETE /tool-connections/:id` stays operator-only for agents (403 with an
  explanatory message): removing a connection revokes every grant built on it, and
  the "with approval" interaction path is not reachable from this route without a
  task context.
- Every agent access on these surfaces writes a `tool_access_audit_events` row
  (actorType `agent`, action `tool_access.<surface>`, read/write or a denied
  delete), next to the unchanged activity-log rows.

## changelog-ru
### Галерея инструментов и подключения принимают агента по гранту, а не только board-актёра (F22)

- `GET /companies/:companyId/tools/gallery`, `GET /companies/:companyId/tools/connections`,
  `GET /tool-connections/:id`, `POST /companies/:companyId/tools/connections`,
  `PATCH /tool-connections/:id` и `PUT /tool-connections/:id/installs` теперь пропускают
  агента с явным грантом компании: `tools:admin` или `tools:manage_connections` на чтение,
  `tools:manage_connections` на мутации. Без гранта — 403; поведение board-актёров не изменилось.
- `DELETE /tool-connections/:id` для агента остаётся операторским (403 с пояснением):
  удаление снимает все построенные на подключении гранты, а путь «с одобрением»
  из этого маршрута без контекста задачи недостижим.
- Каждый агентский доступ на этих поверхностях пишет строку в `tool_access_audit_events`
  (actorType `agent`, действие `tool_access.<поверхность>`, чтение/запись или отказ на
  удалении) рядом с прежними записями журнала активности.

## divergence

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| F22 | Галерея и подключения инструментов: маршруты чита/мутаций пропускают агента по гранту `tools:admin`/`tools:manage_connections` (helper `assertBoardOrAgentGrant` в `authz.ts`), DELETE подключения агенту остаётся 403 «нужен оператор», каждый агентский вызов пишется в `tool_access_audit_events` | `server/src/routes/tool-access.ts` (гейты gallery/connections GET+POST+PATCH+PUT+DELETE, помощники `assertToolsGalleryReadAccess`/`assertToolConnection*Access`/`logToolAccessAgentAudit` с метками `myrmidon(1.6.5-F22)`), `server/src/routes/authz.ts` (`assertBoardOrAgentGrant`) | Административный агент с полными правами компании должен заменять оператора в подключении MCP; у вендора поверхности board-only. Выбор 403 для DELETE зафиксирован в описании PR (путь «с одобрением» требует контекста задачи) | `server/src/__tests__/agent-tool-permissions.myrmidon.test.ts` (myrmidon(F-22) матрица актёр × грант → код) | Когда вендор сам допустит агента по грантам на эти маршруты: удалить helper и куски `myrmidon(1.6.5-F22)`, вернуть `assertBoard`, матричный тест оставить на вендорском поведении | (этот PR) |
