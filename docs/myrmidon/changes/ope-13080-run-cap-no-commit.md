## changelog-en

### Consecutive runs without commit cap (PF-RUN-CAP-NO-COMMIT / OPE-13080)

- Added automatic run cap when consecutive completed runs on an issue do not advance the PR head commit (`general.processes.taskRunsWithoutCommitLimit`, default: 4, 0 = disabled).
- When reached: automatic continuations and re-wakes are skipped, the task transitions to `blocked` with recent run summaries and PR head SHA, and the project lead (or assignee's manager, or adm) is woken with the escalation details.
- Counter resets on a new commit in the PR branch or on a manual unblock (a person moving the task from `blocked` to `todo`/`in_progress`); comments and other edits do not reset it.

## changelog-ru

### Потолок прогонов на задачу без нового коммита (PF-RUN-CAP-NO-COMMIT / OPE-13080)

- Добавлен автоматический потолок прогонов на задачу без нового коммита в ветку PR (`general.processes.taskRunsWithoutCommitLimit`, по умолчанию: 4, 0 — выключено).
- При достижении: новые автоматические продолжения и побудки по задаче не ставятся (skip), задача переводится в `blocked` со сводкой последних прогонов и sha PR, а лид проекта (или руководитель исполнителя, или бот adm) получает побудку.
- Счётчик сбрасывается при новом коммите в ветку PR или ручном снятии блока (человек перевёл задачу из `blocked` в `todo`/`in_progress`); комментарии и другие правки счётчик не сбрасывают.
