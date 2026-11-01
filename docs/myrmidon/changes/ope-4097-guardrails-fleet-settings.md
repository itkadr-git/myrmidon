## settings-en-new

<!-- after: 1.6.5 — SWARM: the board pairs tasks with free agents, no "look for work" wakes -->

### 1.7 — Guardrails and fleet runtime behavior settings (SETTINGS-TO-UI C, OPE-4097)

Starting with Myrmidon 1.7, guardrails, egress mode, tool execution limits, container reconciliation, and container fleet security allowlists can be managed dynamically through the interface and the Behavior Settings API (`/api/myrmidon/behavior-settings`) without restarting the server.

#### Precedence and Sources

All guardrails and fleet settings resolve using three-tier precedence:
1. **`ui` (Stored value)**: Stored in `instance_settings.general.behaviorSettings` when saved via the UI or API.
2. **`env` (Environment variable)**: Falls back to the corresponding `MYRMIDON_*` environment variable when no UI value is saved.
3. **`default` (Built-in default)**: Default value defined in the registry declaration (`packages/shared/src/myrmidon-behavior-settings.ts`).

Effective resolved values and their origin source (`"ui"`, `"env"`, or `"default"`) are shown in the UI panels and returned by `GET /api/myrmidon/behavior-settings`.

#### Dynamic Application (Live Updates)

Settings apply immediately in the running process without server restart:
- **Egress & runner environment**: Container runners read `bot_egress_mode` and `run_env_allow` dynamically per run execution.
- **Tool gateway resilience**: `tool_breaker_*` thresholds, windows, and `tool_timeout_*` limits apply dynamically to all subsequent tool invocations.
- **Bot containers & reconciliation**: Container daemon dynamically checks `bot_containers`, `bot_reconcile_interval_sec`, and allowlists on each reconciliation tick.
- **Browser fleet & stack checks**: Registry entries and check intervals are read dynamically from runtime state.

#### UI Panels and Security Confirmation

Two dedicated panels provide interface controls:
1. **Guardrails Panel (`InstanceGeneralSettings.tsx`)**:
   - Location: Instance → General settings.
   - Controls egress mode, tool circuit breaker thresholds, execution timeouts, and allowed inherited environment variable names.
2. **Fleet Guardrails Panel (`CompanySettings.tsx`)**:
   - Location: Company Settings.
   - Controls container reconciliation, image allowlist, mount source allowlist, GitHub environment allowlist, Hindsight memory banks, MCP servers, browser fleet, and YOLO mode.
   - **Confirmation for Security Boundaries**: Any change to allowlists (`bot_image_allowlist`, `bot_mount_sources`, etc.) or enabling YOLO mode (`bot_yolo` = true) requires explicit operator confirmation via a modal dialog before saving.

#### Registered Keys Catalog

| Registry Key | Environment Variable | Scope | Type | Default | Description |
|---|---|---|---|---|---|
| `bot_egress_mode` | `MYRMIDON_BOT_EGRESS_MODE` | instance | string (`"off"` \| `"log"`) | `"off"` | Bot container egress proxy mode (`off`: direct; `log`: egress proxy with logging) |
| `tool_breaker_failures` | `MYRMIDON_TOOL_BREAKER_FAILURES` | instance | integer | `3` | Number of consecutive tool execution failures before tripping the circuit breaker |
| `tool_breaker_cooldown_ms` | `MYRMIDON_TOOL_BREAKER_COOLDOWN_MS` | instance | integer | `60000` | Tool circuit breaker cooldown period in milliseconds before retry |
| `tool_breaker_window_ms` | `MYRMIDON_TOOL_BREAKER_WINDOW_MS` | instance | integer | `600000` | Sliding window in milliseconds for tool failure counting |
| `tool_timeout_max_ms` | `MYRMIDON_TOOL_TIMEOUT_MAX_MS` | instance | integer | `180000` | Hard timeout for tool execution in milliseconds |
| `tool_timeout_slow_ms` | `MYRMIDON_TOOL_TIMEOUT_SLOW_MS` | instance | integer | `45000` | Execution duration threshold in milliseconds before flagging a slow tool warning |
| `run_env_allow` | `MYRMIDON_RUN_ENV_ALLOW` | instance | string[] | `[]` | Allowed inherited host environment variable names passed to agent runs |
| `bot_containers` | `MYRMIDON_BOT_CONTAINERS` | instance | boolean | `false` | Enable bot container execution and background container reconciliation |
| `bot_reconcile_interval_sec` | `MYRMIDON_BOT_RECONCILE_INTERVAL_SEC` | instance | integer | `60` | Background container reconciliation interval in seconds |
| `bot_image_allowlist` | `MYRMIDON_BOT_IMAGE_ALLOWLIST` | instance | string[] | `[]` | Allowed Docker container image patterns (requires UI confirmation to update) |
| `bot_mount_sources` | `MYRMIDON_BOT_MOUNT_SOURCES` | instance | string[] | `[]` | Allowed host filesystem paths for container mounts (requires UI confirmation to update) |
| `bot_container_github_env_allowlist` | `MYRMIDON_BOT_CONTAINER_GITHUB_ENV_ALLOWLIST` | instance | string[] | `[]` | Allowed GitHub-related environment variable names in bot containers |
| `bot_yolo` | `MYRMIDON_BOT_YOLO` | instance | boolean | `false` | Enable YOLO mode (`HERMES_YOLO_MODE`, skips command confirmations; requires UI confirmation) |
| `bot_hindsight_allowed_banks` | `MYRMIDON_BOT_HINDSIGHT_ALLOWED_BANKS` | instance | string[] | `[]` | Allowed Hindsight long-term memory banks for bot profiles |
| `bot_mcp_servers` | `MYRMIDON_BOT_MCP_SERVERS` | instance | json | `[]` | Shared Model Context Protocol (MCP) server configurations |
| `browser_fleet` | `MYRMIDON_BROWSER_FLEET` | instance | json | `[]` | Registry of browser fleet nodes available for automated browser sessions |
| `browser_idle_timeout_min` | `MYRMIDON_BROWSER_IDLE_TIMEOUT_MIN` | instance | integer | `30` | Idle timeout in minutes before reclaiming an idle browser container |
| `browser_max_duration_min` | `MYRMIDON_BROWSER_MAX_DURATION_MIN` | instance | integer | `120` | Maximum lifetime in minutes for a browser container session |
| `stack_check_interval_sec` | `MYRMIDON_STACK_CHECK_INTERVAL_SEC` | instance | integer | `0` | Stack health verification loop interval in seconds (`0` disables) |

---

## settings-ru-new

<!-- after: 1.6.5 — SWARM: сопоставление на доске, без побудок «поищи работу» -->

### 1.7 — Runtime-настройки ограждений и флота (SETTINGS-TO-UI C, OPE-4097)

Начиная с Myrmidon 1.7, настройки ограждений, режима исходящего трафика (egress), ограничений выполнения инструментов, фоновой сверки контейнеров и списков безопасности флота контейнеров управляются в интерфейсе доски и через Behavior Settings API (`/api/myrmidon/behavior-settings`) без перезапуска сервера.

#### Приоритет и источники

Для всех параметров ограждений и флота действует трёхуровневый приоритет:
1. **`ui` (сохранённое значение)**: значение, сохранённое оператором через интерфейс или API в `instance_settings.general.behaviorSettings`.
2. **`env` (окружение сервера)**: значение соответствующей переменной `MYRMIDON_*`, если в UI значение ещё не сохранено.
3. **`default` (встроенное по умолчанию)**: значение по умолчанию из реестра (`packages/shared/src/myrmidon-behavior-settings.ts`).

Действующее значение и источник (`"ui"`, `"env"` или `"default"`) отображаются в интерфейсе доски и возвращаются API `GET /api/myrmidon/behavior-settings`.

#### Применение на лету (без перезапуска)

Настройки подхватываются запущенным сервером немедленно:
- **Egress и окружение запуска**: раннеры контейнеров считывают `bot_egress_mode` и `run_env_allow` динамически при каждом запуске.
- **Предохранитель инструментов**: пороги и окно `tool_breaker_*`, а также таймауты `tool_timeout_*` применяются динамически к последующим вызовам инструментов.
- **Контейнеры ботов и сверка**: демон сверки проверяет `bot_containers`, `bot_reconcile_interval_sec` и списки разрешений на каждом тике сверки.
- **Флот браузеров и проверка стека**: конфигурация флота и интервалы проверок считываются на лету из состояния runtime.

#### Панели интерфейса и подтверждение границ безопасности

Для управления настройками добавлены две панели:
1. **Панель «Ограждения» (`InstanceGeneralSettings.tsx`)**:
   - Раздел: Настройки инстанса → Общие.
   - Позволяет настраивать режим egress, пороги предохранителя инструментов, таймауты и разрешённые имена унаследованных переменных окружения.
2. **Панель «Ограждения флота» (`CompanySettings.tsx`)**:
   - Раздел: Настройки компании.
   - Позволяет управлять сверкой контейнеров, белыми списками образов, источников монтирования, переменных GitHub, банков Hindsight, серверов MCP, флота браузеров и режимом YOLO.
   - **Подтверждение изменения границ безопасности**: редактирование белых списков (`bot_image_allowlist`, `bot_mount_sources` и др.) или включение режима YOLO (`bot_yolo` = true) требует обязательного подтверждения оператора в модальном диалоге перед сохранением.

#### Каталог зарегистрированных ключей

| Ключ реестра | Переменная окружения | Scope | Тип | По умолчанию | Описание |
|---|---|---|---|---|---|
| `bot_egress_mode` | `MYRMIDON_BOT_EGRESS_MODE` | instance | string (`"off"` \| `"log"`) | `"off"` | Режим исходящего трафика ботов (`off`: прямой; `log`: логирование через egress-прокси) |
| `tool_breaker_failures` | `MYRMIDON_TOOL_BREAKER_FAILURES` | instance | integer | `3` | Количество последовательных сбоев инструмента до срабатывания предохранителя |
| `tool_breaker_cooldown_ms` | `MYRMIDON_TOOL_BREAKER_COOLDOWN_MS` | instance | integer | `60000` | Длительность паузы предохранителя инструментов в миллисекундах |
| `tool_breaker_window_ms` | `MYRMIDON_TOOL_BREAKER_WINDOW_MS` | instance | integer | `600000` | Скользящее окно подсчёта сбоев инструментов в миллисекундах |
| `tool_timeout_max_ms` | `MYRMIDON_TOOL_TIMEOUT_MAX_MS` | instance | integer | `180000` | Максимальный таймаут выполнения инструмента в миллисекундах |
| `tool_timeout_slow_ms` | `MYRMIDON_TOOL_TIMEOUT_SLOW_MS` | instance | integer | `45000` | Порог длительности выполнения инструмента для предупреждения в миллисекундах |
| `run_env_allow` | `MYRMIDON_RUN_ENV_ALLOW` | instance | string[] | `[]` | Разрешённые имена переменных окружения хоста для передачи в прогоны |
| `bot_containers` | `MYRMIDON_BOT_CONTAINERS` | instance | boolean | `false` | Включение запуска контейнеров ботов и фоновой сверки |
| `bot_reconcile_interval_sec` | `MYRMIDON_BOT_RECONCILE_INTERVAL_SEC` | instance | integer | `60` | Интервал фоновой сверки контейнеров ботов в секундах |
| `bot_image_allowlist` | `MYRMIDON_BOT_IMAGE_ALLOWLIST` | instance | string[] | `[]` | Белый список разрешённых образов Docker (требует подтверждения в UI) |
| `bot_mount_sources` | `MYRMIDON_BOT_MOUNT_SOURCES` | instance | string[] | `[]` | Белый список разрешённых путей хоста для монтирования (требует подтверждения в UI) |
| `bot_container_github_env_allowlist` | `MYRMIDON_BOT_CONTAINER_GITHUB_ENV_ALLOWLIST` | instance | string[] | `[]` | Белый список имён GitHub-переменных окружения контейнеров |
| `bot_yolo` | `MYRMIDON_BOT_YOLO` | instance | boolean | `false` | Включение режима YOLO (`HERMES_YOLO_MODE`, пропуск подтверждений; требует подтверждения в UI) |
| `bot_hindsight_allowed_banks` | `MYRMIDON_BOT_HINDSIGHT_ALLOWED_BANKS` | instance | string[] | `[]` | Разрешённые банки долговременной памяти Hindsight |
| `bot_mcp_servers` | `MYRMIDON_BOT_MCP_SERVERS` | instance | json | `[]` | Конфигурация общих серверов MCP (JSON) |
| `browser_fleet` | `MYRMIDON_BROWSER_FLEET` | instance | json | `[]` | Реестр нод флота браузеров (JSON) |
| `browser_idle_timeout_min` | `MYRMIDON_BROWSER_IDLE_TIMEOUT_MIN` | instance | integer | `30` | Таймаут простоя браузера до освобождения в минутах |
| `browser_max_duration_min` | `MYRMIDON_BROWSER_MAX_DURATION_MIN` | instance | integer | `120` | Максимальная длительность сессии контейнера браузера в минутах |
| `stack_check_interval_sec` | `MYRMIDON_STACK_CHECK_INTERVAL_SEC` | instance | integer | `0` | Интервал периодической проверки стека в секундах (`0` отключает) |
