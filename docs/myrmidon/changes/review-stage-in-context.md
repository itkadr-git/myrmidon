## changelog-en

### The review stage participant sees the stage in the task context whatever woke the run (REVIEW-STAGE-IN-CONTEXT)

- On 13-14.11 (candidate 1.6.9-rc.2) reviewers woken by CI, an idle pickup or an operator answered "executionStage=null, there
  is no active participant" and refused to record the decision, although the stage was pending and they were its participant
  (OPE-12886, OPE-12906, OPE-12941). `executionStage` was built only for the wakes of the stage itself
  (`execution_review_requested` and similar); `GET /api/issues/:id/heartbeat-context` carried no stage at all.
- The response now has a top-level `executionStage`, built by the same function as the stage wake context: stage id and type,
  state, current participant, return assignee, last decision, allowed actions, plus `isCurrentParticipant` and a one-line
  `youAre`. The current participant gets `wakeRole: "reviewer"` (`"approver"`) and the actions `approve` / `request_changes`;
  the executor of a returned stage gets `"executor"`; any other caller gets `wakeRole: "observer"`, no actions and the text
  "You are not a participant of the review stage". The field is `null` only when no stage is in flight.

## changelog-ru

### Участник стадии ревью видит стадию в контексте задачи при любой причине побудки (REVIEW-STAGE-IN-CONTEXT)

- 13-14.11 (кандидат 1.6.9-rc.2) ревьюеры, разбуженные по CI, подбором простаивающих или оператором, отвечали
  «executionStage=null, активного участника нет» и не записывали решение, хотя стадия была `pending`, а они были её
  участниками (OPE-12886, OPE-12906, OPE-12941). `executionStage` строился только для побудок самой стадии
  (`execution_review_requested` и подобные); `GET /api/issues/:id/heartbeat-context` стадии не содержал совсем.
- В ответе теперь есть верхнее поле `executionStage`, собранное той же функцией, что и контекст побудки стадии: id и тип
  стадии, состояние, текущий участник, кому вернуть, последнее решение, допустимые действия, плюс `isCurrentParticipant` и
  строка `youAre`. Текущий участник получает `wakeRole: "reviewer"` (`"approver"`) и действия `approve` /
  `request_changes`; исполнитель возвращённой стадии — `"executor"`; любой другой вызывающий — `wakeRole: "observer"`,
  без действий и с текстом «You are not a participant of the review stage». `null` — только когда стадии в работе нет.
