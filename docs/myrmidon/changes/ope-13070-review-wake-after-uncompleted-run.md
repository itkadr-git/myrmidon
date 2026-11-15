## changelog-en

### Verify review wake liveness after reviewer run completes without verdict (OPE-13070)

When a reviewer run triggered by CI completion finishes without recording a verdict (leaving the review stage in `pending`), the review routing sweep liveness pass re-wakes the idle reviewer for this task once `REVIEW_WAKE_STALE_AFTER_MS` has elapsed since the task's last update. Subsequent passes observe `REVIEW_WAKE_RETRY_BACKOFF_MS`. Added regression coverage in `sweep.myrmidon.test.ts`.

## changelog-ru

### Проверка повторной побудки полосы живости после завершения прогона ревьюера без вердикта (OPE-13070)

Когда прогон ревьюера, разбуженного по завершению CI, завершается без вынесения вердикта (стадия ревью остаётся `pending`), полоса живости обхода маршрутизации ревью повторно будит свободного ревьюера по этой задаче после истечения `REVIEW_WAKE_STALE_AFTER_MS` с момента последнего обновления задачи. Повторные проходы полосы соблюдают задержку `REVIEW_WAKE_RETRY_BACKOFF_MS`. Добавлен регрессионный тест в `sweep.myrmidon.test.ts`.
