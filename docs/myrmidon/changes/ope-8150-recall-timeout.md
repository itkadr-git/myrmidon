---
settings-section: Settings in the agent record (not environment variables)
---

## changelog-en

### Hindsight plugin: configurable request timeout with 60s default (OPE-8150)

- Hindsight client requests (`recall`, `retain`) now default to a 60-second timeout
  (`DEFAULT_TIMEOUT_MS = 60_000`), increased from the legacy 15 seconds to prevent
  aborted recall queries when the bank experiences high latency under CPU contention (OPE-3314).
- The timeout is now configurable via the plugin instance configuration field `requestTimeoutMs`
  (declared in manifest with default `60000` and validated on configuration submit).
- Health checks continue to use a dedicated 5-second timeout.

## changelog-ru

### Плагин Hindsight: настраиваемый таймаут запросов с дефолтом 60 с (OPE-8150)

- Таймаут запросов клиента Hindsight (`recall`, `retain`) по умолчанию увеличен
  до 60 секунд (`DEFAULT_TIMEOUT_MS = 60_000`) вместо прежних 15 секунд, что
  устраняет обрывы поиска (recall) при росте латентности банка памяти под нагрузкой
  на CPU (OPE-3314).
- Таймаут настраивается в конфигурации экземпляра плагина через поле `requestTimeoutMs`
  (объявлено в манифесте со значением по умолчанию `60000` и проверяется при валидации).
- Проверка доступности (health) по-прежнему использует отдельный 5-секундный лимит.

## settings-en

| `requestTimeoutMs` (plugin instance configuration, not an environment variable) | OPE-8150 | `60000` | Timeout in milliseconds for Hindsight API requests (recall, retain) in the hindsight plugin (`packages/plugins/hindsight-paperclip`). Default increased to 60,000 ms (60 s) from the legacy 15,000 ms to prevent recall aborts during high bank latency under CPU contention (OPE-3314). Health check continues to use a dedicated 5,000 ms limit. Set in the plugin's instance configuration, not in env; absent value defaults to `60000`. | Positive number. Values <= 0 are rejected by config validation |

## settings-ru-append

<!-- section: Настройки в записи агента (не переменные окружения) -->

| `requestTimeoutMs` (конфигурация экземпляра плагина, не переменная окружения) | OPE-8150 | `60000` | Таймаут в миллисекундах для запросов к Hindsight API (recall, retain) в плагине hindsight (`packages/plugins/hindsight-paperclip`). Дефолт увеличен до 60 000 мс (60 с) с устаревших 15 000 мс во избежание обрывов recall при повышенной латентности банка под CPU-контенцией (OPE-3314). Проверка доступности (health) по-прежнему использует отдельный таймаут 5 000 мс. Задаётся в конфигурации экземпляра плагина, не в окружении; при отсутствии используется дефолт `60000`. | Положительное число. Значения <= 0 отклоняются валидацией конфигурации |
