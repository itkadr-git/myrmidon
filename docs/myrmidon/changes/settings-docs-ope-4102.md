---
settings-section: Track 5 — operations
---
## settings-en-replace

<!-- section: 1.6.1 — BOT-DISK B: shared package cache for bot containers -->
<!-- occurrence: 2 -->
| `MYRMIDON_MCP_TOKEN_*` | MCP-* | Generated per profile from company secrets | The variable name is generated from each `MYRMIDON_BOT_MCP_SERVERS` entry (`MYRMIDON_MCP_TOKEN_<NAME>`, normalized to uppercase letters, digits and underscores); its value is the corresponding company-secret token, placed only in the bot profile's `hermes/.env` (0600) and referenced by `config.yaml`. Names currently include `BOARD`, `DOCS`, `RAGFLOW`, and `PAPERCLIP_BOARD` when those servers are configured | Not set directly by the operator. Configure the server name and `tokenSecret` in `MYRMIDON_BOT_MCP_SERVERS`; the company secret must exist and be non-empty or profile assembly fails. `noAuth` entries have no token variable |

## settings-en-append

<!-- section: Track 5 — operations -->
| `PAPERCLIP_TEST_CAPTURE_PATH` | TEST | unset | Test-only path used by cursor local execution tests to capture the child process environment | Development/testing only; test harness input, not an operator setting and not shown in UI |

## settings-en-append

<!-- section: Track 5 — operations -->
| `MYRMIDON_ALERT_RECOVERY_HOLD_MINUTES` | 1.7 | `15` | Alert recovery hold period in minutes | Behavioral override: UI (1.7); env takes precedence until migration |
| `MYRMIDON_DEPLOY_UPDATE_MODE` | 1.7 | `stored/default` | Forced auto-update mode override | Behavioral override: UI (1.7); env takes precedence until migration |
| `MYRMIDON_DEPLOY_UPDATE_WINDOW_DAYS` | 1.7 | `stored/default` | Forced auto-update schedule days override | Behavioral override: UI (1.7); env takes precedence until migration |
| `MYRMIDON_DEPLOY_UPDATE_WINDOW_FROM` | 1.7 | `stored/default` | Forced auto-update window start override | Behavioral override: UI (1.7); env takes precedence until migration |
| `MYRMIDON_DEPLOY_UPDATE_WINDOW_TO` | 1.7 | `stored/default` | Forced auto-update window end override | Behavioral override: UI (1.7); env takes precedence until migration |
| `MYRMIDON_DEVFLOW_APPROVED_NOT_MERGED_MS` | 1.7 | `stored/default` | Threshold for approved but unmerged work (milliseconds) | Behavioral override: UI (1.7); env takes precedence until migration |
| `MYRMIDON_DEVFLOW_NO_MERGES_MS` | 1.7 | `stored/default` | Threshold for absence of merges (milliseconds) | Behavioral override: UI (1.7); env takes precedence until migration |
| `MYRMIDON_DISABLE_HERMES_LOCAL` | 1.7 | `unset` | Disable the local Hermes adapter when set to 1 | Behavioral override: UI (1.7); env takes precedence until migration |
| `MYRMIDON_GITHUB_EVENTS_MAX_SILENCE_MIN` | 1.7 | `fallback to PAPERCLIP alias` | Maximum GitHub event silence before warning (minutes) | Behavioral override: UI (1.7); env takes precedence until migration |
| `MYRMIDON_GUARD_RETURN_INTERVAL_SEC` | 1.7 | `source default` | Return-guard sweep interval in seconds | Behavioral override: UI (1.7); env takes precedence until migration |
| `MYRMIDON_IDLE_START_HEALTH_TIMEOUT_MS` | 1.7 | `420000` | Bot start health timeout (milliseconds) | Behavioral override: UI (1.7); env takes precedence until migration |
| `MYRMIDON_IDLE_STOP_AFTER_SEC` | 1.7 | `1800` | Idle time before bot stop (seconds) | Behavioral override: UI (1.7); env takes precedence until migration |
| `MYRMIDON_IDLE_STOP_ENABLED` | 1.7 | `enabled` | Enable bot idle-stop service | Behavioral override: UI (1.7); env takes precedence until migration |
| `MYRMIDON_KNOWLEDGE_GATE_MODE` | 1.7 | `source default` | Knowledge gate warning/enforce mode | Behavioral override: UI (1.7); env takes precedence until migration |
| `MYRMIDON_KNOWLEDGE_GATE_START_DATE` | 1.7 | `unset` | Start date for the knowledge gate | Behavioral override: UI (1.7); env takes precedence until migration |
| `MYRMIDON_LESSON_DISTILL_ENABLED` | 1.7 | `off` | Enable lesson distillation with 1 | Behavioral override: UI (1.7); env takes precedence until migration |
| `MYRMIDON_LESSON_DISTILL_PERIOD_MINUTES` | 1.7 | `60` | Lesson distillation sweep interval (minutes) | Behavioral override: UI (1.7); env takes precedence until migration |
| `MYRMIDON_LESSON_DISTILL_REPEAT_THRESHOLD` | 1.7 | `2` | Minimum repetitions for lesson distillation | Behavioral override: UI (1.7); env takes precedence until migration |
| `MYRMIDON_LESSON_DISTILL_WINDOW_HOURS` | 1.7 | `24` | Lesson distillation lookback window (hours) | Behavioral override: UI (1.7); env takes precedence until migration |
| `MYRMIDON_TOOL_AUTONOMY_MAPPING_JSON` | 1.7 | `built-in mapping` | Autonomy tool mapping when no setting is stored | Behavioral override: UI (1.7); env takes precedence until migration |

## settings-ru-replace

<!-- section: Контейнеры ботов (G-серия, план 28.09 «вариант Б») -->
| `MYRMIDON_BOT_CANARY_SELECTOR` | R5-B | нет | Ключ бота-канарейки (agentId): новый образ применяется сначала к этому одному боту, с проверкой состояния здоровья и проверочным прогоном, прежде чем волны | Не задан — задача не может быть создана (503 с подсказкой): канарейка выбирается явно, не угадывается. Канарейка должна быть контейнерным ботом, которого собирает сверка (иначе задача отменяется с причиной). Читается при создании задачи |
| `MYRMIDON_BOT_CANARY_WAVE_SIZE` | R5-B | `4` | Сколько ботов в одной волне после успеха канарейки (по одному боту за раз внутри волны, каждый через свое окно обслуживания агента) | От 1 до 32; значение по умолчанию 4 такое же, как и лимит параллели сверки (`RECONCILE_CONCURRENCY`), поэтому волна не занимает больше памяти, чем обычный проход |
| `MYRMIDON_BOT_CANARY_STEP_TIMEOUT_SEC` | R5-B | `1800` | Сколько секунд задача может стоять в одном статусе, прежде чем отменяется сама | От 60 до 86400 |
| `MYRMIDON_BOT_CANARY_HEALTH_SETTLE_SEC` | R5-B | `90` | Сколько секунд контейнер канарейки должен оставаться здоровым (проверка Docker HEALTHCHECK) до проверочного прогона | От 0 до 3600; 0 — без ожидания, начинается сразу |
| `MYRMIDON_BOT_CANARY_SMOKE_TIMEOUT_SEC` | R5-B | `300` | Лимит времени проверочного прогона: один `POST /v1/runs` на шлюз канарейки, опрашивается до достижения конечного статуса | От 10 до 3600. Прогон, который не завершается вовремя — сбой канарейки (`canary_smoke_failed`) |
| `MYRMIDON_BOT_CANARY_TICK_SEC` | R5-B | `5` | Как часто тик согласует открытую задачу с фактами (статус контейнера, проверка, волны) | От 1 до 3600 |
| `MYRMIDON_BOT_CANARY_VERIFY_TIMEOUT_SEC` | R5-B | `30` | Таймаут сетевых проверок дайджеста (регистр, GitHub) при создании задачи и предварительном просмотре | От 1 до 300 |
| `MYRMIDON_BOT_CANARY_AUTO_ROLLBACK` | R5-C | `1` (вкл) | Основанный на состоянии здоровья автоматический откат флота ботов: сбой канарейки (состояние здоровья или проверка) или сбой бота волны переводит развертывание в `rolling_back` — каждый бот, получивший новый образ (канарейка, как только началось переключение, плюс боты волны), получает повторное применение собственного образа карточки через тот же `applyBotContainerNow`, по одному боту за раз; развертывание затем заканчивается `rolled_back` с сохранением первоначальной причины сбоя. Ошибка применения во время отката завершает развертывание громко (`aborted` с причиной): сверка повторно применяет образ карточки при следующем проходе в любом случае | `0`/`false`/`no`/`off` — более старое поведение R5-B: сбой завершает развертывание с конечным статусом (`canary_failed`/`canary_smoke_failed`/`failed_health`), канарейка остается на новом образе для осмотра, откат ручной |
| `MYRMIDON_MCP_TOKEN_*` | MCP-* | Генерируется для профиля из секретов компании | Имя переменной формируется из каждой записи `MYRMIDON_BOT_MCP_SERVERS` (`MYRMIDON_MCP_TOKEN_<ИМЯ>`, нормализуется до заглавных латинских букв, цифр и подчёркиваний); значение — токен соответствующего секрета компании, попадающий только в `hermes/.env` профиля бота (0600) и используемый ссылкой из `config.yaml`. При настройке таких серверов имена включают `BOARD`, `DOCS`, `RAGFLOW` и `PAPERCLIP_BOARD` | Оператор не задаёт напрямую. Настраиваются имя сервера и `tokenSecret` в `MYRMIDON_BOT_MCP_SERVERS`; секрет компании должен существовать и быть непустым, иначе профиль не соберётся. Для записей `noAuth` переменная токена не создаётся |

## settings-ru-append

<!-- section: Трек 3 — шлюз инструментов и адаптер Hermes -->
| `PAPERCLIP_TEST_CAPTURE_PATH` | TEST | не задана | Тестовый путь, используемый тестами локального выполнения для захвата окружения дочернего процесса | Только для разработки/тестирования; параметр тестового стенда, не настройка оператора и не показывается в UI |

## settings-ru-append

<!-- section: Трек 5 — эксплуатация -->
| `MYRMIDON_ALERT_RECOVERY_HOLD_MINUTES` | 1.7 | `15` | Период ожидания восстановления оповещения, минуты | Поведенческая настройка: в UI (1.7); до переноса env имеет приоритет |
| `MYRMIDON_DEPLOY_UPDATE_MODE` | 1.7 | `stored/default` | Принудительное переопределение режима автообновления | Поведенческая настройка: в UI (1.7); до переноса env имеет приоритет |
| `MYRMIDON_DEPLOY_UPDATE_WINDOW_DAYS` | 1.7 | `stored/default` | Принудительное переопределение дней окна автообновления | Поведенческая настройка: в UI (1.7); до переноса env имеет приоритет |
| `MYRMIDON_DEPLOY_UPDATE_WINDOW_FROM` | 1.7 | `stored/default` | Принудительное переопределение начала окна автообновления | Поведенческая настройка: в UI (1.7); до переноса env имеет приоритет |
| `MYRMIDON_DEPLOY_UPDATE_WINDOW_TO` | 1.7 | `stored/default` | Принудительное переопределение конца окна автообновления | Поведенческая настройка: в UI (1.7); до переноса env имеет приоритет |
| `MYRMIDON_DEVFLOW_APPROVED_NOT_MERGED_MS` | 1.7 | `stored/default` | Порог для одобренной, но не влитой работы (миллисекунды) | Поведенческая настройка: в UI (1.7); до переноса env имеет приоритет |
| `MYRMIDON_DEVFLOW_NO_MERGES_MS` | 1.7 | `stored/default` | Порог отсутствия слияний (миллисекунды) | Поведенческая настройка: в UI (1.7); до переноса env имеет приоритет |
| `MYRMIDON_DISABLE_HERMES_LOCAL` | 1.7 | `unset` | Отключает локальный адаптер Hermes при значении 1 | Поведенческая настройка: в UI (1.7); до переноса env имеет приоритет |
| `MYRMIDON_GITHUB_EVENTS_MAX_SILENCE_MIN` | 1.7 | `fallback to PAPERCLIP alias` | Максимальная тишина событий GitHub до предупреждения (минуты) | Поведенческая настройка: в UI (1.7); до переноса env имеет приоритет |
| `MYRMIDON_GUARD_RETURN_INTERVAL_SEC` | 1.7 | `source default` | Интервал прохода охранного возврата, секунды | Поведенческая настройка: в UI (1.7); до переноса env имеет приоритет |
| `MYRMIDON_IDLE_START_HEALTH_TIMEOUT_MS` | 1.7 | `420000` | Таймаут проверки здоровья при запуске бота (миллисекунды) | Поведенческая настройка: в UI (1.7); до переноса env имеет приоритет |
| `MYRMIDON_IDLE_STOP_AFTER_SEC` | 1.7 | `1800` | Время простоя до остановки бота (секунды) | Поведенческая настройка: в UI (1.7); до переноса env имеет приоритет |
| `MYRMIDON_IDLE_STOP_ENABLED` | 1.7 | `enabled` | Включить остановку ботов при простое | Поведенческая настройка: в UI (1.7); до переноса env имеет приоритет |
| `MYRMIDON_KNOWLEDGE_GATE_MODE` | 1.7 | `source default` | Режим контроля знаний: предупреждение/принудительно | Поведенческая настройка: в UI (1.7); до переноса env имеет приоритет |
| `MYRMIDON_KNOWLEDGE_GATE_START_DATE` | 1.7 | `unset` | Дата начала контроля знаний | Поведенческая настройка: в UI (1.7); до переноса env имеет приоритет |
| `MYRMIDON_LESSON_DISTILL_ENABLED` | 1.7 | `off` | Включает извлечение уроков при значении 1 | Поведенческая настройка: в UI (1.7); до переноса env имеет приоритет |
| `MYRMIDON_LESSON_DISTILL_PERIOD_MINUTES` | 1.7 | `60` | Период извлечения уроков (минуты) | Поведенческая настройка: в UI (1.7); до переноса env имеет приоритет |
| `MYRMIDON_LESSON_DISTILL_REPEAT_THRESHOLD` | 1.7 | `2` | Минимальное число повторений для извлечения урока | Поведенческая настройка: в UI (1.7); до переноса env имеет приоритет |
| `MYRMIDON_LESSON_DISTILL_WINDOW_HOURS` | 1.7 | `24` | Окно извлечения уроков (часы) | Поведенческая настройка: в UI (1.7); до переноса env имеет приоритет |
| `MYRMIDON_TOOL_AUTONOMY_MAPPING_JSON` | 1.7 | `built-in mapping` | Сопоставление автономии инструментов при отсутствии сохранённой настройки | Поведенческая настройка: в UI (1.7); до переноса env имеет приоритет |
