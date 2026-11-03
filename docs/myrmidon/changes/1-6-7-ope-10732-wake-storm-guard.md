---
settings-section: Track 2 — wake and run core
---

## changelog-en

### Wake storm circuit breaker (1.6.7 WAKE-STORM-GUARD)

- Repeated automatic wakes from the same source for one agent are bounded by a sliding window circuit breaker (`MYRMIDON_WAKE_STORM_LIMIT`, `MYRMIDON_WAKE_STORM_WINDOW_MS`). Exceeding the limit trips the source, pauses it for the window duration, and records `heartbeat.wake_storm_guard_tripped`.

## changelog-ru

### Предохранитель от шторма пробуждений (1.6.7 WAKE-STORM-GUARD)

- Автоматические повторяющиеся пробуждения одного агента от одного источника ограничены скользящим предохранителем (`MYRMIDON_WAKE_STORM_LIMIT`, `MYRMIDON_WAKE_STORM_WINDOW_MS`). Превышение лимита приостанавливает источник на время окна и фиксирует событие `heartbeat.wake_storm_guard_tripped`.

## settings-en

| `MYRMIDON_WAKE_STORM_LIMIT` | WAKE-STORM-GUARD | `20` | Maximum wakes admitted for one agent and one wake source during the storm window. The next wake trips that source until the window expires, records `heartbeat.wake_storm_guard_tripped`, and is not admitted; manual/operator wakes bypass this guard | Positive integer; non-numeric, zero, negative or fractional — the default |
| `MYRMIDON_WAKE_STORM_WINDOW_MS` | WAKE-STORM-GUARD | `10000` | Sliding-window duration in milliseconds used with `MYRMIDON_WAKE_STORM_LIMIT` to detect repeated wakes from one source for one agent | Positive number; non-numeric, zero or negative — the default |

## settings-ru

| `MYRMIDON_WAKE_STORM_LIMIT` | WAKE-STORM-GUARD | `20` | Предел допущенных пробуждений одного агента от одного источника за окно. Следующее пробуждение приостанавливает источник до истечения окна, пишет событие `heartbeat.wake_storm_guard_tripped` и отклоняется; ручные вызовы оператора обходят предохранитель | Положительное целое число; нечисловое, 0, отрицательное или дробное — по умолчанию |
| `MYRMIDON_WAKE_STORM_WINDOW_MS` | WAKE-STORM-GUARD | `10000` | Длительность скользящего окна в миллисекундах для детекции шторма пробуждений от одного источника для одного агента | Положительное число; нечисловое, 0 или отрицательное — по умолчанию |
