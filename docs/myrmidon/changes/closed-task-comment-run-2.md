## changelog-en

### Run on a task closed after queue dequeue or with resumeIntent is cleanly cancelled during preparation (CLOSED-TASK-COMMENT-RUN-2)

- Following CLOSED-TASK-COMMENT-RUN (#3169), a run taken from the queue before the task was closed (`done` or `cancelled`), or bypassing the queue check via `resumeIntent`, still reached preparation in `executeRun` and failed with `continuation_task_ownership_changed` (`setup_failed`) and an error-level log.
- During run execution preparation, if the assigned task has reached terminal status (`done` or `cancelled`) or if `buildExecutionContinuation` detects an ownership/terminal status change, the run is now cleanly cancelled with `issue_terminal_status` (or `issue_assignee_changed`) instead of failing setup with an error-level log.

## changelog-ru

### Прогон по задаче, закрытой после взятия из очереди или с resumeIntent, штатно отменяется при подготовке (CLOSED-TASK-COMMENT-RUN-2)

- В развитие исправления CLOSED-TASK-COMMENT-RUN (#3169): прогон, взятый из очереди до закрытия задачи (`done` или `cancelled`), либо обошедший проверку очереди через `resumeIntent`, попадал в подготовку `executeRun` и падал с ошибкой `continuation_task_ownership_changed` (`setup_failed`) и записью в лог уровня error.
- При подготовке к выполнению прогона (`executeRun`), если задача исполнителя перешла в терминальный статус (`done` или `cancelled`) либо если `buildExecutionContinuation` фиксирует смену владельца или закрытие задачи, прогон теперь штатно отменяется с кодом `issue_terminal_status` (или `issue_assignee_changed`), без падения в `setup_failed` и без ошибки в логе.
