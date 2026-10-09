---
settings-section: Track 2 — wake and run core
---

## changelog-en

### A queued run always says why it waits; non-startable runs are cancelled; the operator gets a `queue_stall` card (F-09)

- `server/src/services/heartbeat.ts`: every silent exit of the queued-run sweep
  now leaves a reason on the run (`waitReason`): `scheduling_suppressed` when
  the sweep is suppressed by scheduling, `maintenance` while the agent's
  maintenance window is open, `agent_not_invokable` for an agent that is not
  invokable without being cancelled, and the last observed admission denial for
  the runs the claim phase did not admit. A run with no observed cause keeps
  `waitReason = null` on purpose: the attention card names it instead of a
  guessed reason.
- `server/src/modules/run-dispatch/domain/policy.ts`: a queued run whose task
  is in `backlog` is cancelled with the new error code
  `queued_run_issue_not_startable`; a run whose task is hidden stays queued.
- `server/src/services/attention.ts` + `server/src/myrmidon/stuck-queued/attention.ts`:
  new attention kind `queue_stall` — a queued run older than the stall
  threshold *and* without a `waitReason` raises a card whose subject is the run
  (`kind: "run"`, sourceId = run id), so several stalled runs never collapse
  into one card. The run-limit panels read the same thresholds.
- `server/src/services/decision-queues.ts`: the `queue_stall` card resolves
  through the queue decisions — "keep" leaves the run queued, "archive" files
  the card away, both keyed by the run id the card was raised for.
- `server/src/myrmidon/run-admission.ts`: admission denials are counted
  (`admissionDenials`: total, byReason, lastReason, lastAt) and exposed on the
  runtime-limits view.

## changelog-ru

### Прогон в очереди всегда называет причину ожидания; нестартуемые отменяются; оператор видит карточку `queue_stall` (F-09)

- `server/src/services/heartbeat.ts`: каждый молчаливый выход обхода очереди
  теперь оставляет на прогоне причину (`waitReason`): `scheduling_suppressed`
  при подавлении обхода планировщиком, `maintenance` при открытом окне
  обслуживания агента, `agent_not_invokable` для неинвокабельного агента,
  который не отменяется, и последний наблюдённый отказ допуска для прогонов,
  до которых не дошла фаза claim. Прогон без наблюдённой причины намеренно
  остаётся с `waitReason = null`: его называет карточка внимания, а не
  выдуманная причина.
- `server/src/modules/run-dispatch/domain/policy.ts`: прогон, чья задача ушла в
  `backlog`, отменяется с новым кодом ошибки `queued_run_issue_not_startable`;
  прогон со скрытой задачей остаётся в очереди.
- `server/src/services/attention.ts` + `server/src/myrmidon/stuck-queued/attention.ts`:
  новый вид внимания `queue_stall` — прогон, стоящий в очереди дольше порога и
  без `waitReason`, поднимает карточку с субъектом-прогоном (`kind: "run"`,
  sourceId = id прогона), поэтому несколько застрявших прогонов не сливаются в
  одну карточку. Панели лимитов прогонов читают те же пороги.
- `server/src/services/decision-queues.ts`: карточка `queue_stall` проходит
  через решения очереди — «оставить» оставляет прогон в очереди, «в архив»
  убирает карточку; ключ обоих решений — id прогона, для которого карточка
  поднята.
- `server/src/myrmidon/run-admission.ts`: отказы допуска считаются
  (`admissionDenials`: total, byReason, lastReason, lastAt) и отдаются в
  представлении runtime-limits.

## settings-en

| `MYRMIDON_QUEUED_RUN_EXPLAIN_AFTER_SEC` | 1.6.5 F-09 | `60` | Age of a still-queued run after which the sweep must leave a `waitReason` on it, so a run never waits silently. Read from the process env at sweep time; `instance_settings.general.queuedRunExplainAfterSec` overrides it and is clamped to 10…86400 s | A non-numeric, zero, negative or empty value keeps the default; off is not provided on purpose — a run without a reason is exactly the F-09 defect |
| `MYRMIDON_QUEUED_RUN_STALE_AFTER_SEC` | 1.6.5 F-09 | `3600` | Age of a queued run that has no `waitReason` after which the attention feed raises a `queue_stall` card for it. Read from the process env as the default of the attention settings; `instance_settings.general.queuedRunStaleAfterSec` overrides both and is clamped to 60…604800 s | A non-numeric, zero, negative or empty value keeps the default; the card can be switched off only by setting the instance setting to its maximum |

## settings-ru

| `MYRMIDON_QUEUED_RUN_EXPLAIN_AFTER_SEC` | 1.6.5 F-09 | `60` | Возраст всё ещё стоящего в очереди прогона, после которого обход обязан оставить на нём `waitReason`, чтобы прогон не ждал молча. Читается из окружения процесса в момент обхода; `instance_settings.general.queuedRunExplainAfterSec` перекрывает его и зажимается в 10…86400 с | Нечисловое, нулевое, отрицательное или пустое значение оставляет умолчание; выключения нет намеренно — прогон без причины и есть дефект F-09 |
| `MYRMIDON_QUEUED_RUN_STALE_AFTER_SEC` | 1.6.5 F-09 | `3600` | Возраст прогона в очереди без `waitReason`, после которого лента внимания поднимает по нему карточку `queue_stall`. Читается из окружения процесса как умолчание настроек внимания; `instance_settings.general.queuedRunStaleAfterSec` перекрывает оба и зажимается в 60…604800 с | Нечисловое, нулевое, отрицательное или пустое значение оставляет умолчание; выключить карточку можно только выставлением настройки экземпляра в максимум |