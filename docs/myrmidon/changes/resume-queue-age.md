## changelog-en

### A run queued while its agent was paused is not cancelled as stale right after the resume (RESUME-QUEUE-AGE)

- Runs that stood in the queue while their agent was paused (waiting for a slot, `execution_changes_requested`) were cancelled by the queue-age sweep (`queued_run_stale_timeout`) in the second the pause was lifted: the pause counted as waiting time, the first resumed run had not reached `running` yet, so the slot-wait protection saw nothing. The replacement wake lost the original wake reason.
- Resuming an agent now stamps its queued runs with `queueWaitResumedAt`; the wait of such a run counts from the resume (later of the stamp, the creation time or the retry due time), in the sweep's selection and in the cancellation check.
- Unchanged: a run whose slot stays free longer than the threshold after the resume is still cancelled; other reasons (task closed, assignee changed) and the pause protection of RESUME-AFTER-CANCEL are untouched.

## changelog-ru

### Прогон, стоявший в очереди на паузе агента, не снимается по сроку сразу после снятия паузы (RESUME-QUEUE-AGE)

- Прогоны, стоявшие в очереди, пока их агент был на паузе (ждали слот, `execution_changes_requested`), обход очереди снимал по сроку (`queued_run_stale_timeout`) в ту же секунду, когда пауза снималась: пауза считалась временем ожидания, первый возобновлённый прогон ещё не дошёл до `running`, и защита ожидания слота ничего не видела. Замена теряла исходную причину побудки.
- Снятие паузы теперь ставит на прогоны агента в очереди отметку `queueWaitResumedAt`; ожидание такого прогона считается от снятия паузы (позднее из отметки, создания и срока повтора) — и в выборке обхода, и в проверке снятия.
- Без изменений: прогон, чей слот свободен дольше порога после снятия паузы, по-прежнему снимается; прочие причины (задача закрыта, исполнитель сменился) и защита паузы из RESUME-AFTER-CANCEL не тронуты.
