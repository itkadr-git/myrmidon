# 1.6.6 — REPLAY-BLOCK-TRIAGE: locked tasks stop piling up silently

## changelog-en

### A reassignment clears the settled replay hold; locked tasks surface in the attention feed

- A task whose stopped run left a settled "do not replay" hold
  (`issue_recovery_actions.evidence.automaticRecovery.replay = "blocked"`) used
  to stay locked when it was handed to another executor: the resolve API refused
  with "the recovery source or task owner changed", the new assignee never woke,
  and the backlog grew to 160 locked tasks nobody triaged (OPE-6329).
- Now ANY executor change on a locked task — a board user or an agent, via the
  `assigneeAgentId`/`assigneeUserId` patch of `PATCH /api/issues/:id` — clears
  the hold (the hold belongs to the previous executor's run), records the clear
  in the task's activity with the reassignment note, and wakes the new assignee
  through the standard assignment-wakeup path (`server/src/routes/issues.ts`,
  `server/src/myrmidon/settled-holds/human-unblock.ts`).
- The attention feed gains a `replay_locked` source (`server/src/services/
  attention.ts`, `server/src/myrmidon/replay-blocked/attention.ts`): one card
  per non-closed task whose newest effective blocker is a settled no-replay
  hold, naming the responsible — the assignee's manager (`agents.reportsTo`),
  else the board operator (`companies.defaultResponsibleUserId`) — with the hold
  age and a 24h triage deadline. The dedup key carries the UTC day: a dismissal
  silences the card for that day only and it re-surfaces daily until the hold is
  actually triaged (Restore / Done / Cancel / cleared hold remove it).
- Tests: `human-unblock.myrmidon.test.ts` (agent + board reassignment clears
  and wakes, a non-reassignment edit does not), `replay-locked-attention.
  myrmidon.test.ts` (card appears with the named responsible, re-surfaces the
  next day, disappears on Restore/Done/Cancel/cleared hold, unassigned task
  falls back to the board operator).

## changelog-ru

### Переназначение снимает блокировку повтора; запертые задачи видны в ленте внимания

- Задача, у которой остановленный прогон оставил осевшую блокировку
  «не повторять» (`issue_recovery_actions.evidence.automaticRecovery.replay =
  "blocked"`), раньше оставалась запертой при передаче другому исполнителю:
  resolve-API отвечал «источник восстановления или владелец задачи изменился»,
  новый исполнитель не просыпался, и список молча вырос до 160 разборов
  неприкаянных задач (OPE-6329).
- Теперь любая смена исполнителя запертой задачи — человеком с доски или
  агентом через патч `assigneeAgentId`/`assigneeUserId` в
  `PATCH /api/issues/:id` — снимает блокировку (она относится к прогону
  прежнего исполнителя), оставляет запись о снятии в активности задачи и будит
  нового исполнителя обычным путём побудки по назначению
  (`server/src/routes/issues.ts`, `server/src/myrmidon/settled-holds/
  human-unblock.ts`).
- В ленте внимания появился источник `replay_locked`
  (`server/src/services/attention.ts`,
  `server/src/myrmidon/replay-blocked/attention.ts`): одна карточка на каждую
  незакрытую задачу, у которой свежий значимый блокер — осевшая блокировка
  повтора; карточка называет ответственного — руководитель исполнителя
  (`agents.reportsTo`), иначе оператор доски
  (`companies.defaultResponsibleUserId`) — с возрастом блокировки и суточным
  сроком разбора. Ключ дедупа несёт UTC-сутки: «скрыть» заглушает карточку
  только на день, и она возвращается на следующие сутки, пока блокировку не
  разобрали (Restore / Done / Cancel / снятая блокировка убирают её).
- Тесты: `human-unblock.myrmidon.test.ts` (переназначение агентом и человеком
  снимает блокировку и будит; правка без смены исполнителя — нет),
  `replay-locked-attention.myrmidon.test.ts` (карточка появляется с названным
  ответственным, возвращается на следующий день, исчезает после
  Restore/Done/Cancel/снятия, задача без исполнителя — ответственен оператор
  доски).
