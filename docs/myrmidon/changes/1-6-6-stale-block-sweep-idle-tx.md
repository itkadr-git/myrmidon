---
divergence-section: Трек 1 — платформа
---

## changelog-en

### Stale-block sweep no longer freezes the board with an idle transaction

- The sweep that lifts dead blocks locked the task row, then wrote its activity rows through the
  root database handle instead of its own transaction. The `activity_log` insert touches the same
  task row, so it queued behind the sweep's own lock: the transaction stayed `idle in transaction`
  for about two minutes, blocking other writers, and the next sweep tick repeated it.
- Activity rows are now written inside the unblock transaction. The transaction also sets
  `idle_in_transaction_session_timeout = 15s` and logs a warning with the path name
  (`stale_block_sweep.unblock`) when it stays open longer than 2 s.

## changelog-ru

### Сторож устаревших блокировок больше не подвешивает доску «idle in transaction»

- Сторож, снимающий мёртвые блокировки задач, брал блокировку строки задачи, а записи в журнал
  активности писал через корневое соединение, а не через свою транзакцию. Вставка в
  `activity_log` трогает ту же строку задачи и вставала в очередь за блокировкой самого сторожа:
  транзакция висела `idle in transaction` около двух минут, остальные записи ждали, а на
  следующем тике всё повторялось.
- Записи активности теперь идут внутри транзакции снятия блокировки. Транзакция также выставляет
  `idle_in_transaction_session_timeout = 15s` и пишет предупреждение с именем пути
  (`stale_block_sweep.unblock`), если держится дольше 2 с.
