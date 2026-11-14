## changelog-en

### A content-filter retry is counted per model call and no longer uses up the turn's restart budget (CONTENT-FILTER-RETRY-PER-CALL, OPE-13076)

- The retry after a provider reply with `finish_reason: content_filter` now has its own counter for each model call (at most 2 per call) and no longer consumes the turn's shared `restart_count` (limit `api_max_retries`). Before, the retries competed with other restart reasons, so a turn with several filtered calls could end early. A bot with a fallback model chain still switches to the fallback first.

## changelog-ru

### Повтор после фильтра содержимого считается на вызов модели и не расходует запас перезапусков хода (CONTENT-FILTER-RETRY-PER-CALL, OPE-13076)

- Повтор после ответа провайдера с `finish_reason: content_filter` теперь имеет свой счётчик на каждый вызов модели (не больше 2 на вызов) и не расходует общий `restart_count` хода (предел `api_max_retries`). Раньше повторы конкурировали с другими причинами перезапуска, и ход с несколькими отфильтрованными вызовами мог закончиться раньше времени. Бот с цепочкой резервных моделей по-прежнему сначала переходит на резерв.
