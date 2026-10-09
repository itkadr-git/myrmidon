---
---

## changelog-en

### An agent starts its most important ready task first, and starvation no longer outranks it (1.6.5 RUN-PRIORITY-PICK)

- The per-agent pass of the run sweep now starts the agent's **most important
  ready task** instead of merely the best of the runs already standing in the
  queue. An event run on a low-priority task (a comment, `issue_continuation_needed`,
  `execution_hold_cleared` and the like) no longer holds the agent while its
  critical task — assigned, ready and without a run — waits for a slot it never
  entered: the task that never got a run was the one the comparison could not
  see, because the single selection by task importance ran only for an agent
  without a live run. The pass reads the agent's top ready task with the idle
  pickup's own rules, compares **task** importance — the issue-priority step
  plus the pheromone strength, never the composed run weight, so a
  long wait can never outrank it — and when it is strictly more important than
  the best standing run, wakes it and leaves the standing runs queued with the
  wait reason `higher_priority_ready` (`Более важная готовая задача агента` /
  `the agent's more important ready task goes first` in the runs panel, en/ru).
  Only a real wake reorders anything: an exhausted wake budget, a paused agent,
  a coalesced duplicate or the idle-pickup behaviour switched off all fall back
  to the pass's own order, so the sweep can never hold an agent without giving
  it work instead.
- An operator's Stop stays durable: the cancelled task is not pushed back into
  the queue by the sweep alone — it becomes fair game again only on a newer
  event on that task.
- "Starved for longer than the limit" no longer means "above every critical
  task of any role": the starvation escape lift is bounded by the distance to
  the next issue-priority step, so it lifts a run inside its own importance step
  and can never reach a more important task, whatever the wait. A run of the
  heaviest step keeps the escape lane — nothing is more important than a
  critical task — and aging keeps its own, unchanged budget.

## changelog-ru

### Агент первым берёт свою самую важную готовую задачу, и «голодание» её больше не обгоняет (1.6.5 RUN-PRIORITY-PICK)

- Проход очереди по агенту теперь запускает **самую важную готовую задачу
  агента**, а не только лучший из уже стоящих в очереди прогонов. Прогон по
  событию на задаче низкой важности (комментарий, `issue_continuation_needed`,
  `execution_hold_cleared` и подобные) больше не держит агента, пока его
  критичная задача — назначенная, готовая и без прогона — ждёт слота, в
  сравнение которого она никогда не попадала: единственный выбор по важности
  задачи работал только для агента без живого прогона. Проход читает верхнюю
  готовую задачу агента по тем же правилам, что и подхват простоя, и сравнивает
  важность **задачи** — ступень приоритета плюс силу феромона, но
  никогда составной вес прогона, поэтому долгое ожидание её не перевесит. Если
  задача строго важнее лучшего стоящего прогона, агента будят на неё, а стоящие
  прогоны остаются в очереди с причиной ожидания `higher_priority_ready`
  (`Более важная готовая задача агента` / `the agent's more important ready task
  goes first` в панели прогонов, en/ru). Порядок меняет только реально
  отправленное пробуждение: исчерпанный бюджет пробуждений, агент на паузе,
  склеенное дублирующее событие или выключенный подхват простоя возвращают
  проход к его собственному порядку — проход не может «подержать» агента, не
  дав ему работы.
- Остановка оператором остаётся в силе: отменённую задачу проход сам обратно в
  очередь не ставит — она снова доступна только по новому событию по этой
  задаче.
- «Голодает дольше предела» больше не значит «выше любой критичной задачи любой
  роли»: подъём аварийного выхода ограничен расстоянием до следующей ступени
  важности, поэтому он поднимает прогон в пределах его собственной ступени и
  никогда не достаёт до более важной задачи, сколько бы он ни ждал. Прогон
  самой тяжёлой ступени аварийный выход сохраняет — важнее критичной задачи
  ничего нет, — а старение живёт со своим, неизменным бюджетом.