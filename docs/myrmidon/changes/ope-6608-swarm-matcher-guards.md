## changelog-ru

### 1.6.5 F-26 SWARM (OPE-6608, ревью 09.10): петля, транзакция назначения, касты и гейт хоста, аренда с побудкой

- Петля на пути освобождения закрыта: освободившийся агент не получает обратно задачу,
  прогон которой только что кончился (`excludeIssueId`), его собственная назначенная
  `todo`-задача будится только при включённом idle-pickup (рубильник инстанса и карточки
  агента) и из общего минутного бюджета побудок компании. Остывание задачи
  (`swarm-claim/cooling.ts`, проект §4.3) реальное: последние прогоны по задаче не сдвинули её
  (failed / timed_out / blocked / needs_followup / успех без `advanced`/`completed`) — ждёт
  `30 мин × 2^(n−1)`, потолок 24 ч; любое изменение задачи не системой снимает остывание.
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

## changelog-en

### 1.6.5 F-26 SWARM (OPE-6608, review of 09.10): the loop, the assignment transaction, castes and the host gate, a lease with a wake

- The loop on the release path is closed: a freed agent is not offered the task whose run has
  just ended (`excludeIssueId`); its own assigned `todo` task is woken only while idle pickup is
  on (instance switch and the agent card) and out of the company's shared per-minute wake
  budget. The cooling of a task (`swarm-claim/cooling.ts`, design §4.3) is real: when the last
  runs on a task did not move it (failed / timed_out / blocked / needs_followup / a success
  that was not `advanced`/`completed`) it waits `30 min × 2^(n−1)`, capped at 24 h; any change
  of the task by someone other than the system lifts the cooling.
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
