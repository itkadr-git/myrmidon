## changelog-en

### The review liveness wake no longer re-wakes a reviewer who cannot do anything (OPE-13149)

- On 14.11 (candidate 1.6.9-rc.5) 86 of 164 agent runs in one hour were empty (52%); one reviewer alone made 30 runs in 70 minutes.
  The source was the periodic review routing pass (`myrmidon_review_wakeup_retry`, wake reason `execution_review_requested`): it woke the
  reviewer of every stale pending review on a 10-minute backoff, with no look at the pull request. The reviewer found the head's CI
  still running ("CI result for the current pull request head is not complete", REQUEST CHANGES refused with HTTP 422) and did nothing.
- The pass now reads the CI result of the head with the board's own reader and does not wake the reviewer while it is not complete; the
  `ci_completed` event wakes the reviewer when the result arrives. A task that is no longer `in_review` (returned to the implementer) is
  never woken. The same (task, reviewer, stage, head, CI state) is woken once by the pass; a moved head, a new stage, a changed CI state or
  a cancelled run (failed dispatch) wakes again. An unreadable CI does not hold the wake.

## changelog-ru

### Периодический будильник проверки больше не будит ревьюера, которому нечего делать (OPE-13149)

- 14.11 (кандидат 1.6.9-rc.5) 86 из 164 прогонов агентов за час были пустыми (52%); один ревьюер сделал 30 прогонов за 70 минут.
  Источник — периодический проход маршрутизации проверок (`myrmidon_review_wakeup_retry`, причина `execution_review_requested`): он будил
  ревьюера каждой застоявшейся проверки с шагом 10 минут, не глядя на пулреквест. Ревьюер видел, что CI головы ещё идёт
  («CI result for the current pull request head is not complete», REQUEST CHANGES отклонён с HTTP 422), и ничего не делал.
- Проход теперь читает результат CI головы штатным читателем доски и не будит ревьюера, пока результат не готов; когда он пришёл, ревьюера
  будит событие `ci_completed`. Задачу, которая уже не в `in_review` (возвращена исполнителю), не будит никогда. Одну и ту же связку
  (задача, ревьюер, этап, голова, состояние CI) проход будит один раз; сдвиг головы, новый этап, смена состояния CI или отменённый
  прогон (сорванная доставка) будят снова. Нечитаемый CI будильник не удерживает.
