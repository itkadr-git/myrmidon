## changelog-en

### The board's worker process no longer floods the log with "no process bus" lines (OPE-13117)

- In a split deployment (`general.processes.mode = split`) the worker process logged "run start dispatch requested a remote start but no process bus is wired" 10-40 times a second for agents with one running and one queued run. The dispatchers built for routes and services received no `executesRuns`, which the `notify` mode reads as an api process; they now get the process role through a closure, so an executor process starts the run itself.
- The line is written once per process; later occurrences go to the `debug` level.
- The dispatch triggered by an event (a queued-run effect, a wakeup) is skipped for an agent that already runs as many runs as its limit allows: nothing can start, and the finish of its run dispatches again. The sweep and the run-finish paths are unchanged.
- The dispatcher reads the run-dispatch settings at most once per 5 seconds instead of on every call.

## changelog-ru

### Процесс-исполнитель доски больше не засоряет журнал строкой «no process bus» (OPE-13117)

- В раздельном развёртывании (`general.processes.mode = split`) процесс-исполнитель писал «run start dispatch requested a remote start but no process bus is wired» 10-40 раз в секунду по агентам с одним идущим и одним ожидающим прогоном. Диспетчеры, собранные для роутов и сервисов, не получали `executesRuns`, а режим `notify` читает это как процесс api; теперь роль процесса передаётся замыканием, и исполнитель стартует прогон сам.
- Строка пишется один раз за жизнь процесса, дальше на уровне `debug`.
- Диспетчеризация по событию (эффект очереди прогонов, побудка) пропускается для агента, у которого уже идёт столько прогонов, сколько разрешает его лимит: стартовать нечего, а по завершении прогона диспетчеризация придёт снова. Свип и путь завершения прогона не менялись.
- Настройки диспетчера читаются не чаще раза в 5 секунд, а не на каждый вызов.
