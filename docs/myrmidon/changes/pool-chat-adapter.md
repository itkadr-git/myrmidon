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

## divergence-append
<!-- section: Трек 4 — чаты и навыки -->

### Operator acceptance runbook

This is a deployment runbook, not a claim of live-pool qualification. The implementation and CI tests use a fake transport. Only an authorized operator may enable a real deployment, and this task did not perform that run.

### Required sequence

1. Keep `MYRMIDON_POOL_CHAT_ENABLED` unset (or any value other than `1`) while deploying and validating the database change.
2. Integrate the schema, server, and test commits into the target `main` lineage first. Generate the migration on that integrated head, then inspect the generated SQL and migration journal. Apply it once in a disposable/staging database and verify all four tables, foreign keys, and unique indexes before production rollout. Do not hand-edit the generated snapshot or reuse migration number `0401` if another migration has landed first.
3. Create one module instance per deployment/module with `provider`, `config.endpoint`, allowed models, enabled account records, integer `quotaUnits`/`usedUnits`, and a non-secret `credentialSecretName`. Store the provider key in the deployment's secret store under that exact name; never put a key in module JSON, logs, fixtures, or comments. Configure ChatGPT and Google endpoints independently and verify the endpoint matches the provider.
4. Before enabling the flag, reconcile `dispatching` and `uncertain` attempts and `reserved` quota rows. There is no automatic recovery or retry: an operator must resolve each provider outcome using the provider's request reference and deployment records, then settle or release the reservation according to the provider result. Do not reset a lifetime quota by deleting ledger rows; change the configured baseline/limit through the approved operator procedure and retain the audit trail.
5. With the flag still off, run CI at the exact integrated head and record the commit SHA and all required checks. Enable the flag only after the checks and staging acceptance below pass. Roll back by disabling the flag first; preserve the ledger for investigation.

### Contract acceptance matrix

| Case | Expected evidence | Live operator-only? |
| --- | --- | --- |
| Gate off | Routes are not mounted and no provider call occurs when the flag is unset or not `1`. | No; CI/test evidence |
| Capabilities | Authenticated, scoped response lists only configured provider/model capabilities; it does not expose account refs, quota, secret names, or usage. | No; CI/test evidence |
| Authz and scope | Missing scoped principal is rejected; request status is checked against the persisted channel/subject scope. | No; CI/test evidence |
| Idempotency | Same scoped key and same body returns the durable request without a second send; conflicting body returns a conflict. Concurrent duplicate submission creates one request. | No; CI/test evidence |
| Quota | Concurrent distinct submissions cannot overshoot the account quota; settlement uses provider usage and no-send failure releases the reservation. | No; CI/test evidence |
| Provider failure | Missing secret/endpoint fails closed; a post-dispatch failure becomes `uncertain` and remains reserved without automatic retry. | No; CI/test evidence |
| Redaction | Client/error state contains stable codes only (`provider_transport_failed`, `provider_unknown`, or `provider_not_configured`); provider exception text, keys, URLs, prompts, and response bodies are absent from persisted rows and logs. | No; CI/test evidence plus log scan |
| Migration/recovery | Integrated-head generated migration applies cleanly once and is replay-safe in staging; operator reconciliation leaves no unexplained active reservation. | Migration staging: operator |
| Real provider round trip | One authorized request per configured provider, followed by duplicate replay and a forced/observed failure procedure; provider billing and ledger usage reconcile. | Yes; not run here |
| Retention | Confirm the deployment's approved retention policy for request/result/attempt rows and backups, and test restore plus redaction/access controls. No automatic pool-chat purge is provided by this slice. | Yes; not run here |

### Release decision

The feature remains off until every non-live row has CI/staging evidence and an authorized operator records the live rows. Without that record, report the state as “implementation and CI verified; live-pool acceptance pending”, never as live-qualified.

## divergence-append
<!-- section: Трек 4 — чаты и навыки -->

### Operator acceptance runbook (RU)

Это runbook для deployment, а не утверждение о live-pool qualification. В реализации и CI-тестах используется fake transport. Включать реальный deployment может только уполномоченный оператор; в рамках этой задачи такой запуск не выполнялся.

### Обязательная последовательность

1. Оставьте `MYRMIDON_POOL_CHAT_ENABLED` не заданным (или со значением не `1`) во время выкладки и проверки изменения базы.
2. Сначала интегрируйте schema, server и test-коммиты в целевую линию `main`. На этом интегрированном head сгенерируйте migration, затем проверьте SQL и migration journal. Один раз примените её в disposable/staging базе и проверьте четыре таблицы, внешние ключи и unique indexes перед production rollout. Не редактируйте вручную generated snapshot и не переиспользуйте номер `0401`, если раньше уже появилась другая migration.
3. Создайте для каждого deployment/module один module instance с `provider`, `config.endpoint`, разрешёнными моделями, включёнными account-записями, целыми `quotaUnits`/`usedUnits` и несекретным `credentialSecretName`. Ключ провайдера храните в secret store deployment под этим точным именем; не помещайте ключ в module JSON, логи, fixtures или комментарии. Настройте endpoint ChatGPT и Google независимо и проверьте соответствие endpoint провайдеру.
4. Перед включением флага разберите `dispatching` и `uncertain` attempts и `reserved` quota rows. Автоматического recovery или retry нет: оператор должен разрешить каждый исход провайдера по provider request reference и deployment records, затем settlement или release reservation по фактическому результату. Не сбрасывайте lifetime quota удалением ledger rows; меняйте baseline/limit через утверждённую operator procedure и сохраняйте audit trail.
5. Пока флаг выключен, запустите CI на точном интегрированном head и запишите commit SHA и все обязательные проверки. Включайте флаг только после прохождения checks и staging acceptance ниже. Для rollback сначала выключите флаг; ledger сохраните для расследования.

### Матрица контрактной приёмки

| Случай | Ожидаемое доказательство | Только оператор в live? |
| --- | --- | --- |
| Флаг выключен | Routes не монтируются и вызов провайдера не происходит при unset или значении флага не `1`. | Нет; CI/test evidence |
| Capabilities | Аутентифицированный scoped-ответ содержит только настроенные provider/model capabilities и не раскрывает account refs, quota, secret names или usage. | Нет; CI/test evidence |
| Authz и scope | Запрос без scoped principal отклоняется; status проверяется по сохранённым channel/subject scope. | Нет; CI/test evidence |
| Idempotency | Тот же scoped key с тем же body возвращает durable request без второго send; конфликтующий body даёт conflict. Параллельный duplicate создаёт один request. | Нет; CI/test evidence |
| Quota | Параллельные разные requests не превышают quota account; settlement использует usage провайдера, а no-send failure освобождает reservation. | Нет; CI/test evidence |
| Ошибка провайдера | Отсутствующие secret/endpoint дают fail-closed; post-dispatch failure становится `uncertain`, reservation остаётся, automatic retry отсутствует. | Нет; CI/test evidence |
| Redaction | В client/error state только стабильные коды (`provider_transport_failed`, `provider_unknown` или `provider_not_configured`); текст исключения, ключи, URL, prompts и response bodies отсутствуют в rows и logs. | Нет; CI/test evidence + проверка логов |
| Migration/recovery | Generated migration с интегрированного head один раз применяется чисто и replay-safe в staging; operator reconciliation не оставляет необъяснённых активных reservations. | Migration staging: оператор |
| Реальный round trip | По одному авторизованному request для каждого настроенного провайдера, затем duplicate replay и процедура наблюдаемого/искусственно вызванного failure; billing провайдера согласуется с ledger usage. | Да; здесь не выполнялось |
| Retention | Подтверждены утверждённые deployment retention policy для request/result/attempt rows и backups, а также restore и redaction/access controls. В этом slice автоматического pool-chat purge нет. | Да; здесь не выполнялось |

### Решение о выпуске

Функция остаётся выключенной, пока для каждой non-live строки нет CI/staging evidence, а live-строки не записаны уполномоченным оператором. Без такой записи состояние следует описывать как «implementation и CI проверены; live-pool acceptance ожидается», а не как live-qualified.
