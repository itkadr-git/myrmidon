# Runbook создания и проверки внешнего гнезда (OPE-10548 PR-1)

> English version: [external-nest-runbook.md](external-nest-runbook.md)

Операционный регламент первой волны для создания, конфигурации, проверки изоляции и отзыва доступа внешнего гнезда клиента (OPE-10548, эпик OPE-3799 п.1) на платформе Myrmidon.

---

## 1. Архитектурные принципы и границы изоляции

1. **Единица изоляции — компания-арендатор (`company`)**:
   - Клиент изолируется на уровне компании в единой базе данных PostgreSQL доски владельца. Отдельная база данных или отдельный инстанс на клиента **не создаются** (архитектурное решение контракта OPE-10548 §1).
   - Все ресурсы (задачи, проекты, агенты, секреты, каналы, бюджеты) строго привязаны к `company_id`.
2. **Модель участников**:
   - **Владелец доски (`adm`)**: выполняет администрирование через API/UI владельца (создание компании, касты, агента, лимитов, привязку гнезд).
   - **Оператор стенда**: управляет контейнерами и секретами платформы.
   - **Клиент**: конечный пользователь внешнего канала (Telegram-чат, веб-виджет); не имеет прямого доступа к API или UI доски Myrmidon, UI наружу не публикуется.
3. **Изоляция исполнения**:
   - Агент внешнего бота привязывается к проектам клиента через `agent_nests`.
   - **Критическая граница применимости**: SQL-матчер `agentNestsAllowSql` (`server/src/myrmidon/castes/resolve.ts:87–92`) содержит условие:
     `not exists (select 1 from agent_nests n where n.agent_id = ${agent}) or ${args.projectId} is null or exists (select 1 from agent_nests n where n.agent_id = ${agent} and n.project_id = ${args.projectId})`.
     Агент с гнездом P1 не берет задачи из проекта P2, но **берет задачи без проекта (`projectId IS NULL`)** внутри компании (подтверждено тестом `server/src/myrmidon/castes/castes-default-and-nests.db.myrmidon.test.ts:257–277`).
     Следовательно, механизм `agent_nests` сам по себе **не гарантирует** полную изоляцию от задач без проекта. В компании-арендаторе с внешним ботом обязателен административный регламент: всем задачам явно назначается `projectId`, а project-less задачи исключаются из каст внешнего бота.

---

## 2. Предусловия (Preconditions)

Перед началом настройки внешнего гнезда убедитесь:
- Сервер Myrmidon находится в рабочем состоянии (`GET /api/health` возвращает `status: "ok"`).
- Доступны учетные данные владельца доски (`MYRMIDON_API_KEY` с правами instance admin).
- Определены параметры клиента: название компании, лимиты расходов (`budgetMonthlyCents`), проектные квоты токенов. Префикс задач (`issuePrefix`) генерируется платформой автоматически на основе имени компании.

---

## 3. Последовательность создания и настройки внешнего гнезда

### Шаг 1. Создание компании-арендатора
Компания создается вызовом instance-admin API. По схеме `createCompanySchema` (`packages/shared/src/validators/company.ts`) принимаются поля `name`, `description`, `budgetMonthlyCents` и `defaultResponsibleUserId`:

```http
POST /api/companies
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "name": "Acme External Client",
  "description": "Tenant company for external client Acme",
  "budgetMonthlyCents": 50000
}
```

**Ожидаемый ответ:** HTTP 201 Created с телом компании:
```json
{
  "id": "c1000000-0000-0000-0000-000000000001",
  "name": "Acme External Client",
  "description": "Tenant company for external client Acme",
  "issuePrefix": "ACME",
  "budgetMonthlyCents": 50000,
  "status": "active"
}
```

**Инварианты:**
- Префикс задач (`issuePrefix`) не передается в запросе на создание, а автоматически вычисляется платформой (`createCompanyWithUniquePrefix`, fallback default `PAP`). Если префикс `ACME` уже занят, платформа выделит уникальный суффикс (например `ACME1`).
- Фактический выделенный префикс проверяется из ответа создания или вызовом `GET /api/companies/:companyId`.
- В аудит-логе фиксируется действие `company.created`.
- `budgetMonthlyCents` задает верхний предел расходов компании в центах.

---

### Шаг 2. Создание касты внешнего бота
Внутри компании-арендатора регистрируется выделенная каста. Поле `color` должно соответствовать `CASTE_COLORS` (`packages/shared/src/myrmidon-castes.ts`: `primary`, `muted`, `blue`, `amber`, `green`, `violet`, `red`, `gray`):

```http
POST /api/myrmidon/companies/:companyId/castes
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "key": "external-bot",
  "nameRu": "Внешний бот",
  "nameEn": "External Bot",
  "description": "Каста агентов внешнего клиентского бота с изоляцией гнезда",
  "color": "violet"
}
```

**Ожидаемый ответ:** HTTP 201 Created с зарегистрированной кастой.

**Инварианты:**
- Касты scoped строго внутри `companyId` (тест `castes.db.myrmidon.test.ts: company A's castes are invisible to company B`). Каста `external-bot` компании Acme не пересекается с другими арендаторами.

---

### Шаг 3. Создание проекта клиента с `defaultCasteKey`
Проект создается с указанием касты по умолчанию:

```http
POST /api/companies/:companyId/projects
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "name": "Acme Support Bot",
  "defaultCasteKey": "external-bot"
}
```

**Ожидаемый ответ:** HTTP 201 Created с атрибутами проекта, включая `defaultCasteKey: "external-bot"`.

**Инварианты:**
- Задачи проекта автоматически наследуют касту через `resolveTaskCaste(db, { companyId, issueId })` (`server/src/myrmidon/castes/resolve.ts`) при отсутствии явной касты в задаче.
- Платформа валидирует существование касты в рамках данной компании (`assertProjectDefaultCasteExists`).

---

### Шаг 4. Создание агента внешнего бота и привязка к гнезду (`agent_nests`)

#### 4.1. Создание агента
По схеме `createAgentSchema` (`packages/shared/src/validators/agent.ts`), поле `capabilities` является строкой (`z.string().optional().nullable()`), а роль — ключом касты:

```http
POST /api/companies/:companyId/agents
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "name": "acme-bot",
  "role": "external-bot",
  "title": "Acme Support Agent",
  "adapterType": "process",
  "capabilities": "chat, customer-support",
  "budgetMonthlyCents": 20000
}
```

**Ожидаемый ответ:** HTTP 201 Created со сгенерированным `id` агента (`agentId`).

#### 4.2. Привязка к гнезду (ограничение проектов агента)
```http
PUT /api/myrmidon/companies/:companyId/agents/:agentId/nests
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "projectIds": [
    "<projectId-из-шага-3>"
  ]
}
```

**Ожидаемый ответ:** HTTP 200 OK со списком привязанных `projectIds`.

**Инварианты:**
- Запись создается в таблице `agent_nests(company_id, agent_id, project_id)`.
- Маршрут отвергает проекты чужих компаний с кодом HTTP 400 (`server/src/myrmidon/castes/nests-api.myrmidon.test.ts: another company's project is unknown (400)`).
- Планировщик разрешает агенту брать задачи **только** из проектов его гнезда (`agentNestAllowsProject` в `packages/shared/src/myrmidon-agent-nests.ts`).

---

### Шаг 5. Установка лимитов бюджета и квот токенов

#### 5.1. Установка лимитов расходов гнезда (`budget_limits`)
Реальный контракт платформы (`packages/shared/src/myrmidon-budget-limits.ts`, `server/src/myrmidon/budget-limits/routes.ts`) поддерживает иерархические лимиты уровня `nest` (где `ref` — идентификатор проекта `projectId`):

```http
PUT /api/myrmidon/companies/:companyId/budget-limits/limits/nest/:projectId
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "amountCents": 15000,
  "period": "calendar_month_utc",
  "mode": "hard",
  "isActive": true
}
```

**Ожидаемый ответ:** HTTP 200 OK с сохраненным объектом лимита (`BudgetLimitView`).

**Инварианты и границы применения:**
- `mode: "hard"`: при превышении лимита планировщик жестко блокирует допуск прогона к исполнению (`refuse`, функция `evaluateBudgetLimitAdmission` в `server/src/myrmidon/budget-limits/admission.ts:15–16`, подтверждено тестами `admission.unit.test.ts:31` и `admission.db.myrmidon.test.ts:123`).
- `mode: "soft"`: при превышении лимита `admission.ts:17–18` явно **не** блокирует допуск прогона (`a soft limit never refuses on admission`); приостановка агента (`pause`) и карточка владельцу инициируются асинхронно через подсистему инцидентов (BUDGET-CONFIG-B). Живая пауза агента при soft-превышении является ожидаемым результатом live-проверки (live-прогон на проде не выполнялся).
- `period`: допустимы значения `"calendar_month_utc"` и `"lifetime"`.
- Текущее потребление доступно через `GET /api/myrmidon/companies/:companyId/budget-limits/usage`.
- Все изменения лимитов журналируются в `GET /api/myrmidon/companies/:companyId/budget-limits/journal` (таблица `budget_limit_changes`, подтверждено тестом `server/src/myrmidon/budget-limits/routes.myrmidon.test.ts`).

#### 5.2. Установка суточных и недельных квот токенов (`project_token_quotas`)
Реальный эндпоинт квот токенов проекта (`server/src/myrmidon/project-token-quota/routes.ts`, `packages/shared/src/myrmidon-project-token-quota.ts`) использует путь в единственном числе:

```http
PUT /api/myrmidon/companies/:companyId/projects/:projectId/token-quota
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "dailyTokenLimit": 500000,
  "weeklyTokenLimit": 2500000
}
```

*(Значение `null` для любого из полей снимает ограничение соответствующего окна).*

**Ожидаемый ответ:** HTTP 200 OK со сводкой квоты и текущего статуса.

**Инварианты и границы применения:**
- Статус квоты и конфигурация проверяются вызовом `GET /api/myrmidon/companies/:companyId/projects/:projectId/token-quota` (подтверждено в `server/src/myrmidon/project-token-quota/routes.ts`).
- Логика проверки квоты подтверждена тестом `server/src/myrmidon/project-token-quota/project-token-quota.myrmidon.test.ts:163`: при исчерпании лимита `getProjectTokenQuotaBlock` возвращает непустой блок с указанием превышенного окна.
- Интеграция с циклом исполнения реализована в `server/src/services/heartbeat.ts:31700–31726`: при блокировке квоты задача отклоняется с кодом `PROJECT_TOKEN_QUOTA_EXCEEDED_ERROR_CODE` (`project.token_quota_exceeded`), и пишется событие в `project_token_usage_events`. Переход в БД на активном раннере является ожидаемым результатом live-проверки (live-прогон на проде не выполнялся).

---

### Шаг 6. Настройка секретов компании и привязка к агенту (Secret Bindings)

#### 6.1. Создание секрета компании
Секреты создаются в скоупе компании-арендатора через `POST /api/companies/:companyId/secrets` (`packages/shared/src/validators/secret.ts`, `server/src/routes/secrets.ts`). Поле `provider` задает механизм безопасного хранения (`SECRET_PROVIDERS = local_encrypted | aws_secrets_manager | gcp_secret_manager | vault`), а не название LLM-сервиса:

```http
POST /api/companies/:companyId/secrets
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "name": "OPENAI_API_KEY",
  "value": "<SECRET_KEY_VALUE>",
  "description": "Acme provider API key",
  "provider": "local_encrypted"
}
```

**Ожидаемый ответ:** HTTP 201 Created с метаданными секрета (`id` = `secretId`; поле `value` из ответа API исключено).

#### 6.2. Назначение привязки секрета к агенту (`agent secret binding`)
Привязка секрета к среде исполнения агента выполняется через объявление `secret_ref` в конфигурации адаптера `PATCH /api/agents/:agentId`:

```http
PATCH /api/agents/:agentId
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "adapterConfig": {
    "env": {
      "OPENAI_API_KEY": {
        "type": "secret_ref",
        "secretId": "<secretId-из-шага-6.1>",
        "version": "latest"
      }
    }
  }
}
```

**Ожидаемый ответ:** HTTP 200 OK с обновленной конфигурацией агента.

**Инварианты:**
- При обновлении `adapterConfig` сервис агентов вызывает `syncAgentSecretBindings` (`server/src/services/agents.ts:703`), передавая декларации в `syncSecretRefsForTarget` (`server/src/services/secrets.ts:4821`).
- Платформа валидирует принадлежность `secretId` той же компании (кросс-компанейские ссылки отклоняются).
- В таблице `company_secret_bindings` создается запись, а в аудит-лог пишется событие `secret.binding.created` (подтверждено тестом `server/src/__tests__/agents-service-secret-bindings.test.ts:78–127`).
- Просмотр активных привязок секрета доступен оператору через `GET /api/secrets/:secretId/usage`.
- Значения секретов шифруются в базе данных и никогда не возвращаются в ответах API (`GET /api/companies/:companyId/secrets`).
- Расшифровка и чтение секрета при исполнении фиксируются в `secret_access_events` (`server/src/__tests__/qa-routine-secrets-e2e.test.ts:8,158`, `server/src/__tests__/secrets-service.test.ts:4668`). Журналирование реального прогона внешнего бота является ожидаемым результатом live-проверки.
- Все обращения к секрету во время прогонов логируются в таблице `secret_access_events`.

---

### Шаг 7. Настройка входящего канала (`chat_endpoints`)
Регистрация точки подключения внешнего чата выполняется по строгой схеме `createChatEndpointSchema` (`packages/shared/src/validators/chat-channels.ts`):

```http
POST /api/chat-endpoints
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "provider": "telegram",
  "assignedAgentId": "<agentId>",
  "name": "Acme Support Bot"
}
```

**Ожидаемый ответ:** HTTP 201 Created с объектом конечной точки (`id` = `endpointId`, статус `draft`).

Настройка учетных данных провайдера и перевод в активное состояние выполняются через маршрут конфигурирования жизненного цикла `POST /api/chat-endpoints/:endpointId/configure`:

```http
POST /api/chat-endpoints/:endpointId/configure
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "action": "configure",
  "credentials": {
    "botToken": "<TELEGRAM_BOT_TOKEN>"
  }
}
```

**Инварианты и границы первой волны:**
- Маршрутизация входящих сообщений привязана к `assignedAgentId`, который изолирован в проектах своего гнезда.
- В первой волне проверка членства во внешних чатах (`enforceChatMembership`, фильтрация по `allowedChatIds`) в REST API схеме `chat_endpoints` отсутствует. Ограничение доступа реализуется на уровне настроек бота во внешнем мессенджере (приватный бот / ограниченная группа) оператором вручную; поддержка расширенного гейта источников запланирована в рамках коннектор-контракта PR-3 (OPE-10550).

---

## 4. Порядок отзыва доступа и деактивации (Rollback & Revocation)

При завершении договора с клиентом или подозрении на компрометацию выполните следующую процедуру отзыва:

### Шаг R1. Приостановка или удаление входящего канала
Приостановка приема входящих сообщений выполняется вызовом конфигурирования с действием `pause`:

```http
POST /api/chat-endpoints/:endpointId/configure
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "action": "pause"
}
```

Для полного удаления канала вызывается действие `remove`:
```http
POST /api/chat-endpoints/:endpointId/configure
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "action": "remove"
}
```
*(Прямой метод `DELETE /api/chat-endpoints/:id` или `PATCH status` в API отсутствует; управление состоянием производится строго через `configure`).*

### Шаг R2. Принудительная пауза или терминация агента
Отмена активных прогонов и блокировка пробуждений агента:

```http
POST /api/agents/:agentId/pause
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "reason": "Client contract terminated",
  "cancelActive": true
}
```

Для окончательного прекращения работы агента:
```http
POST /api/agents/:agentId/terminate
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "reason": "Client contract terminated"
}
```

### Шаг R3. Снятие привязок секретов и удаление секрета

#### R3.1. Снятие привязки секрета с агента (Secret Binding Revocation)
Чтобы исключить секрет из окружения агента и остановить передачу учетных данных в контейнер, очистите ссылку на секрет в `adapterConfig.env`:

```http
PATCH /api/agents/:agentId
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "adapterConfig": {
    "env": {}
  }
}
```

**Ожидаемый ответ:** HTTP 200 OK.
`agentService.update` вызывает `syncAgentSecretBindings` (`server/src/services/agents.ts:703`), который выполняет `syncSecretRefsForTarget` с опцией `{ replaceAll: true }`. Так как список ссылок пуст, платформа немедленно удаляет записи привязок данного агента из таблицы `company_secret_bindings` (подтверждено тестом `server/src/__tests__/agents-service-secret-bindings.test.ts:304–326`), прекращая внедрение переменной окружения при последующих запусках.

#### R3.2. Удаление определения секрета компании
```http
DELETE /api/secrets/:secretId
Authorization: Bearer $MYRMIDON_API_KEY
```

**Ожидаемый ответ:** HTTP 200 OK / HTTP 204 No Content.
*(Либо ротация на недействительное значение через интерфейс управления секретами).* Запись удаляется из `company_secrets`. Все последующие попытки использования удаленного секрета терпят неудачу (fail-closed).

### Шаг R4. Отзыв проектного доступа и изоляция гнезда
> **ВНИМАНИЕ! КРИТИЧЕСКИЙ ИНВАРИАНТ БЕЗОПАСНОСТИ:**
> Никогда не используйте `PUT /api/myrmidon/companies/:companyId/agents/:agentId/nests` с пустым списком `{"projectIds": []}` в качестве отзыва доступа!
> Согласно семантике `agent_nests` (`packages/shared/src/myrmidon-agent-nests.ts` и `agentNestAllowsProject`), пустой массив означает, что агент является резидентом всей компании и может брать задачи из **любого** проекта. Передача пустого списка не отзывает доступ, а расширяет его.

Для надежного отзыва доступа к проекту:
1. Выполните терминацию или постоянную паузу агента (шаг R2).
2. Если агент должен продолжить работу над другими проектами клиента, передайте в `PUT nests` только оставшиеся разрешенные `projectIds` (без отозванного проекта).
3. Для полной изоляции агента без терминации перепривяжите его к выделенному пустому/архивному проекту-заглушке, но не очищайте список до пустого массива.

### Шаг R5. Проверка журналов аудита
Оператор проверяет аудит-след деактивации:
1. История изменений лимитов бюджета: `GET /api/myrmidon/companies/:companyId/budget-limits/journal`
2. Журнал доступа к секретам: `GET /api/secrets/:secretId/access-events`
3. Журнал активности компании: `GET /api/companies/:companyId/activity`

---

## 5. Чеклист проверки изоляции и доказательства (Evidence Matrix)

| # | Проверяемый критерий | Метод проверки / запрос | Ожидаемый результат | Чем подтверждено в коде/тестах |
|---|---|---|---|---|
| 1 | Изоляция задач (Nest task confinement) с границей project-less | Создать задачу в компании B, в неразрешенном проекте P2 компании A или задачу без проекта в компании A | Агент Acme Bot исключается из выборки задач других компаний и других проектов. **Граница применимости:** `agentNestsAllowSql` разрешает задачи с `projectId IS NULL`; агент возьмет задачу без проекта, если регламентом не запрещено создание задач без проекта. | SQL-матчер `server/src/myrmidon/castes/resolve.ts:87–92`, тесты `server/src/myrmidon/castes/castes-default-and-nests.db.myrmidon.test.ts:257–277` и `resolve.myrmidon.test.ts` |
| 2 | Запрет кросс-арендных гнезд | `PUT /api/myrmidon/companies/:companyA/agents/:agentA/nests` с `projectIds` компании B | HTTP 400 Bad Request, гнездо не создается | Тест `server/src/myrmidon/castes/nests-api.myrmidon.test.ts: nests: another company's project is unknown (400)` |
| 3 | Сокрытие значений секретов | `GET /api/companies/:companyId/secrets` | В ответе список метаданных, поле `value` отсутствует | `server/src/routes/secrets.ts`, тест `server/src/__tests__/board-key-tenant-confinement.test.ts` |
| 4 | Межарендная изоляция секретов | Попытка чтения секрета компании A токеном/контекстом компании B | HTTP 404 Not Found (сокрытие существования) или HTTP 403 Forbidden | `packages/shared/src/validators/secret.ts`, `server/src/routes/secrets.ts`, тест `server/src/__tests__/agent-cross-tenant-authz-routes.test.ts` |
| 5 | Конфигурация и применение `budget_limits` | 1) Установка лимита `PUT .../limits/nest/:projectId`. 2) Превышение лимита в режимах `hard` и `soft`. | 1) Лимит сохранен и зафиксирован в журнале `budget_limit_changes`. 2) При `mode: "hard"` — жесткий отказ допуска прогона (`refuse`). 3) При `mode: "soft"` — допуск не блокируется (`admission.ts:17-18`); асинхронная пауза агента и карточка владельцу — ожидаемый результат live-проверки. | Конфигурация и журнал проверены тестом `server/src/myrmidon/budget-limits/routes.myrmidon.test.ts`. Блокировка hard проверена тестами `admission.unit.test.ts:31` и `admission.db.myrmidon.test.ts:123`. Живая пауза soft — ожидаемый результат live-проверки (live-прогон на проде не выполнялся). |
| 6 | Конфигурация и применение `project_token_quotas` | 1) Установка квот `PUT .../token-quota`. 2) Оценка превышения лимитов окон. | 1) Квота сохраняется и отдается через `routes.ts`. 2) Блокировка окна выявляется `getProjectTokenQuotaBlock`. 3) Пропуск запуска в `heartbeat.ts:31700` с `project.token_quota_exceeded` — ожидаемый результат live-проверки. | Маршрут проверен в `server/src/myrmidon/project-token-quota/routes.ts`. Логика блокировки проверена тестом `project-token-quota.myrmidon.test.ts:163`. Пропуск раннера — ожидаемый результат live-проверки (live-прогон на проде не выполнялся). |
| 7 | Привязка секретов и аудит доступа | 1) Привязка секрета к агенту `PATCH /api/agents/:agentId`. 2) Исполнение прогона с обращением к секрету. | 1) Запись в `company_secret_bindings` и событие `secret.binding.created` в `activity_log`. 2) Расшифровка фиксируется в `secret_access_events`. | Создание привязки и аудит проверены тестом `server/src/__tests__/agents-service-secret-bindings.test.ts:78–127`. Фиксация доступа к секрету проверена тестами `qa-routine-secrets-e2e.test.ts:8,158` и `secrets-service.test.ts:4668`. Событие прогона — ожидаемый результат live-проверки. |
| 8 | Аудит отзыва доступа | Выполнение шагов R1–R5 (пауза, очистка привязок через `adapterConfig.env: {}`, удаление секрета) | Агент деактивирован, привязки удалены из `company_secret_bindings`, секрет удален из `company_secrets`. | Очистка привязок проверена тестом `server/src/__tests__/agents-service-secret-bindings.test.ts:304–326`. Удаление секрета проверено в `routes/secrets.ts`. Полный live-след отзыва — ожидаемый результат live-проверки (live-прогон на проде не выполнялся). |

---

## 6. Границы готовности платформы и отложенные работы

Для прозрачности планирования функционал внешних гнезд строго разделен на три категории:

### Реализовано в платформе (Myrmidon core main 1.6.5/1.6.6)
- Единая PostgreSQL с полной изоляцией данных по `company_id`.
- Создание компаний с автоматической генерацией уникального `issuePrefix` и настройкой `budgetMonthlyCents`.
- Касты с областью видимости компании (`/myrmidon/companies/:companyId/castes`).
- Назначение `defaultCasteKey` на уровне проекта и разрешение через `resolveTaskCaste`.
- Привязка агентов к проектам через `agent_nests` с защитой от межкомпанейских проектов.
- Лимиты бюджета проекта `budget_limits` (уровень nest: `PUT .../budget-limits/limits/nest/:projectId`) с режимами `hard` (refuse) и `soft` (pause), аудит изменений в журнале `GET .../budget-limits/journal`.
- Суточные и недельные квоты токенов `project_token_quotas` (`PUT .../projects/:projectId/token-quota`) с фиксацией пропусков `project.token_quota_exceeded`.
- Секреты компании с хранилищем `local_encrypted` / `vault`, серверное внедрение и аудит в `secret_access_events`.
- Реестр внешних чатов `chat_endpoints` и жизненный цикл (`configure` с `action: pause | resume | remove`).

### Ручные шаги оператора/владельца
- Создание учетной записи компании-арендатора через API/UI владельца.
- Установка начальных лимитов бюджета и квот токенов при онбординге клиента.
- Ввод API-ключа провайдера модели оператором в зашифрованное хранилище секретов компании.
- Настройка внешнего мессенджера (приватность группы, доступность бота) до появления программного гейта членства.
- Вызов команд деактивации и отзыва при прекращении обслуживания.

### Отложенные работы (за пределами PR-1)
1. **OPE-10549**: Временные секреты с TTL (динамическая ротация через Vault, автоматическое истечение срока действия ключей).
2. **OPE-9131**: Встраивание плагина `myrmidon.personal-bot` в UI доски (ввод секретов клиентом/оператором через веб-интерфейс, экраны настройки персонального бота).
3. **PR-3 / PR-4 (OPE-10548, OPE-10550)**: Коннекторы внешних каналов с встроенной проверкой членства (`enforceChatMembership`) и веб-виджет для сайта клиента с валидацией Origin и доменов.
4. **PR-5 (OPE-10548)**: Журналирование и выгрузка истории клиентских диалогов.

---

## 7. Отметка о проведении проверок (Live Execution Note)

Live-прогон создания компании на боевом инстансе `paperclip-server-1` намеренно **не выполнялся**, чтобы не засорять производственную базу данных тестовыми арендаторами без согласованного окна обслуживания.

Все API-эндпоинты, форматы тел запросов, ограничения и инварианты изоляции проверены непосредственно по актуальной кодовой базе `itkadr-git/myrmidon` (ветка `main`) и подтверждены интеграционными тестами (`server/src/__tests__/agent-cross-tenant-authz-routes.test.ts`, `server/src/__tests__/board-key-tenant-confinement.test.ts`, `server/src/__tests__/plugin-tenant-isolation.test.ts`, `server/src/myrmidon/castes/castes-default-and-nests.db.myrmidon.test.ts`, `server/src/myrmidon/castes/nests-api.myrmidon.test.ts`, `server/src/myrmidon/budget-limits/routes.myrmidon.test.ts`).
