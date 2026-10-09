## changelog-ru

### 1.6.5 F-26 SWARM (OPE-6608): события доски доходят до сопоставителя

- Сервис задач (`services/issues.ts`) после создания и после изменения зовёт хук
  `notifySwarmIssueEvent` (`server/src/myrmidon/swarm-claim/events.ts`): созданная готовая
  задача без исполнителя, а также изменение статуса, снятие исполнителя, смена метки касты
  или блокеров у такой задачи отдаются в `matcher.forIssue`. Хук не бросает в вызывающего и
  не блокирует запись; внутри чужой транзакции пары ждут фиксации коммита.
- Снятие паузы агента (`resumeAgentAfterPause`) зовёт `matcher.forAgent`.
- Выключение роя действует без рестарта: сопоставитель строится на каждое событие и читает
  переключатель в этот момент; выключенный рой не обращается к базе.
- `claimNextTaskForAgent` и `POST …/swarm-claim/claim` берут задачу через `matcher.forAgent`
  (явный pull: живой прогон агента не делает его занятым, побудки нет), а не собственной
  вставкой аренды.
- Супервизорский релиз аренды (`rebalance.ts`) теперь снимает исполнителя и зовёт
  `matcher.forIssue`; «разбудить следующего агента роли по загрузке» убрано — оно давало
  одну и ту же пару и отмену `reassigned → skipped`.

## changelog-en

### 1.6.5 F-26 SWARM (OPE-6608): board events reach the matcher

- The issue service (`services/issues.ts`) calls `notifySwarmIssueEvent`
  (`server/src/myrmidon/swarm-claim/events.ts`) after a create and after an update: a ready
  task created without an owner, and a change of status, of the owner (taken off), of the
  caste label or of the blockers on such a task, go to `matcher.forIssue`. The hook never
  throws into the caller and never blocks the write; inside someone else's transaction the
  pairing waits for the commit.
- Lifting an agent's pause (`resumeAgentAfterPause`) calls `matcher.forAgent`.
- Turning the swarm off takes effect without a restart: the matcher is built per event and
  reads the switch at that moment; a swarm that is off does not touch the database.
- `claimNextTaskForAgent` and `POST …/swarm-claim/claim` take the task through
  `matcher.forAgent` (an explicit pull: the agent's live run does not make it busy and nobody
  is woken) instead of inserting a lease of their own.
- The supervisor's lease release (`rebalance.ts`) now takes the owner off the task and calls
  `matcher.forIssue`; "wake the next agent of the role by load" is gone — it produced the same
  pair again and the `reassigned → skipped` cancellation.
