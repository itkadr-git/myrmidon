---
divergence-section: Трек 2 — ядро побудок и прогонов
settings-section: Track 2 — wake and run core
---

## changelog-en

### Idle-skip measurement and prompt cache by answer cost (1.2-COST-CACHING)

- `MYRMIDON_IDLE_SKIP_METRICS` (off by default) counts every skipped empty timer wake and the model calls it saved, and logs the running totals.
- `MYRMIDON_PROMPT_CACHE_MIN_COST` (unset = off) lets a timer wake with an identical context snapshot reuse the previous finished run's recorded answer when that answer cost at least the threshold. Cheap answers are always recomputed. The skipped wake names the source run.

## changelog-ru

### Замер пропуска пустых побудок и кэш промптов по стоимости ответа (1.2-COST-CACHING)

- `MYRMIDON_IDLE_SKIP_METRICS` (по умолчанию выкл) считает каждую пропущенную пустую побудку по таймеру и сэкономленные вызовы модели и пишет накопленные итоги в журнал.
- `MYRMIDON_PROMPT_CACHE_MIN_COST` (не задан = выкл): побудка по таймеру с идентичным снимком контекста переиспользует записанный ответ предыдущего завершённого прогона, если стоимость ответа не ниже порога. Дешёвые ответы всегда пересчитываются. Пропущенная побудка называет исходный прогон.

## divergence

| 1.2-COST-CACHING | Замер эффекта пропуска пустых побудок и кэширование промптов по данным стоимости. Часть A (`MYRMIDON_IDLE_SKIP_METRICS`, по умолчанию выкл): каждый пропуск `heartbeat.timer.no_actionable_work` дополнительно шагает процессные счётчики «пропущено пустых побудок / сэкономлено вызовов модели» (1:1) и пишет одну строку в журнал с накопленными итогами; пропуск сам не меняется. Часть B (`MYRMIDON_PROMPT_CACHE_MIN_COST`, не задан = выкл): пустая побудка по таймеру, чей снимок контекста идентичен снимку предыдущего завершённого прогона агента (sha256 канонизированного `contextSnapshot`, волатильные `runId`/`requestId`/`wakeupRequestId` не участвуют), переиспользует записанный ответ того прогона вместо нового вызова адаптера — но только когда записанная стоимость ответа не ниже порога (USD; `costUsd`, фолбэк `cacheAdjustedCostUsd`): дешёвый или бесплатный ответ всегда пересчитывается, кэшировать его нечего. Кэш никогда не пересекает границу агента и не действует на побудки с конкретной причиной (задача/комментарий/тикет — они несут новый вход, промпт идентичным быть не может); кэшированная побудка ложится обычной строкой `skipped` с причиной `heartbeat.timer.cached_identical_prompt`, называющей прогон-источник, — аудит показывает, откуда взят переиспользованный ответ. Порог `0`, отрицательный или нечисловой выключает кэш: «кэшировать всё» никогда не является молчаливым исходом опечатки. Хранилища под кэш нет: «запись кэша» — строка предыдущего прогона в `heartbeat_runs`, читаемая в момент побудки (не больше 10 новейших завершённых прогонов агента за поиск) | `server/src/services/heartbeat.ts` (импорт; запись метрики в точке пропуска M3; ветка кэша после ветки пропуска, метки `myrmidon(1.2-COST-CACHING)`) + `server/src/myrmidon/cost-caching.ts`, `server/src/myrmidon/cost-caching.myrmidon.test.ts` | План 1.2 п. 11: холостые прогоны по таймеру и повторные идентичные промпты расходуют токены; пропуск пустых побудок (M3) был неизмерим, а идентичная побудка всегда звонила в модель заново | `server/src/myrmidon/cost-caching.myrmidon.test.ts` | Никогда, наше поведение. Если вендор сам начнёт измерять пропуски и переиспользовать идентичные промпты — сверить и удалить куски `myrmidon(1.2-COST-CACHING)`, модуль и тест | (этот PR) |

## settings-en

| `MYRMIDON_IDLE_SKIP_METRICS` | 1.2-COST-CACHING | off | Measures the effect of the idle-skip: every `heartbeat.timer.no_actionable_work` skip bumps process-wide counters (skipped empty wakes / saved model calls, 1:1) and writes one info log line with the running totals. Off — no counters, no log lines; the skip itself is unaffected | `true`/`1`/`yes`/`on` — enable the measurement. Any other value or unset — off |
| `MYRMIDON_PROMPT_CACHE_MIN_COST` | 1.2-COST-CACHING | unset (disabled) | A generic timer wake whose context snapshot is identical to the agent's previous finished run reuses that run's recorded answer instead of a new adapter invocation — but only when the recorded answer cost at least this threshold (USD; `costUsd`, falling back to `cacheAdjustedCostUsd`). Cheap or free answers are always recomputed: caching them saves nothing. The cached wake lands as a `skipped` request with reason `heartbeat.timer.cached_identical_prompt` naming the source run. Wakes with a concrete reason (issue/comment/task) never cache | A positive finite number (USD) — enable. Unset, `0`, negative or non-numeric — the cache is off |

## settings-ru

| `MYRMIDON_IDLE_SKIP_METRICS` | 1.2-COST-CACHING | выкл | Замер эффекта пропуска пустых побудок: каждый пропуск `heartbeat.timer.no_actionable_work` шагает процессные счётчики («пропущено пустых побудок / сэкономлено вызовов модели») и пишет одну строку в журнал с итогами. Выкл — ни счётчиков, ни строк; сам пропуск не меняется | `true`/`1`/`yes`/`on` — включить замер. Любое другое значение или не задано — выкл |
| `MYRMIDON_PROMPT_CACHE_MIN_COST` | 1.2-COST-CACHING | не задан (выкл) | Побудка по таймеру без конкретной причины, чей снимок контекста идентичен снимку предыдущего завершённого прогона агента, переиспользует записанный ответ вместо нового вызова адаптера, но только когда стоимость ответа не ниже порога (USD; `costUsd`, фолбэк `cacheAdjustedCostUsd`). Дешёвый или бесплатный ответ всегда пересчитывается. Кэшированная побудка — `skipped` с причиной `heartbeat.timer.cached_identical_prompt` и ссылкой на исходный прогон. Побудки с конкретной причиной (задача/комментарий) не кэшируются | Положительное конечное число (USD) — включить. Не задано, `0`, отрицательное или нечисловое — кэш выкл |
