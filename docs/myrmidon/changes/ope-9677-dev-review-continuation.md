## changelog-en

### DEVFLOW: continuation after development review (OPE-9677)

- When an engineer hands an issue to review, automatically assign their next ready issue from the same development project; if none is eligible, signal the project lead.
- The run release path recognizes an author's issue in `in_review` via `executionState.returnAssignee` in an explicitly enabled development project and invokes the existing swarm matcher with an exact `projectId` scope.
- Configured via `MYRMIDON_DEV_PROCESS_PROJECT_IDS` (comma-separated project UUIDs; unset/empty leaves behavior disabled).
- When no eligible task is available in the project, the lead receives a `dev_project_queue_empty` wake signal.

## changelog-ru

### DEVFLOW: следующая готовая задача после сдачи на ревью (OPE-9677)

- Когда инженер передает задачу в ревью, система автоматически подбирает ему следующую готовую задачу того же dev-проекта; если готовых задач нет — отправляет сигнал лиду.
- Путь освобождения прогона определяет задачу автора в `in_review` по `executionState.returnAssignee` в явно включенном dev-проекте и вызывает swarm matcher с точным ограничением `projectId`.
- Настраивается переменной окружения `MYRMIDON_DEV_PROCESS_PROJECT_IDS` (UUID проектов через запятую; если не задана — поведение отключено).
- При отсутствии подходящей задачи в очереди проекта лиду отправляется побудка с причиной `dev_project_queue_empty`.
