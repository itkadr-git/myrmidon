## changelog-en

### PERF: issue list board key defaults, GitHub credentials cache, API load latency alert (OPE-9997) (#2034)

- **Issue List Defaults for Board Keys**: Extended `issuesListAgentDefaults` (`instance_settings.general`) to apply compact view and default limit of 200 (max 500) to integration board keys (`req.actor.source === "board_key"`).
- **GitHub Operation Credentials Cache**: In-memory broker cache for GitHub installation credentials with a 50-minute TTL, keyed by identity context, run, and repository. Actively validates grant and connection state before returning cached tokens.
- **API Load Monitoring and Alerting**: In-memory latency tracking middleware on `/runtime-tools/github/credentials` and `/api/companies/:companyId/issues` via `boardLoadRequestMiddleware()`. Flags route samples with `alert: true` when p95 duration exceeds 2000 ms (2 seconds), exposed through `GET /api/myrmidon/board-load/api-load`.

## changelog-ru

### PERF: умолчания списка задач для board keys, кэш учетных данных GitHub, алерт задержки API (OPE-9997) (#2034)

- **Умолчания списка задач для board keys**: Действие настройки `issuesListAgentDefaults` (`instance_settings.general`) расширено на интеграционные ключи доски (`req.actor.source === "board_key"`): компактный вид и дефолтный лимит 200 (максимум 500).
- **Кэширование учетных данных операций GitHub**: Кэш в оперативной памяти брокера для installation-токенов GitHub со временем жизни 50 минут, ключом по контексту identity, прогону и репозиторию. Проверяет активность гранта и подключения перед отдачей токена.
- **Мониторинг нагрузки API и алерты задержки**: Middleware замера задержек на маршрутах `/runtime-tools/github/credentials` и `/api/companies/:companyId/issues`. Выставляет `alert: true` при превышении p95 порога в 2000 мс (2 секунды), доступно через эндпоинт `GET /api/myrmidon/board-load/api-load`.
