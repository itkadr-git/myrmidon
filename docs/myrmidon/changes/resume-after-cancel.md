## changelog-en

### A task whose run the operator cancelled resumes when its agent is resumed (RESUME-AFTER-CANCEL)

- After an operator cancelled runs and the board restarted, the board closed the recovery actions with a "do not replay" outcome, and lifting the agent's pause woke the tasks as system wakes: they were parked as `execution_reconciliation_required` and each task needed a manual wake.
- Lifting a pause is an explicit operator action, but the wake it issues stays a system wake (no user-requester bypasses: rewake freeze, wake-storm guard, worktree cutoff, `agent.not_invokable` record). The user who lifted the pause travels as `resumedByUserId` on the wake options, and only the settled-hold check reads it: a `pause_resume` wake passes the hold, and then retires it, only when the run holding it is `cancelled` (operator cancel, queue removal).
- Unchanged: a hold of a `failed` / `timed_out` / `interrupted` run (unknown outcome), a hold that names no run or a purged one, a run still running, automatic and system wakes and `retry_failed_run` stay held; the "do not replay" protection is not touched.
- A queued run of an agent the operator has paused is no longer expired by the queue-age sweep (`queued_run_stale_timeout`): it waits for the resume, which promotes it with its own wake reason. Before, the sweep cancelled it and the replacement wake failed with 409 "Agent is not invokable", logged at error level, so nothing continued the task after the resume. The sweep's selection (`listStaleQueuedRuns`) also leaves the runs of paused agents out of its 200-row page, so a mass pause does not crowd out the expired runs of other agents.
- Not changed here: the recovery action closed with outcome `blocked` while the task stays `in_progress`, and `recovery-actions/resolve` with `restored` answering 200 without effect.

## changelog-ru

### Задача, прогон которой отменил оператор, продолжается при снятии паузы с агента (RESUME-AFTER-CANCEL)

- После отмены прогонов оператором и перезапуска доски действия восстановления закрывались с исходом «не повторять», а снятие паузы будило задачи как системные побудки: они откладывались как `execution_reconciliation_required`, и каждую задачу приходилось будить вручную.
- Снятие паузы — явное действие оператора, но побудка остаётся системной (без обходов, которые получает побудка от пользователя: заморозка повторных побудок, защита от штормов, отсечка worktree, запись `agent.not_invokable`). Пользователь, снявший паузу, передаётся как `resumedByUserId` в параметрах побудки, и читает его только проверка удержания: побудка `pause_resume` проходит удержание (и затем снимает его) только когда удерживающий прогон в статусе `cancelled` (отмена оператором, снятие из очереди).
- Без изменений: удержание от прогона в `failed` / `timed_out` / `interrupted` (неизвестный исход), удержание без названного прогона или с удалённым, идущий прогон, автоматические и системные побудки и `retry_failed_run` по-прежнему удерживаются; защита «не повторять» не тронута.
- Прогон в очереди агента, которого оператор поставил на паузу, больше не снимается обходом очереди по сроку (`queued_run_stale_timeout`): он ждёт снятия паузы, которое запускает его со своей причиной побудки. Раньше обход снимал его, замена падала с 409 «Agent is not invokable» (запись уровня error), и после снятия паузы задача не продолжалась. Выборка обхода (`listStaleQueuedRuns`) тоже исключает прогоны агентов на паузе из своей страницы в 200 строк, чтобы массовая пауза не вытесняла просроченные прогоны остальных.
- Здесь не менялось: действие восстановления, закрытое с исходом `blocked` при задаче в `in_progress`, и `recovery-actions/resolve` с `restored`, отвечающий 200 без эффекта.
