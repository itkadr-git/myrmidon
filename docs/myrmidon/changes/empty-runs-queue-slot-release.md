## changelog-en

### A run that waited for its own agent's slot starts when the slot frees instead of expiring by age (EMPTY-RUNS-6B)

- EMPTY-RUNS-6 spared a queued run that waits for its own agent's concurrency slot
  (`waitReason = agent_concurrency`) from the age expiry only while the agent had a `running` run. In the
  second that run ended the age sweep cancelled the waiting run with `queued_run_stale_timeout`, a
  replacement with another wake reason started, and the rest of the agent's waiting runs were expired one
  after another without starting, which froze the task with "N runs without progress".
- Now such a wait is counted from the end of the agent's last started run when that is later than the start of the
  wait. A slot freed just now leaves the age near zero: the run is kept and starts with its own wake reason
  and data. A slot free for the whole threshold without the run starting is a lost start and expires as
  before. While the agent has a `running` run nothing changes. Reassignment, task closure and the other
  task-state checks still cancel the run.

## changelog-ru

### Прогон, ждавший слот своего агента, стартует при освобождении слота, а не снимается по возрасту (EMPTY-RUNS-6B)

- EMPTY-RUNS-6 не снимал по возрасту поставленный в очередь прогон, который ждёт слот параллельности своего
  агента (`waitReason = agent_concurrency`), только пока у агента был прогон в `running`. В ту секунду, когда
  прогон заканчивался, обход по возрасту отменял ожидавший прогон с `queued_run_stale_timeout`, стартовал
  заменяющий с другой причиной побудки, а остальные ожидающие прогоны агента снимались один за другим, не
  стартовав, и задача замерзала с «N прогонов без прогресса».
- Теперь такое ожидание отсчитывается от конца последнего запущенного прогона агента, если он позже начала ожидания.
  Слот освободился только что — возраст около нуля: прогон остаётся и стартует со своей причиной побудки и
  данными. Слот свободен весь порог, а прогон так и не стартовал — это потерянный старт, снимается как
  раньше. Пока у агента есть `running`, ничего не меняется. Переназначение, закрытие задачи и прочие
  проверки состояния задачи по-прежнему снимают прогон.
