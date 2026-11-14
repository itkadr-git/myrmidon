## changelog-en

### OPE-13098: run guard stop signal escalates to lead instead of reviewer

- When a run guard permanently halts an engineer's task ("needs new inputs"), the stop signal (`run_guard_stop_needs_input`) now traverses up the `reports_to` hierarchy (up to 5 steps, cycle-guarded) to find the nearest invokable agent with role `lead` or `architect`.
- Reviewers are skipped as wake recipients because they do not author or slice tasks. If no active lead or architect is found, it falls back to `adm`.
- `isRunGuardStopWakeRecipient` mirrors this check so that execution dispatch only permits the target lead/architect or `adm` to run on the stopped task.

## changelog-ru

### OPE-13098: сигнал остановки защитой уходит лиду вместо ревьюера

- Когда защита прогона окончательно останавливает задачу инженера («нужна новая вводная»), сигнал остановки (`run_guard_stop_needs_input`) поднимается по цепочке `reports_to` (до 5 шагов, с защитой от циклов) до ближайшего вызываемого агента с ролью `lead` или `architect`.
- Ревьюеры пропускаются и не получают побудку, так как переписывание карточек и нарезка задач — обязанность лида/архитектора. Если вызываемый лид или архитектор не найден, управление передаётся `adm`.
- Функция `isRunGuardStopWakeRecipient` зеркально отражает это правило, допуская к запуску на остановленной задаче только целевого лида/архитектора или `adm`.
