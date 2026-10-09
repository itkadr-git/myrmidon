## changelog-ru

### 1.6.5 F-26 SWARM (ревью 09.10): петля, транзакция назначения, касты и гейт хоста, аренда с побудкой

- Петля на пути освобождения закрыта: освободившийся агент не получает обратно задачу,
  прогон которой только что кончился (`excludeIssueId`), его собственная назначенная
  `todo`-задача будится только при включённом idle-pickup (рубильник инстанса и карточки
  агента) и из общего минутного бюджета побудок компании. Задача в окне остывания не
  назначается и не будится: сопоставитель спрашивает единственное правило остывания продукта —
  `isIssueCoolingDown` из `wake-task-guard.ts` (F-26 T5, проект §4.3; база и потолок окна —
  `general.swarm`), через адаптер `swarm-claim/cooling.ts`. Своего правила у сопоставителя нет.
  Правило теперь читает не только прогоны с `invocation_source = 'automation'`, но и прогоны,
  разбуженные с причиной `swarm_matched` / `swarm_claim_queue` / `idle_pickup` при любом
  источнике: сопоставитель будит исполнителя через путь назначения (`assignment`), и задача,
  которую он раз за разом отдаёт и которая падает, тоже остывает. Ручные прогоны человека
  остывания не начинают.
- Назначение сопоставителем — одна транзакция: блокировка строки задачи, аренда, назначение
  через сервис задач (проверки, событие и запись `issue.updated`). Побудка ставится после
  коммита с `rethrowOnError`; не поставилась (ошибка или отказ допуска) — назначение и аренда
  откатываются, в журнале `issue.swarm_matched_rolled_back`. Состояния «назначена, аренда есть,
  прогона нет» больше не бывает.
- Справочник каст (`swarmEligible`, потолок касты) передан в страховочный проход и в путь
  освобождения (`createCasteDirectoryReader`). Путь освобождения и перематч истёкшей аренды идут
  через реальный гейт допуска прогонов хоста (память и CPU); при закрытом гейте истёкшая аренда
  не снимается и исполнитель остаётся на месте.
- Аренда без прогона не истекает, пока по задаче есть побудка в полёте (`queued` /
  `deferred_issue_execution` / `claimed`, не припаркована на hold). «Есть живой прогон» при
  истечении — это живой прогон по этой задаче, а не любой прогон агента.
- В пул сопоставителя попадает только агент, которого примет слой побудок: вызываемость
  (`evaluateAgentInvokability` — статус и цепочка подчинения), окно обслуживания и блок бюджета
  (`swarm-claim/availability.ts`). Побудка, отклонённая всё равно, передаёт ту же задачу
  следующему агенту пула в том же проходе — один невызываемый агент больше не морит задачу
  голодом и не пишет откаты каждые 30 секунд. Задача, чей проект упёрся в бюджет (тот же блок,
  что проверяет слой побудок по задаче и проекту), пропускается без аренды, побудки и отката;
  агенты остаются свободными для остальной очереди касты.

## changelog-en

### 1.6.5 F-26 SWARM (review of 09.10): the loop, the assignment transaction, castes and the host gate, a lease with a wake

- The loop on the release path is closed: a freed agent is not offered the task whose run has
  just ended (`excludeIssueId`); its own assigned `todo` task is woken only while idle pickup is
  on (instance switch and the agent card) and out of the company's shared per-minute wake
  budget. A task inside its cooling window is neither assigned nor woken: the matcher asks the
  product's one cooling rule — `isIssueCoolingDown` of `wake-task-guard.ts` (F-26 T5, design
  §4.3; the base and ceiling of the window are `general.swarm`) — through the adapter
  `swarm-claim/cooling.ts`. The matcher keeps no rule of its own. The rule now reads not only
  runs with `invocation_source = 'automation'` but also runs woken for `swarm_matched` /
  `swarm_claim_queue` / `idle_pickup` whatever their source: the matcher wakes the assignee
  through the assignment path (`assignment`), and a task it keeps handing out that keeps
  failing cools down too. A person's manual runs never start a cooling.
- The matcher's assignment is one transaction: a lock on the task row, the lease, the
  assignment through the issues service (its checks, its event and the `issue.updated`
  activity). The wake is queued after the commit with `rethrowOnError`; when it cannot be
  queued (an error or an admission refusal) the assignment and the lease are rolled back and
  `issue.swarm_matched_rolled_back` is logged. "Assigned, leased, no run" can no longer happen.
- The caste directory (`swarmEligible`, the caste ceiling) reaches the periodic pass and the
  release path (`createCasteDirectoryReader`). The release path and the re-match of an expired
  lease go through the host's real run-admission gate (memory and CPU); with the gate closed an
  expired lease is not released and its owner stays.
- A lease with no run does not expire while a wake for its task is in flight (`queued` /
  `deferred_issue_execution` / `claimed`, not parked on a hold). "Has a live run" at expiry
  means a live run of THIS task, not any run of the agent.
- Only an agent the wake layer will accept enters the matcher's pool: invokability
  (`evaluateAgentInvokability` — status and the reporting chain), the maintenance window and the
  budget block (`swarm-claim/availability.ts`). A wake refused anyway hands the same task to the
  next agent of the pool in the same pass — one agent that cannot be woken no longer starves a
  task or writes a rollback every 30 seconds. A task whose project hit its budget (the same block
  the wake layer checks with the task's issue and project) is skipped with no lease, wake or
  rollback; the agents stay free for the rest of the caste's queue.
