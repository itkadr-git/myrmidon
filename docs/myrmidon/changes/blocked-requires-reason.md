---
divergence-section: Трек 1 — платформа
---

## changelog-en

### A task can no longer enter `blocked` without a reason (422 `blocked_requires_reason`)

- The issue service update, the single point every status change passes through, refuses a
  transition into `blocked` unless, after the change, the task has an open blocker, a
  `blockerMetadata.blockReason`, or an `unblockDescriptor` with an owner and an action. The
  answer is 422 with `details.code = blocked_requires_reason`. Agents, the board and the system
  paths obey the same rule. Already blocked tasks are not re-validated.
- System paths that block a task with no open blocker now name the reason (a recovery liveness
  descriptor): the stranded-assigned recovery disposition and the raw native failure projection.
- When the last open blocker closes (`done`) and nothing else holds the dependent (no
  `blockReason`, no descriptor, an executor exists), it returns to `todo` in the same
  transaction; the existing dependency wake-up runs after commit.
- A `cancelled` blocker now counts as resolved everywhere, the same as `done` (ADM decision 24.10): one
  source of truth `isBlockerResolved` / `blockerOpenSql` / `blockerOpenCondition` in
  `server/src/myrmidon/blocker-resolved.ts` serves dependency readiness, swarm-claim queue and matcher, idle pickup,
  plugin wake checks, blocker attention and the liveness check for non-blocked sources. Idle pickup therefore
  wakes tasks whose only blockers are cancelled; the workspace sync-back barrier still applies to `done` blockers only.
- `scripts/myrmidon/unblock-reasonless.mjs` returns the existing reasonless blocked tasks to
  `todo` for their executor (dry-run by default, `--apply`, snapshot first, batches of 10, no wake-ups).

## changelog-ru

### Задача больше не может перейти в `blocked` без причины (422 `blocked_requires_reason`)

- Сервис обновления задачи, единая точка любой смены статуса, отказывает в переходе в `blocked`,
  если после изменения у задачи нет открытого блокера, `blockerMetadata.blockReason` или
  `unblockDescriptor` с владельцем и действием. Ответ 422, `details.code = blocked_requires_reason`.
  Правило одно для агентов, доски и системных путей. Уже заблокированные задачи не перепроверяются.
- Системные пути, блокирующие задачу без открытого блокера, теперь называют причину (дескриптор
  recovery): ветка recovery для застрявшей назначенной задачи и прямая проекция сбоя native-прогона.
- Когда закрывается последний открытый блокер (`done`) и больше ничто не держит зависимую
  задачу (нет `blockReason`, нет дескриптора, есть исполнитель), она в той же транзакции
  возвращается в `todo`; штатная побудка по зависимости срабатывает после коммита.
- Блокер в статусе `cancelled` теперь считается решённым везде, как `done` (решение ADM 24.10): одна
  точка истины `isBlockerResolved` / `blockerOpenSql` / `blockerOpenCondition` в
  `server/src/myrmidon/blocker-resolved.ts` обслуживает готовность зависимостей, очередь и matcher swarm-claim,
  idle pickup, проверки побудки плагинов, blocker attention и проверку liveness для не-blocked задач. Поэтому
  idle pickup будит задачи, у которых блокеры только отменённые; барьер sync-back рабочего пространства по-прежнему действует только для `done`.
- `scripts/myrmidon/unblock-reasonless.mjs` возвращает уже существующие заблокированные задачи
  без причины в `todo` исполнителю (по умолчанию dry-run, `--apply`, сначала снимок, батчи по 10,
  без побудок).

## divergence

| BLOCKED-REASON | Запрет `blocked` без причины в сервисе обновления задачи (422 `blocked_requires_reason`); дескрипторы причин в recovery-путях; возврат в `todo` при закрытии последнего блокера | `server/src/services/issues.ts`, `server/src/services/recovery/service.ts`, `server/src/services/execution-recovery-resolution.ts` | На бою 277 из 538 blocked-задач без блокера и причины | `server/src/myrmidon/blocked-reason-guard.myrmidon.test.ts` | Убрать вызов `assertBlockedHasReason` и `returnReasonlessDependentsToTodo` в `update` | (этот PR) |
