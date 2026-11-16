## changelog-en

### A PR head change now counts as an external event for the continuation cap

The cap that stops a task after 3 automatic continuations in a row without an
external event no longer stops an engineer who keeps pushing to the task's pull
request. A change of the PR head (the `issue.work_product_head_changed` row) is
treated as an external event and restarts the count. Without a push and without
new input (comment, blocker resolved) the cap works as before.

## changelog-ru

### Смена головы PR теперь считается внешним событием для потолка продолжений

Потолок, останавливающий задачу после 3 автоматических продолжений подряд без
внешнего события, больше не останавливает инженера, который продолжает пушить в
PR задачи. Смена головы PR (строка `issue.work_product_head_changed`) считается
внешним событием и сбрасывает счётчик. Без пуша и без новой вводной
(комментарий, снятие блокера) потолок работает как раньше.
