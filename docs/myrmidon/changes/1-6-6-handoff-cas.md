---
divergence-section: 1.6.6 — UPSTREAM-HANDOFF (часть A): CAS-передача задачи по владельцу и версии
---

## changelog-en

### Guarded agent-to-agent task handoff on the general PATCH path (1.6.6 UPSTREAM-HANDOFF, part A)

- `PATCH /api/issues/{id}` accepts optional `expectedAssigneeAgentId` (nullable)
  and `expectedStatusVersion`. When both are present and the update changes the
  assignee, the handoff runs as compare-and-set, following vendor
  paperclipai/paperclip#13686: the expectations are checked first without a lock
  and again under `SELECT ... FOR UPDATE` inside the commit transaction; any
  owner, version or user-assignment mismatch answers
  `409 issue_reassignment_conflict` and the row is left untouched. Requests
  without the fields keep the previous behavior.
- A guarded handoff stops the previous owner's live run through the existing
  ownership-change stop (`stopRunnerGoalForOwnershipChange` +
  `heartbeat.cancelRun`, confirmed stop), then commits in one transaction: a
  re-read under `FOR UPDATE`, the CAS and stopped-run fences (executionRunId
  unchanged, no running/queued/scheduled_retry run — otherwise
  `409 reassignment_stop_unconfirmed`), the new owner, `statusVersion + 1`, the
  `in_progress → todo` demote, and an `issue.reassigned` activity receipt
  (`commandId`, `disposition applied/duplicate/conflict/rollback`,
  `stateRevision`, `scheduledWakeKeys`). The response carries the applied
  receipt.
- Handoff idempotency: an optional `handoffIdempotencyKey` is checked against
  the activity journal (action + commandId + sha256 fingerprint of the inputs,
  no new index or migration). A replay with the same fingerprint returns the
  stored `duplicate` receipt without mutating; the same key with a different
  fingerprint answers `409 idempotency_conflict`.
- Guarded rollback: when the commit phase fails after the previous owner's run
  was already stopped under confirmation, the previous owner receives a
  restore wake (issue-state guard: statuses todo/in_progress, previous owner,
  previous version; executionRunId in the snapshot), the failure is recorded as
  a `rollback` receipt, and restore errors are aggregated into the receipt and
  logged — never swallowed. The new owner's wake carries a deterministic
  idempotency key and the part-B statusVersion guard, so a lost delivery cannot
  enqueue the wake twice and a stale delivery cannot start a turn.
- Forbidden handoff states match the vendor: `in_review`, `done`, `cancelled`,
  conversation issues and issues with a pending execution stage refuse a
  guarded reassignment with 409.
- `reason` (optional) records the handoff cause both in the receipt and as a
  thread comment. Every disposition — applied, duplicate, conflict, rollback —
  lands in the activity journal, which feeds the weekly handoff counter.

## changelog-ru

### Защищённая передача задачи между агентами на общем PATCH-пути (1.6.6 UPSTREAM-HANDOFF, часть A)

- `PATCH /api/issues/{id}` принимает необязательные `expectedAssigneeAgentId`
  (допускает null) и `expectedStatusVersion`. При обоих полях и смене
  исполнителя передача идёт как compare-and-set по образцу вендорского
  paperclipai/paperclip#13686: ожидания сверяются сначала без замка, затем
  повторно под `SELECT ... FOR UPDATE` в транзакции коммита; любое
  рассогласование владельца, версии или пользовательского назначения отвечает
  `409 issue_reassignment_conflict` и строку не трогает. Запросы без полей
  работают как раньше.
- Guard-передача останавливает живой ход прежнего владельца существующим
  стопом при смене владельца (`stopRunnerGoalForOwnershipChange` +
  `heartbeat.cancelRun`, подтверждённый стоп) и коммитит одной транзакцией:
  перечитывание под `FOR UPDATE`, заборы CAS и остановленного хода (runId не
  сменился, нет running/queued/scheduled_retry — иначе
  `409 reassignment_stop_unconfirmed`), новый владелец, `statusVersion + 1`,
  понижение `in_progress → todo` и квитанция `issue.reassigned` в журнале
  активностей (`commandId`, `disposition applied/duplicate/conflict/rollback`,
  `stateRevision`, `scheduledWakeKeys`). Применённая квитанция приходит в
  ответе.
- Идемпотентность передачи: необязательный `handoffIdempotencyKey` сверяется с
  журналом активностей (действие + commandId + sha256-отпечаток входов, без
  новых индексов и миграций). Повтор с тем же отпечатком возвращает хранимую
  квитанцию `duplicate` без мутации; тот же ключ с другим отпечатком даёт
  `409 idempotency_conflict`.
- Защищённый откат: если фаза коммита упала после подтверждённой остановки хода
  прежнего владельца, прежний владелец получает побудку-восстановление (охрана
  состояния: todo/in_progress, прежний владелец, прежняя версия; executionRunId
  в снапшоте), сбой записывается квитанцией `rollback`, а ошибки восстановления
  агрегируются в квитанцию и логируются — не глотаются. Побудка нового владельца
  несёт детерминированный ключ идемпотентности и охрану по statusVersion из
  части B: потерянная доставка не поставит побудку дважды, устаревшая — не
  запустит лишний ход.
- Запрещённые состояния передачи совпадают с вендором: `in_review`, `done`,
  `cancelled`, разговорная задача и pending-стадия исполнения отказывают
  guard-передаче с 409.
- `reason` (необязательно) записывает причину передачи и в квитанцию, и
  комментарием в тред. Каждая диспозиция — applied, duplicate, conflict,
  rollback — попадает в журнал активностей, из которого считается недельный
  счётчик передач.

## divergence

| HANDOFF-CAS | Передача задачи между агентами на общем пути PATCH /api/issues/{id} — механика вендорского нативного раннера (#13686, коммит d82fbb0f, функция reassignTask): CAS по владельцу и statusVersion под SELECT ... FOR UPDATE, остановка старого хода существующим стопом смены владельца, коммит передачи одной транзакцией с перечитыванием под замком и заборами (runId не сменился, нет живого хода), квитанция issue.reassigned (commandId, disposition applied/duplicate/conflict/rollback, stateRevision, scheduledWakeKeys), идемпотентность по отпечатку sha256 в журнале активностей без новых индексов и миграций, защищённый откат побудкой прежнему владельцу по образцу restoreInterruptedWork, побудка нового владельца с ключом и охраной состояния (совместно с частью B), отказ передачи из in_review/done/cancelled/разговорной задачи/pending-стадии. Семантический инструмент раннера НЕ переносится — только серверная механика на маршрут. | `server/src/routes/issues.ts` (CAS-блоки PATCH-обработчика, стоп-флаг, транзакционный коммит, побудки, откат, квитанция в ответе), `server/src/myrmidon/handoff-cas.ts` (отпечаток, сверка CAS, перечитывание под FOR UPDATE, забор живого хода, квитанция, отказные состояния) | Вендорская передача исключает потерянные и задвоенные пересылки задачи между агентами; наш общий PATCH-путь не имел ни CAS-сверки под замком, ни квитанции, ни защищённого отката после остановленного хода | `server/src/__tests__/handoff-cas.myrmidon.test.ts` | Никогда, наше поведение | — |
