## changelog-en

### The review stage participant's approval is recorded whichever wake started the run (REVIEW-APPROVAL-RECORDED)

- On 14.11 (candidate 1.6.9-rc.2) the approval of a reviewer was refused with HTTP 409 (`issue_done_pull_request_gate`), the stage stayed
  `pending` or fell to `idle`, and recovery blocked the task (OPE-13059, OPE-13061). Cause: when the PATCH to `in_review` routed a
  reviewer immediately and then deferred the reviewer wake (CI wait or the per-tick wake quota), the admission monitor policy was built
  from the policy as it was before the routing, so it overwrote the stored policy with `stages: []`. The stage in the execution state
  no longer existed in the policy, the participant's `done` was not a decision and went straight to the PR gate. It did not depend on
  the wake that started the run.
- The monitor policy is now built on the policy as persisted after the update and the routing, so the routed stage survives.
- The approval of the current participant of a pending review stage is also recorded when the policy has lost the stage (or the whole
  policy): the stage completes with an approved decision, and with an open PR the task waits for the merge as usual. Tasks already
  in that state need no manual repair.

## changelog-ru

### Одобрение участника стадии ревью записывается, каким бы прогоном ни был разбужен ревьюер (REVIEW-APPROVAL-RECORDED)

- 14.11 (кандидат 1.6.9-rc.2) одобрение ревьюера отклонялось с HTTP 409 (`issue_done_pull_request_gate`), стадия оставалась `pending`
  или уходила в `idle`, а восстановление блокировало задачу (OPE-13059, OPE-13061). Причина: когда PATCH в `in_review` сразу назначал
  ревьюера, а потом откладывал его побудку (ожидание CI или квота побудок за тик), политика монитора допуска строилась из политики
  до назначения и затирала сохранённую политику значением `stages: []`. Стадия из состояния исполнения пропадала из политики, `done`
  участника не считался решением и шёл прямо на ворота PR. От того, какой побудкой запущен прогон, это не зависело.
- Политика монитора теперь строится из политики, сохранённой после обновления и назначения, и назначенная стадия не теряется.
- Одобрение текущего участника стадии `pending` записывается и тогда, когда в политике нет стадии (или нет всей политики): стадия
  завершается с решением «одобрено», при открытом PR задача ждёт слияния как обычно. Задачи, уже попавшие в такое состояние,
  ручной правки не требуют.
