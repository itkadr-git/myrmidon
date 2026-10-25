---
settings-section: Track 4 — chats and skills
---

## changelog-en

### Pool-chat server boundary (OPE-8207)

- Adds authenticated module-scoped capabilities, submit, and request-status routes with bounded request validation, scoped idempotency, durable request/attempt/reservation records, account-selection policy, and fail-closed provider dispatch.
- A replay returns its existing durable request without repeating provider I/O. A request that may have reached a provider remains `uncertain`; provider exceptions are reduced to a stable redacted code. Missing provider transport configuration fails closed and releases the reservation.
- Quota is enforced per account in tokens. Each new request reserves an upper bound (estimated input at 4 characters per token plus the requested output ceiling) under a per-module advisory lock, so concurrent submits cannot overshoot `quotaUnits`; the check reads live usage from the ledger (reserved or settled units of dispatching, sent and uncertain attempts) added to the configured `usedUnits` baseline. Settlement replaces the reservation with actual usage; failed no-send attempts release it. The cap is a lifetime budget: the operator resets it by raising `quotaUnits` or lowering `usedUnits`. Automatic recovery of requests stuck in `uncertain` is not included: they keep their reservation until an operator resolves them.
- Disabled by default (`MYRMIDON_POOL_CHAT_ENABLED`). Live pool validation is operator-only and was not run.

## changelog-ru

### Серверная граница pool-chat (OPE-8207)

- Добавлены аутентифицированные маршруты capabilities, отправки и чтения статуса запроса в области модуля: строгая ограниченная валидация, scoped idempotency, долговечные записи запроса/попытки/reservation, policy выбора аккаунта и fail-closed отправка провайдеру.
- Повторный запрос возвращает существующую долговечную запись без повторного вызова провайдера. Запрос, который мог дойти до провайдера, сохраняется в состоянии `uncertain`; исключения провайдера заменяются стабильным безопасным кодом. Если transport не настроен, запрос завершается fail-closed, reservation освобождается.
- Квота ведётся по аккаунтам в токенах. Новый запрос резервирует верхнюю оценку (входные символы / 4 плюс запрошенный потолок вывода) под advisory-блокировкой модуля, поэтому параллельные запросы не превысят `quotaUnits`; проверка берёт фактическое использование из реестра (reservation или settled units у попыток dispatching, sent и uncertain) плюс базовое `usedUnits` из конфигурации. Расчёт заменяет резерв фактическим расходом; провально-неотправленные попытки резерв освобождают. Лимит — суммарный бюджет: оператор сбрасывает его, повышая `quotaUnits` или уменьшая `usedUnits`. Автоматического разбора запросов в `uncertain` нет: они держат резерв, пока оператор их не разрешит.
- Выключено по умолчанию (`MYRMIDON_POOL_CHAT_ENABLED`). Проверка на live pool — только оператором, не проводилась.

## settings-en

| `MYRMIDON_POOL_CHAT_ENABLED` | OPE-8207 | unset (off) | Enables the pool-chat module boundary; deployment-specific module configuration, secret resolution, provider transport, migration, quota recovery, and acceptance verification are required before live use | unset or any value other than `1` — off |

## settings-ru

| `MYRMIDON_POOL_CHAT_ENABLED` | OPE-8207 | unset (off) | Включает границу pool-chat; до live-использования необходимы deployment-specific конфигурация модуля, разрешение секретов, transport провайдера, миграция, quota recovery и acceptance-проверка | не задано или любое значение кроме `1` — выключено |

### Operator acceptance runbook (EN)

This deployment runbook is not evidence of live-pool qualification. CI uses fake transports; no live provider acceptance is claimed here. Keep the feature disabled until an authorized operator completes and records staging and live checks.

#### Required sequence

1. Keep `MYRMIDON_POOL_CHAT_ENABLED` unset (or not `1`) during deployment and validation.
2. The pool-chat schema is already integrated in current main via migration `0411_pool_chat_module_instance`. Confirm that migration is applied on the target database and verify its four tables and constraints; do not generate or add another pool-chat schema migration for this runbook.
3. Configure a module instance with its provider endpoint, allowed models, enabled account records (`quotaUnits` and `usedUnits`), and non-secret `credentialSecretName`. Store provider credentials only in the deployment secret store. Never put secrets in module JSON, logs, fixtures, or comments. Configure ChatGPT and Google endpoints independently; Google Gemini transport is integrated in current main.
4. Grant `chat:invoke` only to service principals scoped to the exact `moduleId`, `channelId`, and `subjectId` tuple.
5. Quota is a per-account lifetime token budget. Each request reserves an input estimate (input characters / 4) plus the requested output ceiling under a module advisory lock. The cap check reads ledger reservations/settlements for dispatching, sent, and uncertain attempts plus configured `usedUnits`. Settlement replaces reservation with provider usage; a confirmed no-send failure releases it. Reset only through the approved `quotaUnits`/`usedUnits` procedure; never delete ledger rows to reset quota.
6. Before enabling, reconcile `dispatching` and `uncertain` attempts and reserved quota. There is no automatic recovery/retry: use provider request references and deployment records to resolve each outcome, then settle or release the reservation.
7. With the flag off, verify exact-head CI and staging acceptance. Enable only after an authorized operator records passing evidence. For rollback, disable the flag first and preserve ledger records.

### Contract acceptance matrix

| Case | Expected evidence | Live, operator-only? |
| --- | --- | --- |
| Gate off | Routes are not mounted and no provider call occurs unless the flag is `1`. | No; CI/test evidence |
| Capabilities | Authenticated scoped response lists configured provider/model capabilities without account refs, quota, secret names, or usage. | No; CI/test evidence |
| Authz and scope | Unscoped principal is rejected; status access outside persisted channel/subject scope is indistinguishable from unknown id. | No; CI/test evidence |
| Idempotency | Same scoped key/body returns durable request without another send; conflicting body fails; concurrent duplicates create one request. | No; CI/test evidence |
| Quota | Advisory-locked concurrent submissions stay within token quota; reservation uses estimated input plus output ceiling; settlement uses provider usage; no-send failure releases reservation. | No; CI/test evidence |
| Migration/recovery | Migration `0411_pool_chat_module_instance` is applied once; operator reconciles dispatching/uncertain attempts and reserved quota, with no unexplained active reservation. | Staging: operator |
| Google transport | Configured Google Gemini request follows the provider transport contract and errors remain redacted. | No; CI/test evidence; live provider check is operator-only |
| Real provider round trip | Authorized request per configured provider, duplicate replay, observed failure and provider-billing/ledger reconciliation. | Yes; not run here |
| Retention | Confirm approved retention for request/result/attempt rows and backups; test restore and access/redaction controls. | Yes; not run here |

### Release decision

Keep pool-chat disabled until CI/staging evidence covers non-live rows and an authorized operator records live acceptance. Until then report: “implementation and CI verified; live-pool acceptance pending.” Do not describe the feature as live-qualified.

### Operator acceptance runbook (RU)

Это руководство по развёртыванию, а не доказательство live-квалификации пула. В CI используются fake transport; live-приёмка провайдеров здесь не заявляется. Оставляйте функцию выключенной, пока уполномоченный оператор не выполнит и не зафиксирует staging- и live-проверки.

#### Обязательная последовательность

1. Оставьте `MYRMIDON_POOL_CHAT_ENABLED` не заданным (или не равным `1`) во время выкладки и проверки.
2. Схема pool-chat уже интегрирована в текущий main миграцией `0411_pool_chat_module_instance`. Убедитесь, что она применена на целевой базе, и проверьте четыре таблицы и ограничения; для этого runbook не нужно генерировать или добавлять новую миграцию схемы pool-chat.
3. Настройте экземпляр модуля: endpoint провайдера, разрешённые модели, включённые записи аккаунтов (`quotaUnits` и `usedUnits`) и несекретное `credentialSecretName`. Храните учётные данные только в secret store deployment. Не помещайте секреты в JSON модуля, логи, фикстуры или комментарии. Endpoint ChatGPT и Google настраивайте отдельно; transport Google Gemini уже интегрирован в текущий main.
4. Выдавайте `chat:invoke` только служебным субъектам с точной областью `moduleId`, `channelId`, `subjectId`.
5. Квота — суммарный бюджет токенов по аккаунту. Каждый запрос резервирует оценку входа (число символов / 4) плюс потолок запрошенного вывода под advisory-блокировкой модуля. Проверка лимита читает резервы/settlement из ledger для попыток dispatching, sent и uncertain плюс настроенный `usedUnits`. Settlement заменяет резерв фактическим usage провайдера; подтверждённый сбой до отправки освобождает резерв. Сбрасывайте квоту только утверждённой процедурой изменения `quotaUnits`/`usedUnits`; не удаляйте строки ledger для сброса.
6. До включения разберите попытки `dispatching` и `uncertain` и зарезервированную квоту. Автоматического recovery/retry нет: используйте provider request references и записи deployment, чтобы разрешить каждый исход, затем выполните settlement или release резерва.
7. При выключенном флаге проверьте CI точного head и staging-приёмку. Включайте функцию, только когда уполномоченный оператор зафиксирует успешные результаты. Для отката сначала выключите флаг и сохраните записи ledger.

### Матрица контрактной приёмки

| Случай | Ожидаемое доказательство | Live, только оператор? |
| --- | --- | --- |
| Флаг выключен | Маршруты не монтируются и вызова провайдера нет, пока флаг не равен `1`. | Нет; CI/тесты |
| Capabilities | Аутентифицированный scoped-ответ содержит настроенные provider/model capabilities без account refs, quota, secret names или usage. | Нет; CI/тесты |
| Authz и scope | Запрос без scoped principal отклоняется; доступ к status вне сохранённой области channel/subject неотличим от неизвестного id. | Нет; CI/тесты |
| Идемпотентность | Тот же scoped key/body возвращает durable request без повторной отправки; конфликтующий body отклоняется; параллельные дубли создают один request. | Нет; CI/тесты |
| Квота | Конкурентные запросы под advisory-блокировкой остаются в пределах токеновой квоты; резерв учитывает оценку входа и потолок вывода; settlement использует usage провайдера; сбой без отправки освобождает резерв. | Нет; CI/тесты |
| Миграция и разбор | Миграция `0411_pool_chat_module_instance` применена один раз; оператор разбирает dispatching/uncertain и зарезервированную квоту без необъяснённых активных резервов. | Staging: оператор |
| Google transport | Настроенный запрос Google Gemini соответствует контракту transport провайдера; ошибки редактируются. | Нет; CI/тесты; live-проверка оператора |
| Реальный обмен | Авторизованный запрос к каждому настроенному провайдеру, повтор дубля, наблюдаемый сбой и сверка биллинга с ledger. | Да; здесь не выполнялось |
| Хранение | Подтверждена утверждённая политика хранения строк запросов/результатов/попыток и бэкапов; проверены восстановление и контроль доступа/редактирования. | Да; здесь не выполнялось |

### Решение о выпуске

Оставляйте pool-chat выключенным, пока CI/staging не подтверждают non-live строки, а уполномоченный оператор не зафиксирует live-приёмку. До этого сообщайте: «реализация и CI проверены; live-приёмка пула ожидается». Не называйте функцию live-квалифицированной.
