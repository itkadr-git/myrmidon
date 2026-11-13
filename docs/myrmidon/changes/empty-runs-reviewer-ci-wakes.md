## changelog-en

### Reviewers are not woken on a non-final or already-seen CI result (EMPTY-RUNS-3B, EMPTY-RUNS-2C)

- EMPTY-RUNS-3B: a CI delivery wakes the task only on the result of the current head. When a head has a `CI result` check, only a finished one that is not skipped, cancelled or stale counts; the "every check has finished" fallback is used only for a head that has no `CI result` at all. A partial run (a label event, an auxiliary workflow) whose `CI result` is skipped no longer produces a `ci_completed` wake.
- EMPTY-RUNS-3B: one result of one head wakes once, whatever kind of event carries it (`check_run`, `check_suite`, `workflow_run`). The handled result is kept as `ciVerdictHandled` (head and verdict) on the pull request work product and is not cleared when a job of the head starts, as `lastCompletedCi` is; a failed result clears it, so a green result after a re-run is news again.
- EMPTY-RUNS-2C: the idle pickup of a review participant reads the head CI as it is now and applies the same admission rule as the hand-off to review and the executor's comment: while the head CI is unfinished, unreadable or red the reviewer is not picked up (a critical issue is). A failed read wakes as before. Switch: `MYRMIDON_REVIEW_COMMENT_WAKE_GATE_ENABLED`.
- EMPTY-RUNS-3B: the `ci_completed` wake for a task in review goes to the participant of its pending review stage, not to the assignee; a task in review without a pending stage wakes nobody. The idle pickup does not take an `in_review` task whose stage is missing or belongs to another agent.

## changelog-ru

### Ревьюеров не будят по неитоговому или уже учтённому результату CI (EMPTY-RUNS-3B, EMPTY-RUNS-2C)

- EMPTY-RUNS-3B: событие CI будит задачу только по итогу текущей головы. Если у головы есть проверка `CI result`, считается лишь завершённая, не пропущенная, не отменённая и не устаревшая; запасной путь «все проверки завершены» работает только когда `CI result` у головы нет совсем. Частичный прогон (событие метки, побочный workflow) с пропущенной `CI result` больше не даёт побудку `ci_completed`.
- EMPTY-RUNS-3B: один итог одной головы будит один раз при любом виде события (`check_run`, `check_suite`, `workflow_run`). Учтённый итог хранится как `ciVerdictHandled` (голова и итог) в рабочем продукте PR и не сбрасывается стартом задачи той же головы, в отличие от `lastCompletedCi`; красный итог его сбрасывает, поэтому зелёный после перезапуска снова новость.
- EMPTY-RUNS-2C: подбор задачи ревьюером (idle pickup) читает CI головы на текущий момент и применяет то же правило допуска, что сдача на ревью и комментарий исполнителя: пока CI головы не завершён, не читается или красный, ревьюера не будят (критичную задачу будят). Если прочитать CI не удалось, будит как раньше. Переключатель: `MYRMIDON_REVIEW_COMMENT_WAKE_GATE_ENABLED`.
- EMPTY-RUNS-3B: побудка `ci_completed` по задаче в `in_review` адресуется участнику стадии ревью `pending`, а не исполнителю задачи; без стадии задача в `in_review` никого не будит. Подбор задачи (idle pickup) не берёт `in_review` без стадии или со стадией другого агента.
