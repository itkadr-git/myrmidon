## changelog-en

### A run queued while its agent was paused is not cancelled as stale right after the resume (RESUME-QUEUE-AGE)

- Runs that stood in the queue while their agent was paused (waiting for a slot, `execution_changes_requested`) were cancelled by the queue-age sweep (`queued_run_stale_timeout`) in the second the pause was lifted: the pause counted as waiting time, the first resumed run had not reached `running` yet, so the slot-wait protection saw nothing. The replacement wake lost the original wake reason.
- Resuming an agent now stamps its queued runs with `queueWaitResumedAtMs` (epoch milliseconds; a value that does not fit is ignored, never an error); the wait of such a run counts from the resume (later of the stamp, the creation time or the retry due time), in the sweep's selection and in the cancellation check.
- The service keys the sweep writes onto a queued run (wait reason and detail, queue position and length) are now merged on the database side, so they cannot erase the stamp. A failed stamp is logged as a warning and does not stop the queue from being promoted.
- Known limits: runs that waited while the board was down or in a maintenance window longer than the threshold, and the pause of a whole company, do not get the stamp.
- Unchanged: a run whose slot stays free longer than the threshold after the resume is still cancelled; other reasons (task closed, assignee changed) and the pause protection of RESUME-AFTER-CANCEL are untouched.

## changelog-ru

### Прогон, стоявший в очереди на паузе агента, не снимается по сроку сразу после снятия паузы (RESUME-QUEUE-AGE)

- Прогоны, стоявшие в очереди, пока их агент был на паузе (ждали слот, `execution_changes_requested`), обход очереди снимал по сроку (`queued_run_stale_timeout`) в ту же секунду, когда пауза снималась: пауза считалась временем ожидания, первый возобновлённый прогон ещё не дошёл до `running`, и защита ожидания слота ничего не видела. Замена теряла исходную причину побудки.
- Снятие паузы теперь ставит на прогоны агента в очереди отметку `queueWaitResumedAtMs` (миллисекунды эпохи; неподходящее значение игнорируется, не ошибка); ожидание такого прогона считается от снятия паузы (позднее из отметки, создания и срока повтора) — и в выборке обхода, и в проверке снятия.
- Служебные ключи, которые обход пишет на прогон в очереди (причина и детали ожидания, позиция и длина очереди), теперь пишутся слиянием на стороне базы и не могут стереть отметку. Сбой записи отметки пишется в журнал уровнем warn и не мешает продвинуть очередь.
- Известные ограничения: прогоны, ждавшие, пока доска была выключена или в окне обслуживания дольше порога, и снятие паузы компании отметку не получают.
- Без изменений: прогон, чей слот свободен дольше порога после снятия паузы, по-прежнему снимается; прочие причины (задача закрыта, исполнитель сменился) и защита паузы из RESUME-AFTER-CANCEL не тронуты.
