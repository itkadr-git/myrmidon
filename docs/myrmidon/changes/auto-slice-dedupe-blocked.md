## changelog-en

### A blocked or in-review slicing task no longer stops the next slice

The board skipped creating a new AUTO-SLICE task while an earlier one was in
`blocked` or `in_review`. A lead that cuts tasks parks the slicing task behind
them as blockers, so the queue refill stalled for hours and engineers sat idle.
The duplicate check now looks only at `backlog`, `todo` and `in_progress`.

## changelog-ru

### Задача нарезки в blocked или in_review больше не мешает следующей нарезке

Доска не создавала новую задачу AUTO-SLICE, пока прежняя стояла в `blocked`
или `in_review`. Ведущий, нарезав задачи, ставит задачу нарезки в блокеры за
ними, и пополнение очереди вставало на часы, а инженеры простаивали.
Проверка дубля теперь смотрит только на `backlog`, `todo` и `in_progress`.
