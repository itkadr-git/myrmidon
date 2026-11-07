## changelog-en

### Stranded deferred wakes are advanced or closed (1.6.6)

- A periodic reconcile pass now cancels deferred wakes of done or cancelled tasks whose lock is free.
- The same pass hands the queue of an open task with a free lock to the ordinary release drain, including wakes without comment ids and wakes queued after an acknowledged operator Stop.
- Tasks under an effective "do not replay" hold keep waiting and advance in the first pass after the hold is lifted.
- The first pass after deploy also cleans up the records left behind earlier; the pass is idempotent.

## changelog-ru

### Зависшие отложенные побудки продвигаются или закрываются (1.6.6)

- Периодический проход гасит отложенные побудки закрытых (done/cancelled) задач, у которых замок свободен.
- Тот же проход отдаёт очередь открытой задачи со свободным замком обычному drain при освобождении: в том числе побудки без id комментариев и побудки, поставленные после подтверждённой остановки оператором.
- Задачи под действующей защитой «не повторять» ждут, как и раньше, и продвигаются в первом проходе после снятия защиты.
- Первый проход после выката заодно чистит накопленные записи; проход идемпотентен.
