---
divergence-section: Трек 1 — платформа
---

## changelog-en

### An agent no longer wakes itself with its own PATCH or comment-time bookkeeping (TOKEN-BURN-H, OPE-12049)

- On 07.11 the `adm` bot spent ten empty runs an hour on itself: each run released its task, assigned it back to
  itself and got "Wake from own PATCH (issue_assigned)"; the server then echoed the run's final text as a comment after
  the run closed, and the next `swarm_matched` wake read that comment as new input from the "previous round".
- `PATCH /issues/:id` no longer queues the two task-state wakes (`issue_assigned` after an assignee change,
  `issue_status_changed` out of backlog/blocked/closed) when the PATCH is made by the assignee itself from its own run
  on this very task. The skip is narrow: the actor is the assignee and its authenticated run's `issueId` is this task.
  An agent working from a run on another task, a user, a system actor or another agent still wakes the assignee exactly
  as before; comment and mention wakes already had their own self guards. The shared assignment service
  (`queueIssueAssignmentWakeup`: create, child_create, accepted-plan decomposition, status cards, summary slots) does
  not skip: an agent legitimately creates tasks for itself and each needs its run.
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
- `PATCH /issues/:id` больше не ставит две побудки о состоянии задачи (`issue_assigned` при смене исполнителя,
  `issue_status_changed` при выходе из backlog/blocked/закрытого), если PATCH сделал сам исполнитель из своего прогона
  по этой же задаче. Условие узкое: актор — исполнитель, а `issueId` его аутентифицированного прогона — эта задача.
  Агент из прогона по другой задаче, пользователь, система или другой агент будят исполнителя как раньше; у побудок по
  комментарию и упоминанию свои проверки «сам себя» уже были. Общий сервис побудок (`queueIssueAssignmentWakeup`: create,
  child_create, разбиение принятого плана, карточки статуса, слоты сводок) ничего не пропускает: агент законно создаёт
  задачи на себя, и каждая требует своего прогона.
- Тормоз повторных побудок (`swarm_matched`, `idle_pickup` и др.) больше не считает собственную активность
  разбуженного агента «новым входом с прошлого прогона» и не считает собственную служебную работу прогона (освобождение
  задачи, назначение обратно на себя, эхо итогового текста `run_presentation_resolver`) прогрессом по задаче. Настоящий
  комментарий, смена статуса, передача другому агенту, документ и рабочий продукт по-прежнему считаются.

## divergence

| 1.6.6-TOKEN-BURN-H | Агент не будит сам себя: `PATCH /issues/:id` пропускает побудки `issue_assigned`/`issue_status_changed`, если PATCH сделал исполнитель из своего прогона по этой же задаче; тормоз повторных побудок не считает собственную активность агента новым входом, а освобождение/назначение на себя/эхо итогового текста — прогрессом | `server/src/routes/issues.ts`, `server/src/services/heartbeat.ts`, `server/src/services/issue-rewake-throttle.ts` (метка `myrmidon(1.6.6 OPE-12049)`) | Агент, меняющий свою задачу, будил себя побудкой и платил пустой прогон; служебные записи после прогона сбрасывали тормоз `swarm_matched` (07.11, бот adm: 10 пустых прогонов в час) | `server/src/__tests__/issue-update-comment-wakeup-routes.test.ts`, `server/src/__tests__/issue-rewake-throttle.test.ts`, `server/src/services/issue-assignment-wakeup.myrmidon.test.ts` | Когда вендор сам не будит исполнителя на его же изменение из его прогона и не считает служебные записи прогона входом — удалить метки и тесты | (этот PR) |
