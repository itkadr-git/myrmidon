## changelog-en

### Reviewer's changes_requested decision is recorded when review stage is missing from policy (REVIEW-CHANGES-LOST-STAGE)

- When an issue's execution stage definition was lost from its execution policy (e.g. policy monitor overwriting stages with an empty array or policy reset), a reviewer's changes requested decision (`in_progress` with comment) was rejected or caused execution state to be cleared without recording a decision.
- The stage participant's `changes_requested` transition is now properly recorded against the active pending review stage, bumping the review rounds count, moving the issue status back to `in_progress`, and returning assignment to the `returnAssignee`.

## changelog-ru

### Запрос правок ревьюером записывается, когда стадия ревью отсутствует в политике (REVIEW-CHANGES-LOST-STAGE)

- Когда определение стадии ревью пропадало из политики исполнения задачи (например, при перезаписи стадий пустым массивом монитором допуска или сбросе политики), запрос правок ревьюером (`in_progress` с комментарием) отклонялся либо очищал состояние исполнения без фиксации решения.
- Запрос правок (`changes_requested`) от назначенного участника стадии `pending` теперь корректно фиксируется в решении, инкрементирует счётчик раундов, переводит задачу в `in_progress` и возвращает назначение автору (`returnAssignee`).
