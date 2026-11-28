## changelog-en

### A blocked or in-review slicing task no longer stops the next slice

The board skipped creating a new AUTO-SLICE task while an earlier one was in
`blocked` or `in_review`. A lead that cuts tasks parks the slicing task behind
them as blockers, so the queue refill stalled for hours and engineers sat idle.
The duplicate check now looks only at `backlog`, `todo` and `in_progress`.

An agent can no longer create a task under an AUTO-SLICE task without a release
label (422 `auto_slice_child_needs_release_label`). When an AUTO-SLICE task is
closed as done, its open child tasks move to the single epic named under
`Открытые эпики:` in its description. With several epics or none, the tasks stay
and the reason is written to the activity log.

## changelog-ru

### Задача нарезки в blocked или in_review больше не мешает следующей нарезке

Доска не создавала новую задачу AUTO-SLICE, пока прежняя стояла в `blocked`
или `in_review`. Ведущий, нарезав задачи, ставит задачу нарезки в блокеры за
ними, и пополнение очереди вставало на часы, а инженеры простаивали.
Проверка дубля теперь смотрит только на `backlog`, `todo` и `in_progress`.

Агент больше не может создать задачу под AUTO-SLICE без метки выпуска (422
`auto_slice_child_needs_release_label`). Когда AUTO-SLICE закрывается в done,
её открытые дочерние задачи переходят на единственный эпик из строки
`Открытые эпики:` в описании. Если эпиков несколько или нет, задачи остаются, а
причина записывается в журнал активности.
