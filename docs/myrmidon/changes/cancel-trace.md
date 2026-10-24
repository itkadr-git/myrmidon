## changelog-en

### Traceable run cancellations and cached GitHub App tokens (OPE-8543)

- Every run cancellation logs `heartbeat run cancellation requested` with `runId`, `agentId`, `correlationId`, the source (`code`, endpoint, actor) and the reason. The same provenance is stored in `resultJson.executionCancellation` and forwarded to the Hermes gateway as `X-Paperclip-Correlation-Id` / `X-Paperclip-Cancellation-*` headers; the Hermes adapter logs the correlation id and sender when it stops a gateway run.
- `company_secrets.last_resolved_at` is updated at most once per five minutes per secret instead of on every resolution. GitHub App installation tokens are cached until five minutes before expiry (`myrmidon.github_app.issued` is expected to drop to about one per installation per hour).

## changelog-ru

### Прослеживаемые отмены прогонов и кэш токенов GitHub App (OPE-8543)

- Каждая отмена прогона пишет в лог `heartbeat run cancellation requested` с `runId`, `agentId`, `correlationId`, источником (код, endpoint, actor) и причиной. Те же данные сохраняются в `resultJson.executionCancellation` и передаются в Hermes gateway заголовками `X-Paperclip-Correlation-Id` / `X-Paperclip-Cancellation-*`; адаптер Hermes логирует correlation id и отправителя при остановке прогона на gateway.
- `company_secrets.last_resolved_at` обновляется не чаще раза в пять минут на секрет, а не при каждом чтении. Токены установки GitHub App кэшируются до истечения минус пять минут (`myrmidon.github_app.issued` должен упасть примерно до одного на установку в час).
