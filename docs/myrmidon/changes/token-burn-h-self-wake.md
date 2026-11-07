---
divergence-section: Трек 1 — платформа
---

## changelog-en

### An agent no longer wakes itself with its own PATCH or comment-time bookkeeping (TOKEN-BURN-H, OPE-12049)

- On 07.11 the `adm` bot spent ten empty runs an hour on itself: each run released its task, assigned it back to
  itself and got "Wake from own PATCH (issue_assigned)"; the server then echoed the run's final text as a comment after
  the run closed, and the next `swarm_matched` wake read that comment as new input from the "previous round".
- `queueIssueAssignmentWakeup` now compares the acting agent with the assignee and skips the wake
  (`self_wake_skipped`, logged, returns `null`). `PATCH /issues/:id` does the same for the two self-made task-state
  wakes (`issue_assigned` after an assignee change, `issue_status_changed` out of backlog/blocked/closed). A user, a
  system actor or another agent still wakes the assignee exactly as before; comment and mention wakes already had their
  own self guards.
- The rewake throttle (`swarm_matched`, `idle_pickup`, ...) no longer counts the woken agent's own activity as "new
  input since the last run", and no longer counts a run's own bookkeeping (task release, assignment back to itself, the
  `run_presentation_resolver` echo of the final text) as issue progress. A real comment, a status change, a hand-off to
  another agent, a document or a work product still count.

## changelog-ru

### Агент больше не будит сам себя своим PATCH и служебными записями после прогона (TOKEN-BURN-H, OPE-12049)

- 07.11 бот `adm` за час сделал десять пустых прогонов на самого себя: каждый прогон освобождал задачу, назначал её
  обратно на себя и получал «Wake от собственного PATCH (issue_assigned)»; после закрытия прогона сервер публиковал его
  итоговый текст комментарием, и следующая побудка `swarm_matched` принимала этот комментарий за новый вход «прошлого
  круга».
- `queueIssueAssignmentWakeup` теперь сравнивает действующего агента с исполнителем и пропускает побудку
  (`self_wake_skipped`, запись в журнал, возвращает `null`). `PATCH /issues/:id` делает то же для двух побудок о
  состоянии задачи, вызванных самим исполнителем (`issue_assigned` при смене исполнителя, `issue_status_changed` при выходе
  из backlog/blocked/закрытого). Пользователь, система или другой агент будят исполнителя как раньше; у побудок по
  комментарию и упоминанию свои проверки «сам себя» уже были.
- Тормоз повторных побудок (`swarm_matched`, `idle_pickup` и др.) больше не считает собственную активность
  разбуженного агента «новым входом с прошлого прогона» и не считает собственную служебную работу прогона (освобождение
  задачи, назначение обратно на себя, эхо итогового текста `run_presentation_resolver`) прогрессом по задаче. Настоящий
  комментарий, смена статуса, передача другому агенту, документ и рабочий продукт по-прежнему считаются.

## divergence

| 1.6.6-TOKEN-BURN-H | Агент не будит сам себя: пропуск побудки, если действующий агент = исполнитель (`queueIssueAssignmentWakeup`, PATCH `issue_assigned`/`issue_status_changed`); тормоз повторных побудок не считает собственную активность агента новым входом, а освобождение/назначение на себя/эхо итогового текста — прогрессом | `server/src/services/issue-assignment-wakeup.ts`, `server/src/routes/issues.ts`, `server/src/services/heartbeat.ts`, `server/src/services/issue-rewake-throttle.ts` (метка `myrmidon(1.6.6 OPE-12049)`) | Агент, меняющий свою задачу, будил себя побудкой и платил пустой прогон; служебные записи после прогона сбрасывали тормоз `swarm_matched` (07.11, бот adm: 10 пустых прогонов в час) | `server/src/services/issue-assignment-wakeup.myrmidon.test.ts`, `server/src/__tests__/issue-rewake-throttle.test.ts`, `server/src/__tests__/issue-update-comment-wakeup-routes.test.ts` | Когда вендор сам не будит исполнителя на его же изменение и не считает служебные записи прогона входом — удалить метки и тесты | (этот PR) |
