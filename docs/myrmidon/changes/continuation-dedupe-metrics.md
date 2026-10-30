## changelog-en

### Continuation dedupe counters are exposed on the metrics scrape

- The `/metrics` endpoint exposes `myrmidon_continuation_created_total` for continuation keys claimed
  for the first time and `myrmidon_continuation_deduped_total` for claims suppressed because their
  key was already claimed.
- These counters are process-local and reset when a process restarts. Each sample
  carries the existing `role` label.
- Continuation keys are not metric labels. The scrape exposes no key values or
  per-key series. This avoids unbounded cardinality and identifier disclosure.
- The `metrics-scrape-failing` runbook documents how to interpret the counters.

## changelog-ru

### Счётчики дедупликации continuation доступны в скрейпе метрик

- Эндпоинт `/metrics` публикует `myrmidon_continuation_created_total` для continuation keys,
  впервые принятых claim-путём, и `myrmidon_continuation_deduped_total` для повторных claims уже
  принятого ключа, подавленных дедупликацией.
- Счётчики локальны для процесса и обнуляются при его перезапуске. Каждый sample
  содержит существующую метку `role`.
- Continuation keys не являются метками метрик. Скрейп не публикует значения
  ключей или отдельные ряды на каждый ключ; это предотвращает неограниченную
  кардинальность и раскрытие идентификаторов.
- Runbook `metrics-scrape-failing` описывает интерпретацию счётчиков.
