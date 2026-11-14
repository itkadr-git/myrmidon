# OPE-13077: maintenance-interrupt retry continuation — EN text, run times, branch and head SHA

## EN

When the board interrupts a run for maintenance (rollout), the retry used to
receive a short Russian-only instruction with no timestamps and no pointer to
the task branch. 55 of 88 maintenance-interrupted retries on 13–14 Nov started
the task over from zero.

The retry instruction now:

- is written in English, matching the rest of the wake text;
- names the interrupted run and the maintenance window;
- reports the run start time, the interrupt time and how long it ran;
- names the task branch and the latest commit (head SHA) when the board
  knows them from the issue's pull-request work product;
- tells the agent to run `git status` and `git log --oneline -5`, read the
  latest comments, and continue from where the work stopped.

Delivery path is unchanged: `scheduleBoundedRetry` copies
`livenessContinuationInstruction` into the retry context snapshot,
`buildPaperclipWakePayload` surfaces it as `livenessContinuation`, and the
shared `renderPaperclipWakePrompt` prints the "Run liveness continuation:"
block that hermes-gateway renders.

Regular wakes (`issue_assigned`, `ci_completed`) do not receive the block:
`livenessContinuation` is only populated when the retry context carries it.

## RU

Когда доска обрывает прогон для обслуживания (выкат), повтор раньше получал
короткую инструкцию только на русском, без времён и без указания ветки задачи.
55 из 88 таких повторов 13–14 ноября начинали задачу заново.

Инструкция повтора теперь:

- написана на английском, как остальной текст побудки;
- называет прерванный прогон и окно обслуживания;
- сообщает время старта прогона, время обрыва и длительность;
- называет ветку задачи и последний коммит (head SHA), если доска знает их
  из рабочего продукта PR задачи;
- велит выполнить `git status` и `git log --oneline -5`, прочитать свежие
  комментарии и продолжить с места остановки.

Путь доставки не изменился: `scheduleBoundedRetry` копирует
`livenessContinuationInstruction` в снапшот контекста повтора,
`buildPaperclipWakePayload` отдаёт его как `livenessContinuation`, а общий
`renderPaperclipWakePrompt` печатает блок «Run liveness continuation:»,
который рендерит hermes-gateway.

Обычные побудки (`issue_assigned`, `ci_completed`) блок не получают:
`livenessContinuation` заполняется только когда контекст повтора его несёт.
