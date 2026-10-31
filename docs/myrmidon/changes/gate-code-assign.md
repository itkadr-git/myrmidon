## changelog-en

### Code issues are assigned to engineers only (GATE-CODE-ASSIGN)

Creating an issue, or changing its assignee, now refuses (422 `issue_requires_engineer`) an assignment of a code issue to an agent whose role is not `engineer`. An issue counts as code when it carries the `needs-engineer` label, routes to the engineer caste, or needs a live checkout (`skill_test` harness, `operator_branch`/`reuse_existing` workspace preference); nothing is inferred from the title or description, and an unreadable signal never blocks (fail-open). Whoever already holds the issue can still change its status. Humans can still be assigned, and issues in review or finished can be held by a reviewer. When the workspace of an engineer issue cannot be prepared, the issue returns to the queue through the regular issue update and a free engineer picks it up without a lead.

## changelog-ru

### Кодовые задачи назначаются только инженерам (GATE-CODE-ASSIGN)

Создание задачи и смена исполнителя теперь отклоняют (422 `issue_requires_engineer`) назначение кодовой задачи агенту, чья роль не `engineer`. Задача кодовая, если у неё метка `needs-engineer`, она маршрутизируется в касту инженеров или требует живого checkout (харнесс `skill_test`, настройка рабочего пространства `operator_branch`/`reuse_existing`); по заголовку и описанию ничего не выводится, а нечитаемый сигнал не блокирует (fail-open). Людям назначать по-прежнему можно, а задачу на ревью или завершённую может держать ревьюер. Если рабочее пространство инженерной задачи подготовить не удалось, задача возвращается в очередь штатным обновлением и её забирает свободный инженер без лида.
