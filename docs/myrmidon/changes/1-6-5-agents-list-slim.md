---
---

## changelog-en

### The company agent list ships without adapter_config; the config stays one request away (PERF-DIET G2)

- `GET /api/companies/:companyId/agents` no longer returns `adapterConfig`. The
  heavy, secret-bearing column (environment bindings, secret and API-access
  references) is not read from the database at all for this response: the list
  now selects the narrow projection and extracts the model in SQL
  (`adapter_config->>'model'`) into a new `adapterModel` field.
- The full configuration stays available exactly as before through
  `GET /agents/:id` (detail), `GET /agents/:id/configuration` and
  `GET /companies/:companyId/agent-configurations`; access rules
  (`filterAgentsForActor`, the restricted view) and spend hydration are
  unchanged. An actor without `agent_config:read` keeps the old disclosure:
  the restricted list view blanks `runtimeConfig` and `adapterModel` instead of
  blanking `adapterConfig`.
- The board UI follows: the agents list renders its model column from
  `adapterModel`; the new-issue dialog and the issue properties pane read the
  selected assignee's configuration on demand (only for a `paperclip_runner`
  provider or the required-user-secret warning); the secret-access section of
  Settings → Secrets reads the configuration endpoint for the whole company.
- The `paperclipai secrets migrate-inline-env` CLI command follows too: it reads
  `GET /companies/:companyId/agent-configurations`, because the slim list no
  longer carries the inline env bindings that command migrates.

## changelog-ru

### Список агентов компании отдаётся без adapter_config; конфиг — одним запросом рядом (PERF-DIET G2)

- `GET /api/companies/:companyId/agents` больше не возвращает `adapterConfig`.
  Тяжёлая колонка с секретами (привязки переменных окружения, ссылки на
  секреты и API-доступ) на этом ответе вообще не читается из базы: список
  берёт узкую проекцию, а модель вычисляется в SQL (`adapter_config->>'model'`)
  в новое поле `adapterModel`.
- Полный конфиг остаётся доступен как раньше: `GET /agents/:id` (карточка),
  `GET /agents/:id/configuration` и `GET /companies/:companyId/agent-configurations`;
  правила доступа (`filterAgentsForActor`, ограниченный вид) и подстановка
  расхода не изменились. Актор без `agent_config:read` получает прежний объём:
  ограниченный вид списка обнуляет `runtimeConfig` и `adapterModel` вместо
  `adapterConfig`.
- Интерфейс доски переведён: колонка модели в списке агентов берётся из
  `adapterModel`; диалог новой задачи и панель свойств задачи читают конфиг
  выбранного исполнителя по запросу (только для провайдера `paperclip_runner`
  или предупреждения о пользовательских секретах); раздел доступа агентов на
  экране «Секреты» берёт конфигурации компании отдельным запросом.
- Команда CLI `paperclipai secrets migrate-inline-env` переведена следом: она
  читает `GET /companies/:companyId/agent-configurations`, потому что узкий
  список больше не отдаёт inline-привязки переменных окружения, которые эта
  команда переносит в секреты.

## divergence-new

<!-- after-line: ## 1.6.1 — ADMIN-AGENT, часть B: грантовые проверки актора на маршрутах окружений и tool-подключений -->

### 1.6.5 — PERF-DIET G2: список агентов без adapter_config

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| 1.6.5-PERF-DIET-G2 | Маршрут списка агентов компании (`GET /companies/:companyId/agents`) отдаёт узкую проекцию `AgentListItem[]` без `adapter_config`; модель приходит вычисленным полем `adapterModel` (`adapter_config->>'model'` в SQL, читается без остальных ключей конфига). Полный конфиг — как и раньше — в `GET /agents/:id`, `GET /agents/:id/configuration` и `GET /companies/:companyId/agent-configurations`; `agentService.list` остаётся полным читателем для внутренних вызовов, добавлен `listSummaries` (узкий `select`, узкое чтение для `orgChainHealth`). Ограниченный вид списка (актор без `agent_config:read`) обнуляет `runtimeConfig` и `adapterModel`. UI: список агентов берёт модель из `adapterModel`; диалог новой задачи и панель свойств задачи читают конфиг исполнителя по запросу (`queryKeys.agents.configuration`); раздел доступа агентов на экране «Секреты» читает `listConfigurations` (`queryKeys.agents.configurations`); в shared тип `Agent.adapterConfig` стал необязательным, добавлены `AgentListItem` и `AgentConfigurationSummary` | `server/src/routes/agents.ts`, `server/src/services/agents.ts`, `packages/shared/src/types/agent.ts`, `ui/src/api/agents.ts`, `ui/src/lib/queryKeys.ts`, `ui/src/pages/Agents.tsx`, `ui/src/pages/Agents.production.tsx`, `ui/src/pages/Secrets.tsx`, `ui/src/components/NewIssueDialog.tsx`, `ui/src/components/issue-properties/IssueProperties.tsx`, `cli/src/commands/client/secrets.ts` | PERF-DIET v2, пункт 1.6.2-G: `GET /agents` 2,3 с → 0,3 с на живой компании. Список сериализовал конфиг каждого агента (привязки env, ссылки на секреты) на каждый проход реконсайлера и каждой вкладки интерфейса, хотя список читает только модель; заодно исчезает класс утечек, из-за которого список приходилось редактировать per-row (TEC-7032) | `server/src/__tests__/agent-permissions-routes.test.ts` (список без `adapterConfig`, `adapterModel` на месте, ограниченный вид, `listSummaries` вместо `list`), UI-тесты `Agents.test.tsx`, `NewIssueDialog.test.tsx`, `IssueProperties.test.tsx`, `Secrets.render.test.tsx` | Никогда: наш маршрут и наш интерфейс. Вендорский аналог — `GET /agents` с полным конфигом; при переносе на вендора вернуть `adapterConfig` в проекцию и перенести потребителей из UI обратно | (этот PR) |