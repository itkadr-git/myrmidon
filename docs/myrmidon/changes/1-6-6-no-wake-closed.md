## changelog-en

### Assignment wakes are suppressed for closed issues (PLUGIN-REGISTRY 2/3)

- Ported the vendor guard from paperclipai/paperclip #13738: assigning or
  re-assigning an agent on an issue whose status is `done` or `cancelled`
  no longer queues a heartbeat wake. The check runs once, centrally, in
  `server/src/services/issue-assignment-wakeup.ts`, so every call point is
  covered at once — issue create, child create, accepted plan decomposition,
  interaction accept, status-card and summary-slot generation, chat, routine
  and secret-proposal wakes.
- `backlog` suppression stays as before; an explicit reopen transition
  (done/cancelled → todo) still wakes the assignee because the wake carries
  the issue's new status.

## changelog-ru

### Побудка по назначению подавляется для закрытых задач (PLUGIN-REGISTRY 2/3)

- Перенесён вендорский guard из paperclipai/paperclip #13738: назначение или
  переназначение агента на задаче в статусе `done` или `cancelled` больше не
  ставит побудку heartbeat. Проверка выполняется один раз, централизованно, в
  `server/src/services/issue-assignment-wakeup.ts` — покрыты все точки вызова:
  создание задачи, дочерние задачи, принятое разбиение плана, принятие
  взаимодействия, генерация статус-карт и сводных слотов, чат, рутины и
  уведомления о секрет-предложениях.
- Подавление для `backlog` осталось как раньше; явный переход reopen
  (done/cancelled → todo) по-прежнему будёт исполнителя, потому что побудка
  читает новый статус задачи.
