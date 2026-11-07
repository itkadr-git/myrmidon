# Runbook создания и проверки внешнего гнезда (OPE-10548 PR-1)

> English version: [external-nest-runbook.md](external-nest-runbook.md)

Операционный регламент первой волны для создания, конфигурации, проверки изоляции и отзыва доступа внешнего гнезда клиента (OPE-10548, эпик OPE-3799 п.1) на платформе Myrmidon.

---

## 1. Архитектурные принципы и границы изоляции

1. **Единица изоляции — компания-арендатор (`company`)**:
   - Клиент изолируется на уровне компании в единой базе данных PostgreSQL доски владельца. Отдельная база данных или отдельный инстанс на клиента **не создаются** (решение контракта OPE-10548 §1).
   - Все ресурсы (задачи, проекты, агенты, секреты, каналы, бюджеты) строго привязаны к `company_id`.
2. **Модель участников**:
   - **Владелец доски (`adm`)**: выполняет администрирование через API/UI владельца (создание компании, касты, агента, лимитов, привязку гнезд).
   - **Оператор стенда**: управляет контейнерами и секретами платформы.
   - **Клиент**: конечный пользователь внешнего канала (Telegram-чат, веб-виджет); не имеет учетной записи на доске Myrmidon, UI доски наружу не публикуется.
3. **Изоляция исполнения**:
   - Агент внешнего бота привязывается к проектам клиента через `agent_nests`. Агент с гнездами физически не может брать задачи из других проектов или других компаний (`agentNestAllowsProject`).

---

## 2. Предусловия (Preconditions)

Перед началом настройки внешнего гнезда убедитесь:
- Сервер Myrmidon находится в рабочем состоянии (`GET /api/health` возвращает `status: "ok"`).
- Доступны учетные данные владельца доски (`MYRMIDON_API_KEY` с правами instance admin).
- Определены параметры клиента: название компании, префикс задач (`issuePrefix`, латиница 2–6 символов, уникальный на доске), лимиты расходов и токенов.

---

## 3. Последовательность создания и настройки внешнего гнезда

### Шаг 1. Создание компании-арендатора
Компания создается вызовом instance-admin API:

```http
POST /api/companies
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "name": "Acme External Client",
  "issuePrefix": "ACME",
  "budgetMonthlyCents": 50000
}
```

**Ожидаемый ответ:** HTTP 201 Created с телом компании, содержащим `id` (`companyId`), `issuePrefix: "ACME"`, `budgetMonthlyCents: 50000`.

**Инварианты:**
- Уникальность `issuePrefix` на доске гарантирует префиксную изоляцию идентификаторов задач (`ACME-1`, `ACME-2`).
- В аудит-логе фиксируется действие `company.created`.
- `budgetMonthlyCents` задает верхний предел расходов компании в центах.

---

### Шаг 2. Создание касты внешнего бота
Внутри компании-арендатора регистрируется выделенная каста:

```http
POST /api/myrmidon/companies/:companyId/castes
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "key": "external-bot",
  "nameRu": "Внешний бот",
  "nameEn": "External Bot",
  "description": "Каста агентов внешнего клиентского бота с изоляцией гнезда",
  "color": "sky"
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
- Задачи проекта автоматически наследуют `defaultCasteKey` при отсутствии явной касты в задаче (`resolveTaskCasteKey`).
- Платформа валидирует существование касты в рамках данной компании (`assertProjectDefaultCasteExists`).

---

### Шаг 4. Создание агента внешнего бота и привязка к гнезду (`agent_nests`)

#### 4.1. Создание агента
```http
POST /api/companies/:companyId/agents
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "name": "acme-bot",
  "role": "external-bot",
  "title": "Acme Support Agent",
  "adapterType": "process",
  "capabilities": ["chat", "customer-support"],
  "budgetMonthlyCents": 20000
}
```

**Ожидаемый ответ:** HTTP 201 Created с сгенерированным `agentId`.

#### 4.2. Привязка к гнезду (ограничение проектов агента)
```http
PUT /api/companies/:companyId/agents/:agentId/nests
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
- Маршрут отвергает проекты чужих компаний с кодом HTTP 400 (`nests-api.myrmidon.test.ts: another company's project is unknown (400)`).
- Планировщик разрешает агенту брать задачи **только** из проектов его гнезда (`server/src/myrmidon/castes/resolve.ts`).

---

### Шаг 5. Установка лимитов бюджета и квот токенов

#### 5.1. Установка лимитов расходов гнезда (`budget_limits`)
Лимит уровня `nest` привязывается к проекту клиента:

```http
PUT /api/companies/:companyId/budget-limits/nest/:projectId
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "hardLimitCents": 15000,
  "softLimitCents": 10000,
  "period": "monthly",
  "action": "pause",
  "reason": "Acme initial monthly budget"
}
```

**Ожидаемый ответ:** HTTP 200 OK.

**Инварианты:**
- `softLimitCents`: при достижении мягкого порога генерируется предупреждение/карточка владельцу.
- `hardLimitCents`: при достижении жесткого порога исполняется заданное действие (`pause` переводит агента в паузу, `refuse` отклоняет дальнейшие вызовы).
- Каждая модификация сохраняется в журнале аудита `budget_limit_changes`.

#### 5.2. Установка суточных и недельных квот токенов (`project_token_quotas`)
```http
PUT /api/companies/:companyId/projects/:projectId/token-quotas
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "dailyLimitTokens": 500000,
  "weeklyLimitTokens": 2500000,
  "action": "reject"
}
```

**Ожидаемый ответ:** HTTP 200 OK.

**Инварианты:**
- Защита от резкого выжигания токенов модели внешними запросами.
- При превышении суточного или недельного объема вызовы отклоняются (`action: "reject"`).

---

### Шаг 6. Настройка секретов компании и привязка к потребителю
Секреты провайдеров создаются в скоупе компании-арендатора:

```http
POST /api/companies/:companyId/secrets
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "key": "LLM_API_KEY",
  "value": "<SECRET_KEY_VALUE>",
  "description": "Acme provider API key",
  "provider": "openai"
}
```

**Ожидаемый ответ:** HTTP 201 Created с метаданными секрета (поле `value` в ответе отсутствует).

**Инварианты:**
- Значения секретов шифруются в базе данных и никогда не возвращаются в ответах API (`GET /api/companies/:companyId/secrets`).
- Обращение к секрету разрешено только через серверный резолвер `secret-ref` в контексте `company_id` (урок PAP-2394).
- Все операции расшифровки и чтения логируются в `secret_access_events`.

---

### Шаг 7. Настройка входящего канала (`chat_endpoints`)
Регистрация точки подключения канала бота к проекту:

```http
POST /api/companies/:companyId/chat-endpoints
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "connectionId": "telegram-acme-bot",
  "provider": "telegram",
  "agentId": "<agentId>",
  "projectId": "<projectId>",
  "status": "active",
  "config": {
    "allowedChatIds": ["-1001234567890"],
    "enforceChatMembership": true
  }
}
```

**Ожидаемый ответ:** HTTP 201 Created с зарегистрированной точкой подключения.

**Инварианты:**
- Канал строго привязан к `companyId`, `agentId` и `projectId`.
- Проверка членства (`enforceChatMembership`) до отправки запроса в LLM предотвращает неавторизованные вызовы из внешних чатов (требование OPE-3852).

---

## 4. Порядок отзыва доступа и деактивации (Rollback & Revocation)

При завершении договора с клиентом или подозрении на компрометацию выполните следующую процедуру отзыва:

### Шаг R1. Немедленная деактивация входящего канала
Отключение входящего трафика предотвращает новые вызовы модели:

```http
PATCH /api/companies/:companyId/chat-endpoints/:endpointId
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "status": "disabled"
}
```
*(Либо полное удаление через `DELETE /api/companies/:companyId/chat-endpoints/:endpointId`)*.

### Шаг R2. Принудительная пауза или терминация агента
Отмена текущих активных прогонов и остановка агента:

```http
POST /api/agents/:agentId/pause
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "reason": "Client contract terminated",
  "cancelActive": true
}
```
*(При полном закрытии клиента вызывается `POST /api/agents/:agentId/terminate`)*.

### Шаг R3. Инвалидация и удаление секретов
```http
DELETE /api/secrets/:secretId
Authorization: Bearer $MYRMIDON_API_KEY
```
*(Либо ротация на фиктивное значение через `POST /api/secrets/:secretId/rotate`)*.
Все попытки использования удаленного секрета приведут к отказу (fail-closed).

### Шаг R4. Отвязка проекта от гнезда агента
```http
PUT /api/companies/:companyId/agents/:agentId/nests
Authorization: Bearer $MYRMIDON_API_KEY
Content-Type: application/json

{
  "projectIds": []
}
```
Агент отвязывается от проектных очередей.

### Шаг R5. Проверка журналов аудита
Оператор проверяет аудит-след деактивации:
1. История изменений лимитов: `GET /api/companies/:companyId/budget-limits/changes`
2. Журнал доступа к секретам: `GET /api/secrets/:secretId/access-events`
3. Журнал активности компании: `GET /api/companies/:companyId/activity`

---

## 5. Чеклист проверки изоляции и доказательства (Evidence Matrix)

| # | Проверяемый критерий | Метод проверки / запрос | Ожидаемый результат | Чем подтверждено в коде/тестах |
|---|---|---|---|---|
| 1 | Изоляция задач (Nest confinement) | Создать задачу в компании B или в проекте компании A вне nests агента | Агент Acme Bot не матчится планировщиком (match score = 0, исключен из выборки) | `server/src/myrmidon/castes/resolve.ts`, тест `castes-default-and-nests.db.myrmidon.test.ts` |
| 2 | Запрет кросс-арендных гнезд | `PUT /api/companies/:companyA/agents/:agentA/nests` с `projectIds` компании B | HTTP 400 Bad Request, гнездо не создается | Тест `nests-api.myrmidon.test.ts: nests: another company's agent is not a nest owner (404) and another company's project is unknown (400)` |
| 3 | Сокрытие значений секретов | `GET /api/companies/:companyId/secrets` | В ответе список метаданных, поле `value` отсутствует | Тест `board-key-tenant-confinement.test.ts`, схемы `server/src/routes/secrets.ts` |
| 4 | Межарендная изоляция секретов | Попытка чтения секрета компании A токеном/контекстом компании B | HTTP 404 Not Found (сокрытие существования) или HTTP 403 Forbidden | `packages/shared/src/myrmidon-secrets.ts`, тест `agent-cross-tenant-authz-routes.test.ts` |
| 5 | Применение `budget_limits` | Превышение лимита `hardLimitCents` в проекте гнезда | Агент переводится в статус `paused` или запрос отклоняется (`refuse`) | `server/src/myrmidon/budget-limits/store.ts`, таблица `budget_limits` |
| 6 | Применение `project_token_quotas` | Превышение лимита `dailyLimitTokens` | Ошибка превышения квоты (HTTP 429), вызов модели блокируется | `server/src/myrmidon/project-token-quota/routes.ts`, таблица `project_token_quotas` |
| 7 | Аудит доступа к секретам | Вызов бота с использованием привязанного секрета | В таблице `secret_access_events` создается запись с `actor_id`, `consumer`, `issue_id`, `outcome: "success"` | Тест `agent-cross-tenant-authz-routes.test.ts`, таблица `secret_access_events` |
| 8 | Аудит отзыва доступа | Выполнение шагов R1–R4 | Записи деактивации в `activity`, события в `budget_limit_changes` и удаление ключа | Тест `agent-cross-tenant-authz-routes.test.ts` |

---

## 6. Границы готовности платформы и отложенные работы

Для прозрачности планирования функционал внешних гнезд строго разделен на три категории:

### Реализовано в платформе (Myrmidon core main 1.6.5/1.6.6)
- Единая PostgreSQL с полной изоляцией таблиц по `company_id`.
- Создание компаний с `issuePrefix` и `budgetMonthlyCents`.
- Касты с областью видимости компании (`/myrmidon/companies/:companyId/castes`).
- Назначение `defaultCasteKey` на уровне проекта (`services/projects.ts`).
- Привязка агентов к проектам через `agent_nests` с защитой от кросс-арендных проектов.
- Лимиты бюджета проекта `budget_limits` (уровень nest) и аудит изменений `budget_limit_changes`.
- Суточные и недельные квоты токенов `project_token_quotas`.
- Секреты компании `company_secrets`, серверное связывание и аудит `secret_access_events`.
- Базовый реестр каналов `chat_endpoints` со скоупом на компанию.

### Ручные шаги оператора/владельца
- Создание учетной записи компании-арендатора через API/UI владельца.
- Установка начальных лимитов бюджета и квот токенов при онбординге клиента.
- Ввод API-ключа провайдера модели оператором (до готовности встроенного UI-пикера).
- Вызов команд деактивации и отзыва при прекращении обслуживания.

### Отложенные работы (за пределами PR-1)
1. **OPE-10549**: Временные секреты с TTL (динамическая ротация через Vault, автоматическое истечение срока действия ключей).
2. **OPE-9131**: Встраивание плагина `myrmidon.personal-bot` в UI доски (ввод секретов клиентом/оператором через веб-интерфейс, экраны настройки персонального бота).
3. **PR-4 (OPE-10548)**: Веб-виджет для сайта клиента как новый провайдер каналов поверх коннектор-контракта (OPE-10550) с валидацией Origin и доменов.
4. **PR-5 (OPE-10548)**: Журналирование и выгрузка истории клиентских диалогов.

---

## 7. Отметка о проведении проверок (Live Execution Note)

Live-прогон создания компании на боевом инстансе `paperclip-server-1` намеренно **не выполнялся**, чтобы не засорять производственную базу данных тестовыми арендаторами без согласованного окна обслуживания.

Все API-эндпоинты, форматы тел запросов, ограничения и инварианты изоляции проверены непосредственно по актуальной кодовой базе `itkadr-git/myrmidon` (ветка `main`) и покрыты существующими интеграционными тестами (`agent-cross-tenant-authz-routes.test.ts`, `board-key-tenant-confinement.test.ts`, `plugin-tenant-isolation.test.ts`, `castes-default-and-nests.db.myrmidon.test.ts`, `nests-api.myrmidon.test.ts`).
