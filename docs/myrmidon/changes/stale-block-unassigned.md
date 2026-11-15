## changelog-en

### The stale-block sweep returns an unassigned task with a dead block to todo instead of failing on every pass (STALE-BLOCK-UNASSIGNED)

- On 13.11 (candidate 1.6.9-rc.2) a task created straight in `blocked` with a closed blocker and no assignee made the sweep log
  "stale block sweep failed for one task" (HttpError 422) on every pass and stay blocked for good. The block had a named
  reason (the edge to the blocker), so the sweep chose `in_progress`, and the issue service refuses `in_progress` for a
  task with neither an agent nor a user assignee ("in_progress issues require an assignee").
- A task without an assignee now goes to `todo` (the dead edge is removed, the comment says "without assignee"). A task with
  an assignee returns to `in_progress` as before; a bare block still goes to `todo`.
- The failure warning now also carries `errorMessage`: the fixed refusal sentence of the issue service for a 4xx
  HttpError (plain words only, at most 120 characters), so the cause of a repeated 422 reads from the log. Messages of
  other errors are still not logged.

## changelog-ru

### Обход «мёртвых блокировок» возвращает задачу без исполнителя в todo, а не падает на каждом проходе (STALE-BLOCK-UNASSIGNED)

- 13.11 (кандидат 1.6.9-rc.2) задача, созданная сразу в `blocked` с закрытым блокером и без исполнителя, заставляла обход
  писать в журнал «stale block sweep failed for one task» (HttpError 422) на каждом проходе и оставалась заблокированной
  навсегда. У блокировки была названная причина (ребро на блокер), поэтому обход выбирал `in_progress`, а сервис задач
  отказывает в `in_progress` задаче без исполнителя — ни агента, ни пользователя («in_progress issues require an
  assignee»).
- Задача без исполнителя теперь уходит в `todo` (мёртвое ребро снято, в комментарии «without assignee»). Задача с
  исполнителем возвращается в `in_progress`, как раньше; «голая» блокировка по-прежнему уходит в `todo`.
- Предупреждение о сбое теперь несёт и `errorMessage`: фиксированную фразу отказа сервиса задач для HttpError 4xx
  (только простые слова, до 120 символов), чтобы причина повторяющегося 422 читалась из журнала. Тексты других ошибок
  по-прежнему не логируются.
