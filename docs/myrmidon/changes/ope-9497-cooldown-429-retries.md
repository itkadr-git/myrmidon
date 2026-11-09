## changelog-en

### Heartbeat & Adapters: delay retries on deployment cooldown and HTTP 429 instead of immediate wakeups (1.6.6 WAKE-5, OPE-9497)

- Added recognition for LiteLLM deployment pool cooldown signatures (`No deployments available`, `all deployments in cooldown`, `all deployments are in cooldown`, `All deployments for selected model are in cooldown`, `deployments in cooldown`) and HTTP 429 / `too many requests` / `rate_limit_error` in both the board retry classifier (`server/src/myrmidon/run-retry-policy/classification.ts`) and the Hermes gateway adapter (`packages/adapters/hermes/src/gateway/server/execute.ts`).
- `errorResult` maps deployment cooldown to `errorFamily: "provider_quota"` with `resultJson.cooldown: true` and extracts `retryNotBefore`, while generic HTTP 429 without a cooldown signature stays `transient_upstream` with `retryNotBefore`.
- Bounded retry scheduling honors `Retry-After` / `retryNotBefore` precedence over default backoff, otherwise applies exponential backoff with jitter and ceiling, suppresses immediate wakeup, and schedules at most one `scheduled_retry` per window.
- Added operator guides: `docs/myrmidon/guides/deployment-cooldown-retries.md` and `docs/myrmidon/guides/deployment-cooldown-retries.ru.md`.

## changelog-ru

### Heartbeat и адаптеры: отложенный повтор при deployment cooldown и HTTP 429 вместо немедленного пробуждения (1.6.6 WAKE-5, OPE-9497)

- Добавлено распознавание сигнатур cooldown пула деплойментов (`No deployments available`, `all deployments in cooldown`, `all deployments are in cooldown`, `All deployments for selected model are in cooldown`, `deployments in cooldown`) и HTTP 429 / `too many requests` / `rate_limit_error` в классификаторе политики повторов (`server/src/myrmidon/run-retry-policy/classification.ts`) и в адаптере Hermes Gateway (`packages/adapters/hermes/src/gateway/server/execute.ts`).
- В `errorResult` ошибки cooldown деплойментов получают `errorFamily: "provider_quota"` и `resultJson.cooldown: true` с извлечением `retryNotBefore`, а обычный HTTP 429 без сигнатуры cooldown остаётся в `transient_upstream` с подсказкой `retryNotBefore`.
- Планировщик ограниченных повторов учитывает приоритет `Retry-After` / `retryNotBefore` над стандартным бэкоффом, иначе применяет экспоненциальный бэкофф с джиттером и потолком, не создаёт немедленного пробуждения и ставит не более одного `scheduled_retry` на окно.
- Добавлены руководства оператора: `docs/myrmidon/guides/deployment-cooldown-retries.md` и `docs/myrmidon/guides/deployment-cooldown-retries.ru.md`.
