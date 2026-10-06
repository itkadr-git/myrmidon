---
divergence-section: Трек 2 — ядро побудок и прогонов
settings-section: Track 2 — wake and run core
---

## changelog-en

### Company-wide wake budget for idle pickup (IDLE-WAKE-BUDGET)

- The board wakes at most five ready agents a minute per company (was: every
  idle agent with a ready task in one pass). The wakes go out in batches: one
  sweep pass emits at most `MYRMIDON_IDLE_PICKUP_WAKE_BATCH` wakes for a
  company, the rest follow on the next pass inside the same minute.
- The ceiling is shared by both idle-pickup paths — the periodic sweep and the
  pickup that runs right after a run releases its task — so a fleet of
  finishing runs cannot burst past it either.
- Two new environment knobs: `MYRMIDON_IDLE_PICKUP_WAKE_BUDGET_PER_MIN`
  (default 5, the ticket's number) and `MYRMIDON_IDLE_PICKUP_WAKE_BATCH`
  (default 5, never above the minute budget).
- A wake denied by the budget is not lost: the same candidate is re-evaluated
  in the next window, and both paths report how many candidates waited.

## changelog-ru

### Общий бюджет побудок на компанию для IDLE-PICKUP (IDLE-WAKE-BUDGET)

- Доска будит не больше пяти готовых агентов в минуту на компанию (было:
  каждый простаивающий агент с готовой задачей за один проход). Побудки уходят
  батчами: один проход подметания выдаёт компании не больше
  `MYRMIDON_IDLE_PICKUP_WAKE_BATCH` побудок, остальные — следующим проходом в ту
  же минуту.
- Потолок общий для обоих путей IDLE-PICKUP — периодического прохода и побудки
  сразу после освобождения задачи прогоном, — поэтому и флот завершающихся
  прогонов не может его пробить.
- Две новые ручки окружения: `MYRMIDON_IDLE_PICKUP_WAKE_BUDGET_PER_MIN`
  (по умолчанию 5, число из тикета) и `MYRMIDON_IDLE_PICKUP_WAKE_BATCH`
  (по умолчанию 5, не больше минутного бюджета).
- Отказанная бюджетом побудка не теряется: тот же кандидат пересматривается в
  следующем окне, а оба пути отчитываются, сколько кандидатов подождали.

## divergence

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| IDLE-WAKE-BUDGET | Компанийный бюджет побудок IDLE-PICKUP: не больше `MYRMIDON_IDLE_PICKUP_WAKE_BUDGET_PER_MIN` (по умолчанию 5) побудок на компанию в минуту, батчами по `MYRMIDON_IDLE_PICKUP_WAKE_BATCH` (по умолчанию 5, клампится минутным бюджетом) за проход. Окно минутное, живёт в процессе доски и прокручивается само. Бюджет один на оба пути побудок (периодический проход и побудка после освобождения задачи прогоном), поэтому потолок держится на пару, а не на каждый путь в отдельности. Разрешённая побудка списывает допуск в момент решения будить (даже если допуск её потом отложил), отказанная — не теряется: кандидат пересматривается в следующем окне. Отказ считается в `budgetSkipped`, превышение батча в проходе — в `skippedOverBatch` | `server/src/services/heartbeat.ts` (создание общего бюджета и передача его в оба пути; метка `myrmidon(IDLE-WAKE-BUDGET)`) + `server/src/myrmidon/idle-pickup.ts` | 28.09 доску положил OOM от массовой побудки: каждый вик — полная LLM-сессия, и проход будил всех простаивающих агентов сразу. Тикет требует «company-wide wake budget ≤5/мин батчами»; отдельного планировщика не заводим — расширяем существующий IDLE-PICKUP | `server/src/__tests__/idle-wake-budget.myrmidon.test.ts` (настройки и клампы, окно и раздельные счётчики компаний, отказ побудки при исчерпанном бюджете, батч прохода, изоляция компаний, потолок между проходами одного окна) | Никогда, наше поведение. Снятие: удалить блок `myrmidon(IDLE-WAKE-BUDGET)` и бюджет из `idle-pickup.ts`, создание бюджета и два его проброса в `heartbeat.ts`, тест-файл | (этот PR) |

## settings-en

| `MYRMIDON_IDLE_PICKUP_WAKE_BUDGET_PER_MIN` | IDLE-WAKE-BUDGET | `5` | Company-wide ceiling of idle-pickup wakes inside one minute (batches): the board wakes at most this many ready agents of one company per minute, whichever path emits the wake | From 1 to 60; `0`, negative, fractional or non-numeric — the default. The ceiling is process-local: a restart only ever resets it towards allowing more wakes |
| `MYRMIDON_IDLE_PICKUP_WAKE_BATCH` | IDLE-WAKE-BUDGET | `5` | How many wakes one sweep pass may emit for one company: the minute's allowance arrives in batches spread over passes instead of one burst. Clamped to the minute budget, so a batch above it is the budget | From 1 to 60; `0`, negative, fractional or non-numeric — the default. A company that used its batch waits for the next pass; other companies in the same pass are unaffected |

## settings-ru-append

<!-- section: Трек 2 — ядро побудок и прогонов -->
| `MYRMIDON_IDLE_PICKUP_WAKE_BUDGET_PER_MIN` | IDLE-WAKE-BUDGET | `5` | Потолок побудок IDLE-PICKUP на компанию в минуту (батчами): доска будит не больше стольких готовых агентов одной компании за минуту, независимо от того, какой путь выдал побудку | От 1 до 60; `0`, отрицательное, дробное или нечисловое — умолчание. Потолок считается в процессе доски: перезапуск лишь сбрасывает счётчик в сторону разрешения, а не запрета |
| `MYRMIDON_IDLE_PICKUP_WAKE_BATCH` | IDLE-WAKE-BUDGET | `5` | Сколько побудок один проход подметания может выдать одной компании: минутный допуск приходит батчами по проходам, а не одним залпом. Клампится минутным бюджетом, поэтому батч больше него — это сам бюджет | От 1 до 60; `0`, отрицательное, дробное или нечисловое — умолчание. Компания, израсходовавшая батч, ждёт следующего прохода; остальные компании того же прохода не задерживаются |