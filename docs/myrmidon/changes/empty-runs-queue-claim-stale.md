## changelog-en

### A run that waited for its own agent's slot starts at slot release instead of being cancelled as stale (EMPTY-RUNS-6C)

- EMPTY-RUNS-6 and 6B spared a queued run that waits for its own agent's concurrency slot from the age expiry,
  but only while its wait reason was `agent_concurrency`. In the pass that frees the slot the start sweep takes
  the heaviest waiting run and renames the wait of the other ready runs of the agent to `priority`; the age
  sweep of the same second then cancelled them with `queued_run_stale_timeout` and queued replacements whose
  wake reason was `queued_run_stale_timeout`, so the original reason (`pause_resume`,
  `execution_changes_requested`) and context were lost.
- Now `priority` counts as the same wait for the agent's own slot. Such a run is kept while the agent has a
  `running` run and for the threshold after the end of any started run of the agent (succeeded, failed or
  cancelled), and starts with its own wake reason and data. A run that does not start with a free slot for the
  whole threshold, and every other cancellation reason (reassignment, closed task), are unchanged.

## changelog-ru

### Прогон, ждавший слот своего агента, стартует при освобождении слота, а не снимается как зависший (EMPTY-RUNS-6C)

- EMPTY-RUNS-6 и 6B не снимали по возрасту поставленный в очередь прогон, ждущий слот параллельности своего
  агента, но только пока причина ожидания была `agent_concurrency`. В проходе, освобождающем слот, обход
  запуска берёт самый весомый ждущий прогон и переименовывает ожидание остальных готовых прогонов агента в
  `priority`; обход по возрасту в ту же секунду снимал их с `queued_run_stale_timeout` и ставил замены с
  причиной побудки `queued_run_stale_timeout`, и исходная причина (`pause_resume`,
  `execution_changes_requested`) с контекстом терялась.
- Теперь `priority` считается тем же ожиданием слота своего агента. Такой прогон остаётся, пока у агента есть
  `running`, и в течение порога после конца любого запущенного прогона агента (успех, падение, отмена), и
  стартует со своей причиной побудки и данными. Прогон, не стартующий при свободном слоте весь порог, и все
  прочие причины снятия (смена исполнителя, закрытая задача) не меняются.
