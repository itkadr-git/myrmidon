## changelog-en

### An engineer agent handing a task to review without a review stage now gets a load-balanced review stage instead of a 422 (OPE-13099)

- When an engineer agent sent `PATCH {status: "in_review"}` for a task with no review path (no review stage, card, approval, human assignee or monitor), the board answered 422 `missing: review_path`, so instructions carried a hand-made "reviewer by PR number modulo 6" rule that bypassed load balancing.
- Now, with review routing enabled and a task that is not `human_only`, the board adds a review stage to the task's existing policy when the executor is an engineer. Its participants are the invokable reviewers of the executor's own group (the author and assignee are excluded), and the usual transition picks the least loaded one as the current participant in the same write.
- With no reviewer in the group, or for a non-engineer executor, nothing is added and the previous 422 stays. A task that already has a review stage, a re-submission after `changes_requested`, and PATCH requests from the board or a user behave as before.

## changelog-ru

### Агент-инженер, сдающий задачу на ревью без стадии ревью, получает от доски стадию с распределением по нагрузке вместо 422 (OPE-13099)

- Когда агент-инженер слал `PATCH {status: "in_review"}` по задаче без пути ревью (нет стадии ревью, карточки, согласования, исполнителя-человека и монитора), доска отвечала 422 `missing: review_path`; из-за этого в инструкциях жило ручное правило «ревьюер по номеру PR, остаток от деления на 6», обходившее распределение нагрузки.
- Теперь при включённой маршрутизации ревью и задаче не `human_only` доска добавляет к прежней политике задачи стадию ревью, если исполнитель — инженер. Участники — доступные ревьюеры группы исполнителя (автор и исполнитель исключены); обычный переход выбирает наименее загруженного текущим участником в той же записи.
- Если в группе ревьюеров нет или исполнитель не является инженером, ничего не добавляется и прежний 422 остаётся. Задача со стадией ревью, повторная сдача после `changes_requested` и запросы доски или пользователя работают как раньше.
