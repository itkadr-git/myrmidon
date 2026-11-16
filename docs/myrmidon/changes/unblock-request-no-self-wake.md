## changelog-en

### The board no longer wakes an agent to unblock its own block and throttles repeat unblock requests

When the owner of a block (`unblockDescriptor.owner`) was the issue's own assignee, the board woke it with
`issue_unblock_requested` on every blocked transition. The agent saw nobody to wait for but itself, set `blocked` again
and went to sleep, which produced about 17 empty runs in 15 minutes. Now the assignee is not woken to unblock itself:
the request is escalated to the project lead (or the assignee's manager) and, when there is none, only written to the
activity log (`issue.unblock_request_self_owner_logged`). Repeat `issue_unblock_requested` wakes for the same issue and
owner are sent no more often than `blockerMetadata.nextCheckAt`, or once per 30 minutes when it is not set. A new
external event on the issue (a comment by another author or a blocker change) lifts the limit at once. No migrations.

## changelog-ru

### Доска больше не будит исполнителя снимать его же блок и ограничивает повторные запросы на снятие блока

Если владельцем снятия блока (`unblockDescriptor.owner`) был сам исполнитель задачи, доска будила его причиной
`issue_unblock_requested` при каждом переходе в blocked. Агент видел, что ждать некого, кроме себя, снова ставил
`blocked` и засыпал: около 17 пустых прогонов за 15 минут. Теперь исполнителя не будят снимать собственный блок:
запрос уходит лиду проекта (или руководителю исполнителя), а если их нет — только пишется в журнал активности
(`issue.unblock_request_self_owner_logged`). Повторная побудка `issue_unblock_requested` по той же задаче и тому же
владельцу — не чаще `blockerMetadata.nextCheckAt`, а без него — раз в 30 минут. Новое внешнее событие по задаче
(комментарий другого автора, изменение блокеров) снимает ограничение сразу. Миграций нет.
