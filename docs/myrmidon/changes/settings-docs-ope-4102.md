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

## settings-ru-replace

<!-- section: Контейнеры ботов (G-серия, план 28.09 «вариант Б») -->
| `MYRMIDON_MCP_TOKEN_*` | MCP-* | Генерируется для профиля из секретов компании | Имя переменной формируется из каждой записи `MYRMIDON_BOT_MCP_SERVERS` (`MYRMIDON_MCP_TOKEN_<ИМЯ>`, нормализуется до заглавных латинских букв, цифр и подчёркиваний); значение — токен соответствующего секрета компании, попадающий только в `hermes/.env` профиля бота (0600) и используемый ссылкой из `config.yaml`. При настройке таких серверов имена включают `BOARD`, `DOCS`, `RAGFLOW` и `PAPERCLIP_BOARD` | Оператор не задаёт напрямую. Настраиваются имя сервера и `tokenSecret` в `MYRMIDON_BOT_MCP_SERVERS`; секрет компании должен существовать и быть непустым, иначе профиль не соберётся. Для записей `noAuth` переменная токена не создаётся |

## settings-ru-append

<!-- section: Трек 5 — эксплуатация -->
| `PAPERCLIP_TEST_CAPTURE_PATH` | TEST | не задана | Тестовый путь, используемый тестами локального выполнения для захвата окружения дочернего процесса | Только для разработки/тестирования; параметр тестового стенда, не настройка оператора и не показывается в UI |
