---
settings-section: Track 4 — chats and skills
---

## changelog-en

### Pool-chat server boundary (OPE-8207)

- Adds authenticated module-scoped capabilities, submit, and request-status routes with bounded request validation, scoped idempotency, durable request/attempt/reservation records, account-selection policy, and fail-closed provider dispatch.
- A replay returns its existing durable request without repeating provider I/O. A request that may have reached a provider remains `uncertain`; provider exceptions are reduced to a stable redacted code. Missing provider transport configuration fails closed and releases the reservation.
- This is a disabled-by-default implementation boundary, not acceptance-complete quota accounting. Reservation is currently a fixed per-request unit; there is no durable atomic per-account balance enforcement/recovery. Do not use live pool accounts until actual-unit estimation, balance cap, transactional reservation/settlement, recovery, and acceptance verification are implemented. No live-pool validation is implied.

## changelog-ru

### Серверная граница pool-chat (OPE-8207)

- Добавлены аутентифицированные маршруты capabilities, отправки и чтения статуса запроса в области модуля: строгая ограниченная валидация, scoped idempotency, долговечные записи запроса/попытки/reservation, policy выбора аккаунта и fail-closed отправка провайдеру.
- Повторный запрос возвращает существующую долговечную запись без повторного вызова провайдера. Запрос, который мог дойти до провайдера, сохраняется в состоянии `uncertain`; исключения провайдера заменяются стабильным безопасным кодом. Если transport не настроен, запрос завершается fail-closed, reservation освобождается.
- Это отключённая по умолчанию реализационная граница, но quota accounting ещё не доведён до приёмки. Reservation сейчас фиксированная на запрос; долговечного атомарного баланса и проверки лимита по аккаунту нет. Нельзя использовать live-аккаунты, пока не реализованы оценка фактических units, контроль лимита, транзакционные reservation/settlement, recovery и acceptance-проверки. Проверка на live pool не проводилась.

## settings-en

| `MYRMIDON_POOL_CHAT_ENABLED` | OPE-8207 | unset (off) | Enables the pool-chat module boundary; deployment-specific module configuration, secret resolution, provider transport, migration, quota recovery, and acceptance verification are required before live use | unset or any value other than `1` — off |

## settings-ru

| `MYRMIDON_POOL_CHAT_ENABLED` | OPE-8207 | unset (off) | Включает границу pool-chat; до live-использования необходимы deployment-specific конфигурация модуля, разрешение секретов, transport провайдера, миграция, quota recovery и acceptance-проверка | не задано или любое значение кроме `1` — выключено |
