# ADR-0052: Изоляция компаний и контролируемый канал запросов к ADM

- Status: proposed
- Date: 2026-11-12
- Deciders: владелец продукта и ADM (после review)
- Scope: OPE-12763, parent OPE-9214

## Контекст

BBQ, Work, Life и ADM должны быть отдельными компаниями Myrmidon. Общая компания создаёт риск ошибочной раздачи задач и смешения агентов, проектов, секретов и памяти. Изоляция должна быть проверяема на уровне каждого запроса, а не только соглашением о маршрутизации.

Эта запись задаёт целевую модель и контракт миграции. Она не разрешает перенос, копирование, удаление или изменение существующих данных. Любая миграция начинается только после успешного dry-run, сохранённого отчёта и явного одобрения владельца продукта.

## Решение

1. Компания — корень tenant-изоляции. Каждый tenant-scoped объект имеет companyId и проверяется по нему в route/service до чтения, изменения, выдачи токена или запуска побочного эффекта.
2. Принцип по умолчанию — deny. Наличие общей учётной записи, instance-admin роли, совпадения имени, упоминания агента или существующей связи пользователя не даёт доступа к другой компании.
3. Агент принадлежит ровно одной рабочей компании для исполнения конкретной задачи. Переназначение возможно только на активного агента целевой компании и через существующую assignability-проверку.
4. Пользователь может быть членом нескольких компаний, но membership и grants независимы. Сессия, API key, бюджет, секретная привязка и память не наследуют права из другой компании.
5. ADM — отдельная компания и единственный межкомпанейский контрольный канал. Межкомпанейский запрос не является прямым чтением или вызовом ресурса целевой компании.

## Модель членства и ролей

`company_memberships` — источник членства с ключом `(companyId, principalType, principalId)`, статусом `pending|active|suspended|archived` и ролью. Для людей роли: `owner`, `admin`, `operator`, `viewer`. Для агентов membership — отдельная запись principal type `agent`; capability grants выдаются явно и только в пределах companyId.

Роль не заменяет membership: сначала активное членство, затем действие разрешено ролью или grant. `owner` нельзя удалить как последнего активного владельца. При suspension/archive немедленно отзываются сессии, ключи и доступ к подключениям; открытые задачи переводятся в безопасное состояние по существующему archive flow.

Instance-admin — административная роль экземпляра, не глобальный data-plane read. Для company data она обязана иметь явное членство/делегированный запрос с аудитом.

## Матрица границ

| Объект | Владелец границы | Разрешение внутри компании | Межкомпанейский доступ |
|---|---|---|---|
| Агенты и agent API keys | `agents.companyId`, key company | active membership + role/grant + key scope | deny; только ADM-запрос, без передачи исходного ключа |
| Задачи, комментарии, checkout, runs | `issues.companyId` и связанные rows | `issue:read/mutate`, assignability и private-task wall | deny, включая списки, поиск, события и existence oracle |
| Проекты и документы | `projects.companyId`, document membership не расширяет tenant | project membership + company access | deny; ADM получает только утверждённый projection |
| Skills/base skills/policies | company skill lifecycle/policy | skill grant, scoped к companyId | deny; импорт только через проверенный bundle и явное действие ADM |
| Secrets и secret bindings | company secret + target company | purpose-specific grant, TTL, redaction | deny; ADM не получает raw secret, только metadata/operation result |
| Connections/tools/profiles | tool connection/grant company | connection grant, key scope и audit | deny; допускается только одобренный tool invocation через gateway |
| Бюджеты/costs/limits | budget policy и cost rows company | budget owner/admin; hard-stop остаётся локальным | deny; ADM видит агрегат/health, не произвольные расходы |
| Память/knowledge/corpus/agent sessions | company/nest/task key | company membership и task/session binding | deny; cross-company delivery — только явно помеченный redacted artifact |
| Chat/exchange/inbox/wake | source issue/company и recipient company | channel policy + recipient membership | deny; ADM request channel — отдельный typed request |
| Audit/activity/approvals | событие содержит `companyId` и actor context | company auditors + ADM governance view | ADM видит audit envelope; payload и secret content не расширяются |

Системные таблицы без companyId (например, instance settings и user preference) не становятся скрытым мостом к tenant data: любая операция над company data всё равно проходит company authorization и пишет audit context.

## Запрос прав или инструмента к ADM

Вводится отдельный `adm_access_request` API/очередь (реализация — отдельная задача, до миграции). Запрос содержит:

- immutable `requestId`, `sourceCompanyId`, `requesterType`, `requesterId`, `targetCompanyId` (для ADM это ADM), `resourceType`, `resourceRef` и `action`;
- минимальное обоснование, срок действия, idempotency key, correlation/run id;
- `requestedScope` с allowlist-полями; raw tokens, secret values и произвольные URLs запрещены схемой;
- state `pending|approved|denied|expired|revoked`, approver identity, decision time и expiry.

Алгоритм: (1) проверить активное членство источника и допустимость action; (2) создать immutable audit event до исполнения; (3) доставить только в ADM queue; (4) ADM approve/deny с reason; (5) выдать короткоживущий, audience-bound capability либо выполнить operation в ADM gateway; (6) повторно проверить source/target, scope, expiry и revocation непосредственно перед действием; (7) записать результат и redacted summary. Approval одной операции не превращается в постоянный grant и не меняет membership.

Запрещено: source agent сам выбирает target company, проксирует произвольный HTTP, получает raw secret, использует capability после expiry/revoke, меняет approval/audit, или получает ответ по ресурсу, к которому request был denied. Ошибки возвращаются одинаково для отсутствующего и запрещённого target resource, чтобы не создавать existence oracle.

Обязательные audit поля: requestId, company IDs, actor/principal, action/resource type (не secret value), requested scope hash, decision, approver, capability id/hash, expiry, correlation/run id, outcome, reason code. Audit append-only и недоступен source agent для изменения.

## Карта точек авторизации и угроз

| Точка | Проверка | Угроза/негативный исход |
|---|---|---|
| route path/query и entity lookup | resolve resource, `hasCompanyAccess`, затем action authz | B получает 403/404, а не данные A и не факт существования |
| service/repository query | обязательный company predicate на read/write | забытый route gate не обходит tenant boundary |
| issue queue/heartbeat/checkout | company + assignee + private wall + task context | агент B не видит, не подхватывает и не получает wake задачи A |
| API key/session middleware | key company, active membership, revocation | ключ A не работает в B; suspended token немедленно отвергнут |
| secret resolver/tool gateway | target company, purpose, scope, expiry | tool не получает секрет другой компании и не логирует его значение |
| skill/document import | source/target allowlist, manifest, approval | импорт не копирует secrets, grants, sessions или скрытые membership |
| budgets/cost writes | company policy и actor grant | B не меняет лимит A и не расходует его бюджет |
| memory/search/events | tenant filter до ranking/serialization/broadcast | утечки через поиск, SSE, exchange, comments и telemetry исключены |
| ADM request approval/execution | typed schema, immutable audit, double-check before effect | подмена target/scope, replay и privilege escalation блокируются |
| migration/rollback | dry-run report, snapshot, idempotency, owner approval | частичный перенос не меняет production state |

Основные угрозы: confused deputy через общего пользователя; leaked agent key; IDOR по UUID; existence oracle; cross-company event/search cache; секрет в audit/log/error; replay capability; stale membership после suspension; массовый неверный assignment; migration partial failure.

## Обязательные негативные тест-кейсы

Каждый кейс должен быть интеграционным или route/service тестом с двумя реальными company IDs и проверкой результата и отсутствия побочного эффекта:

1. Agent A key читает/меняет ресурс B — 403, данные B не возвращены.
2. User active в A, viewer или отсутствует в B — B denied; instance-admin без B membership не получает data-plane read.
3. UUID задачи/проекта/секрета A передан в route B — 404/403 по контракту, без existence oracle.
4. A task не появляется в B list/search/queue/swarm/heartbeat/checkout/live events/comments/approvals.
5. Агент B не может назначить себя на задачу A; archive A не назначает открытые задачи неактивному пользователю или агенту B.
6. Secret binding/connection/profile A запрошен из B — deny; raw secret отсутствует в response, logs и audit.
7. Skill/document/corpus export A не импортирует membership, key, grant, secret, budget или session в B.
8. Budget/cost write B с идентификатором A не меняет policy, counters или hard-stop state A.
9. Memory/session/search delivery A не возвращается агенту B; task key нельзя заменить глобальным runtime session.
10. ADM request с target A, но source B или scope вне allowlist — deny и audit; approval не даёт постоянного grant.
11. Expired, revoked, replayed, altered или wrong-audience capability — deny; каждое решение аудируется без secret value.
12. Suspension/archive отзывает session/key/connection access; повтор старого токена и tool invocation отвергается.
13. Concurrent approve/revoke/execute допускает не более одного эффекта; повтор по idempotency key не удваивает действие.
14. Dry-run, interrupted migration и rollback сохраняют counts, IDs, memberships, grants, secrets, budgets, sessions и relations.

Существующие опорные проверки: `authz-company-access.test.ts`, `agent-cross-tenant-authz-routes.test.ts`, `board-key-tenant-confinement.test.ts`, `companies-route-cross-company-authz.test.ts`, `authz-existence-oracle-guard.test.ts`, private-task suites и `arch-invariants-gate`. Новые ADM protocol и migration safety suites обязательны до реализации соответствующих маршрутов.

## Dry-run, миграция и rollback

Фаза 0 — инвентаризация только чтением: построить mapping каждой сущности к целевой компании, перечислить ambiguous rows, cross-company references, secrets, connections, budgets, memory and open tasks. Fail closed при любой неоднозначности.

Фаза 1 — shadow authorization: включить метрики deny/allow и audit envelopes без изменения данных; сравнить expected company mapping с реальными route/service decisions.

Фаза 2 — dry-run на production snapshot: посчитать строки и связи до/после виртуального split, проверить уникальность, FK, key scopes, assignment, budget totals и redaction. Отчёт подписывается владельцем продукта и ADM; отсутствие ambiguous rows и zero unexpected cross-company edges — обязательное условие.

Фаза 3 — пилот только Life: отдельное окно, immutable pre-migration snapshot, feature flag deny-by-default, батчи с checkpoint и idempotency. Сначала routing/read boundaries, затем controlled data move; secrets и external connections не копируются автоматически.

Фаза 4 — Work, затем BBQ; ADM остаётся отдельным control plane. После каждого этапа — reconciliation counts/IDs/relations, authz negative suite, budget and secret smoke checks, owner sign-off.

Rollback: остановить новые writes, отозвать выданные migration capabilities, сохранить audit/checkpoints, восстановить routing и memberships из snapshot, удалить только rows с migration provenance (никогда не делать broad delete), повторить reconciliation. Если snapshot или provenance отсутствует, rollback запрещён — задача остаётся blocked до решения владельца.

Условия начала миграции: принято это ADR; утверждён mapping; dry-run report сохранён; все негативные тесты зелёные; есть backup/restore proof, rollback owner и окно; ADM одобрил конкретный batch. До этого изменения схемы, переносы данных и включение cross-company grants запрещены.

## Открытые решения

Нужно отдельно утвердить формат и persistence `adm_access_request`, список ADM approvers, максимальные TTL capability и точный redacted projection. Эти вопросы не являются разрешением временно ослабить текущую company authorization.
