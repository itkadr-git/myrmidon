## changelog-en

### A task whose run the operator cancelled resumes when its agent is resumed (RESUME-AFTER-CANCEL)

- After an operator cancelled runs and the board restarted, the board closed the recovery actions with a "do not replay" outcome, and lifting the agent's pause woke the tasks as system wakes: they were parked as `execution_reconciliation_required` and each task needed a manual wake.
- Lifting a pause is an explicit operator action. The wakes it issues are now attributed to the board user who resumed the agent and `pause_resume` counts as an explicit wake, like a manual one: the settled hold of a cancelled run (run terminal, no finalization lease, no successor) no longer parks it.
- Unchanged: a failed run with an unknown outcome, a run still running, automatic and system wakes and `retry_failed_run` stay held; the "do not replay" protection is not touched.
- Not changed here: the recovery action closed with outcome `blocked` while the task stays `in_progress`, and `recovery-actions/resolve` with `restored` answering 200 without effect.

## changelog-ru

### Задача, прогон которой отменил оператор, продолжается при снятии паузы с агента (RESUME-AFTER-CANCEL)

- После отмены прогонов оператором и перезапуска доски действия восстановления закрывались с исходом «не повторять», а снятие паузы будило задачи как системные побудки: они откладывались как `execution_reconciliation_required`, и каждую задачу приходилось будить вручную.
- Снятие паузы — явное действие оператора. Побудки, которые оно создаёт, теперь приписаны пользователю доски, снявшему паузу, а `pause_resume` считается явной побудкой, как ручная: закрытое удержание отменённого прогона (прогон завершён, нет аренды финализации, нет преемника) её не откладывает.
- Без изменений: упавший прогон с неизвестным исходом, идущий прогон, автоматические и системные побудки и `retry_failed_run` по-прежнему удерживаются; защита «не повторять» не тронута.
- Здесь не менялось: действие восстановления, закрытое с исходом `blocked` при задаче в `in_progress`, и `recovery-actions/resolve` с `restored`, отвечающий 200 без эффекта.
