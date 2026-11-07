---
divergence-section: Трек 2 — ядро побудок и прогонов
---

## changelog-en

### Continuation wakes only for actionable assigned issues, with a real attempt cap (OPE-11948)

- An automatic `issue_continuation_needed` wake is now admitted only for an issue in `todo` or `in_progress` that is assigned to the woken agent. Issues in `backlog`, `blocked`, `in_review`, `done` and `cancelled`, and issues assigned to someone else, get no continuation wake. A continuation that is already queued is cancelled at dispatch when the issue is no longer `todo` or `in_progress`.
- The continuation loop is now bounded by a real counter. It counts the succeeded continuation runs of one agent on one issue since the latest external input. External input is a comment or a movement by a user or by a different agent, a resolved blocker, a PR or CI sync event. The agent's own comments and updates and system bookkeeping no longer reset it. After 3 such runs no further continuation is enqueued, and the issue is moved to `blocked` with a system comment until an external event arrives.
- Before the change, the agent's own activity counted as progress and kept `continuation_attempt` at 0, so neither the attempt limit nor the rewake throttle stopped the loop: in one day about 22% of engineer wakes were continuation wakes for parked issues.

## changelog-ru

### Продолжения только для рабочих задач своего исполнителя и настоящий предел попыток (OPE-11948)

- Автоматическая побудка `issue_continuation_needed` теперь допускается только для задачи в статусе `todo` или `in_progress`, назначенной на пробуждаемого агента. Для `backlog`, `blocked`, `in_review`, `done`, `cancelled` и для задач, назначенных на другого, продолжение не создаётся. Уже стоящее в очереди продолжение отменяется при запуске, если задача больше не `todo` и не `in_progress`.
- Цикл продолжений ограничен настоящим счётчиком: он считает успешные прогоны-продолжения одного агента на одной задаче после последнего внешнего события. Внешнее событие — комментарий или движение от пользователя или другого агента, снятый блокер, событие синхронизации PR или CI. Собственные комментарии и правки агента и служебные записи системы счётчик больше не сбрасывают. После 3 таких прогонов новое продолжение не ставится, задача переводится в `blocked` с системным комментарием до внешнего события.
- До правки собственная активность агента считалась прогрессом и держала `continuation_attempt` на нуле, поэтому ни предел попыток, ни ограничитель повторных побудок не останавливали цикл: за сутки около 22% побудок инженеров были продолжениями для припаркованных задач.

## divergence

| CONTINUATION-CAP | Автоматическая побудка `issue_continuation_needed` (источник `automation`, исполнитель-система) допускается только для задачи `todo`/`in_progress`, назначенной на пробуждаемого агента: иначе заявка закрывается как `skipped` (`issue_state_guard_mismatch`, `continuationSkipped: issue_not_actionable`). Настоящий счётчик: успешные прогоны-продолжения агента на задаче после последнего внешнего события (комментарий или движение пользователя или другого агента, снятый блокер, синхронизация PR или CI; собственная активность агента и системные записи не в счёт); на третьем подряд новая побудка закрывается как `skipped` (`issue_rewake_throttled`, `continuationSkipped: continuation_cap_reached`), а задача после коммита переводится в `blocked` (`human_decision`) с системным комментарием. В очереди запуска автоматическое продолжение отменяется (`issue_not_in_progress`), если задача уже не `todo`/`in_progress` | `server/src/services/heartbeat.ts` (блок допуска продолжений в `enqueueWakeupInner`, `applyContinuationCapStop`), `server/src/modules/run-dispatch/domain/policy.ts`, `server/src/modules/run-dispatch/adapters/postgres.ts` + `server/src/myrmidon/continuation-cap.ts`, `server/src/myrmidon/wake-task-guard.ts` (экспорт списков движения) | Прод 06.11: около 22% побудок инженеров, около 500 в сутки, были продолжениями для задач в `backlog`/`blocked` каждые 1-9 минут. Собственные комментарии и правки агента считались прогрессом (`liveness_state=advanced`), `continuation_attempt` оставался 0, и ни предел попыток, ни `ISSUE_REWAKE_FREEZE_THRESHOLD` цикл не останавливали | `server/src/__tests__/heartbeat-continuation-cap.test.ts`, `server/src/myrmidon/continuation-cap.test.ts`, `server/src/modules/run-dispatch/domain/policy.myrmidon.test.ts` | Удалить куски `myrmidon(OPE-11948)` в heartbeat.ts, политике и адаптере запуска, модуль и тесты | (этот PR) |
