## changelog-en

### Fixed: the repeated tool failure limit no longer aborts working runs (OPE-12796)

- The hermes_gateway guard "Repeated tool failure limit exceeded" stopped a run after any three failed calls of one tool in a row: the gateway reports `error` as a boolean, so every failure looked like "the same error". It now counts only the same call (same tool and arguments, and the same error text when the event carries one) failing again after the model has seen the previous failure. Parallel failures of one model turn and failures of different calls no longer add up; a successful call still resets the counter. The threshold (3) and the stop message are unchanged; the run log now also shows the arguments of the repeated call.
- Code: `packages/adapters/hermes/src/gateway/server/myrmidon-tool-failure-repeat.ts`, wired in `execute.ts`. Tests: `myrmidon-tool-failure-repeat.myrmidon.test.ts`, `execute.test.ts`.

## changelog-ru

### Исправлено: лимит повторов ошибок инструментов больше не обрывает рабочие прогоны (OPE-12796)

- Защита hermes_gateway «Repeated tool failure limit exceeded» останавливала прогон после любых трёх подряд неудачных вызовов одного инструмента: шлюз присылает `error` булевым признаком, и все неудачи выглядели «одинаковой ошибкой». Теперь считается только один и тот же вызов (тот же инструмент и аргументы, и тот же текст ошибки, если событие его несёт), неудавшийся снова после того, как модель увидела прошлую неудачу. Параллельные неудачи одного хода модели и неудачи разных вызовов не суммируются; успешный вызов по-прежнему сбрасывает счётчик. Порог (3) и текст остановки не изменены; в журнале прогона теперь есть аргументы повторяющегося вызова.
- Код: `packages/adapters/hermes/src/gateway/server/myrmidon-tool-failure-repeat.ts`, подключение в `execute.ts`. Тесты: `myrmidon-tool-failure-repeat.myrmidon.test.ts`, `execute.test.ts`.
