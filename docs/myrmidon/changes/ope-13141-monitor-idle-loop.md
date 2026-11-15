## changelog-en

### Monitor of a task that waits for subtasks no longer polls with a model (MONITOR-IDLE-LOOP / OPE-13141)

- A due monitor of a task that has subtasks compares a snapshot (task and subtask statuses, pull requests, comments and documents by anyone but the owner) with the one recorded at the previous wake. Nothing changed: no model wake, the monitor moves on (`issue.monitor_deferred`, reason `issue_state_unchanged`).
- After `general.processes.monitorUnchangedWakeLimit` unchanged terms in a row (default 3, 0 = off) the monitor is removed and `issue.monitor_cleared` with a warning is written to the activity log. Monitors of tasks without subtasks, review CI-wait monitors and manual triggers are not affected.
- When a subtask's pull request is merged and the board settles the subtask to `done`, the owner of the parent is woken once (`issue_children_completed`, key per parent and subtask; `allChildrenTerminal` says whether it was the last one).
- The no-commit run cap (`taskRunsWithoutCommitLimit`) applies to every agent role, not only to engineers.

## changelog-ru

### Монитор задачи, ждущей подзадачи, больше не опрашивает модель (MONITOR-IDLE-LOOP / OPE-13141)

- Сработавший монитор задачи с подзадачами сравнивает снимок (статусы задачи и подзадач, PR, комментарии и документы не от владельца) со снимком прошлой побудки. Ничего не изменилось — модель не будится, монитор переносится (`issue.monitor_deferred`, причина `issue_state_unchanged`).
- После `general.processes.monitorUnchangedWakeLimit` сроков подряд без изменений (по умолчанию 3, 0 — выключено) монитор снимается, в журнал активности пишется `issue.monitor_cleared` с предупреждением. Мониторы задач без подзадач, монитор ожидания CI на ревью и ручной запуск не затронуты.
- Когда PR подзадачи влит и доска закрыла подзадачу как `done`, владелец родителя будится один раз (`issue_children_completed`, ключ — родитель и подзадача; `allChildrenTerminal` — была ли подзадача последней).
- Потолок прогонов без нового коммита (`taskRunsWithoutCommitLimit`) действует на агентов любой роли, не только инженеров.
