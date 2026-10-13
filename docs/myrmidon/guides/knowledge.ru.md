# База знаний (KNOWLEDGE-2.0, 1.6.6)

> English version: [knowledge.md](knowledge.md)

Knowledge 2.0 — собственный вики-модуль компании: один сервис знаний, в который
ходят и люди (UI доски), и агенты (REST и MCP-инструменты) с **одними правами**.
Гайд покрывает API-поверхность из K-2 Часть B поверх домена и хранилища K-1.

Источник дизайна: `ops/audit/knowledge-architecture-2.0.md` (§3.4, §6).
Реестр решений OPE-401: 04.10 — вики своя, плагин выводится; 08.10 — плагин
включён как мост до своего модуля, перенос знаний — K-6.

## Текущее состояние

Что делает слитый код 1.6.6:

- REST-поверхность живёт под
  `/api/myrmidon/companies/:companyId/knowledge/*` — поиск, карточки, ревизии,
  бэклинки, предложения, экспорт/импорт и мутации (создание, черновик-ревизия,
  submit, publish, approve, rollback, archive, supersede, propose,
  accept/decline предложения).
- MCP-поверхность — один эндпоинт на компанию:
  `POST /api/myrmidon/companies/:companyId/knowledge/mcp` — JSON-RPC
  (`initialize`, `tools/list`, `tools/call`). Имена и схемы инструментов — в
  `packages/shared/src/myrmidon-knowledge-tools.ts`.
- Обе поверхности проходят одни и те же гейты в одном порядке над одним модулем
  (`createKnowledgeModule`), поэтому права не зависят от точки входа.

## Гейты (одни и те же пять на обеих поверхностях)

1. **Доступ к компании.** `assertCompanyAccess` — чужой компании сразу 403.
2. **Грант на инструмент (`permissions.toolAccess`, S6).** Агенту нужен грант
   на вызванный инструмент (`knowledge_search`, `knowledge_read`,
   `knowledge_propose`, `knowledge_write_draft`, `knowledge_publish`, …).
   Без гранта: HTTP 403, стабильный код `knowledge_tool_access_denied`, до
   хранилища дело не доходит. Пользователям доски грант не нужен.
3. **Сканер инъекций на запись.** Когда включён
   `MYRMIDON_GUARDRAILS_INJECTION_ENABLED`, тела propose/draft/create идут
   через `scanForInjection` (`server/src/myrmidon/guardrails/injection.ts`);
   помеченное тело отклоняется с 422 `knowledge_injection_flagged` до записи.
4. **Матрица автономии.** `knowledge_publish` агентом внутри `auto`-разделов
   (`glossary/…`, `releases/…`, `architecture/…`) публикует сразу; вне их —
   паркует карточку согласования (`tool_action_requests`, reason
   `requires_approval_policy`) и отвечает 409 `knowledge_approval_required`.
   `rule_approve` агентом **запрещён всегда** — см. П4 ниже.
5. **Доменные гейты (K-1).** Грамматика slug, автомат статусов
   (draft → in_review → published), совпадение approverKind, цепочки supersede
   — правила хранилища всплывают как 4xx со стабильными кодами.

## Критерии приёмки K-2 Часть B

- **Агент без гранта → отказ шлюза.** 403 `knowledge_tool_access_denied`;
  тесты на стабе модуля проверяют, что хранилище не трогалось.
- **`knowledge_publish` вне `auto`-разделов → карточка согласования.**
  Карточка остаётся неопубликованной, парковается карточка для доски, вызывающий
  получает 409 `knowledge_approval_required` с id карточки в details.
- **`rule_approve` агентом → `forbidden` даже по инструкции (тест П4).**
  Гейт стоит **до** грант-шлюза на роуте approve, поэтому агента с любыми
  грантами и разрешающей строкой матрицы это не спасает: правило меняет, что
  рассказывается всем агентам касты, утверждает его только человек.
  Стабильный код: `knowledge_rule_approve_forbidden`.
- **`knowledge_propose` без источников → 422.** Проверка до хранилища:
  422 `knowledge_propose_requires_sources`.
- **Поиск p95 < 500 мс FTS на 1 000 страниц** — за задачей поиска K-3 (PG FTS
  индекс); сам REST-роут поиска дополнительных запросов не добавляет.

## Умолчания матрицы автономии

В `AUTONOMY_ACTION_CLASSES` добавлены четыре класса
(`packages/shared/src/myrmidon-autonomy.ts`):

| класс действия                | умолчание агентам   | примечание                             |
| ----------------------------- | -------------------- | -------------------------------------- |
| `knowledge_publish`           | `approval_required`  | `allowed` внутри `auto`-разделов       |
| `rule_approve`                | `forbidden`          | не переопределяется инструкциями агента |
| `skill_promote`               | `approval_required`  | продвижение скилла до касты            |
| `knowledge_external_publish`  | `forbidden`          | публикация знаний наружу компании      |

Операторы правят матрицу на существующем экране автономии
(Настройки → Autonomy); при отсутствии подходящей строки применяются
безопасные умолчания.

## Работа с MCP-эндпоинтом

```json
POST /api/myrmidon/companies/:companyId/knowledge/mcp
{"jsonrpc":"2.0","id":1,"method":"tools/list"}
```

Пример `tools/call` (`knowledge_search`):

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call",
 "params":{"name":"knowledge_search","arguments":{"q":"deploy runbook"}}}
```

Отказы приходят JSON-RPC-ошибками с теми же стабильными кодами (403
`knowledge_tool_access_denied`, 409 `knowledge_approval_required`, …), поэтому
клиент реагирует на коды, а не на текст сообщения.

## Где код

- `server/src/myrmidon/knowledge/routes.ts` — REST-роутер и его гейты.
- `server/src/myrmidon/knowledge/mcp.ts` — MCP-эндпоинт и схемы инструментов.
- `server/src/myrmidon/knowledge/service.ts` — модуль на компанию.
- `packages/shared/src/myrmidon-knowledge-tools.ts` — имена инструментов,
  `auto`-разделы, стабильные коды.
- `packages/shared/src/myrmidon-autonomy.ts` — классы действий и умолчания.
- Тесты: `server/src/myrmidon/knowledge/routes.myrmidon.test.ts` (П1–П4).
