---
divergence-section: Трек 2 — ядро побудок и прогонов
---

## changelog-en

### A run waiting in its own agent's queue is no longer expired and the task is no longer frozen for it (EMPTY-RUNS-6)

- A queued run older than `general.processes.queuedRunStaleAfterSec` (30 minutes) is cancelled with
  `queued_run_stale_timeout` and the agent is woken for the task again. For a run that simply stood behind its own
  agent's running runs this bought nothing: the wake queued the same run behind the same ceiling, and after the second
  expiry the rewake throttle froze the task and told the lead that the agent "made 2 runs on the task without
  progress" although no run of it had ever started. On 13.11 seven tasks were assigned to one engineer with two slots
  at once; two high-priority tasks that block four others were frozen that way while the engineer was working. 46 of
  the 50 expiries of the last 72 hours carried the wait reason `agent_concurrency`.
- The age check now leaves such a run in the queue: the start sweep has named its wait `agent_concurrency` (the
  agent's own concurrency ceiling is full) and the agent has a run in `running` at this moment. It starts when a slot
  frees, as any queued run does. The task-state checks still apply to it: a reassigned or closed task cancels
  the run as before.
- Nothing else changes. A run with that wait reason but no running run behind it (a lost start), a run held for
  another reason or for none, and a run behind another agent expire as before, and two expiries in a row still freeze
  the task (OPE-12290).

## changelog-ru

### Прогон, ждущий в очереди своего же агента, больше не снимается по сроку, и задача из-за этого не замораживается (EMPTY-RUNS-6)

- Прогон, простоявший в очереди дольше `general.processes.queuedRunStaleAfterSec` (30 минут), снимается с кодом
  `queued_run_stale_timeout`, и агента будят по задаче снова. Для прогона, который просто стоял за идущими прогонами
  своего же агента, это ничего не давало: побудка ставила такой же прогон в ту же очередь, а после второго снятия
  тормоз повторных побудок замораживал задачу и писал лиду, что агент «выполнил 2 прогонов по задаче без прогресса»,
  хотя ни один прогон по ней не стартовал. 13.11 на одного инженера с двумя слотами разом назначили семь задач; две
  задачи высокого приоритета, которые держат ещё четыре, оказались заморожены, пока инженер работал. Из 50 снятий за
  72 часа 46 были с причиной ожидания `agent_concurrency`.
- Проверка возраста теперь оставляет такой прогон в очереди: проход запуска назвал его ожидание `agent_concurrency`
  (собственный предел одновременных прогонов агента занят), и у агента сейчас есть прогон в статусе `running`. Он
  стартует, когда освободится слот, как любой прогон в очереди. Проверки состояния задачи к нему по-прежнему
  применяются: переназначенная или закрытая задача снимает прогон, как раньше.
- Остальное без изменений. Прогон с этой причиной ожидания, за которым нет идущего прогона (потерянный запуск),
  прогон, удержанный по другой причине или без причины, и прогон за чужим агентом снимаются по сроку как раньше; два
  снятия подряд по-прежнему замораживают задачу (OPE-12290).

## divergence

| EMPTY-RUNS-6 | Прогон в очереди, ждущий собственный слот агента (`waitReason = agent_concurrency` и у агента есть прогон `running`), не снимается по возрасту (`queued_run_stale_timeout`); проверки состояния задачи к нему применяются как раньше | `server/src/modules/run-dispatch/adapters/postgres.ts` (`cancelStaleQueuedRun`, метка `myrmidon(EMPTY-RUNS-6)`) | 13.11: 46 из 50 снятий по сроку за 72 ч — прогоны за идущими прогонами своего же агента; после двух снятий задача замораживалась с ложным «N прогонов без прогресса» (OPE-13021, OPE-13024) | `server/src/modules/run-dispatch/adapters/postgres.myrmidon.test.ts` (блок EMPTY-RUNS-6) | Когда вендор сам не снимает по возрасту прогон, ждущий слот своего агента, — удалить `queuedRunWaitsForOwnAgentSlot` и тесты | (этот PR) |
