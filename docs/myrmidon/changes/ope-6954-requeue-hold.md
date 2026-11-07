---
---

## changelog-en

### A task the dispatcher returns to the queue keeps its status (REQUEUE-HOLD)

- A task whose stopped run gets reconciled no longer loses the status the
  dispatcher set: `settleUnrecoverableExecutions` projected the failed run onto
  `blocked` even when the board had already moved the task back to `todo`, so
  the queue refill was silently reverted within minutes while `blockedBy`
  stayed empty and no run existed for the task.
- The reconciliation now keeps the ready-queue status (`todo`/`backlog`),
  records the same settled hold (`evidence.automaticRecovery.replay =
  "blocked"`, so nothing is replayed and wake admission is unchanged) and
  clears the dead run's pointers.
- Tasks being worked on (`in_progress`, `in_review`, …) keep the previous
  behaviour and still project to `blocked`; the Agent Chat branch is untouched.
- The settled hold is released exactly where it was released before — an
  explicitly authorized wake (L2) or a board person — and a board person now
  releases it by moving the held task into a working status from any other
  status (`blocked -> todo` is no longer the only move that counts).

## changelog-ru

### Задача, которую диспетчер вернул в очередь, сохраняет свой статус (REQUEUE-HOLD)

- Задача, разбор остановившегося прогона которой закрывает восстановление,
  больше не теряет статус, выставленный диспетчером: `settleUnrecoverableExecutions`
  проецировал отказ прогона на `blocked` даже тогда, когда доска уже вернула
  задачу в `todo`, из-за чего наполнение очереди молча откатывалось через
  несколько минут, `blockedBy` оставался пустым, а прогона по задаче не было.
- Восстановление теперь сохраняет статус очереди (`todo`/`backlog`), пишет то
  же закрытое удержание (`evidence.automaticRecovery.replay = "blocked"` —
  ничего не повторяется, допуск побудок не меняется) и снимает только указатели
  мёртвого прогона.
- Задачи в работе (`in_progress`, `in_review` и т. п.) сохраняют прежнее
  поведение и по-прежнему проецируются в `blocked`; ветка задач Agent Chat не
  тронута.
- Снятие закрытого удержания — там же, где было: явно авторизованная побудка
  (L2) или человек на доске; теперь человек снимает удержание и переводом
  удержанной задачи в рабочий статус из любого другого статуса (единственным
  подходящим ходом `blocked -> todo` дело больше не ограничивается).

## divergence-new

<!-- after: CHAT-HOLD: чаты не держатся, сообщение владельца будит, очередь не молчит -->

### REQUEUE-HOLD: задача, возвращённая актором в очередь после отказа прогона, сохраняет свой статус

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| REQUEUE-HOLD | Задача, которую актор вернул в очередь (`todo`/`backlog`) после отказа прогона, сохраняет этот статус: `settleUnrecoverableExecutions` не переводит её в `blocked`, а закрывает разбор как `outcome = "cancelled"`, записав то же закрытое удержание `evidence.automaticRecovery.replay = "blocked"` (ничего не повторяется, допуск побудок не меняется) и сняв только указатели мёртвого прогона; текст резолюции — почему задача не в работе. Обычные задачи (`in_progress`, `in_review` и т. п.) — вендорское поведение (`blocked`), ветка Agent Chat (CHAT-HOLD) не тронута. Снятие удержания — где и было: явно авторизованная побудка (L2) или человек на доске; к HOLD-READY добавлено, что человек переводит удержанную задачу в рабочий статус и из любого другого статуса (часть 1 правила теперь принимает и `statusChangeRequested` PATCH-а) | Вендор помечен `myrmidon(OPE-6954)`: `server/src/services/execution-recovery-resolution.ts` (импорт, флаг `requeued`, ветка записи, `outcome`, текст резолюции), `server/src/routes/issues.ts` (поле `statusChangeRequested` в точке вызова `mayBeHumanUnblock`); наши файлы: `server/src/myrmidon/settled-holds/requeued.ts`, `server/src/myrmidon/settled-holds/human-unblock.ts` (расширение правила HOLD-READY) | Инцидент OPE-6324 (10.10.2026): лид дважды вернул застрявшую задачу в `todo`, и оба раза через 1,5–3 минуты её молча вернуло в `blocked` (`execution-recovery`, 22:10:13 и 23:05:20 UTC) — `blockedBy` пуст, прогона нет, `executionRunId`/`checkoutRunId` пусты. Закрытый разбор проецировал отказ прогона на статус, выбранный актором уже после отказа: раздачу очереди нельзя было вернуть в работу (вахта наполнения теряла задачи) | `server/src/myrmidon/settled-holds/requeued.myrmidon.test.ts` (воспроизведение OPE-6324: `todo` остаётся `todo`, удержание записано, задача не «готова», `backlog` тоже, `in_progress` идёт вендорским путём), `server/src/myrmidon/settled-holds/human-unblock.myrmidon.test.ts` (человек, переводящий удержанную задачу из `todo` в работу, снимает удержание и будит исполнителя; чистые случаи правила) | Когда вендор перестанет проецировать отказ прогона на статус, выставленный после отказа, — убрать куски `myrmidon(OPE-6954)`, модуль `requeued.ts` и его тесты | OPE-6954 |