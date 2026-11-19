## changelog-en

### Assignee comment wake on a closed task is cancelled cleanly instead of failing setup (CLOSED-TASK-COMMENT-RUN)

- Following RUN-SETUP-STALE-TASK (#3156), a comment wake on an already closed task (`done` or `cancelled`) still caused the assignee's queued run to start and fail in `buildExecutionContinuation` (`continuation_task_ownership_changed`) with an error-level log line.
- The comment bypass for terminal task status no longer applies to runs of the task assignee: queued assignee runs on closed tasks are cancelled at claim time with `issue_terminal_status` (info log, no `failed`). Non-assignee comment wakes, explicit resume intents, and pending card responses continue to bypass as before.

## changelog-ru

### Прогон исполнителя по комментарию в закрытой задаче отменяется штатно, а не падает при подготовке (CLOSED-TASK-COMMENT-RUN)

- В развитие исправления RUN-SETUP-STALE-TASK (#3156): комментарий в закрытую задачу (`done` или `cancelled`) приводил к тому, что прогон исполнителя из очереди стартовал и падал в `buildExecutionContinuation` (`continuation_task_ownership_changed`) с записью уровня error.
- Обход терминального статуса по комментарию больше не применяется к прогонам самого исполнителя: такие прогоны отменяются при взятии из очереди с кодом `issue_terminal_status` (уровень info, без `failed`). Прогоны не-исполнителей по комментарию, явные намерения возобновить (`resumeIntent`) и ответы на карточки работают как раньше.
