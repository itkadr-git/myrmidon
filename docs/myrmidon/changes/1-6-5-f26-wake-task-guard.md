---
divergence-section: Трек 5 — эксплуатация
settings-section: Track 5 — operations
---

## changelog-en

### Automatic wakes without a task are closed before the model; stale tasks cool down (1.6.5 F-26 T5)

- A swarm wake (`swarm_matched`, `idle_pickup`, `issue_assigned`,
  `swarm_claim_queue`) that names no existing task — no issue id in the wake
  context or an issue that no longer exists — no longer starts a model run.
  It is recorded as skipped at the moment the wake is queued, before any
  adapter exists, so it costs zero tokens; each such closure lands in the
  activity journal as `heartbeat.wake_skipped_taskless` with the gate reason
  (`no_task` / `task_missing`). Manual wakes, chat and every other wake
  source are untouched: a manual wake of a user always passes, even for a
  deleted task.
- A task that produces no movement stops being woken in circles. When the
  last automatic run of a task ended stale — failed, timed out,
  `blocked`/`needs_followup`, or succeeded without advancing a `todo` task —
  and the task did not move since (a comment, or a status / assignee /
  description change; the row's `updatedAt` is not a signal, a finished run
  bumps it itself), the task
  cools down for `cooldownBaseMin · 2^(n-1)` minutes (base 30, capped at
  24 h), where n is the number of consecutive stale runs since the last movement.
  Any comment on the task or any real task update lifts the window immediately; when it expires the
  task becomes a wake candidate again. Idle pickup obeys the window, and the
  new read-only `GET /api/myrmidon/companies/:id/swarm/cooling` lists every
  cooling task with its trigger, window length and next allowed wake time.
- Both knobs live in instance general settings under `general.swarm`
  (`runWithoutTaskGate`, `cooldownBaseMin`, `cooldownCeilingHours`); absent
  settings mean the defaults above, and a malformed block degrades to
  defaults rather than breaking the wake path.

## changelog-ru

### Побудки автоматики без задачи закрываются до модели; задача без движения остывает (1.6.5 F-26 T5)

- Побудка роя (`swarm_matched`, `idle_pickup`, `issue_assigned`,
  `swarm_claim_queue`), в которой нет ссылки на существующую задачу — ни id
  задачи в контексте побудки, либо задача уже не существует, — больше не
  запускает модель. Она закрывается как skipped в момент постановки побудки в
  очередь, до создания адаптера, и стоит 0 токенов; каждый такой случай
  попадает в журнал активности как `heartbeat.wake_skipped_taskless` с
  причиной гейта (`no_task` / `task_missing`). Ручные побудки, чат и прочие
  источники побудок не затронуты: ручная побудка пользователя проходит
  всегда, даже по удалённой задаче.
- Задача, по которой нет движения, перестаёт будиться по кругу. Если
  последний автоматический прогон задачи завершился «стыло» — failed,
  timed_out, `blocked`/`needs_followup` или succeeded без
  продвижения задачи в `todo`, — и с тех пор задача не двигалась (комментарий, смена статуса, исполнителя
  или описания; `updatedAt` строки не сигнал — завершившийся прогон сам его
  обновляет), задача остывает `cooldownBaseMin · 2^(n-1)` минут
  (база 30, потолок 24 ч), где n — число подряд идущих стылых прогонов после последнего движения.
  Любой комментарий по задаче или реальное её изменение снимает окно сразу;
  после истечения окна задача снова становится кандидатом на побудку. Остывание
  учитывается в idle pickup, а новый read-only эндпоинт
  `GET /api/myrmidon/companies/:id/swarm/cooling` показывает все остывающие
  задачи с причиной, длиной окна и временем следующего захода.
- Обе настройки лежат в общих настройках инстанса в блоке `general.swarm`
  (`runWithoutTaskGate`, `cooldownBaseMin`, `cooldownCeilingHours`); отсутствие
  блока означает умолчания выше, а испорченный блок превращается в умолчания,
  а не ломает путь побудки.

## divergence

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.5-F26-T5 | Гейт «прогон только с задачей» + экспоненциальное остывание. Наш модуль `server/src/myrmidon/wake-task-guard.ts` (чистые вердикты `isTasklessAutomaticWake`/`tasklessGateReason`, `isIssueCoolingDown`, `readSwarmSettings`, read-model `listCoolingIssues`) и наш файл настроек `packages/shared/src/myrmidon-swarm-wake.ts` (схема `general.swarm`, резолвер с умолчаниями, `swarmCoolingPeriodMs`). В вендоре помечены `myrmidon(1.6.5 F-26 T5)`: `server/src/services/heartbeat.ts` (в `enqueueWakeup`, после резолва issueId и до любой постановки run/wakeup-request — проверка гейта, закрывающая побудку `return null` с записью журнала; ручные побудки и чаты выше по потоку не затронуты), `server/src/myrmidon/idle-pickup.ts` (цикл `idlePickupForAgent`: кандидаты в остывании пропускаются через тот же `isIssueCoolingDown`), `packages/shared/src/validators/instance.ts` и `packages/shared/src/types/instance.ts` (поле `swarm`), `packages/shared/src/index.ts` (реэкспорт), `server/src/app.ts` + наш `server/src/myrmidon/wake-task-guard-routes.ts` (GET-эндпоинт остывания) | Критерий F-26: прогоны без задачи и повторные побудки blocked-задач жгли ~230 М входных токенов в сутки; цель — 0 прогонов автоматики без `context_issue_id` и ≤1 стылого прогона на задачу в час | `server/src/myrmidon/wake-task-guard.myrmidon.test.ts`: четыре blocked-причины без issueId → гейт; ручная побудка → проходит; два стылых прогона → 60-мин окно (base 30, экспонента); комментарий снимает остывание; succeeded без advanced по todo-задаче остывает, advanced — нет; окно истекло — не остывает; шов heartbeat: автоматическая побудка `swarm_matched` без issueId → `wakeup` вернул null, ни одного run, адаптер не вызван | Никогда, наше поведение. Снятие: удалить `wake-task-guard.ts`, `wake-task-guard-routes.ts`, `myrmidon-swarm-wake.ts`, маркеры `myrmidon(1.6.5 F-26 T5)` в heartbeat/idle-pickup/shared/app и тест | (этот PR) |

## settings-en

| `general.swarm.runWithoutTaskGate` | 1.6.5-F26-T5 | `true` | Gate automatic swarm wakes that name no existing task: the run closes skipped before the adapter (0 tokens). | Set `false` in instance general settings `swarm` block to disable the gate. |
| `general.swarm.cooldownBaseMin` | 1.6.5-F26-T5 | `30` | Base of the exponential cooling of a stale wake candidate, minutes (`base · 2^(n-1)`). | Raise to 1 or disable cooling by settings edit; not needed — gate is independent. |
| `general.swarm.cooldownCeilingHours` | 1.6.5-F26-T5 | `24` | Ceiling of one cooling period, hours. | Same as above. |

## settings-ru

| `general.swarm.runWithoutTaskGate` | 1.6.5-F26-T5 | `true` | Гейт автоматических побудок роя без существующей задачи: прогон закрывается skipped до адаптера (0 токенов). | Поставить `false` в блоке `swarm` общих настроек инстанса. |
| `general.swarm.cooldownBaseMin` | 1.6.5-F26-T5 | `30` | База экспоненциального остывания стылого кандидата побудки, минут (`база · 2^(n-1)`). | Изменить в блоке `swarm`; гейт с остыванием независимы. |
| `general.swarm.cooldownCeilingHours` | 1.6.5-F26-T5 | `24` | Потолок одного окна остывания, часов. | То же. |
