---
settings-section: Track 4 — chats and skills
---

## changelog-en

### Pool-chat server boundary (OPE-8207)

- Adds authenticated module-scoped capabilities, submit, and request-status routes with bounded request validation, scoped idempotency, durable request/attempt/reservation records, account-selection policy, and fail-closed provider dispatch.
- A replay returns its existing durable request without repeating provider I/O. A request that may have reached a provider remains `uncertain`; provider exceptions are reduced to a stable redacted code. Missing provider transport configuration fails closed and releases the reservation.
- Quota is enforced per account in tokens. Each new request reserves an upper bound (estimated input at 4 characters per token plus the requested output ceiling) under a per-module advisory lock, so concurrent submits cannot overshoot `quotaUnits`; the check reads live usage from the ledger (reserved or settled units of dispatching, sent and uncertain attempts) added to the configured `usedUnits` baseline. Settlement replaces the reservation with actual usage; failed no-send attempts release it. The cap is a lifetime budget: the operator resets it by raising `quotaUnits` or lowering `usedUnits`. Automatic recovery of requests stuck in `uncertain` is not included: they keep their reservation until an operator resolves them.
- The router identity tuple (`channelId`, `subjectId`) is passed as validated query parameters (1..128 characters of `[A-Za-z0-9._:@-]`), never in the JSON body, which stays closed to unknown keys. Requests carrying the tuple in the body are rejected with 400; a missing value resolves to `http`, which no scoped grant matches by default.
- Disabled by default (`MYRMIDON_POOL_CHAT_ENABLED`). Live pool validation is operator-only and was not run.

## changelog-ru

### Серверная граница pool-chat (OPE-8207)

- Добавлены аутентифицированные маршруты capabilities, отправки и чтения статуса запроса в области модуля: строгая ограниченная валидация, scoped idempotency, долговечные записи запроса/попытки/reservation, policy выбора аккаунта и fail-closed отправка провайдеру.
- Повторный запрос возвращает существующую долговечную запись без повторного вызова провайдера. Запрос, который мог дойти до провайдера, сохраняется в состоянии `uncertain`; исключения провайдера заменяются стабильным безопасным кодом. Если transport не настроен, запрос завершается fail-closed, reservation освобождается.
- Квота ведётся по аккаунтам в токенах. Новый запрос резервирует верхнюю оценку (входные символы / 4 плюс запрошенный потолок вывода) под advisory-блокировкой модуля, поэтому параллельные запросы не превысят `quotaUnits`; проверка берёт фактическое использование из реестра (reservation или settled units у попыток dispatching, sent и uncertain) плюс базовое `usedUnits` из конфигурации. Расчёт заменяет резерв фактическим расходом; провально-неотправленные попытки резерв освобождают. Лимит — суммарный бюджет: оператор сбрасывает его, повышая `quotaUnits` или уменьшая `usedUnits`. Автоматического разбора запросов в `uncertain` нет: они держат резерв, пока оператор их не разрешит.
- Идентификационная пара маршрутизатора (`channelId`, `subjectId`) передаётся валидируемыми query-параметрами (1..128 символов `[A-Za-z0-9._:@-]`), не в JSON-теле, которое остаётся закрытым для неизвестных ключей. Запрос с парой в теле отклоняется с 400; отсутствующее значение превращается в `http`, которому по умолчанию не соответствует ни один scoped grant.
- Выключено по умолчанию (`MYRMIDON_POOL_CHAT_ENABLED`). Проверка на live pool — только оператором, не проводилась.

## settings-en

| `MYRMIDON_POOL_CHAT_ENABLED` | OPE-8207 | unset (off) | Enables the pool-chat module boundary; deployment-specific module configuration, secret resolution, provider transport, migration, quota recovery, and acceptance verification are required before live use | unset or any value other than `1` — off |

## settings-ru

| `MYRMIDON_POOL_CHAT_ENABLED` | OPE-8207 | unset (off) | Включает границу pool-chat; до live-использования необходимы deployment-specific конфигурация модуля, разрешение секретов, transport провайдера, миграция, quota recovery и acceptance-проверка | не задано или любое значение кроме `1` — выключено |
