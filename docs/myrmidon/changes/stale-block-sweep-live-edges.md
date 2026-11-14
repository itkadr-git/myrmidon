## changelog-en

### The stale-block sweep no longer fails forever on a task with a dead cited reason and an open blocker (STALE-BLOCK-LIVE-EDGES)

- On 13.11 the board logged "stale block sweep failed for one task" about 50 times an hour, for the same 14 blocked tasks on
  every pass, with no cause in the log. Each of them had a cited reason (`unblockDescriptor.reasonRef`) that had died —
  a passed date, a passed event deadline or a closed recovery incident — and at the same time a blocked-by edge to a
  task that is still open. With a reasonRef the sweep never looked at the edges, judged the block dead and moved the
  task to `in_progress`; the issue service refused ("Issue is blocked by unresolved blockers"), the transaction rolled
  back and the next pass did the same.
- The sweep now counts an open blocker on an edge the reasonRef does not cover as a live reason: the task stays
  blocked, the pass reports it as `skippedLive`, and the task wakes through the ordinary `issue_blockers_resolved`
  path when that blocker closes. A dead reasonRef whose blockers are all done or cancelled is unblocked as before.
- The failure warning now carries the class of the exception and its HTTP status (`errorName`, `errorStatus`), and
  still nothing of its message, code, cause or stack.

## changelog-ru

### Обход «мёртвых блокировок» больше не падает бесконечно на задаче с умершей причиной и открытым блокером (STALE-BLOCK-LIVE-EDGES)

- 13.11 доска писала в журнал «stale block sweep failed for one task» около 50 раз в час — по одним и тем же 14
  заблокированным задачам на каждом проходе и без причины в журнале. У каждой была названная причина блокировки
  (`unblockDescriptor.reasonRef`), которая уже умерла: прошедшая дата, прошедший срок события или закрытый инцидент
  восстановления, — и при этом связь «заблокирована задачей», которая ещё открыта. При наличии reasonRef обход на
  связи не смотрел, считал блокировку мёртвой и переводил задачу в `in_progress`; сервис задач отказывал («Issue is
  blocked by unresolved blockers»), транзакция откатывалась, и следующий проход делал то же самое.
- Теперь открытый блокер на связи, которую reasonRef не покрывает, считается живой причиной: задача остаётся
  заблокированной, проход учитывает её как `skippedLive`, а разбудит её обычный путь `issue_blockers_resolved`, когда
  блокер закроется. Задача с умершим reasonRef, у которой все блокеры выполнены или отменены, разблокируется как
  раньше.
- Предупреждение о сбое теперь несёт класс исключения и его HTTP-статус (`errorName`, `errorStatus`) и по-прежнему
  ничего из его текста, кода, причины и стека.
